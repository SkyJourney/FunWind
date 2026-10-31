import { createHash } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { accountDeletionRequests, affectedRowsOf, emailTokens, getWebDb, users } from "@funwind/db";
import type { DbTx } from "@/lib/audit";
import { generateToken, hashToken } from "./token";

/**
 * 邮件令牌（找回 reset / 邮箱验证 verify / 老用户认领 claim 三合一）。
 * 不透明令牌经邮件投递；库内只存 SHA-256；单次使用（原子 UPDATE 防并发复用）。
 */

export type EmailTokenPurpose = "reset" | "verify" | "claim";

const TTL_SEC: Record<EmailTokenPurpose, number> = {
  reset: 3600, // 1 小时
  verify: 24 * 3600, // 24 小时
  claim: 30 * 24 * 3600, // 30 天（召回窗口）
};

/**
 * 同一用户同一用途最多同时保留的有效令牌数。
 * 取 6 = forgot 的每小时发信上限（见 app/actions/auth.ts）：reset 令牌 1 小时有效，所以有效期内永远不会被「上限」挤掉；
 * 上限只用来拦住 30 天有效的 claim 令牌无限堆积。若设得更小（如 3），别人连发 3 封找回邮件就能把你邮箱里最早那封挤失效。
 */
export const MAX_LIVE_TOKENS = 6;

/**
 * 签发令牌并返回明文（拼进邮件链接）。
 * 旧实现每次签发先删掉该用户该用途的全部旧令牌——于是任何人替你请求一次「找回密码」，你邮箱里已有的链接就失效了
 * （冷却时间一过就能再来一次，可以让你永远用不上链接）。现在未过期、未使用的旧令牌继续有效；
 * 只清理过期 / 已使用的行，超过上限时才删最旧的。令牌被成功消费时再作废其余的（见 consumeEmailToken）。
 */
export async function issueEmailTokenInTx(
  tx: DbTx,
  userId: number,
  purpose: EmailTokenPurpose,
  expectedEmailKey?: string,
): Promise<string> {
  const [user] = await tx
    .select({ emailKey: users.emailKey, state: users.state })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
    .for("update");
  if (!user || user.state !== "active" || !user.emailKey) {
    throw new Error("无法为没有有效邮箱的账号签发邮件令牌");
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
  if (closure) throw new Error("注销中的账号不能签发邮件令牌");
  if (expectedEmailKey !== undefined && user.emailKey !== expectedEmailKey) {
    throw new Error("签发邮箱已变更");
  }

  const mine = and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose));
  await tx
    .delete(emailTokens)
    .where(
      and(mine, sql`(${emailTokens.usedAt} IS NOT NULL OR ${emailTokens.expiresAt} <= NOW())`),
    );
  const live = await tx
    .select({ id: emailTokens.id })
    .from(emailTokens)
    .where(mine)
    .orderBy(desc(emailTokens.createdAt));
  const evict = live.slice(MAX_LIVE_TOKENS - 1).map((r) => r.id);
  if (evict.length > 0) await tx.delete(emailTokens).where(inArray(emailTokens.id, evict));

  const token = generateToken();
  await tx.insert(emailTokens).values({
    id: hashToken(token),
    purpose,
    userId,
    emailKeySnapshot: hashEmailKey(user.emailKey),
    createdAt: sql`NOW()`,
    expiresAt: sql`NOW() + INTERVAL ${TTL_SEC[purpose]} SECOND`,
  });
  return token;
}

export async function issueEmailToken(
  userId: number,
  purpose: EmailTokenPurpose,
  expectedEmailKey?: string,
): Promise<string> {
  return getWebDb().transaction((tx) => issueEmailTokenInTx(tx, userId, purpose, expectedEmailKey));
}

export const hashEmailKey = (emailKey: string): string =>
  createHash("sha256").update(emailKey).digest("hex");

/** 预检令牌是否存在且未过期；后续写操作仍需在事务中再次校验并消费。 */
export async function peekEmailTokenUserId(
  token: string,
  purpose: EmailTokenPurpose,
): Promise<number | null> {
  if (!token) return null;
  const [row] = await getWebDb()
    .select({ userId: emailTokens.userId })
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.id, hashToken(token)),
        eq(emailTokens.purpose, purpose),
        sql`${emailTokens.usedAt} IS NULL`,
        sql`${emailTokens.expiresAt} > NOW()`,
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

/** 在调用方事务中原子消费令牌；供凭据轮换把令牌消费和密码更新放在同一事务。 */
export async function consumeEmailTokenInTx(
  tx: DbTx,
  token: string,
  purpose: EmailTokenPurpose,
): Promise<number | null> {
  if (!token) return null;
  const id = hashToken(token);
  const [candidate] = await tx
    .select({ userId: emailTokens.userId })
    .from(emailTokens)
    .where(and(eq(emailTokens.id, id), eq(emailTokens.purpose, purpose)))
    .limit(1);
  if (!candidate) return null;

  const [user] = await tx
    .select({ emailKey: users.emailKey, state: users.state })
    .from(users)
    .where(eq(users.id, candidate.userId))
    .limit(1)
    .for("update");
  const [closure] = await tx
    .select({ id: accountDeletionRequests.id })
    .from(accountDeletionRequests)
    .where(
      and(
        eq(accountDeletionRequests.userId, candidate.userId),
        inArray(accountDeletionRequests.status, ["pending", "completed"]),
      ),
    )
    .limit(1);
  if (closure) {
    await tx.delete(emailTokens).where(eq(emailTokens.id, id));
    return null;
  }

  const [row] = await tx
    .select({
      userId: emailTokens.userId,
      purpose: emailTokens.purpose,
      emailKeySnapshot: emailTokens.emailKeySnapshot,
      usedAt: emailTokens.usedAt,
      isLive: sql<boolean>`${emailTokens.expiresAt} > NOW()`.mapWith(Boolean),
    })
    .from(emailTokens)
    .where(eq(emailTokens.id, id))
    .limit(1)
    .for("update");
  if (!row || row.userId !== candidate.userId || row.purpose !== purpose || row.usedAt !== null) {
    return null;
  }
  if (!row.isLive) return null;
  if (
    !user ||
    user.state !== "active" ||
    !user.emailKey ||
    row.emailKeySnapshot !== hashEmailKey(user.emailKey)
  ) {
    await tx.delete(emailTokens).where(eq(emailTokens.id, id));
    return null;
  }

  const result = await tx
    .update(emailTokens)
    .set({ usedAt: sql`NOW()` })
    .where(
      and(
        eq(emailTokens.id, id),
        sql`${emailTokens.usedAt} IS NULL`,
        sql`${emailTokens.expiresAt} > NOW()`,
      ),
    );
  if (affectedRowsOf(result) === 0) return null;

  await tx
    .delete(emailTokens)
    .where(
      and(
        eq(emailTokens.userId, candidate.userId),
        eq(emailTokens.purpose, purpose),
        ne(emailTokens.id, id),
      ),
    );
  await tx
    .update(users)
    .set({ emailVerifiedAt: sql`NOW()` })
    .where(eq(users.id, candidate.userId));
  return candidate.userId;
}

/** 消费令牌（单次、原子）：返回 userId 或 null（无效/过期/已用） */
export async function consumeEmailToken(
  token: string,
  purpose: EmailTokenPurpose,
): Promise<number | null> {
  if (!token) return null;
  return getWebDb().transaction((tx) => consumeEmailTokenInTx(tx, token, purpose));
}
