import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { cache } from "react";
import {
  files,
  getWebDb,
  normalizeKey,
  pointAccounts,
  posts,
  threads,
  userProfiles,
  userStats,
  users,
} from "@funwind/db";
import { findActiveGlobalBan } from "@/lib/authz/restrictions";
import { getPointsName } from "@/lib/auth/settings";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import { buildViewerScope, visiblePredicate } from "./visibility";
import type { Subject } from "@/lib/authz/types";
import { extractFeedMedia } from "./feed-media";
import { selectList, threadScope, toItem, type ThreadListItem } from "./threads";

/** 个人页数据。已注销账号（含迁移生成的“已注销用户”占位账号）不开页面：查询直接返回 null */

export interface Profile {
  id: number;
  username: string;
  createdAt: string;
  signatureMd: string | null;
  avatarKey: string | null;
  threadCount: number;
  postCount: number;
  featuredCount: number;
  /** 粉丝数（M8） */
  followerCount: number;
  points: number;
  /** 积分显示名（site_settings.points.name，默认“积分”，青翼导入后为“青翼币”） */
  pointsName: string;
  /** 私信权限（M10.5 功能补全）：all/following/off */
  pmPolicy: "all" | "following" | "off";
  ban: { reason: string; endsAt: string | null } | null;
}

export async function getProfile(uid: number): Promise<Profile | null> {
  const db = getWebDb();
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      createdAt: users.createdAt,
      signatureMd: userProfiles.signatureMd,
      avatarKey: files.storageKey,
      pmPolicy: userProfiles.pmPolicy,
      threadCount: userStats.threadCount,
      postCount: userStats.postCount,
      featuredCount: userStats.featuredCount,
      followerCount: userStats.followerCount,
      points: pointAccounts.balance,
    })
    .from(users)
    .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
    .leftJoin(files, eq(files.id, userProfiles.avatarFileId))
    .leftJoin(userStats, eq(userStats.userId, users.id))
    .leftJoin(pointAccounts, eq(pointAccounts.userId, users.id))
    .where(and(eq(users.id, uid), eq(users.state, "active")))
    .limit(1);
  const r = rows[0];
  if (!r) return null;

  return {
    ...r,
    threadCount: r.threadCount ?? 0,
    postCount: r.postCount ?? 0,
    featuredCount: r.featuredCount ?? 0,
    followerCount: r.followerCount ?? 0,
    points: r.points ?? 0,
    pointsName: await getPointsName(),
    pmPolicy: r.pmPolicy ?? "all",
    ban: await findActiveGlobalBan(uid),
  };
}

/**
 * 用户名 → 用户 id（管理动作按用户名定位；身份口径与登录一致：归一化键 username_key）。
 * 已注销（state≠active）账号不算命中；找不到返回 null。
 */
export async function findUserIdByName(username: string): Promise<number | null> {
  const [row] = await getWebDb()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.usernameKey, normalizeKey(username)), eq(users.state, "active")))
    .limit(1);
  return row?.id ?? null;
}

/** 头像存储键（请求级缓存：帖子页作者行最多 21 个作者，同一作者只查一次） */
export const avatarKeyOf = cache(async (userId: number): Promise<string | null> => {
  const [row] = await getWebDb()
    .select({ key: files.storageKey })
    .from(userProfiles)
    .innerJoin(files, eq(files.id, userProfiles.avatarFileId))
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return row?.key ?? null;
});

/* ===== 用户公开内容聚合（M10.5 S5-B2，docs/wireframes/profile.html） ===== */

export const USER_CONTENT_PER_PAGE = 10;

export interface UserContentPage<T> {
  items: T[];
  total: number;
  page: number;
  totalPages: number;
}

/**
 * 某用户的公开主题（公开页/我的页共用）。可见口径与首页内容流一致：
 * 观众可读 + 上目录 + visible——受限/不上目录版块的主题（含其版块名）不出现。
 */
export async function getUserThreads(
  viewer: Subject,
  uid: number,
  page: number,
): Promise<UserContentPage<ThreadListItem>> {
  const [scope, { tree }] = await Promise.all([buildViewerScope(viewer), getAuthzSnapshot()]);
  const listed = scope.readable.filter((id) => tree.get(id)?.isListed);
  const base = and(
    threadScope(scope),
    sql`${threads.authorId} = ${uid}`,
    eq(threads.state, "visible"),
    listed.length > 0 ? inArray(threads.forumId, listed) : sql`false`,
  )!;
  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(threads)
    .where(base);
  const total = Number(n);
  const totalPages = Math.max(1, Math.ceil(total / USER_CONTENT_PER_PAGE));
  const cur = Math.min(Math.max(1, page), totalPages);
  const rows = listed.length
    ? await selectList(base)
        .orderBy(desc(threads.lastPostedAt), desc(threads.id))
        .limit(USER_CONTENT_PER_PAGE)
        .offset((cur - 1) * USER_CONTENT_PER_PAGE)
    : [];
  return { items: rows.map((r) => toItem(r)), total, page: cur, totalPages };
}

export interface UserReplyItem {
  postId: number;
  threadId: number;
  threadTitle: string;
  floor: number;
  excerpt: string | null;
  createdAt: string;
}

/** 某用户的公开回复：帖子可见 + 所属主题可见且上目录；摘要取正文前 80 字。 */
export async function getUserReplies(
  viewer: Subject,
  uid: number,
  page: number,
): Promise<UserContentPage<UserReplyItem>> {
  const [scope, { tree }] = await Promise.all([buildViewerScope(viewer), getAuthzSnapshot()]);
  const listed = scope.readable.filter((id) => tree.get(id)?.isListed);
  const base = and(
    visiblePredicate(
      { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
      scope,
    ),
    eq(posts.authorId, uid),
    eq(threads.state, "visible"),
    listed.length > 0 ? inArray(threads.forumId, listed) : sql`false`,
  )!;
  const [{ n }] = await getWebDb()
    .select({ n: sql<number>`COUNT(*)` })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(base);
  const total = Number(n);
  const totalPages = Math.max(1, Math.ceil(total / USER_CONTENT_PER_PAGE));
  const cur = Math.min(Math.max(1, page), totalPages);
  const rows =
    listed.length > 0
      ? await getWebDb()
          .select({
            postId: posts.id,
            threadId: threads.id,
            threadTitle: threads.title,
            floor: posts.floor,
            bodyMd: posts.bodyMd,
            createdAt: posts.createdAt,
          })
          .from(posts)
          .innerJoin(threads, eq(threads.id, posts.threadId))
          .where(base)
          .orderBy(desc(posts.id))
          .limit(USER_CONTENT_PER_PAGE)
          .offset((cur - 1) * USER_CONTENT_PER_PAGE)
      : [];
  return {
    items: rows.map((r) => ({
      postId: r.postId,
      threadId: r.threadId,
      threadTitle: r.threadTitle,
      floor: r.floor,
      excerpt: r.bodyMd ? extractFeedMedia(r.bodyMd).excerpt : null,
      createdAt: r.createdAt,
    })),
    total,
    page: cur,
    totalPages,
  };
}
