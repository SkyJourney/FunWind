import { and, asc, eq, sql } from "drizzle-orm";
import { forumPrefixes, forums, getWebDb } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import type { ForumNode } from "./forum-tree";

/**
 * 版块管理服务（M10.6a，docs/milestones/M10.6-feature-completion.md 批次 a）：
 * 创建/更新（含父级迁移）/删除/前缀 CRUD。只做编辑入口——可见性与策略的判定引擎照旧
 * （lib/authz），所有变更同事务写审计、提交后失效权限快照（TTL 30s 兜底 CLI/其他进程改库）。
 */

export type ForumAdminError =
  | "not_found" // 目标版块或父级不存在
  | "cycle" // 父级迁移目标在自己子树内
  | "has_children" // 有子级，禁止删除
  | "has_threads"; // 有主题，禁止删除

export interface ForumActor {
  userId: number | null;
  ip?: string | null;
}

export interface ForumCreateInput {
  parentId: number;
  kind: "section" | "forum";
  name: string;
  description: string | null;
  icon: string;
  sortOrder: number;
  isListed: boolean;
}

export interface ForumUpdateInput {
  parentId: number;
  name: string;
  description: string | null;
  icon: string;
  sortOrder: number;
  isListed: boolean;
  readPolicy: ForumNode["readPolicy"];
  writePolicy: ForumNode["writePolicy"];
  reviewPolicy: ForumNode["reviewPolicy"];
  isArchived: boolean;
}

/** 物化路径拼接：根为 /{id}/，否则父路径（以 / 结尾）追加自身 id */
export function childPath(parentPath: string, id: number): string {
  return `${parentPath}${id}/`;
}

export function depthOf(path: string): number {
  return path.split("/").filter(Boolean).length;
}

export interface MoveUpdate {
  id: number;
  parentId: number;
  path: string;
  depth: number;
}

export type MovePlan =
  { ok: true; updates: MoveUpdate[] } | { ok: false; code: "not_found" | "cycle" };

/**
 * 纯函数：把 fid（含全部后代）迁到 newParentId 下的重算计划。
 * 环检测：新父级不得是自身或自身后代（物化路径前缀判定）；根路径约定为 /{fid}/。
 * 与现父级相同的"迁移"是幂等空操作，不视为环。
 */
export function planMove(rows: readonly ForumNode[], fid: number, newParentId: number): MovePlan {
  const self = rows.find((r) => r.id === fid);
  if (!self) return { ok: false, code: "not_found" };
  let parentPath = "/";
  if (newParentId !== 0) {
    const parent = rows.find((r) => r.id === newParentId);
    if (!parent) return { ok: false, code: "not_found" };
    // 目标是自身或在自己子树内 → 成环（物化路径前缀判定；parent 为自身时同样命中）
    if (parent.path.startsWith(self.path)) return { ok: false, code: "cycle" };
    parentPath = parent.path;
  }
  const base = childPath(parentPath, fid);
  const updates: MoveUpdate[] = [];
  for (const r of rows) {
    if (r.id !== fid && !r.path.startsWith(self.path)) continue;
    const path = r.id === fid ? base : base + r.path.slice(self.path.length);
    updates.push({
      id: r.id,
      parentId: r.id === fid ? newParentId : r.parentId,
      path,
      depth: depthOf(path),
    });
  }
  return { ok: true, updates };
}

const forumCols = {
  id: forums.id,
  parentId: forums.parentId,
  path: forums.path,
  depth: forums.depth,
  kind: forums.kind,
  name: forums.name,
  description: forums.description,
  icon: forums.icon,
  sortOrder: forums.sortOrder,
  readPolicy: forums.readPolicy,
  writePolicy: forums.writePolicy,
  reviewPolicy: forums.reviewPolicy,
  isListed: forums.isListed,
  isArchived: forums.isArchived,
};

export async function listForumRows(): Promise<ForumNode[]> {
  return (await getWebDb().select(forumCols).from(forums).orderBy(asc(forums.id))) as ForumNode[];
}

async function loadAllForums(tx: DbTx): Promise<ForumNode[]> {
  return (await tx.select(forumCols).from(forums).orderBy(asc(forums.id))) as ForumNode[];
}

export async function createForum(
  actor: ForumActor,
  input: ForumCreateInput,
): Promise<{ ok: true; id: number } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => {
    let parentPath = "/";
    if (input.parentId !== 0) {
      const [parent] = await tx
        .select({ path: forums.path })
        .from(forums)
        .where(eq(forums.id, input.parentId))
        .limit(1)
        .for("update");
      if (!parent) return { ok: false as const, code: "not_found" as const };
      parentPath = parent.path;
    }
    // path 含自身 id（自增），先占位插入再回填物化路径
    const [hdr] = await tx.insert(forums).values({
      parentId: input.parentId,
      path: "/",
      depth: 1,
      kind: input.kind,
      name: input.name,
      description: input.description,
      icon: input.icon,
      sortOrder: input.sortOrder,
      isListed: input.isListed,
    });
    const id = Number(hdr.insertId);
    const path = childPath(parentPath, id);
    const depth = depthOf(path);
    await tx.update(forums).set({ path, depth }).where(eq(forums.id, id));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "forum.create",
      targetType: "forum",
      targetId: id,
      after: { ...input, path, depth },
      ip: actor.ip,
    });
    return { ok: true as const, id };
  });
  if (result.ok) invalidateAuthzSnapshot();
  return result;
}

