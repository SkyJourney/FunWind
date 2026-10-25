import { and, eq } from "drizzle-orm";
import { cache } from "react";
import {
  files,
  getWebDb,
  normalizeKey,
  pointAccounts,
  userProfiles,
  userStats,
  users,
} from "@funwind/db";
import { findActiveGlobalBan } from "@/lib/authz/restrictions";
import { getPointsName } from "@/lib/auth/settings";

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
