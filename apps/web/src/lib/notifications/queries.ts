import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { announcementReads, announcements, getWebDb, notifications, users } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";

/**
 * 读取契约（M8，docs/NOTIFICATIONS.md §6）：unreadSummary / list / markRead。
 * 公告不逐人写行——读取时合并，已读状态在 announcement_reads。
 * 游标：createdAt 字符串（北京墙面时间，定长可比较）+ id 兜底在合并排序内实现；
 * 精简页的分页容忍同秒并列的极小偏差（记录于 M8 文档取舍）。
 */

export interface UnreadSummary {
  interaction: number;
  message: number;
  moderation: number;
  account: number;
  /** 未读的有效公告数（合并进总数） */
  announcement: number;
  total: number;
}

/** 有效公告：NOW() ∈ [starts_at, ends_at]（ends_at 空为长期）且受众匹配（游客只看 all） */
function validAnnouncementWhere(viewerLoggedIn: boolean) {
  return and(
    sql`${announcements.startsAt} <= NOW()`,
    sql`(${announcements.endsAt} IS NULL OR ${announcements.endsAt} > NOW())`,
    viewerLoggedIn ? undefined : eq(announcements.audience, "all"),
  );
}

export async function unreadSummary(userId: number | null): Promise<UnreadSummary> {
  const summary: UnreadSummary = {
    interaction: 0,
    message: 0,
    moderation: 0,
    account: 0,
    announcement: 0,
    total: 0,
  };
  if (userId !== null) {
    const rows = await getWebDb()
      .select({ category: notifications.category, n: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .groupBy(notifications.category);
    for (const r of rows) {
      const n = Number(r.n);
      if (r.category === "interaction") summary.interaction = n;
      else if (r.category === "message") summary.message = n;
      else if (r.category === "moderation") summary.moderation = n;
      else if (r.category === "account") summary.account = n;
    }
    // 公告未读 = 有效公告数 - 已读行数（读满即 0）
    const [valid] = await getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(announcements)
      .where(validAnnouncementWhere(true));
    const [read] = await getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(announcementReads)
      .where(eq(announcementReads.userId, userId));
    summary.announcement = Math.max(0, Number(valid?.n ?? 0) - Number(read?.n ?? 0));
  } else {
    // 游客：只有 audience=all 的公告，且无已读状态
    const [valid] = await getWebDb()
      .select({ n: sql<number>`COUNT(*)` })
      .from(announcements)
      .where(validAnnouncementWhere(false));
    summary.announcement = Number(valid?.n ?? 0);
  }
  summary.total =
    summary.interaction +
    summary.message +
    summary.moderation +
    summary.account +
    summary.announcement;
  return summary;
}

export type FeedCategory = "interaction" | "message" | "moderation" | "account" | "announcement";

export interface FeedItem {
  kind: "notification" | "announcement";
  id: number;
  category: FeedCategory;
  type: string;
  actorId: number | null;
  actorName: string | null;
  /** 已读：通知看 read_at；公告看 announcement_reads（游客恒未读） */
  read: boolean;
  createdAt: string;
  /** 渲染所需载荷 */
  data: Record<string, unknown> | null;
  title?: string;
  bodyMd?: string;
  targetType?: string;
  targetId?: number;
  groupKey?: string | null;
}

export interface ListOptions {
  category?: FeedCategory;
  /** 游标：上一页最后一项的 createdAt（严格小于取下一页） */
  before?: string;
  limit?: number;
}

const DEFAULT_LIST_LIMIT = 20;

/** 合并时间线：通知 + 有效公告，createdAt 降序（游标分页） */
export async function listFeed(
  userId: number | null,
  opts: ListOptions = {},
): Promise<{ items: FeedItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT), 50);
  const loggedIn = userId !== null;
  const notifCategory =
    opts.category !== undefined && opts.category !== "announcement" ? opts.category : undefined;

  const notifRows = loggedIn
    ? await getWebDb()
        .select({
          id: notifications.id,
          category: notifications.category,
          type: notifications.type,
          actorId: notifications.actorId,
          actorName: users.username,
          readAt: notifications.readAt,
          createdAt: notifications.createdAt,
          data: notifications.data,
          targetType: notifications.targetType,
          targetId: notifications.targetId,
          groupKey: notifications.groupKey,
        })
        .from(notifications)
        .leftJoin(users, eq(users.id, notifications.actorId))
        .where(
          and(
            eq(notifications.userId, userId),
            notifCategory ? eq(notifications.category, notifCategory) : undefined,
            opts.before ? lt(notifications.createdAt, opts.before) : undefined,
          ),
        )
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit)
    : [];

  const notifItems: FeedItem[] = notifRows.map((r) => ({
    kind: "notification" as const,
    id: r.id,
    category: r.category as FeedCategory,
    type: r.type,
    actorId: r.actorId,
    actorName: r.actorName,
    read: r.readAt !== null,
    createdAt: r.createdAt,
    data: (r.data ?? null) as Record<string, unknown> | null,
    targetType: r.targetType,
    targetId: r.targetId,
    groupKey: r.groupKey,
  }));

  // 公告只在「全部」与 announcement 分类时合并
  const includeAnnouncements = !notifCategory;
  const annItems: FeedItem[] = includeAnnouncements
    ? (
        await getWebDb()
          .select()
          .from(announcements)
          .where(
            and(
              validAnnouncementWhere(loggedIn),
              opts.before ? lt(announcements.createdAt, opts.before) : undefined,
            ),
          )
          .orderBy(desc(announcements.createdAt), desc(announcements.id))
          .limit(limit)
      ).map((a) => ({
        kind: "announcement" as const,
        id: a.id,
        category: "announcement" as const,
        type: "announcement",
        actorId: a.createdBy,
        actorName: null,
        read: loggedIn
          ? false // 已读状态在下方二次查询合并
          : false,
        createdAt: a.createdAt,
        data: null,
        title: a.title,
        bodyMd: a.bodyMd,
      }))
    : [];

  // 公告已读状态（登录用户）
  if (loggedIn && annItems.length > 0) {
    const readRows = await getWebDb()
      .select({ announcementId: announcementReads.announcementId })
      .from(announcementReads)
      .where(
        and(
          eq(announcementReads.userId, userId),
          inArray(
            announcementReads.announcementId,
            annItems.map((a) => a.id),
          ),
        ),
      );
    const readIds = new Set(readRows.map((r) => r.announcementId));
    for (const a of annItems) a.read = readIds.has(a.id);
  }

  const merged = [...notifItems, ...annItems]
    .sort((a, b) =>
      a.createdAt === b.createdAt ? b.id - a.id : b.createdAt < a.createdAt ? -1 : 1,
    )
    .slice(0, limit);

  const last = merged[merged.length - 1];
  return { items: merged, nextCursor: merged.length === limit && last ? last.createdAt : null };
}

