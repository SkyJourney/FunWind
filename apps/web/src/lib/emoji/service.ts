import "server-only";

import { eq, sql } from "drizzle-orm";
import { emojiGroups, emojis, getWebDb, insertIdOf } from "@funwind/db";
import { writeAudit, type ConfigActor, type DbTx } from "@/lib/audit";
import { isDuplicateKey } from "@/lib/auth/register";
import type { ModerationApiTrace, ModerationWriteDenial } from "@/lib/moderation/contents";

/**
 * 表情管理服务（M20.3 Step 4 从 admin/emojis/actions.ts 抽出的元数据七动作）：
 * 组建 / 组改名 / 组启停 / 组删（组内非空拒删）/ 组排序 / 表情改名排序 / 表情启停。
 * 后台 Action 与管理 REST 双入口共享写入与审计语义（审计 action 名与原 Action 一致）；
 * 上传类两动作（组标题图、表情批量上传）耦合图片处理管线，不进 REST，仍留在 Action。
 * 停用只影响面板，已发布正文里的 /emoji/{id}.{ext} 引用永远可渲染（提供路由不检查 enabled）。
 * emoji_groups.name 唯一：重名冲突由唯一键兜底捕获为 name_exists。
 */

export type EmojiDenialCode = "not_found" | "name_exists" | "not_empty" | "bad_name";
export type EmojiDenial = ModerationWriteDenial<EmojiDenialCode>;

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const EMOJIS_DENIAL_HTTP = {
  not_found: "not_found",
  name_exists: "state_conflict",
  not_empty: "state_conflict",
  bad_name: "bad_request",
} as const;

export const checkGroupName = (name: string): { ok: true; name: string } | EmojiDenial => {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 50) return { ok: false, code: "bad_name" };
  return { ok: true, name: trimmed };
};

/** 审计 after 的统一附加：via 取 actor 实际入口（REST 带	trace 时另附 requestId/tokenSuffix）。 */
const emojiAuditFields = (actor: ConfigActor, trace?: ModerationApiTrace) => ({
  via: actor.via,
  ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
});

export async function lockEmojiGroup(tx: DbTx, id: number) {
  const [group] = await tx
    .select()
    .from(emojiGroups)
    .where(eq(emojiGroups.id, id))
    .limit(1)
    .for("update");
  return group ?? null;
}

// ------------------------------------------------------------
// 共享写入内核（后台与 REST 共用；事务内调用）
// ------------------------------------------------------------

/** 组建内核：插入（唯一键兜底 name_exists）+ 审计。 */
export async function applyGroupCreate(
  tx: DbTx,
  actor: ConfigActor,
  name: string,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; groupId: number } | EmojiDenial> {
  try {
    const id = insertIdOf(
      await tx.insert(emojiGroups).values({
        name,
        sort: 0,
        createdAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      }),
    );
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "admin.emoji.group.create",
      targetType: "emoji_group",
      targetId: id,
      after: { name, ...emojiAuditFields(actor, trace) },
      ip: actor.ip,
    });
    return { ok: true, groupId: id };
  } catch (error) {
    if (isDuplicateKey(error)) return { ok: false, code: "name_exists" };
    throw error;
  }
}

/** 组改名内核：同值 unchanged（不写审计）；重名 clash 拒绝；唯一键兜底同码。 */
export async function applyGroupRename(
  tx: DbTx,
  actor: ConfigActor,
  id: number,
  before: { name: string },
  name: string,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; changed: boolean } | EmojiDenial> {
  if (before.name === name) return { ok: true, changed: false };
  const [clash] = await tx
    .select({ id: emojiGroups.id })
    .from(emojiGroups)
    .where(eq(emojiGroups.name, name))
    .limit(1);
  if (clash) return { ok: false, code: "name_exists" };
  try {
    await tx
      .update(emojiGroups)
      .set({ name, updatedAt: sql`NOW()` })
      .where(eq(emojiGroups.id, id));
  } catch (error) {
    if (isDuplicateKey(error)) return { ok: false, code: "name_exists" };
    throw error;
  }
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "admin.emoji.group.rename",
    targetType: "emoji_group",
    targetId: id,
    before: { name: before.name },
    after: { name, ...emojiAuditFields(actor, trace) },
    ip: actor.ip,
  });
  return { ok: true, changed: true };
}

