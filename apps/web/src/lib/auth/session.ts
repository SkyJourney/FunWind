import { cache } from "react";
import { cookies } from "next/headers";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { accountDeletionRequests, getWebDb, sessions, userRestrictions, users } from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import { restrictionActive } from "@/lib/authz/restrictions";
import { generateToken, hashToken } from "./token";

/**
 * 服务端会话（M4）：不透明令牌 cookie，库内只存 SHA-256。
 * 有效期口径：**30 天绝对过期**，从登录那一刻算起，活跃使用不延长（M5.6 S3 明确）。
 * 真正的滑动续期要同时延长 expires_at 并刷新 cookie 的 maxAge，而 cookie 只能在 Server Action / Route Handler 里写，
 * 不能在 RSC 渲染里写；要做须引入中间件，暂不做。last_seen_at 只作活跃度展示，不参与有效期判定。
 * 会话读取还校验账号状态、旧密码待换新、注销申请与全站封禁；改密路径通过 revokeAll/revokeOther 删除对应会话行。
 * cookie Secure 按站点协议自动判定（http://127.0.0.1 下浏览器拒收 Secure，E2E 必需）。
 */

export const SESSION_COOKIE = "fw_session";
/** 注销申请状态/撤销专用的短权限 cookie，不构成普通登录态。 */
export const CLOSURE_ACCESS_COOKIE = "fw_closure_access";
/** 双轨强制换密快速门（middleware 只读 cookie，不查库；真源 = users.legacy_password_pending） */
export const MUST_CHANGE_COOKIE = "fw_must_change";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const CLOSURE_ACCESS_TTL_SECONDS = 35 * 24 * 3600;
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

export interface ClosureAccess {
  requestId: number;
  userId: number;
  status: "pending" | "completed";
  scheduledAt: string;
  canCancel: boolean;
}

export type SessionCreationFailure =
  | "not_active"
  | "password_change_required"
  | "password_change_not_required"
  | "account_closing"
  | "banned";

export class SessionCreationError extends Error {
  constructor(readonly code: SessionCreationFailure) {
    super(code);
    this.name = "SessionCreationError";
  }
}

async function readCurrentSessionUser(
  legacyPasswordChangeOnly: boolean,
): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = getWebDb();
  const rows = await db
    .select({
      userId: sessions.userId,
      createdAt: sessions.createdAt,
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
        eq(users.legacyPasswordPending, legacyPasswordChangeOnly),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const [closure] = await db
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, row.userId),
        inArray(accountDeletionRequests.status, ["pending", "completed"]),
      ),
    )
    .limit(1);
  if (closure) return null;

  const [banOverlap] = await db
    .select({ id: userRestrictions.id })
    .from(userRestrictions)
    .where(
      and(
        eq(userRestrictions.userId, row.userId),
        eq(userRestrictions.kind, "ban"),
        eq(userRestrictions.scopeId, 0),
        sql`${userRestrictions.startsAt} <= NOW()`,
        sql`(${userRestrictions.endsAt} IS NULL OR ${userRestrictions.endsAt} >= ${row.createdAt})`,
      ),
    )
    .limit(1);
  if (banOverlap) {
    await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
    return null;
  }

  // 记录最近活跃时间（每小时至多写一次，避免写放大），不延长绝对过期时间。
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
}

/** 普通登录态；旧密码待换新、注销申请中、已注销或全站封禁均不获得普通主体。 */
export const getCurrentUser = cache(() => readCurrentSessionUser(false));

/** 仅用于强制换密页面与动作的受限会话，不供普通页面、API 或权限主体使用。 */
export const getPasswordChangeUser = cache(() => readCurrentSessionUser(true));