/** 批量标记已读：通知按 ids / 分类 / 全部；公告写 announcement_reads */
export async function markRead(
  userId: number,
  scope: {
    ids?: readonly number[];
    category?: Exclude<FeedCategory, "announcement"> | "announcement";
    all?: boolean;
  },
): Promise<void> {
  const db = getWebDb();
  if (scope.ids !== undefined) {
    if (scope.ids.length === 0) return;
    await db
      .update(notifications)
      .set({ readAt: nowBeijingWallTime() })
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          inArray(notifications.id, [...scope.ids]),
        ),
      );
    return;
  }
  if (scope.category !== undefined && scope.category !== "announcement") {
    await db
      .update(notifications)
      .set({ readAt: nowBeijingWallTime() })
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          eq(notifications.category, scope.category),
        ),
      );
  }
  if (scope.all || scope.category === "announcement") {
    // 公告：给所有有效公告写已读行（幂等）
    const valid = await db
      .select({ id: announcements.id })
      .from(announcements)
      .where(validAnnouncementWhere(true));
    if (valid.length > 0) {
      await db
        .insert(announcementReads)
        .values(valid.map((a) => ({ userId, announcementId: a.id, readAt: nowBeijingWallTime() })))
        .onDuplicateKeyUpdate({ set: { readAt: sql`${announcementReads.readAt}` } });
    }
  }
}
