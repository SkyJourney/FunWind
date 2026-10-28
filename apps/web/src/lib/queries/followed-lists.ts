import { eq, inArray } from "drizzle-orm";
import { files, forums, getWebDb, userProfiles, users } from "@funwind/db";

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

  const forumRows = forumIds.length
    ? await db
        .select({ id: forums.id, name: forums.name, threadCount: forums.threadCount })
        .from(forums)
        .where(inArray(forums.id, [...forumIds]))
    : [];
  const order = new Map(forumIds.map((id, i) => [id, i]));
  const forumItems = forumRows
    .map((r) => ({ ...r, threadCount: r.threadCount ?? 0 }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const userRows = userIds.length
    ? await db
        .select({
          id: users.id,
          username: users.username,
          avatarKey: files.storageKey,
        })
        .from(users)
        .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
        .leftJoin(files, eq(files.id, userProfiles.avatarFileId))
        .where(inArray(users.id, [...userIds]))
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