/** 读取注销专用访问凭据；该凭据只能访问注销状态页，且不可恢复普通权限。 */
export async function getClosureAccess(): Promise<ClosureAccess | null> {
  const token = (await cookies()).get(CLOSURE_ACCESS_COOKIE)?.value;
  if (!token) return null;
  const [row] = await getWebDb()
    .select({
      requestId: accountDeletionRequests.id,
      userId: accountDeletionRequests.userId,
      status: accountDeletionRequests.status,
      scheduledAt: accountDeletionRequests.scheduledAt,
      canCancel: sql<boolean>`${accountDeletionRequests.scheduledAt} > NOW()`.mapWith(Boolean),
    })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.accessTokenHash, hashToken(token)),
        sql`${accountDeletionRequests.accessExpiresAt} > NOW()`,
        inArray(accountDeletionRequests.status, ["pending", "completed"]),
      ),
    )
    .orderBy(sql`${accountDeletionRequests.id} DESC`)
    .limit(1);
  if (!row || (row.status !== "pending" && row.status !== "completed")) return null;
  return { ...row, status: row.status };
}

export async function setClosureAccessCookie(token: string): Promise<void> {
  (await cookies()).set(CLOSURE_ACCESS_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureSite(),
    path: "/",
    maxAge: CLOSURE_ACCESS_TTL_SECONDS,
  });
}

export async function clearClosureAccessCookie(): Promise<void> {
  (await cookies()).delete(CLOSURE_ACCESS_COOKIE);
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureSite(),
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export async function createSessionInTx(
  tx: DbTx,
  userId: number,
  meta: { ip?: string | null; userAgent?: string } = {},
  legacyPasswordChangeOnly = false,
): Promise<string> {
  const token = generateToken();
  const [user] = await tx
    .select({ state: users.state, legacyPasswordPending: users.legacyPasswordPending })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");
  if (!user || user.state !== "active") throw new SessionCreationError("not_active");
  if (user.legacyPasswordPending !== legacyPasswordChangeOnly) {
    throw new SessionCreationError(
      legacyPasswordChangeOnly ? "password_change_not_required" : "password_change_required",
    );
  }
  const [closure] = await tx
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, userId),
        inArray(accountDeletionRequests.status, ["pending", "completed"]),
      ),
    )
    .limit(1);
  if (closure) throw new SessionCreationError("account_closing");
  const [ban] = await tx
    .select({ id: userRestrictions.id })
    .from(userRestrictions)
    .where(
      and(
        eq(userRestrictions.userId, userId),
        eq(userRestrictions.kind, "ban"),
        eq(userRestrictions.scopeId, 0),
        restrictionActive,
      ),
    )
    .limit(1);
  if (ban) throw new SessionCreationError("banned");

  await tx.insert(sessions).values({
    id: hashToken(token),
    userId,
    createdAt: sql`NOW()`,
    expiresAt: sql`NOW() + INTERVAL ${SESSION_TTL_MS / 1000} SECOND`,
    lastSeenAt: sql`NOW()`,
    ip: meta.ip ?? null,
    userAgent: (meta.userAgent ?? "").slice(0, 255) || null,
  });
  return token;
}

async function persistSession(
  userId: number,
  meta: { ip?: string | null; userAgent?: string },
  legacyPasswordChangeOnly: boolean,
): Promise<void> {
  const token = await getWebDb().transaction((tx) =>
    createSessionInTx(tx, userId, meta, legacyPasswordChangeOnly),
  );
  await setSessionCookie(token);
  await clearClosureAccessCookie();
}

/** 创建普通会话；数据库状态不允许普通登录时拒绝写入 session。 */
export async function createSession(
  userId: number,
  meta: { ip?: string | null; userAgent?: string } = {},
): Promise<void> {
  return persistSession(userId, meta, false);
}

/** 只为已验证旧密码的强制换密流程创建受限会话。 */
export async function createLegacyPasswordChangeSession(
  userId: number,
  meta: { ip?: string | null; userAgent?: string } = {},
): Promise<void> {
  return persistSession(userId, meta, true);
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
  store.delete(MUST_CHANGE_COOKIE);
  store.delete(CLOSURE_ACCESS_COOKIE);
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
