import { and, asc, eq, sql } from "drizzle-orm";
import { forumPrefixes, forums, getWebDb, insertIdOf } from "@funwind/db";
import { writeAudit, type DbTx } from "@/lib/audit";
import { invalidateAuthzSnapshot } from "@/lib/authz/snapshot";
import type { ModerationApiTrace } from "@/lib/moderation/contents";
import type { ForumNode } from "./forum-tree";
import { forumSelectCols } from "./select";

/**
 * 版块管理服务（M10.6a，docs/milestones/M10.6-feature-completion.md 批次 a）：
 * 创建/更新（含父级迁移）/删除/前缀 CRUD。只做编辑入口——可见性与策略的判定引擎照旧
 * （lib/authz），所有变更同事务写审计、提交后失效权限快照（TTL 30s 兜底 CLI/其他进程改库）。
 * M20.3 Step 4：同一批事务内核抽出为 lock/apply 共享函数，后台入口与本文件尾部的
 * 管理 REST prepare 变体共用（prepare/lock/execute 三段式，见文件尾说明）。
 */

export type ForumAdminError =
  | "not_found" // 目标版块或父级不存在
  | "cycle" // 父级迁移目标在自己子树内
  | "has_children" // 有子级，禁止删除
  | "has_threads"; // 有主题，禁止删除

export interface ForumActor {
  userId: number | null;
  ip?: string | null;
  /** 操作来源（M20.3）：后台入口不传（审计保持原形态）；管理 REST 变体传 "api" 并附加 trace */
  via?: string;
}

export interface ForumCreateInput {
  parentId: number;
  kind: "section" | "forum";
  name: string;
  description: string | null;
  sortOrder: number;
  isListed: boolean;
}

export interface ForumUpdateInput {
  parentId: number;
  name: string;
  description: string | null;
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

export async function listForumRows(): Promise<ForumNode[]> {
  return (await getWebDb()
    .select(forumSelectCols)
    .from(forums)
    .orderBy(asc(forums.id))) as ForumNode[];
}

async function loadAllForums(tx: DbTx): Promise<ForumNode[]> {
  return (await tx.select(forumSelectCols).from(forums).orderBy(asc(forums.id))) as ForumNode[];
}

/**
 * 审计 after 的 REST 附加字段：actor 带 via（管理 REST 变体）时附加 via 与 API 追踪字段，
 * 后台 actor 不带 via，返回空对象、审计形态与原实现完全一致。
 */
function auditExtras(actor: ForumActor, trace?: ModerationApiTrace): Record<string, unknown> {
  if (actor.via === undefined) return {};
  return {
    via: actor.via,
    ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
  };
}

/** 事务内共享内核（后台与 REST lock 段共用）：创建时的父级存在性锁（parentId=0 为根，无锁目标） */
export async function lockCreateParent(
  tx: DbTx,
  parentId: number,
): Promise<{ ok: true; parentPath: string } | { ok: false; code: ForumAdminError }> {
  let parentPath = "/";
  if (parentId !== 0) {
    const [parent] = await tx
      .select({ path: forums.path })
      .from(forums)
      .where(eq(forums.id, parentId))
      .limit(1)
      .for("update");
    if (!parent) return { ok: false as const, code: "not_found" as const };
    parentPath = parent.path;
  }
  return { ok: true as const, parentPath };
}

/** 事务内共享内核（后台与 REST execute 段共用）：占位插入 + 物化路径回填 + 审计 */
export async function applyForumCreate(
  tx: DbTx,
  actor: ForumActor,
  input: ForumCreateInput,
  parentPath: string,
  trace?: ModerationApiTrace,
): Promise<{ ok: true; id: number }> {
  // path 含自身 id（自增），先占位插入再回填物化路径
  const [hdr] = await tx.insert(forums).values({
    parentId: input.parentId,
    path: "/",
    depth: 1,
    kind: input.kind,
    name: input.name,
    description: input.description,
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
    after: { ...input, path, depth, ...auditExtras(actor, trace) },
    ip: actor.ip,
  });
  return { ok: true as const, id };
}

export async function createForum(
  actor: ForumActor,
  input: ForumCreateInput,
): Promise<{ ok: true; id: number } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => {
    const locked = await lockCreateParent(tx, input.parentId);
    if (!locked.ok) return locked;
    return applyForumCreate(tx, actor, input, locked.parentPath);
  });
  if (result.ok) invalidateAuthzSnapshot();
  return result;
}

/**
 * 事务内共享内核（后台与 REST execute 段共用）：加载全树、环裁决（cycle/not_found）、
 * 更新标量字段、迁移子树回填物化路径、审计。守卫裁决在本函数内完成——REST 变体中
 * 它随 execute 运行（合法回放已被幂等缓存短路，不会重复裁决）；后台入口保持在原事务内原位。
 */
export async function applyForumUpdate(
  tx: DbTx,
  actor: ForumActor,
  fid: number,
  input: ForumUpdateInput,
  trace?: ModerationApiTrace,
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
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
      // iconKey 不在此更新：板块图由 uploadForumIcon action 维护，普通编辑不得清空
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
    after: {
      ...input,
      path: plan.updates.find((x) => x.id === fid)?.path ?? before.path,
      ...auditExtras(actor, trace),
    },
    ip: actor.ip,
  });
  return { ok: true as const };
}

export async function updateForum(
  actor: ForumActor,
  fid: number,
  input: ForumUpdateInput,
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => applyForumUpdate(tx, actor, fid, input));
  if (result.ok) invalidateAuthzSnapshot();
  return result;
}