/** 组启停内核：同值零审计。 */
export async function applyGroupToggle(
  tx: DbTx,
  actor: ConfigActor,
  id: number,
  before: { enabled: boolean },
  enabled: boolean,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; changed: boolean }> {
  if (before.enabled === enabled) return { ok: true, changed: false };
  await tx
    .update(emojiGroups)
    .set({ enabled, updatedAt: sql`NOW()` })
    .where(eq(emojiGroups.id, id));
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "admin.emoji.group.toggle",
    targetType: "emoji_group",
    targetId: id,
    before: { enabled: before.enabled },
    after: { enabled, ...emojiAuditFields(actor, trace) },
    ip: actor.ip,
  });
  return { ok: true, changed: true };
}

/** 组删内核：组内还有表情就不允许删（与板块「有内容仅归档」同一保护思路）。 */
export async function applyGroupDelete(
  tx: DbTx,
  actor: ConfigActor,
  id: number,
  before: { name: string; sort: number },
  trace?: ModerationApiTrace,
): Promise<{ ok: true } | EmojiDenial> {
  const [{ n }] = await tx
    .select({ n: sql<number>`COUNT(*)` })
    .from(emojis)
    .where(eq(emojis.groupId, id));
  if (Number(n) > 0) return { ok: false, code: "not_empty" };
  await tx.delete(emojiGroups).where(eq(emojiGroups.id, id));
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "admin.emoji.group.delete",
    targetType: "emoji_group",
    targetId: id,
    before: { name: before.name, sort: before.sort },
    after: emojiAuditFields(actor, trace),
    ip: actor.ip,
  });
  return { ok: true };
}

/** 组排序内核：直接改 sort 值（展示按 (sort, id) 升序），同值零审计。 */
export async function applyGroupReorder(
  tx: DbTx,
  actor: ConfigActor,
  id: number,
  before: { sort: number },
  sort: number,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; changed: boolean }> {
  if (before.sort === sort) return { ok: true, changed: false };
  await tx
    .update(emojiGroups)
    .set({ sort, updatedAt: sql`NOW()` })
    .where(eq(emojiGroups.id, id));
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "admin.emoji.group.reorder",
    targetType: "emoji_group",
    targetId: id,
    before: { sort: before.sort },
    after: { sort, ...emojiAuditFields(actor, trace) },
    ip: actor.ip,
  });
  return { ok: true, changed: true };
}

/** 表情更新内核（改名+keywords+排序一动作三事）：值未变不写审计。 */
export async function applyEmojiUpdate(
  tx: DbTx,
  actor: ConfigActor,
  id: number,
  before: { name: string; keywords: string; sort: number },
  input: { name: string; keywords: string; sort: number },
  trace?: ModerationApiTrace,
): Promise<{ ok: true; changed: boolean }> {
  if (
    before.name === input.name &&
    before.keywords === input.keywords &&
    before.sort === input.sort
  ) {
    return { ok: true, changed: false };
  }
  await tx
    .update(emojis)
    .set({ name: input.name, keywords: input.keywords, sort: input.sort, updatedAt: sql`NOW()` })
    .where(eq(emojis.id, id));
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "admin.emoji.update",
    targetType: "emoji",
    targetId: id,
    before: { name: before.name, keywords: before.keywords, sort: before.sort },
    after: { ...input, ...emojiAuditFields(actor, trace) },
    ip: actor.ip,
  });
  return { ok: true, changed: true };
}

/** 表情启停内核：同值零审计。 */
export async function applyEmojiToggle(
  tx: DbTx,
  actor: ConfigActor,
  id: number,
  before: { enabled: boolean },
  enabled: boolean,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; changed: boolean }> {
  if (before.enabled === enabled) return { ok: true, changed: false };
  await tx
    .update(emojis)
    .set({ enabled, updatedAt: sql`NOW()` })
    .where(eq(emojis.id, id));
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "admin.emoji.toggle",
    targetType: "emoji",
    targetId: id,
    before: { enabled: before.enabled },
    after: { enabled, ...emojiAuditFields(actor, trace) },
    ip: actor.ip,
  });
  return { ok: true, changed: true };
}

