import "server-only";

import { eq } from "drizzle-orm";
import { emojis } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import type { ModerationApiTrace, PreparedModerationWrite } from "@/lib/moderation/contents";
import {
  applyGroupCreate,
  applyGroupRename,
  applyGroupToggle,
  applyGroupDelete,
  applyGroupReorder,
  applyEmojiUpdate,
  applyEmojiToggle,
  lockEmojiGroup,
  checkGroupName,
  type EmojiDenialCode,
  type EmojiDenial,
} from "./service";

// ------------------------------------------------------------
// REST 写变体（prepare/lock/execute；合法回放已被幂等缓存短路）
// ------------------------------------------------------------

export type PreparedEmojiWrite = PreparedModerationWrite<
  {
    groupId?: number;
    emojiId?: number;
    changed?: boolean;
    enabled?: boolean;
    sort?: number;
    deleted?: boolean;
  },
  EmojiDenialCode
>;

/** REST 组建：组名校验在 prepare；唯一键冲突在 execute 兜底为 name_exists。 */
export async function prepareApiEmojiGroupCreate(
  actor: ConfigActor,
  name: string,
  trace?: ModerationApiTrace,
): Promise<PreparedEmojiWrite | EmojiDenial> {
  const checked = checkGroupName(name);
  if (!checked.ok) return checked;
  return {
    ok: true,
    async lock(tx) {
      // 组建无行锁目标；唯一键冲突在 execute（幂等事务内）兜底为 name_exists
      return {
        ok: true as const,
        async execute() {
          const applied = await applyGroupCreate(tx, actor, checked.name, trace);
          return applied.ok ? { ok: true as const, data: { groupId: applied.groupId } } : applied;
        },
      };
    },
  };
}

/** REST 组改名：存在性在锁段；同值/重名裁决在 execute。 */
export async function prepareApiEmojiGroupRename(
  actor: ConfigActor,
  id: number,
  name: string,
  trace?: ModerationApiTrace,
): Promise<PreparedEmojiWrite | EmojiDenial> {
  const checked = checkGroupName(name);
  if (!checked.ok) return checked;
  return {
    ok: true,
    async lock(tx) {
      const before = await lockEmojiGroup(tx, id);
      if (!before) return { ok: false, code: "not_found" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyGroupRename(
            tx,
            actor,
            id,
            { name: before.name },
            checked.name,
            trace,
          );
          return applied.ok
            ? { ok: true as const, data: { groupId: id, changed: applied.changed } }
            : applied;
        },
      };
    },
  };
}

/** REST 组启停：同值裁决在 execute。 */
export async function prepareApiEmojiGroupEnabled(
  actor: ConfigActor,
  id: number,
  enabled: boolean,
  trace?: ModerationApiTrace,
): Promise<PreparedEmojiWrite | EmojiDenial> {
  return {
    ok: true,
    async lock(tx) {
      const before = await lockEmojiGroup(tx, id);
      if (!before) return { ok: false, code: "not_found" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyGroupToggle(
            tx,
            actor,
            id,
            { enabled: before.enabled },
            enabled,
            trace,
          );
          return {
            ok: true as const,
            data: { groupId: id, enabled, changed: applied.changed },
          };
        },
      };
    },
  };
}

/** REST 组删：非空裁决在 execute。 */
export async function prepareApiEmojiGroupDelete(
  actor: ConfigActor,
  id: number,
  trace?: ModerationApiTrace,
): Promise<PreparedEmojiWrite | EmojiDenial> {
  return {
    ok: true,
    async lock(tx) {
      const before = await lockEmojiGroup(tx, id);
      if (!before) return { ok: false, code: "not_found" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyGroupDelete(
            tx,
            actor,
            id,
            { name: before.name, sort: before.sort },
            trace,
          );
          return applied.ok ? { ok: true as const, data: { groupId: id, deleted: true } } : applied;
        },
      };
    },
  };
}

/** REST 组排序：同值裁决在 execute。 */
export async function prepareApiEmojiGroupReorder(
  actor: ConfigActor,
  id: number,
  sort: number,
  trace?: ModerationApiTrace,
): Promise<PreparedEmojiWrite | EmojiDenial> {
  return {
    ok: true,
    async lock(tx) {
      const before = await lockEmojiGroup(tx, id);
      if (!before) return { ok: false, code: "not_found" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyGroupReorder(
            tx,
            actor,
            id,
            { sort: before.sort },
            sort,
            trace,
          );
          return {
            ok: true as const,
            data: { groupId: id, sort, changed: applied.changed },
          };
        },
      };
    },
  };
}

/** REST 表情更新（改名+keywords+排序）：存在性在锁段；值未变不写审计。 */
export async function prepareApiEmojiUpdate(
  actor: ConfigActor,
  id: number,
  input: { name: string; keywords: string; sort: number },
  trace?: ModerationApiTrace,
): Promise<PreparedEmojiWrite | EmojiDenial> {
  const name = input.name.trim();
  if (!name || name.length > 50) return { ok: false, code: "bad_name" };
  return {
    ok: true,
    async lock(tx) {
      const [before] = await tx
        .select()
        .from(emojis)
        .where(eq(emojis.id, id))
        .limit(1)
        .for("update");
      if (!before) return { ok: false, code: "not_found" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyEmojiUpdate(
            tx,
            actor,
            id,
            { name: before.name, keywords: before.keywords, sort: before.sort },
            { name, keywords: input.keywords, sort: input.sort },
            trace,
          );
          return {
            ok: true as const,
            data: { emojiId: id, changed: applied.changed },
          };
        },
      };
    },
  };
}

/** REST 表情启停：同值裁决在 execute。 */
export async function prepareApiEmojiEnabled(
  actor: ConfigActor,
  id: number,
  enabled: boolean,
  trace?: ModerationApiTrace,
): Promise<PreparedEmojiWrite | EmojiDenial> {
  return {
    ok: true,
    async lock(tx) {
      const [before] = await tx
        .select()
        .from(emojis)
        .where(eq(emojis.id, id))
        .limit(1)
        .for("update");
      if (!before) return { ok: false, code: "not_found" };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyEmojiToggle(
            tx,
            actor,
            id,
            { enabled: before.enabled },
            enabled,
            trace,
          );
          return {
            ok: true as const,
            data: { emojiId: id, enabled, changed: applied.changed },
          };
        },
      };
    },
  };
}
