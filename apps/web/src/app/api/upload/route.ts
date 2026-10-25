import { NextResponse } from "next/server";
import { rateLimit, rateLimitRefund } from "@/lib/auth/ratelimit";
import { checkPermission } from "@/lib/authz/service";
import { getCurrentSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { limitsFor } from "@/lib/limits/load";
import { readBodyBytes } from "@/lib/net/read-body";
import { isSameOrigin } from "@/lib/net/same-origin";
import { getStorageDir } from "@/lib/storage";
import { parseCropField } from "@/lib/uploads/crop";
import { admit } from "@/lib/uploads/policy";
import { ProcessError, processImage } from "@/lib/uploads/process-image";
import { sniffType } from "@/lib/uploads/sniff";
import { quotaPrecheck, storeUpload } from "@/lib/uploads/store";
import {
  FORM_OVERHEAD_BYTES,
  IMAGE_TYPES,
  MAX_BYTES,
  type UploadPurpose,
  type SniffedType,
} from "@/lib/uploads/types";

/**
 * 文件上传（M6.4b，设计稿 §3）。`POST /api/upload?purpose=inline|attachment|avatar`，multipart 表单：
 *   file（必填）、forumId（inline / attachment 必填）、crop（可选，JSON 字符串，自然像素）。
 * 用途放在查询参数里：读取请求体之前就能按用途设定字节上限，避免为了判断用途而把 50 MB 整包读进内存。
 *
 * 顺序：同源 → 登录 → 限流（用户桶先、全局桶后，被用户桶拒绝的不占全局额度）→ 字节上限（413）
 *      → 表单解析 → 版块权限（越权 404）/ 头像限制（no_avatar 403）→ 嗅探与准入（415）
 *      → 图片处理（400 / 413）→ 配额与落盘登记（429）。
 * 不走 Server Action：它的请求体上限是 1 MB，且返回值需要是 JSON。
 */

const PURPOSES: readonly UploadPurpose[] = ["inline", "attachment", "avatar"];
const USER_PER_MINUTE = 30;
const GLOBAL_PER_MINUTE = 600;
const WINDOW_MS = 60_000;

function json(body: unknown, status: number): Response {
  return NextResponse.json(body, { status });
}

/**
 * 同一账号同时进行中的上传上限。读体、解码与重编码都在内存里进行，每个请求最多占用约 50 MB 的副本，
 * 并发必须有界（否则单账号 30 次/分钟的限流仍可在瞬时叠加出数 GB 的内存峰值）。
 */
const INFLIGHT_PER_USER = 3;
const inflight = new Map<number, number>();

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return json({ error: "forbidden" }, 403);
  const url = new URL(request.url);

  const subject = await getCurrentSubject();
  if (subject.userId === null) return json({ error: "unauthorized" }, 401);
  const userId = subject.userId;

  const userKey = `upload:user:${userId}`;
  if (!rateLimit(userKey, USER_PER_MINUTE, WINDOW_MS).allowed) {
    return json({ error: "rate_limited" }, 429);
  }
  if (!rateLimit("upload:global", GLOBAL_PER_MINUTE, WINDOW_MS).allowed) {
    rateLimitRefund(userKey);
    return json({ error: "rate_limited" }, 429);
  }

  // 并发闸放在读体之前：超出的请求直接 429，不占用内存
  const active = inflight.get(userId) ?? 0;
  if (active >= INFLIGHT_PER_USER) return json({ error: "rate_limited" }, 429);
  inflight.set(userId, active + 1);
  try {
    return await handleUpload(request, url, subject, userId);
  } finally {
    const left = (inflight.get(userId) ?? 1) - 1;
    if (left <= 0) inflight.delete(userId);
    else inflight.set(userId, left);
  }
}

