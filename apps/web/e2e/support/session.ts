import { createHash, randomBytes } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { withE2eDb } from "./db";

/**
 * 以指定用户身份“已登录”：直接往库里写一条会话（库内只存令牌哈希）并把明文令牌注入 cookie。
 * 为什么不走界面登录：登录有账号级频控（每账号 10 分钟 5 次），许多用例共用 admin/会员账号，
 * 反复界面登录会互相挤爆额度。真实的界面登录流程只由 auth.spec 覆盖。
 */
export async function loginAs(
  context: BrowserContext,
  userId: number,
  baseHost = "127.0.0.1",
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await withE2eDb((q) =>
    q.exec(
      "INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, NOW(), NOW() + INTERVAL 2 HOUR, NOW())",
      [createHash("sha256").update(token).digest("hex"), userId],
    ),
  );
  await context.addCookies([
    {
      name: "fw_session",
      value: token,
      domain: baseHost,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return token;
}

/** 演示夹具里的用户 id（与 packages/db 的 DEMO 常量一致） */
export const USERS = {
  alice: 90001, // 无密码；帖 900101/900104 的作者
  xiaoyi: 90002, // 无密码；审核版块里待审核/已驳回帖的作者
  banned: 90003,
  admin: 90004,
  member: 90005, // 已购买门控 9001
  team: 90006, // 演示团队成员：可读受限版块 904；余额 50
  legacyUser: 95002, // 双轨密码账号（M10.6c）：旧密码 e2e-legacy-pass，登录后强制换密
} as const;
