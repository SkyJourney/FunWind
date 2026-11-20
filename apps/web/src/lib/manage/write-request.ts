import "server-only";

import type { z } from "zod";
import { rateLimit } from "@/lib/auth/ratelimit";
import { ManageApiError } from "@/lib/manage/errors";
import type { ManageHandlerContext } from "@/lib/manage/route";
import type { UsableAdminApiToken } from "@/lib/manage/tokens";

export const MANAGE_WRITE_BODY_LIMIT = 16 * 1024;
export const MANAGE_WRITE_TOKEN_LIMIT = 10;
export const MANAGE_WRITE_USER_LIMIT = 30;

/** 只用明确的 on 启用写端点；读端点不经过这道门。 */
export function enforceManageWriteGate(token: UsableAdminApiToken): void {
  if (process.env.MANAGE_API_WRITES !== "on") throw new ManageApiError("writes_disabled");
  const tokenBucket = rateLimit(`manage:write:token:${token.id}`, MANAGE_WRITE_TOKEN_LIMIT, 60_000);
  if (!tokenBucket.allowed) throw new ManageApiError("rate_limited", tokenBucket.retryAfterSec);
  const userBucket = rateLimit(
    `manage:write:user:${token.userId}`,
    MANAGE_WRITE_USER_LIMIT,
    60_000,
  );
  if (!userBucket.allowed) throw new ManageApiError("rate_limited", userBucket.retryAfterSec);
}

/** 逐块限制实际字节数，不能用客户端声明的长度替代读取上限。 */
export async function readManageJson(request: Request): Promise<unknown> {
  const media = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (media !== "application/json") throw new ManageApiError("unsupported_media_type");
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) throw new ManageApiError("bad_request");
    if (Number(declared) > MANAGE_WRITE_BODY_LIMIT) throw new ManageApiError("payload_too_large");
  }
  if (!request.body) throw new ManageApiError("bad_request");

  const reader = request.body.getReader();
  const buffer = new Uint8Array(MANAGE_WRITE_BODY_LIMIT);
  let used = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (used + chunk.value.byteLength > buffer.length) {
        void reader.cancel().catch(() => undefined);
        throw new ManageApiError("payload_too_large");
      }
      buffer.set(chunk.value, used);
      used += chunk.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)));
  } catch (error) {
    if (error instanceof ManageApiError) throw error;
    throw new ManageApiError("bad_request");
  } finally {
    reader.releaseLock();
  }
}

/** 只有通过公共写门禁的 route 才应调用本函数。
 * idParam 省略 = 无路径目标的写（创建/批量类）：targetId 记 0，意图唯一性由请求体指纹承担。 */
export async function parseManageWrite<S extends z.ZodType>(
  { request, params }: Pick<ManageHandlerContext, "request" | "params">,
  schema: S,
  idParam?: string,
): Promise<{ targetId: number; idempotencyKey: string; input: z.infer<S> }> {
  let targetId = 0;
  if (idParam !== undefined) {
    const raw = (await params)[idParam];
    const numeric = Number(raw);
    if (
      typeof raw !== "string" ||
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(numeric) ||
      numeric <= 0
    ) {
      throw new ManageApiError("bad_request");
    }
    targetId = numeric;
  }
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
    throw new ManageApiError("bad_request");
  }
  return { targetId, idempotencyKey, input: schema.parse(await readManageJson(request)) };
}
