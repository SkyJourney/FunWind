import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getWebDb, users } from "@funwind/db";
import { consumeEmailToken } from "@/lib/auth/tokens";

/** 邮箱验证（开放注册）：消费 verify 令牌 → 标记 email_verified_at → 跳登录 */
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
  const db = getWebDb();
  await db
    .update(users)
    .set({ emailVerifiedAt: sql`NOW()` })
    .where(eq(users.id, userId));
  return NextResponse.redirect(
    new URL(
      "/login?message=" + encodeURIComponent("邮箱验证完成，请登录"),
      process.env.APP_URL ?? "http://127.0.0.1:3100",
    ),
  );
}
