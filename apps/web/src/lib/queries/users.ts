import { and, eq } from "drizzle-orm";
import {
  files,
  getWebDb,
  pointAccounts,
  siteSettings,
  userProfiles,
  userStats,
  users,
} from "@funwind/db";
import { findActiveGlobalBan } from "@/lib/authz/restrictions";

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

  const [nameRow] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, "points.name"))
    .limit(1);
  const pointsName = (nameRow?.value as { name?: string } | undefined)?.name ?? "积分";

  return {
    ...r,
    threadCount: r.threadCount ?? 0,
    postCount: r.postCount ?? 0,
    featuredCount: r.featuredCount ?? 0,
    points: r.points ?? 0,
    pointsName,
    ban: await findActiveGlobalBan(uid),
  };
}
