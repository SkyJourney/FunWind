import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { files, getWebDb } from "@funwind/db";
import type { Subject } from "@/lib/authz/types";
import { recordDownload, resolveFileGrant } from "@/lib/gates/attachments";
import { resolveStaticPath } from "@/lib/static-files";
import { getStorageDir } from "@/lib/storage";

/**
 * /files/<storage_key> 的请求处理（docs/DESIGN-MODEL.md §5）。路由文件只做薄薄一层，逻辑在这里以便脱离 Next 做集成测试。
 *
 * 鉴权（附件部分的判定集中在 lib/gates/attachments.ts，硬约定 3d）：
 *   · 图片类（头像、正文图片、徽章图）公开——storage_key 由内容哈希派生、不可枚举（能力 URL）。
 *     例外：文件的所有附件引用都绑定了门控时，图片也要经门控放行，且响应 private / no-store。
 *   · 非图片附件：经 attachments 反查所属帖子，要求「帖子对观众可见」「该版块持有 attachment.download」，
 *     附件绑定了门控的还要求该门控对观众开放。同一文件可能被多个帖子引用（按哈希去重），任意一处放行即可。
 *   · 一切拒绝都是 404（硬约定 7），不暴露文件是否存在。
 * 响应头：Content-Type 只取 files.mime、绝不按扩展名推断；nosniff；非图片一律 attachment；
 * 再加 CSP sandbox 作纵深防御——即使将来有人登记了可脚本化类型，浏览器也不会执行。
 */

/** 可内联展示的图片类型（svg 不在其中：可脚本化，一律当附件下载） */
export const IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

const KEY_RE = /^([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/;

/** 严格校验路径形态：ab/cd/<64 位小写十六进制>.<ext>，且前两级目录必须等于哈希前缀。通过则返回 storage_key */
export function parseFileKey(segments: readonly string[]): string | null {
  // 恰好三段、段内不含 "/"：Next 会把 %2f 解码进段内，`49%2f77/<sha>.png` 拼接后能通过下面的正则，
  // 同一个文件就有了多个 URL 形态（缓存键分裂，按路径写的前置 ACL / WAF 规则也能被绕过，M5.6 S4）
  if (segments.length !== 3 || segments.some((seg) => seg.includes("/"))) return null;
  const key = segments.join("/");
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const [, d1, d2, sha] = m;
  return sha!.startsWith(d1! + d2!) ? key : null;
}

/** Content-Disposition：去掉控制字符与路径/引号字符，RFC 5987 编码中文名，ASCII 兜底名防头部注入 */
export function contentDisposition(kind: "inline" | "attachment", originalName: string): string {
  const clean =
    originalName
      .replace(/[\x00-\x1f\x7f"\\/]/g, "")
      .trim()
      .slice(0, 200) || "download";
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="download"; filename*=UTF-8''${encoded}`;
}

export type FileAccess =
  | {
      kind: "image";
      sha256: string;
      mime: string;
      /** 经门控放行的图片：响应依赖会话，不得被共享缓存存下来，也不走 ETag 304 */
      gated: boolean;
    }
  | {
      kind: "attachment";
      sha256: string;
      mime: string;
      attachmentId: number;
      originalName: string;
    };

/** 解析观众对该 storage_key 的访问权；无权或不存在 → null（调用方一律 404） */
export async function resolveFileAccess(viewer: Subject, key: string): Promise<FileAccess | null> {
  const [file] = await getWebDb()
    .select({ id: files.id, sha256: files.sha256, mime: files.mime })
    .from(files)
    .where(eq(files.storageKey, key))
    .limit(1);
  if (!file) return null; // 只查库，不探测文件系统
  const mime = file.mime || "application/octet-stream";
  const isImage = IMAGE_MIMES.has(mime);

  const grant = await resolveFileGrant(viewer, { id: file.id, isImage });
  if (!grant) return null;
  if (isImage) {
    return {
      kind: "image",
      sha256: file.sha256,
      mime,
      gated: grant.kind === "granted" && grant.gated,
    };
  }
  // 非图片必然经附件行放行（public 只会出现在图片分支）
  if (grant.kind !== "granted") return null;
  return {
    kind: "attachment",
    sha256: file.sha256,
    mime,
    attachmentId: grant.attachmentId,
    originalName: grant.originalName,
  };
}

const notFound = () => new Response("not found", { status: 404 });

/** 构造响应头（纯函数，便于断言） */
export function fileHeaders(access: FileAccess, size: number): Record<string, string> {
  const base: Record<string, string> = {
    "content-type": access.mime,
    "content-length": String(size),
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (access.kind === "image") {
    if (access.gated) {
      // 门控图片的放行依赖会话：不带 ETag，不进共享缓存
      return { ...base, "content-disposition": "inline", "cache-control": "private, no-store" };
    }
    return {
      ...base,
      "content-disposition": "inline",
      etag: `"${access.sha256}"`,
      "cache-control": "public, max-age=31536000, immutable",
    };
  }
  return {
    ...base,
    "content-disposition": contentDisposition("attachment", access.originalName),
    // 附件鉴权依赖会话，不得被共享缓存存下来
    "cache-control": "private, no-store",
  };
}

export async function handleFileRequest(
  req: Request,
  segments: readonly string[],
  viewer: Subject,
  storageDir: string = getStorageDir(),
): Promise<Response> {
  const key = parseFileKey(segments);
  if (!key) return notFound();
  const access = await resolveFileAccess(viewer, key);
  if (!access) return notFound();

  if (
    access.kind === "image" &&
    !access.gated &&
    req.headers.get("if-none-match") === `"${access.sha256}"`
  ) {
    return new Response(null, { status: 304, headers: { etag: `"${access.sha256}"` } });
  }

  const full = resolveStaticPath(storageDir, key.split("/"));
  if (!full) return notFound();
  let size: number;
  try {
    const stat = await fs.stat(full);
    if (!stat.isFile()) return notFound();
    size = stat.size;
  } catch {
    console.error(`[files] 数据库有记录但存储缺失: ${key}`);
    return notFound();
  }

  // 下载计数：只在真正取内容的 GET 上累加，一次请求一次
  if (access.kind === "attachment" && req.method === "GET") {
    await recordDownload(access.attachmentId);
  }

  const body = Readable.toWeb(createReadStream(full)) as ReadableStream;
  return new Response(body, { status: 200, headers: fileHeaders(access, size) });
}
