import "server-only";

import { eq } from "drizzle-orm";
import { forums } from "@funwind/db";
import type { ModerationWriteDenial } from "@/lib/moderation/contents";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import type { ModerationApiTrace, PreparedModerationWrite } from "@/lib/moderation/contents";
import {
  applyForumAddPrefix,
  applyForumCreate,
  applyForumDelete,
  applyForumRemovePrefix,
  applyForumUpdate,
  lockCreateParent,
  lockDeleteTarget,
  lockPrefixHost,
  lockPrefixRow,
  type ForumActor,
  type ForumAdminError,
  type ForumCreateInput,
  type ForumUpdateInput,
} from "./admin";

// ============================================================
// REST 写变体（M20.3 Step 4）：prepare/lock/execute 三段式，供管理 REST 幂等
// 管线接入；与后台入口共享本文件的 lock/apply 事务内核，写入/审计语义完全一致。
// 幂等契约：lock 段只做存在性与归属锁，可变状态裁决（环检测、删除守卫等）统一在
// execute——合法回放在进入本函数前已被幂等缓存短路，不会重复裁决；execute 闭包
// 捕获 lock 的 tx，在同一事务内完成写入与审计（不另开事务）；权限快照失效移入
// afterCommit，由幂等管线在事务提交后调用（后台入口仍在自身事务成功后失效）。
// ============================================================

/** 业务拒绝码 → 对外信封映射（REST 适配层使用；未登记码由入口兜底 internal）。 */
export const FORUMS_DENIAL_HTTP = {
  not_found: "not_found",
  cycle: "state_conflict",
  has_children: "state_conflict",
  has_threads: "state_conflict",
} as const;

/** REST 三段式写变体的准备产物类型（data 统一为目标版块 id，denial 复用域拒绝码）。 */
export type PreparedForumWrite = PreparedModerationWrite<Record<string, number>, ForumAdminError>;

/** REST 创建版块：父级存在性锁在 lock 段；占位插入与路径回填在 execute（创建无状态裁决）。 */
export async function prepareApiForumCreate(
  actor: ForumActor,
  input: ForumCreateInput,
  trace?: ModerationApiTrace,
): Promise<PreparedForumWrite | ModerationWriteDenial<ForumAdminError>> {
  return {
    ok: true,
    async lock(tx) {
      const locked = await lockCreateParent(tx, input.parentId);
      if (!locked.ok) return locked;
      return {
        ok: true as const,
        async execute() {
          const applied = await applyForumCreate(tx, actor, input, locked.parentPath, trace);
          return {
            ok: true as const,
            data: { id: applied.id },
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}

/** REST 编辑版块：目标行 FOR UPDATE 存在性锁在 lock 段；环裁决（cycle）与写入在 execute。 */
export async function prepareApiForumUpdate(
  actor: ForumActor,
  fid: number,
  input: ForumUpdateInput,
  trace?: ModerationApiTrace,
): Promise<PreparedForumWrite | ModerationWriteDenial<ForumAdminError>> {
  return {
    ok: true,
    async lock(tx) {
      const [row] = await tx
        .select({ id: forums.id })
        .from(forums)
        .where(eq(forums.id, fid))
        .limit(1)
        .for("update");
      if (!row) return { ok: false as const, code: "not_found" as const };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyForumUpdate(tx, actor, fid, input, trace);
          if (!applied.ok) return applied;
          return {
            ok: true as const,
            data: { id: fid },
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}

/** REST 删除版块：目标行存在性锁在 lock 段；删除守卫（has_children/has_threads）在 execute 裁决。 */
export async function prepareApiForumDelete(
  actor: ForumActor,
  fid: number,
  trace?: ModerationApiTrace,
): Promise<PreparedForumWrite | ModerationWriteDenial<ForumAdminError>> {
  return {
    ok: true,
    async lock(tx) {
      const self = await lockDeleteTarget(tx, fid);
      if (!self) return { ok: false as const, code: "not_found" as const };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyForumDelete(tx, actor, fid, self, trace);
          if (!applied.ok) return applied;
          return {
            ok: true as const,
            data: { id: fid },
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}

/** REST 新增前缀：宿主版块存在性检查在 lock 段；插入与审计在 execute。 */
export async function prepareApiForumAddPrefix(
  actor: ForumActor,
  fid: number,
  input: { name: string; sortOrder: number },
  trace?: ModerationApiTrace,
): Promise<PreparedForumWrite | ModerationWriteDenial<ForumAdminError>> {
  return {
    ok: true,
    async lock(tx) {
      const forum = await lockPrefixHost(tx, fid);
      if (!forum) return { ok: false as const, code: "not_found" as const };
      return {
        ok: true as const,
        async execute() {
          const applied = await applyForumAddPrefix(tx, actor, fid, input, trace);
          return {
            ok: true as const,
            data: { forumId: fid, prefixId: applied.prefixId },
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}

/** REST 移除前缀：id+宿主归属行存在性检查在 lock 段（越权与不存在同型 not_found）；删除在 execute。 */
export async function prepareApiForumRemovePrefix(
  actor: ForumActor,
  fid: number,
  prefixId: number,
  trace?: ModerationApiTrace,
): Promise<PreparedForumWrite | ModerationWriteDenial<ForumAdminError>> {
  return {
    ok: true,
    async lock(tx) {
      const row = await lockPrefixRow(tx, fid, prefixId);
      if (!row) return { ok: false as const, code: "not_found" as const };
      return {
        ok: true as const,
        async execute() {
          await applyForumRemovePrefix(tx, actor, fid, row, trace);
          return {
            ok: true as const,
            data: { id: fid },
            async afterCommit() {
              invalidateAuthzSnapshot();
            },
          };
        },
      };
    },
  };
}
