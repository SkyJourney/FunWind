import { and, count, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { cache } from "react";
import {
  files,
  getWebDb,
  normalizeKey,
  pointAccounts,
  posts,
  threads,
  userProfiles,
  userRestrictions,
  userStats,
  users,
} from "@funwind/db";
import { findActiveGlobalBan, restrictionActive } from "@/lib/authz/restrictions";
import { getPointsName } from "@/lib/auth/settings";
import { getAuthzSnapshot } from "@/lib/authz/snapshot";
import { buildViewerScope, visiblePredicate } from "./visibility";
import { GUEST_SUBJECT, type Subject } from "@/lib/authz/types";
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
  /** 仅公开显示通用封禁标记，不含理由/期限 */
  ban: boolean;
}

export async function getProfile(
  uid: number,
  viewer: Subject = GUEST_SUBJECT,
): Promise<Profile | null> {
  const db = getWebDb();
  const [rows, activeProfileRestrictions, scope, { tree }] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        createdAt: users.createdAt,
        signatureMd: userProfiles.signatureMd,
        avatarKey: files.storageKey,
        pmPolicy: userProfiles.pmPolicy,
        followerCount: userStats.followerCount,
        points: pointAccounts.balance,
      })
      .from(users)
      .leftJoin(userProfiles, eq(userProfiles.userId, users.id))
      .leftJoin(files, eq(files.id, userProfiles.avatarFileId))
      .leftJoin(userStats, eq(userStats.userId, users.id))
      .leftJoin(pointAccounts, eq(pointAccounts.userId, users.id))
      .where(and(eq(users.id, uid), eq(users.state, "active")))
      .limit(1),
    db
      .select({ kind: userRestrictions.kind })
      .from(userRestrictions)
      .where(
        and(
          eq(userRestrictions.userId, uid),
          eq(userRestrictions.scopeId, 0),
          inArray(userRestrictions.kind, ["no_avatar", "no_signature"]),
          restrictionActive,
        ),
      ),
    buildViewerScope(viewer),
    getAuthzSnapshot(),
  ]);
  const r = rows[0];
  if (!r) return null;

  const restrictedKinds = new Set(activeProfileRestrictions.map((restriction) => restriction.kind));
  const listedForumIds = scope.readable.filter((id) => tree.get(id)?.isListed);
  let threadCount = 0;
  let postCount = 0;
  let featuredCount = 0;
  if (listedForumIds.length > 0) {
    const [threadRows, postRows] = await Promise.all([
      db
        .select({
          count: count(),
          featured: sql<number>`COALESCE(SUM(${threads.isFeatured}), 0)`.mapWith(Number),
        })
        .from(threads)
        .where(
          and(
            eq(threads.authorId, uid),
            eq(threads.state, "visible"),
            inArray(threads.forumId, listedForumIds),
          ),
        ),
      db
        .select({ count: count() })
        .from(posts)
        .innerJoin(threads, eq(threads.id, posts.threadId))
        .where(
          and(
            eq(posts.authorId, uid),
            eq(posts.state, "visible"),
            eq(threads.state, "visible"),
            inArray(threads.forumId, listedForumIds),
          ),
        ),
    ]);
    threadCount = Number(threadRows[0]?.count ?? 0);
    featuredCount = Number(threadRows[0]?.featured ?? 0);
    postCount = Number(postRows[0]?.count ?? 0);
  }

  return {
    ...r,
    signatureMd: restrictedKinds.has("no_signature") ? null : r.signatureMd,
    avatarKey: restrictedKinds.has("no_avatar") ? null : r.avatarKey,
    threadCount,
    postCount,
    featuredCount,
    followerCount: r.followerCount ?? 0,
    points: r.points ?? 0,
    pointsName: await getPointsName(),
    pmPolicy: r.pmPolicy ?? "all",
    ban: (await findActiveGlobalBan(uid)) !== null,
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
  const db = getWebDb();
  const [row] = await db
    .select({ key: files.storageKey })
    .from(userProfiles)
    .innerJoin(files, eq(files.id, userProfiles.avatarFileId))
    .where(
      and(
        eq(userProfiles.userId, userId),
        notExists(
          db
            .select({ id: userRestrictions.id })
            .from(userRestrictions)
            .where(
              and(
                eq(userRestrictions.userId, userProfiles.userId),
                eq(userRestrictions.kind, "no_avatar"),
                eq(userRestrictions.scopeId, 0),
                restrictionActive,
              ),
            ),
        ),
      ),
    )
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
  // 可见口径与 getUserThreads/首页流一致：只放 state='visible' 的公开回帖。
  // 注意：visiblePredicate 会给「作者本人」放开 pending/rejected、给「版主」放开 hidden/deleted——
  // 那是审核视角的特权，放在公开页会让已删除内容出现在全站可达 URL 上，故此处显式收紧。
  const base = and(
    visiblePredicate(
      { forumId: threads.forumId, state: posts.state, authorId: posts.authorId },
      scope,
    ),
    eq(posts.authorId, uid),
    eq(posts.state, "visible"),
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
