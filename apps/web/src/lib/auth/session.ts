import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, gt, sql } from "drizzle-orm";
import { getWebDb, sessions, userBans, users } from "@funwind/db";
import { generateToken, hashToken } from "./token";

/**
 * 服务端会话（M4）：不透明令牌 cookie，库内只存 SHA-256。
 * 可撤销性：封禁/改密 → revokeAllForUser 即时失效全部会话。
 * cookie Secure 按站点协议自动判定（http://127.0.0.1 下浏览器拒收 Secure，E2E 必需）。
 */

export const SESSION_COOKIE = "fw_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const isSecureSite = () => (process.env.APP_URL ?? "").startsWith("https://");

export interface SessionUser {
  id: number;
  username: string;
  email: string;
  passwordHashIsSet: boolean;
  groupId: number;
  globalBanReason: string | null; // 非空 = 处于全局封禁中
}

/** 当前登录用户（含全局封禁判定）；未登录返回 null。请求级缓存。 */
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
      groupId: users.groupId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, sql`NOW()`)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // 全局封禁（fid=0 且 未过期/永久）
  const banRows = await db
    .select({ reason: userBans.reason })
    .from(userBans)
    .where(
      and(
        eq(userBans.userId, row.userId),
        eq(userBans.fid, 0),
        sql`(${userBans.endTime} IS NULL OR ${userBans.endTime} > NOW())`,
      ),
    )
    .limit(1);
  const banReason = banRows[0]?.reason ?? null;

  // 滑动续期（每小时至多一次，避免写放大）
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
    passwordHashIsSet: row.passwordHash !== null,
    groupId: row.groupId,
    globalBanReason: banReason,
  };
});

/** 创建会话并写 cookie（登录/注册成功；登录时须先销毁旧会话=防会话固定） */
export async function createSession(
  userId: number,
  meta: { ip?: string; userAgent?: string } = {},
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
