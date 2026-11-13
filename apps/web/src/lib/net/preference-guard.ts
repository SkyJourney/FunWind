import "server-only";
import { NextResponse } from "next/server";
import type { ZodType } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { takePreferenceRateLimit } from "@/lib/auth/preference-ratelimit";
import { isSameOrigin } from "@/lib/net/same-origin";

/**
 * 设置类写 API 的共享门口链（M18 Step 3 提取，preferences 与 push/subscription 路由共用）：
 * 同源 → 会话鉴权 → zod 结构校验 → 共享偏好频控，通过后调 action(user, body)。
 * 错误响应形状与各路由原实现逐字一致（403/401/400/429 + Retry-After）。
 */

type SessionUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;

export async function preferenceGuard<T>(
  request: Request,
  schema: ZodType<T>,
  action: (user: SessionUser, body: T) => Promise<Response>,
): Promise<Response> {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: T;
  try {
    body = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const quota = takePreferenceRateLimit(user.id);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSec) } },
    );
  }

  return action(user, body);
}
