import { and, eq, sql } from "drizzle-orm";
import { emailTokens, getWebDb } from "@funwind/db";
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

/** 签发令牌并返回明文（拼进邮件链接）；同一用户同一用途重签时旧令牌全部作废 */
export async function issueEmailToken(userId: number, purpose: EmailTokenPurpose): Promise<string> {
  const db = getWebDb();
  await db
    .delete(emailTokens)
    .where(and(eq(emailTokens.userId, userId), eq(emailTokens.purpose, purpose)));
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
  return rows[0]?.userId ?? null;
}