/** 事务内共享内核（后台与 REST lock 段共用）：删除目标的 FOR UPDATE 存在性锁 */
export async function lockDeleteTarget(tx: DbTx, fid: number) {
  const [self] = await tx.select().from(forums).where(eq(forums.id, fid)).limit(1).for("update");
  return self ?? null;
}

/**
 * 事务内共享内核（后台与 REST execute 段共用）：删除守卫裁决（has_children/has_threads）
 * + 前缀级联清理 + 删除行 + 审计。REST 变体中守卫随 execute 运行。
 */
export async function applyForumDelete(
  tx: DbTx,
  actor: ForumActor,
  fid: number,
  self: typeof forums.$inferSelect,
  trace?: ModerationApiTrace,
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
  const [child] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(forums)
    .where(eq(forums.parentId, fid));
  if (Number(child.n) > 0) return { ok: false as const, code: "has_children" as const };
  if (self.threadCount > 0) return { ok: false as const, code: "has_threads" as const };
  await tx.delete(forumPrefixes).where(eq(forumPrefixes.forumId, fid));
  await tx.delete(forums).where(eq(forums.id, fid));
  const extras = auditExtras(actor, trace);
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "forum.delete",
    targetType: "forum",
    targetId: fid,
    before: { ...self },
    // 原实现无 after；仅 REST（有 via）时补一条带 via/trace 的 after，后台审计形态不变
    ...(Object.keys(extras).length > 0 ? { after: extras } : {}),
    ip: actor.ip,
  });
  return { ok: true as const };
}

export async function deleteForum(
  actor: ForumActor,
  fid: number,
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => {
    const self = await lockDeleteTarget(tx, fid);
    if (!self) return { ok: false as const, code: "not_found" as const };
    return applyForumDelete(tx, actor, fid, self);
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

/** 事务内共享内核（后台与 REST lock 段共用）：前缀宿主版块存在性检查（与原实现一致，不加行锁） */
export async function lockPrefixHost(tx: DbTx, fid: number) {
  const [forum] = await tx
    .select({ id: forums.id })
    .from(forums)
    .where(eq(forums.id, fid))
    .limit(1);
  return forum ?? null;
}

/** 事务内共享内核（后台与 REST execute 段共用）：插入前缀 + 审计 */
export async function applyForumAddPrefix(
  tx: DbTx,
  actor: ForumActor,
  fid: number,
  input: { name: string; sortOrder: number },
  trace?: ModerationApiTrace,
): Promise<{ ok: true; prefixId: number }> {
  const prefixId = insertIdOf(
    await tx
      .insert(forumPrefixes)
      .values({ forumId: fid, name: input.name, sortOrder: input.sortOrder }),
  );
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "forum.prefix.add",
    targetType: "forum",
    targetId: fid,
    after: { ...input, prefixId, ...auditExtras(actor, trace) },
    ip: actor.ip,
  });
  return { ok: true as const, prefixId };
}

/** 事务内共享内核（后台与 REST lock 段共用）：按 id+宿主 双条件取前缀行（归属校验即存在性） */
export async function lockPrefixRow(tx: DbTx, fid: number, prefixId: number) {
  const [row] = await tx
    .select()
    .from(forumPrefixes)
    .where(and(eq(forumPrefixes.id, prefixId), eq(forumPrefixes.forumId, fid)))
    .limit(1);
  return row ?? null;
}

/** 事务内共享内核（后台与 REST execute 段共用）：删除前缀行 + 审计 */
export async function applyForumRemovePrefix(
  tx: DbTx,
  actor: ForumActor,
  fid: number,
  row: typeof forumPrefixes.$inferSelect,
  trace?: ModerationApiTrace,
): Promise<{ ok: true }> {
  await tx.delete(forumPrefixes).where(eq(forumPrefixes.id, row.id));
  const extras = auditExtras(actor, trace);
  await writeAudit(tx, {
    actorId: actor.userId,
    action: "forum.prefix.remove",
    targetType: "forum",
    targetId: fid,
    before: { name: row.name },
    // 原实现无 after；仅 REST（有 via）时补一条带 via/trace 的 after，后台审计形态不变
    ...(Object.keys(extras).length > 0 ? { after: extras } : {}),
    ip: actor.ip,
  });
  return { ok: true as const };
}

export async function addPrefix(
  actor: ForumActor,
  fid: number,
  input: { name: string; sortOrder: number },
): Promise<{ ok: true } | { ok: false; code: ForumAdminError }> {
  const db = getWebDb();
  const result = await db.transaction(async (tx) => {
    const forum = await lockPrefixHost(tx, fid);
    if (!forum) return { ok: false as const, code: "not_found" as const };
    return applyForumAddPrefix(tx, actor, fid, input);
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
    const row = await lockPrefixRow(tx, fid, prefixId);
    if (!row) return { ok: false as const, code: "not_found" as const };
    return applyForumRemovePrefix(tx, actor, fid, row);
  });
  if (result.ok) invalidateAuthzSnapshot();
  return result;
}

// REST 写变体已拆至 api-writes.ts（M20.3 Step 4 棘轮拆分）；此处 re-export 维持 import 路径稳定。
export {
  FORUMS_DENIAL_HTTP,
  prepareApiForumCreate,
  prepareApiForumUpdate,
  prepareApiForumDelete,
  prepareApiForumAddPrefix,
  prepareApiForumRemovePrefix,
  type PreparedForumWrite,
} from "./api-writes";
