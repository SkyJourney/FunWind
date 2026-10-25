import { and, eq, inArray, ne } from "drizzle-orm";
import { normalizeKey, users } from "@funwind/db";
import { extractMentionTokens } from "@funwind/content";
import type { DbTx } from "@/lib/audit";

/**
 * @提及的用户解析（M8）：候选 token 归一化后按 username_key 精确匹配**活跃**用户，
 * 排除作者本人；提及不出现在门控隐藏区（调用方传公开正文）。
 * 编辑路径传 priorSource 时做差集——只对**新增**的提及发事件，重复编辑不重复打扰。
 */

export async function resolveMentionUserIds(
  tx: DbTx,
  source: string,
  authorId: number,
  priorSource?: string,
): Promise<number[]> {
  const tokens = extractMentionTokens(source);
  if (tokens.length === 0) return [];
  const keys = [...new Set(tokens.map(normalizeKey))];
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(inArray(users.usernameKey, keys), eq(users.state, "active"), ne(users.id, authorId)),
    );
  if (priorSource === undefined) return rows.map((r) => r.id);
  const prior = new Set(await resolveMentionUserIds(tx, priorSource, authorId));
  return rows.map((r) => r.id).filter((id) => !prior.has(id));
}
