import { forums, getWebDb, roleGrants } from "@funwind/db";
import { ForumTree, type ForumNode } from "@/lib/forums/forum-tree";
import { buildSnapshot, type AuthzSnapshot } from "./types";

/**
 * 规则快照加载器：版块树 + 全部授权行，常驻进程内存。
 * 失效途径：① 管理动作提交后显式 invalidateAuthzSnapshot()；② TTL 兜底（CLI 迁移/种子/其他进程改库的情形）。
 * 单实例语义——多实例部署前需换成共享失效通道（与频控同属 M13 的已知边界）。
 * 缓存挂在 globalThis：Next 的页面图与路由处理图是两份模块实例，必须共用同一份缓存与失效信号。
 */

const TTL_MS = 30_000;

interface Holder {
  value: Promise<AuthzSnapshot> | null;
  loadedAt: number;
}
const g = globalThis as unknown as { __fwAuthzSnapshot?: Holder };
const holder: Holder = (g.__fwAuthzSnapshot ??= { value: null, loadedAt: 0 });

async function load(): Promise<AuthzSnapshot> {
  const db = getWebDb();
  const [forumRows, grantRows] = await Promise.all([
    db
      .select({
        id: forums.id,
        parentId: forums.parentId,
        path: forums.path,
        depth: forums.depth,
        kind: forums.kind,
        name: forums.name,
        description: forums.description,
        iconKey: forums.iconKey,
        sortOrder: forums.sortOrder,
        readPolicy: forums.readPolicy,
        writePolicy: forums.writePolicy,
        reviewPolicy: forums.reviewPolicy,
        isListed: forums.isListed,
        isArchived: forums.isArchived,
      })
      .from(forums),
    db
      .select({
        roleKey: roleGrants.roleKey,
        permissionKey: roleGrants.permissionKey,
        scopeId: roleGrants.scopeId,
      })
      .from(roleGrants),
  ]);
  return buildSnapshot(new ForumTree(forumRows as ForumNode[]), grantRows);
}

export function getAuthzSnapshot(): Promise<AuthzSnapshot> {
  const now = Date.now();
  if (!holder.value || now - holder.loadedAt > TTL_MS) {
    const p = load();
    holder.value = p;
    holder.loadedAt = now;
    // 加载失败不缓存失败结果，下次请求重试
    p.catch(() => {
      if (holder.value === p) holder.value = null;
    });
  }
  return holder.value;
}

/** 管理动作（授权/版块/策略变更）提交后调用 */
export function invalidateAuthzSnapshot(): void {
  holder.value = null;
  holder.loadedAt = 0;
}

export async function getForumTree(): Promise<ForumTree> {
  return (await getAuthzSnapshot()).tree;
}
