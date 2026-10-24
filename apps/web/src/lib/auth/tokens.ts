import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { emailTokens, getWebDb, users } from "@funwind/db";
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
export async function issueEmailToken(userId: number, purpose: EmailTokenPurpose): Promise<string> {
  const db = getWebDb();
  const mine = and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose));
  // 过期或已使用的行没有保留价值
  await db
    .delete(emailTokens)
    .where(
      and(mine, sql`(${emailTokens.usedAt} IS NOT NULL OR ${emailTokens.expiresAt} <= NOW())`),
    );
  // 为新令牌腾出名额：保留最新的 MAX_LIVE_TOKENS - 1 个
  const live = await db
    .select({ id: emailTokens.id })
    .from(emailTokens)
    .where(mine)
    .orderBy(desc(emailTokens.createdAt));
  const evict = live.slice(MAX_LIVE_TOKENS - 1).map((r) => r.id);
  if (evict.length > 0) await db.delete(emailTokens).where(inArray(emailTokens.id, evict));

  const token = generateToken();
  await db.insert(emailTokens).values({
    id: hashToken(token),
    purpose,
    userId,
    createdAt: sql`NOW()`,
    expiresAt: sql`NOW() + INTERVAL ${TTL_SEC[purpose]} SECOND`,
  });
  return token;
}

/** 消费令牌（单次、原子）：返回 userId 或 null（无效/过期/已用） */
export async function consumeEmailToken(
  token: string,
  purpose: EmailTokenPurpose,
): Promise<number | null> {
  if (!token) return null;
  const db = getWebDb();
  const id = hashToken(token);
  const result = await db
    .update(emailTokens)
    .set({ usedAt: sql`NOW()` })
    .where(
      and(
        eq(emailTokens.id, id),
        eq(emailTokens.purpose, purpose),
        sql`${emailTokens.usedAt} IS NULL`,
        sql`${emailTokens.expiresAt} > NOW()`,
      ),
    );
  const affected = (result as unknown as [{ affectedRows: number }])[0]?.affectedRows ?? 0;
  if (affected === 0) return null;
  const rows = await db
    .select({ userId: emailTokens.userId })
    .from(emailTokens)
    .where(eq(emailTokens.id, id))
    .limit(1);
  const userId = rows[0]?.userId ?? null;
  if (userId !== null) {
    // 一个令牌成功使用，同用户同用途的其余令牌一并作废：改完密码 / 认领完，之前发出的其他链接不该再能用
    await db
      .delete(emailTokens)
      .where(
        and(
          eq(emailTokens.userId, userId),
          eq(emailTokens.purpose, purpose),
          ne(emailTokens.id, id),
        ),
      );
    // 令牌经邮件投递且被成功消费，就证明用户控制该邮箱：reset / claim / verify 三种用途都记为已验证。
    // 这样站点切到开放注册模式时，已认领的迁移用户不会被“邮箱未验证”规则拦在写操作之外。
    await db
      .update(users)
      .set({ emailVerifiedAt: sql`NOW()` })
      .where(
        and(
          eq(users.id, userId),
          sql`${users.email} IS NOT NULL`,
          sql`${users.emailVerifiedAt} IS NULL`,
        ),
      );
  }
  return userId;
}
