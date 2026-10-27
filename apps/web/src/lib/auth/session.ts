import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, gt, ne, sql } from "drizzle-orm";
import { getWebDb, sessions, users } from "@funwind/db";
import { findActiveGlobalBan } from "@/lib/authz/restrictions";
import { generateToken, hashToken } from "./token";

/**
 * 服务端会话（M4）：不透明令牌 cookie，库内只存 SHA-256。
 * 有效期口径：**30 天绝对过期**，从登录那一刻算起，活跃使用不延长（M5.6 S3 明确）。
 * 真正的滑动续期要同时延长 expires_at 并刷新 cookie 的 maxAge，而 cookie 只能在 Server Action / Route Handler 里写，
 * 不能在 RSC 渲染里写；要做须引入中间件，暂不做。last_seen_at 只作活跃度展示，不参与有效期判定。
 * 可撤销性：封禁/改密 → revokeAllForUser 即时失效全部会话。
 * cookie Secure 按站点协议自动判定（http://127.0.0.1 下浏览器拒收 Secure，E2E 必需）。
 */

export const SESSION_COOKIE = "fw_session";
/** 双轨强制换密快速门（middleware 只读 cookie，不查库；真源 = users.legacy_password_pending） */
export const MUST_CHANGE_COOKIE = "fw_must_change";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
/** 双轨换密 cookie 与会话 cookie 同一套 Secure 判定（http://127.0.0.1 下浏览器拒收 Secure） */
export const isSecureSite = () => (process.env.APP_URL ?? "").startsWith("https://");

export interface SessionUser {
  id: number;
  username: string;
  /** 迁移用户可能没有邮箱 */
  email: string | null;
  emailVerified: boolean;
  passwordHashIsSet: boolean;
}

/**
 * 当前登录用户；未登录返回 null。请求级缓存。
 * 会话失效条件：令牌不存在/过期、账号已注销（state=deleted）、处于全站封禁中。
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = getWebDb();
  const rows = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      username: users.username,
      email: users.email,
      passwordHash: users.passwordHash,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.id, hashToken(token)),
        gt(sessions.expiresAt, sql`NOW()`),
        eq(users.state, "active"),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // 全站封禁中：会话视为失效（登录页会显示理由与期限）
  if (await findActiveGlobalBan(row.userId)) return null;

  // 记录最近活跃时间（每小时至多写一次，避免写放大）。注意：不延长 expires_at，见文件头的有效期口径
  await db
    .update(sessions)
    .set({ lastSeenAt: sql`NOW()` })
    .where(
      and(
        eq(sessions.id, hashToken(token)),
        sql`(last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL 1 HOUR)`,
      ),
    );

  return {
    id: row.userId,
    username: row.username,
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
    passwordHashIsSet: row.passwordHash !== null,
  };
});

/** 创建会话并写 cookie（登录/注册成功；登录时须先销毁旧会话=防会话固定） */
export async function createSession(
  userId: number,
  meta: { ip?: string | null; userAgent?: string } = {},
): Promise<void> {
  const token = generateToken();
  const db = getWebDb();
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    createdAt: sql`NOW()`,
    expiresAt: sql`NOW() + INTERVAL ${SESSION_TTL_MS / 1000} SECOND`,
    lastSeenAt: sql`NOW()`,
    ip: meta.ip ?? null,
    userAgent: (meta.userAgent ?? "").slice(0, 255) || null,
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureSite(),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

/** 登出 / 单点登出 */
export async function destroyCurrentSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const db = getWebDb();
    await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
  }
  store.delete(SESSION_COOKIE);
}

/** 改密/重置后吊销某用户全部会话 */
export async function revokeAllForUser(userId: number): Promise<void> {
  const db = getWebDb();
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** 改密后吊销**其他**会话（保留当前设备，用户不被踢出）；当前无会话 cookie 时不删任何行 */
export async function revokeOtherSessions(userId: number): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return;
  const db = getWebDb();
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, hashToken(token))));
}