export async function updateForum(
  actor: ForumActor,
  fid: number,
  input: ForumUpdateInput,
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => {
    const rows = await loadAllForums(tx);
    const before = rows.find((r) => r.id === fid);
    if (!before) return { ok: false as const, code: "not_found" as const };

    const plan =
      input.parentId === before.parentId
        ? ({ ok: true, updates: [] } as MovePlan)
        : planMove(rows, fid, input.parentId);
    if (!plan.ok) return { ok: false as const, code: plan.code };

    await tx
      .update(forums)
      .set({
        parentId: input.parentId,
        name: input.name,
        description: input.description,
        icon: input.icon,
        sortOrder: input.sortOrder,
        readPolicy: input.readPolicy,
        writePolicy: input.writePolicy,
        reviewPolicy: input.reviewPolicy,
        isListed: input.isListed,
        isArchived: input.isArchived,
      })
      .where(eq(forums.id, fid));
    for (const u of plan.updates) {
      // fid 的标量字段（含 parentId）已由上面的更新覆盖；这里统一回填物化路径与深度
      await tx
        .update(forums)
        .set(
          u.id === fid
            ? { path: u.path, depth: u.depth }
            : { parentId: u.parentId, path: u.path, depth: u.depth },
        )
        .where(eq(forums.id, u.id));
    }

    await writeAudit(tx, {
      actorId: actor.userId,
      action: "forum.update",
      targetType: "forum",
      targetId: fid,
      before: { ...before },
      after: { ...input, path: plan.updates.find((x) => x.id === fid)?.path ?? before.path },
      ip: actor.ip,
    });
    return { ok: true as const };
  });
  if (result.ok) invalidateAuthzSnapshot();
  return result;
}

export async function deleteForum(
  actor: ForumActor,
  fid: number,
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => {
    const [self] = await tx.select().from(forums).where(eq(forums.id, fid)).limit(1).for("update");
    if (!self) return { ok: false as const, code: "not_found" as const };
    const [child] = await tx
      .select({ n: sql<number>`count(*)` })
      .from(forums)
      .where(eq(forums.parentId, fid));
    if (Number(child.n) > 0) return { ok: false as const, code: "has_children" as const };
    if (self.threadCount > 0) return { ok: false as const, code: "has_threads" as const };
    await tx.delete(forumPrefixes).where(eq(forumPrefixes.forumId, fid));
    await tx.delete(forums).where(eq(forums.id, fid));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "forum.delete",
      targetType: "forum",
      targetId: fid,
      before: { ...self },
      ip: actor.ip,
    });
    return { ok: true as const };
  });
  if (result.ok) invalidateAuthzSnapshot();
  return result;
}

// ============================================================
// 版块主题前缀
// ============================================================

export async function listPrefixes(fid: number) {
  return getWebDb()
    .select()
    .from(forumPrefixes)
    .where(eq(forumPrefixes.forumId, fid))
    .orderBy(asc(forumPrefixes.sortOrder), asc(forumPrefixes.id));
}

export async function addPrefix(
  actor: ForumActor,
  fid: number,
  input: { name: string; sortOrder: number },
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => {
    const [forum] = await tx
      .select({ id: forums.id })
      .from(forums)
      .where(eq(forums.id, fid))
      .limit(1);
    if (!forum) return { ok: false as const, code: "not_found" as const };
    await tx
      .insert(forumPrefixes)
      .values({ forumId: fid, name: input.name, sortOrder: input.sortOrder });
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "forum.prefix.add",
      targetType: "forum",
      targetId: fid,
      after: input,
      ip: actor.ip,
    });
    return { ok: true as const };
  });
  if (result.ok) invalidateAuthzSnapshot();
  return result;
}

export async function removePrefix(
  actor: ForumActor,
  fid: number,
  prefixId: number,
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(forumPrefixes)
      .where(and(eq(forumPrefixes.id, prefixId), eq(forumPrefixes.forumId, fid)))
      .limit(1);
    if (!row) return { ok: false as const, code: "not_found" as const };
    await tx.delete(forumPrefixes).where(eq(forumPrefixes.id, prefixId));
    await writeAudit(tx, {
      actorId: actor.userId,
      action: "forum.prefix.remove",
      targetType: "forum",
      targetId: fid,
      before: { name: row.name },
      ip: actor.ip,
    });
    return { ok: true as const };
  });
  if (result.ok) invalidateAuthzSnapshot();
  return result;
}
