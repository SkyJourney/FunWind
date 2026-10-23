import type { ReadPolicy, WritePolicy } from "@funwind/db";
import { GUEST_GID, isScopedRole, MEMBER_GIDS, parseGidList, roleOfGid } from "./legacy-groups.js";

export interface OldForum {
  fid: number;
  parentid: number;
  type: string;
  name: string;
  descrip: string | null;
  vieworder: number;
  isshow: number;
  icon: string | null;
  allow_read: string | null;
  allow_post: string | null;
  allow_reply: string | null;
}

export interface ForumRow {
  id: number;
  parentId: number;
  path: string;
  depth: number;
  kind: "section" | "forum";
  name: string;
  description: string | null;
  icon: string;
  sortOrder: number;
  readPolicy: ReadPolicy;
  writePolicy: WritePolicy;
  isListed: boolean;
  isArchived: boolean;
}

export interface ForumScopeGrant {
  roleKey: string;
  permissionKey: "forum.read" | "forum.write";
  scopeId: number;
}

export interface ForumTransformResult {
  forums: ForumRow[];
  /** 仅 restricted 版块需要：团队角色在该版块作用域的读/写授权 */
  grants: ForumScopeGrant[];
  stats: {
    styledNames: number;
    archived: number;
    orphanParents: number[];
    cycles: number[];
    /** 白名单里出现、但没有对应角色的旧 gid → 出现的版块次数 */
    unmappedGids: Map<number, number>;
  };
}

/**
 * 读策略：旧站「空白名单 = 不限制」，但实测 43 个版块全部配置，故空值也只是 inherit。
 * 含游客组 → public；含任一会员组 → members；否则 restricted（只有团队/管理员）。
 */
export function deriveReadPolicy(gids: readonly number[]): ReadPolicy {
  if (gids.length === 0) return "inherit";
  if (gids.includes(GUEST_GID)) return "public";
  if (gids.some((g) => MEMBER_GIDS.has(g))) return "members";
  return "restricted";
}

/** 写策略：发帖与回复白名单取并集；含任一会员组即沿用默认（inherit），否则 restricted */
export function deriveWritePolicy(gids: readonly number[]): WritePolicy {
  if (gids.length === 0) return "inherit";
  if (gids.some((g) => MEMBER_GIDS.has(g))) return "inherit";
  return "restricted";
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").trim();

export function transformForums(rows: readonly OldForum[]): ForumTransformResult {
  const byId = new Map(rows.map((r) => [Number(r.fid), r]));
  const resolved = new Map<number, { path: string; depth: number }>();
  const orphanParents: number[] = [];
  const cycles: number[] = [];

  /** 沿父链求 path/depth；父不存在或成环时降级为根并记录 */
  const resolve = (fid: number, seen: Set<number>): { path: string; depth: number } => {
    const hit = resolved.get(fid);
    if (hit) return hit;
    const row = byId.get(fid)!;
    const parent = Number(row.parentid);
    let out: { path: string; depth: number };
    if (parent === 0) {
      out = { path: `/${fid}/`, depth: 1 };
    } else if (!byId.has(parent)) {
      orphanParents.push(fid);
      out = { path: `/${fid}/`, depth: 1 };
    } else if (seen.has(parent)) {
      cycles.push(fid);
      out = { path: `/${fid}/`, depth: 1 };
    } else {
      const p = resolve(parent, new Set([...seen, fid]));
      out = { path: `${p.path}${fid}/`, depth: p.depth + 1 };
    }
    resolved.set(fid, out);
    return out;
  };

  const forums: ForumRow[] = [];
  const grants: ForumScopeGrant[] = [];
  const unmappedGids = new Map<number, number>();
  let styledNames = 0;
  let archived = 0;

  for (const r of [...rows].sort((a, b) => Number(a.fid) - Number(b.fid))) {
    const id = Number(r.fid);
    const { path, depth } = resolve(id, new Set([id]));
    const rawName = String(r.name ?? "");
    const name = stripTags(rawName);
    if (name !== rawName.trim()) styledNames++;

    const readGids = parseGidList(r.allow_read);
    const writeGids = [...new Set([...parseGidList(r.allow_post), ...parseGidList(r.allow_reply)])];
    const readPolicy = deriveReadPolicy(readGids);
    const writePolicy = deriveWritePolicy(writeGids);
    const isArchived = name.includes("回收站");
    if (isArchived) archived++;

    forums.push({
      id,
      parentId: orphanParents.includes(id) || cycles.includes(id) ? 0 : Number(r.parentid),
      path,
      depth,
      kind: r.type === "category" ? "section" : "forum",
      name,
      description: r.descrip ? String(r.descrip) : null,
      icon: r.icon ?? "",
      sortOrder: Number(r.vieworder ?? 0),
      readPolicy,
      writePolicy,
      isListed: Number(r.isshow ?? 1) > 0,
      isArchived,
    });

    // restricted 版块：白名单里的团队角色获得该版块作用域授权（admin 在评估器中短路，不需要）
    const addGrants = (
      gids: readonly number[],
      permissionKey: ForumScopeGrant["permissionKey"],
    ) => {
      const seen = new Set<string>();
      for (const gid of gids) {
        const roleKey = roleOfGid(gid);
        if (!roleKey) {
          unmappedGids.set(gid, (unmappedGids.get(gid) ?? 0) + 1);
          continue;
        }
        if (!isScopedRole(roleKey) || seen.has(roleKey)) continue;
        seen.add(roleKey);
        grants.push({ roleKey, permissionKey, scopeId: id });
      }
    };
    if (readPolicy === "restricted") addGrants(readGids, "forum.read");
    if (writePolicy === "restricted") addGrants(writeGids, "forum.write");
  }

  return {
    forums,
    grants,
    stats: { styledNames, archived, orphanParents, cycles, unmappedGids },
  };
}
