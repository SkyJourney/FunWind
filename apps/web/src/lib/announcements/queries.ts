import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { announcementReads, announcements, getWebDb } from "@funwind/db";

/**
 * 公告展示页数据（M13 追加功能）：/a/{id} 详情 + /a 归档列表。
 *
 * 可见性口径与通知中心同源（validAnnouncementWhere）：
 *  · 有效期：NOW() ∈ [starts_at, ends_at]（ends_at 空为长期）；
 *  · 受众：audience=member 只对登录用户可见，游客只看 all；
 *  · 归档列表额外放行**已过期**的公告（否则下架公告的链接会变成死链——归档页是它的归宿）。
 * 读不到表（零表韧性：安装向导第 1 步之前）一律按「无公告」处理，不抛错。
 */

export interface AnnouncementDetail {
  id: number;
  title: string;
  bodyMd: string;
  level: "info" | "important";
  audience: "all" | "members";
  showBanner: boolean;
  startsAt: string;
  endsAt: string | null;
  createdAt: string;
}

export interface AnnouncementListItem {
  id: number;
  title: string;
  level: "info" | "important";
  startsAt: string;
  endsAt: string | null;
  /** 是否仍在有效期内（归档页据此标注「已结束」） */
  active: boolean;
}

function rowsOf<T>(result: unknown): T[] {
  const rows = (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as T[];
  return rows ?? [];
}

/** 公告详情：按 id 取（受众/有效期过滤；游客看不到 member-only 公告）。返回 null = 不存在或不可见。 */
export async function getAnnouncement(
  id: number,
  viewerLoggedIn: boolean,
): Promise<AnnouncementDetail | null> {
  console.log("[announcement-debug] getAnnouncement id=%d viewerLoggedIn=%s", id, viewerLoggedIn);
  try {
    const [row] = await getWebDb()
      .select({
        id: announcements.id,
        title: announcements.title,
        bodyMd: announcements.bodyMd,
        level: announcements.level,
        audience: announcements.audience,
        showBanner: announcements.showBanner,
        startsAt: announcements.startsAt,
        endsAt: announcements.endsAt,
        createdAt: announcements.createdAt,
      })
      .from(announcements)
      .where(
        and(
          eq(announcements.id, id),
          sql`${announcements.startsAt} <= NOW()`,
          sql`(${announcements.endsAt} IS NULL OR ${announcements.endsAt} > NOW())`,
          viewerLoggedIn ? undefined : eq(announcements.audience, "all"),
        ),
      )
      .limit(1);
    return row ?? null;
  } catch (e) {
    console.warn("[announcement] 读取公告失败:", e);
    return null;
  }
}

/** 公告归档列表：全部公告（含已过期——归档页是过期公告的归宿），按 id 倒序。 */
export async function listAnnouncements(
  viewerLoggedIn: boolean,
  limit = 50,
): Promise<AnnouncementListItem[]> {
  try {
    const result = await getWebDb().execute(sql`
      SELECT a.id AS id, a.title AS title, a.level AS level,
             a.starts_at AS startsAt, a.ends_at AS endsAt,
             (a.starts_at <= NOW() AND (a.ends_at IS NULL OR a.ends_at > NOW())) AS active
      FROM announcements a
      ${viewerLoggedIn ? sql`` : sql`WHERE a.audience = 'all'`}
      ORDER BY a.id DESC
      LIMIT ${limit}
    `);
    return rowsOf<Record<string, unknown>>(result).map((r) => ({
      id: Number(r.id),
      title: String(r.title),
      level: r.level as "info" | "important",
      startsAt: String(r.startsAt),
      endsAt: r.endsAt === null || r.endsAt === undefined ? null : String(r.endsAt),
      active: Number(r.active) === 1,
    }));
  } catch (e) {
    console.warn("[announcement] 读取公告列表失败:", e);
    return [];
  }
}

/** 该公告对当前用户是否已读（游客无已读状态恒 false）。 */
export async function isAnnouncementRead(
  announcementId: number,
  userId: number | null,
): Promise<boolean> {
  if (userId === null) return false;
  try {
    const [row] = await getWebDb()
      .select({ announcementId: announcementReads.announcementId })
      .from(announcementReads)
      .where(
        and(
          eq(announcementReads.userId, userId),
          eq(announcementReads.announcementId, announcementId),
        ),
      )
      .limit(1);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** 标记单条公告已读（详情页访问时调用——「看了详情即已读」）。游客与重复标记无副作用。 */
export async function markAnnouncementRead(
  announcementId: number,
  userId: number | null,
): Promise<void> {
  if (userId === null) return;
  try {
    await getWebDb()
      .insert(announcementReads)
      .values({ userId, announcementId, readAt: sql`NOW()` })
      .onDuplicateKeyUpdate({ set: { readAt: sql`NOW()` } });
  } catch (e) {
    console.warn("[announcement] 标记已读失败:", e);
  }
}
