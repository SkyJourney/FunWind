import { NextResponse } from "next/server";
import { consumeEmailToken } from "@/lib/auth/tokens";

/** 邮箱验证（开放注册）：消费 verify 令牌（消费成功即在 consumeEmailToken 内标记 email_verified_at）→ 跳登录 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const userId = await consumeEmailToken(token, "verify");
  if (!userId) {
    return NextResponse.redirect(
      new URL(
        "/login?error=" + encodeURIComponent("验证链接无效或已过期"),
        process.env.APP_URL ?? "http://127.0.0.1:3100",
      ),
    );
  }
  return NextResponse.redirect(
    new URL(
      "/login?message=" + encodeURIComponent("邮箱验证完成，请登录"),
      process.env.APP_URL ?? "http://127.0.0.1:3100",
    ),
  );
}