async function handleUpload(
  request: Request,
  url: URL,
  subject: Subject,
  userId: number,
): Promise<Response> {
  const purposeRaw = url.searchParams.get("purpose") ?? "";
  if (!(PURPOSES as readonly string[]).includes(purposeRaw))
    return json({ error: "bad_request" }, 400);
  const purpose = purposeRaw as UploadPurpose;

  // 按用途的上限读取：超限在流式读取时即中止
  const body = await readBodyBytes(request, MAX_BYTES[purpose] + FORM_OVERHEAD_BYTES);
  if (body === null) return json({ error: "too_large" }, 413);

  let form: FormData;
  try {
    const contentType = request.headers.get("content-type") ?? "";
    // Response 的 BodyInit 要求 ArrayBuffer 背书的视图：拷贝一份（上限 50 MB，临时多占一份内存可接受）
    const ab = new ArrayBuffer(body.byteLength);
    new Uint8Array(ab).set(body);
    form = await new Response(ab, { headers: { "content-type": contentType } }).formData();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "bad_request" }, 400);
  if (file.size > MAX_BYTES[purpose]) return json({ error: "too_large" }, 413);

  let forumId: number | null = null;
  if (purpose === "avatar") {
    // 头像不属于任何版块，但仍是写类动作：封禁 / 禁言 / 未验证邮箱（开放注册）同样不得上传（审查复查）
    const decision = await checkPermission(subject, "attachment.upload", {});
    if (!decision.allowed) return json({ error: "forbidden" }, 403);
    // no_avatar 是全站限制，评估器不处理它，这里直接判断
    if (subject.restrictions.some((r) => r.kind === "no_avatar" && r.scopeId === 0)) {
      return json({ error: "avatar_restricted" }, 403);
    }
  } else {
    const raw = form.get("forumId");
    const id = typeof raw === "string" ? Number(raw) : Number.NaN;
    if (!Number.isInteger(id) || id <= 0) return json({ error: "bad_request" }, 400);
    forumId = id;
    // 越权一律 404，不暴露版块是否存在（硬约定 7）
    const decision = await checkPermission(subject, "attachment.upload", { forumId: id });
    if (!decision.allowed) return json({ error: "not_found" }, 404);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sniffed = sniffType(bytes);
  if (sniffed === null) return json({ error: "unsupported_type" }, 415);
  // 当前 sharp 构建无法解码 BMP：在入口拒绝，而不是在处理阶段以「无法解码」失败
  if (sniffed === "bmp") return json({ error: "unsupported_type" }, 415);
  const admitted = admit(file.name, purpose, sniffed);
  if (!admitted.ok) return json({ error: admitted.code }, 415);

  const cropRaw = form.get("crop");
  const cropField = parseCropField(typeof cropRaw === "string" ? cropRaw : null);
  if (cropField.kind === "invalid") return json({ error: "crop_invalid" }, 400);
  const crop = cropField.kind === "value" ? cropField.value : undefined;

  const limits = await limitsFor(subject, forumId ?? undefined);
  // 配额预检放在图片处理之前：超额的账号不应再消耗解码与重编码的资源（非权威，权威检查仍在存储事务内）
  if (!(await quotaPrecheck(userId, limits.uploadsPerDay))) {
    return json({ error: "quota_exceeded" }, 429);
  }

  let stored: {
    bytes: Buffer;
    sniffed: Exclude<SniffedType, "bmp">;
    width: number | null;
    height: number | null;
  };
  if (IMAGE_TYPES.has(sniffed)) {
    try {
      const out = await processImage(bytes, { sniffed, crop, avatar: purpose === "avatar" });
      // processImage 从不输出 BMP（BMP 统一编码为 PNG）；这道守卫只为收窄类型
      if (out.sniffed === "bmp") return json({ error: "unsupported_type" }, 415);
      stored = { bytes: out.bytes, sniffed: out.sniffed, width: out.width, height: out.height };
    } catch (e) {
      if (e instanceof ProcessError)
        return json({ error: e.code }, e.code === "pixels" ? 413 : 400);
      throw e;
    }
  } else {
    // 非图片：原样存储，不裁剪
    if (crop !== undefined) return json({ error: "crop_not_image" }, 400);
    stored = { bytes, sniffed, width: null, height: null };
  }

  const result = await storeUpload(
    {
      userId,
      bytes: stored.bytes,
      sniffed: stored.sniffed,
      width: stored.width,
      height: stored.height,
      avatar: purpose === "avatar",
    },
    { storageDir: getStorageDir(), uploadsPerDay: limits.uploadsPerDay },
  );
  if (!result.ok) return json({ error: result.code }, 429);

  const f = result.file;
  return json(
    {
      fileId: f.fileId,
      storageKey: f.storageKey,
      url: `/files/${f.storageKey}`,
      mime: f.mime,
      width: f.width,
      height: f.height,
      sizeBytes: f.sizeBytes,
    },
    200,
  );
}