// ------------------------------------------------------------
// 后台入口（返回结果码；Action 负责 redirect/notFound/revalidatePath）
// ------------------------------------------------------------

export type EmojiGroupMutation =
  { ok: true; changed?: boolean } | { ok: false; code: EmojiDenialCode };

export async function createEmojiGroup(
  actor: ConfigActor,
  name: string,
): Promise<{ ok: true; groupId: number } | { ok: false; code: EmojiDenialCode }> {
  const checked = checkGroupName(name);
  if (!checked.ok) return checked;
  return getWebDb().transaction((tx) => applyGroupCreate(tx, actor, checked.name));
}

export async function renameEmojiGroup(
  actor: ConfigActor,
  id: number,
  name: string,
): Promise<EmojiGroupMutation> {
  const checked = checkGroupName(name);
  if (!checked.ok) return checked;
  return getWebDb().transaction(async (tx) => {
    const before = await lockEmojiGroup(tx, id);
    if (!before) return { ok: false, code: "not_found" };
    return applyGroupRename(tx, actor, id, { name: before.name }, checked.name);
  });
}

export async function toggleEmojiGroupEnabled(
  actor: ConfigActor,
  id: number,
  enabled: boolean,
): Promise<EmojiGroupMutation> {
  return getWebDb().transaction(async (tx) => {
    const before = await lockEmojiGroup(tx, id);
    if (!before) return { ok: false, code: "not_found" };
    return applyGroupToggle(tx, actor, id, { enabled: before.enabled }, enabled);
  });
}

export async function deleteEmojiGroup(
  actor: ConfigActor,
  id: number,
): Promise<EmojiGroupMutation> {
  return getWebDb().transaction(async (tx) => {
    const before = await lockEmojiGroup(tx, id);
    if (!before) return { ok: false, code: "not_found" };
    return applyGroupDelete(tx, actor, id, { name: before.name, sort: before.sort });
  });
}

export async function reorderEmojiGroup(
  actor: ConfigActor,
  id: number,
  sort: number,
): Promise<EmojiGroupMutation> {
  return getWebDb().transaction(async (tx) => {
    const before = await lockEmojiGroup(tx, id);
    if (!before) return { ok: false, code: "not_found" };
    return applyGroupReorder(tx, actor, id, { sort: before.sort }, sort);
  });
}

export async function updateEmoji(
  actor: ConfigActor,
  id: number,
  input: { name: string; keywords: string; sort: number },
): Promise<EmojiGroupMutation> {
  return getWebDb().transaction(async (tx) => {
    const [before] = await tx.select().from(emojis).where(eq(emojis.id, id)).limit(1).for("update");
    if (!before) return { ok: false, code: "not_found" };
    return applyEmojiUpdate(
      tx,
      actor,
      id,
      { name: before.name, keywords: before.keywords, sort: before.sort },
      input,
    );
  });
}

export async function toggleEmojiEnabled(
  actor: ConfigActor,
  id: number,
  enabled: boolean,
): Promise<EmojiGroupMutation> {
  return getWebDb().transaction(async (tx) => {
    const [before] = await tx.select().from(emojis).where(eq(emojis.id, id)).limit(1).for("update");
    if (!before) return { ok: false, code: "not_found" };
    return applyEmojiToggle(tx, actor, id, { enabled: before.enabled }, enabled);
  });
}

// REST 写变体与管理读已拆至 api-writes.ts / queries-admin.ts（M20.3 Step 4 棘轮拆分）；
// 此处 re-export 维持 import 路径稳定。
export {
  prepareApiEmojiGroupCreate,
  prepareApiEmojiGroupRename,
  prepareApiEmojiGroupEnabled,
  prepareApiEmojiGroupDelete,
  prepareApiEmojiGroupReorder,
  prepareApiEmojiUpdate,
  prepareApiEmojiEnabled,
  type PreparedEmojiWrite,
} from "./api-writes";
export {
  listEmojiGroupsAdmin,
  listEmojisAdminPage,
  type AdminEmojiGroupRow,
  type AdminEmojiRow,
} from "./queries-admin";
