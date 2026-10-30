import { and, eq, inArray, sql } from "drizzle-orm";
import { files, forums, getWebDb, userProfiles, userRestrictions, users } from "@funwind/db";
import { restrictionActive } from "@/lib/authz/restrictions";
import { publicUserDeleted } from "./public-identity";
import { checkPermission, getReadableForumIds } from "@/lib/authz/service";
import { loadSubject } from "@/lib/authz/subject";

/**
 * 关注列表（M10.6d 站长反馈：关注动态页缺「关注了什么」管理区）：
 * 返回当前用户关注的板块与用户两张列表（名字+链接+头像键），供就地取关与管理跳转。
 */

export interface FollowedForumItem {
  id: number;
  name: string;
  threadCount: number;
}

export interface FollowedUserItem {
  id: number;
  username: string;
  avatarKey: string | null;
}

export async function followedLists(
  userId: number,
  forumIds: readonly number[],
  userIds: readonly number[],
): Promise<{ forums: FollowedForumItem[]; users: FollowedUserItem[] }> {
  const db = getWebDb();
  const viewer = await loadSubject(userId);
  if (viewer.userId === null || !(await checkPermission(viewer, "site.visit")).allowed) {
    return { forums: [], users: [] };
  }
  const readable = new Set(await getReadableForumIds(viewer));
  const visibleForumIds = forumIds.filter((id) => readable.has(id));

  const forumRows = visibleForumIds.length
    ? await db
        .select({ id: forums.id, name: forums.name, threadCount: forums.threadCount })
        .from(forums)
        .where(inArray(forums.id, visibleForumIds))
    : [];
  const order = new Map(visibleForumIds.map((id, i) => [id, i]));
  const forumItems = forumRows
    .map((r) => ({ ...r, threadCount: r.threadCount ?? 0 }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const userRows = userIds.length
    ? await db
        .select({
          id: users.id,
          username: users.username,
          avatarKey: sql<string | null>`CASE WHEN EXISTS (
            SELECT 1 FROM ${userRestrictions}
             WHERE ${userRestrictions.userId} = ${users.id}
               AND ${userRestrictions.kind} = 'no_avatar'
               AND ${userRestrictions.scopeId} = 0
               AND ${restrictionActive}
          ) THEN NULL ELSE ${files.storageKey} END`,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .leftJoin(files, eq(files.id, userProfiles.avatarFileId))
        .where(
          and(
            inArray(users.id, [...userIds]),
            eq(users.state, "active"),
            sql`NOT ${publicUserDeleted(users.id, users.state)}`,
          )!,
        )
    : [];
  const uOrder = new Map(userIds.map((id, i) => [id, i]));
  const userItems = userItemsSort(userRows, uOrder);

  return { forums: forumItems, users: userItems };
}

function userItemsSort(
  rows: { id: number; username: string; avatarKey: string | null }[],
  order: Map<number, number>,
) {
  return rows
    .map((r) => ({ id: r.id, username: r.username, avatarKey: r.avatarKey ?? null }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
