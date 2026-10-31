import { and, desc, eq, sql } from "drizzle-orm";
import { getWebDb, posts, reports, threads, users } from "@funwind/db";
import type { ConfigActor } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import { isDuplicateKey } from "@/lib/auth/register";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { sweepPending } from "@/lib/events/outbox";
import { notify } from "@/lib/notifications/notify";
import { publicUsername } from "@/lib/queries/public-identity";
import { pageBounds } from "@/lib/queries/paging";

/**
 * 举报（M9）：前台提交（唯一键 (post_id, reporter_id) 幂等——同人同帖一次）与后台处理。
 * 处理结果经 notify() 直接通知举报人（report.resolved，非事件链——处理是低频管理动作，
 * 直接通知即可；dedup 键按处理动作天然一次）。
 */

export type SubmitReportResult =
  | { ok: true }
  | { ok: false; code: "login" | "not_found" | "forbidden" | "already" | "reason_required" };

/** 举报确认页的数据仅在目标可读且可举报时返回；不可见对象与不存在统一视为 404。 */
export async function reportPostTarget(
  viewer: Subject,
  postId: number,
): Promise<{ threadId: number; title: string } | null> {
  if (viewer.userId === null) return null;
  const [post] = await getWebDb()
    .select({
      threadId: threads.id,
      title: threads.title,
      authorId: posts.authorId,
      state: posts.state,
      threadState: threads.state,
      forumId: threads.forumId,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(eq(posts.id, postId))
    .limit(1);
  if (
    !post ||
    post.state !== "visible" ||
    post.threadState !== "visible" ||
    post.authorId === viewer.userId ||
    !(await checkPermission(viewer, "forum.read", { forumId: post.forumId })).allowed ||
    !(await checkPermission(viewer, "forum.report", { forumId: post.forumId })).allowed
  ) {
    return null;
  }
  return { threadId: post.threadId, title: post.title };
}

/** 前台举报：服务端同时复核主题/回帖可见状态、版块读取范围和非本人目标。 */
export async function submitReport(
  viewer: Subject,
  postId: number,
  reason: string,
): Promise<SubmitReportResult> {
  if (viewer.userId === null) return { ok: false, code: "login" };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, code: "reason_required" };
  const [post] = await getWebDb()
    .select({
      id: posts.id,
      authorId: posts.authorId,
      state: posts.state,
      forumId: threads.forumId,
      threadState: threads.state,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(eq(posts.id, postId))
    .limit(1);
  if (
    !post ||
    post.state !== "visible" ||
    post.threadState !== "visible" ||
    post.authorId === viewer.userId
  ) {
    return { ok: false, code: "not_found" };
  }
  if (!(await checkPermission(viewer, "forum.read", { forumId: post.forumId })).allowed) {
    return { ok: false, code: "not_found" };
  }
  if (!(await checkPermission(viewer, "forum.report", { forumId: post.forumId })).allowed) {
    return { ok: false, code: "forbidden" };
  }

  try {
    await getWebDb().insert(reports).values({
      postId,
      reporterId: viewer.userId,
      reason: trimmed,
      createdAt: nowBeijingWallTime(),
    });
  } catch (e) {
    if (isDuplicateKey(e)) return { ok: false, code: "already" };
    throw e;
  }
  return { ok: true };
}

export type HandleReportResult =
  { ok: true } | { ok: false; code: "not_found" | "note_required" | "bad_status" };

/** 后台处理（resolved=已处置 / dismissed=忽略）；说明回给举报人通知 */
export async function handleReport(
  admin: ConfigActor & { userId: number },
  reportId: number,
  outcome: "resolved" | "dismissed",
  note: string,
): Promise<HandleReportResult> {
  const trimmed = note.trim();
  if (!trimmed) return { ok: false, code: "note_required" };
  if (outcome !== "resolved" && outcome !== "dismissed") return { ok: false, code: "bad_status" };

  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<HandleReportResult | null> => {
      const [row] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("update");
      if (!row) return { ok: false, code: "not_found" };
      if (row.status !== "pending") return { ok: false, code: "bad_status" };

      await tx
        .update(reports)
        .set({
          status: outcome,
          handledBy: admin.userId,
          handledNote: trimmed,
          handledAt: nowBeijingWallTime(),
        })
        .where(eq(reports.id, reportId));
      await writeAudit(tx, {
        actorId: admin.userId,
        action: `report.${outcome}`,
        targetType: "report",
        targetId: reportId,
        after: { postId: row.postId, reporterId: row.reporterId, note: trimmed, via: admin.via },
        ip: admin.ip,
      });
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (failure) return failure;

  // 通知举报人（非事件链——低频管理动作直发；dedup 键随处理动作天然一次）
  await notify({
    type: "report.resolved",
    recipients: [(await reportReporter(reportId))!],
    actorId: admin.userId,
    targetType: "report",
    targetId: reportId,
    dedupKey: (uid) => `report:${reportId}:${uid}`,
    data: { note: trimmed },
  });
  await sweepPending();
  return { ok: true };
}

async function reportReporter(reportId: number): Promise<number | null> {
  const [row] = await getWebDb()
    .select({ reporterId: reports.reporterId })
    .from(reports)
    .where(eq(reports.id, reportId));
  return row?.reporterId ?? null;
}

export interface ReportQueueItem {
  id: number;
  postId: number;
  threadId: number;
  threadTitle: string;
  reason: string;
  reporterName: string | null;
  status: string;
  createdAt: string;
}

/** 举报队列分页参数（M9.5）：状态 tab + 板块筛选 */
export type ReportPageFilters = {
  status: "pending" | "resolved" | "dismissed";
  forumId?: number;
  page: number;
  perPage?: number;
};

/** 举报队列（M9.5 改分页）：SQL where（状态 + 板块）+ COUNT，替代无上限拉取 */
export async function listReportPage(
  filters: ReportPageFilters,
): Promise<{ items: ReportQueueItem[]; total: number; page: number; totalPages: number }> {
  const perPage = filters.perPage ?? 20;
  const conds = [eq(reports.status, filters.status)];
  if (filters.forumId) conds.push(eq(threads.forumId, filters.forumId));
  const where = and(...conds);

  const [countRow] = await getWebDb()
    .select({ total: sql<number>`COUNT(*)` })
    .from(reports)
    .innerJoin(posts, eq(posts.id, reports.postId))
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(where);
  const total = Number(countRow?.total ?? 0);
  const { page, totalPages, offset } = pageBounds(total, filters.page, perPage);
  const rows = await getWebDb()
    .select({
      id: reports.id,
      postId: reports.postId,
      threadId: threads.id,
      threadTitle: threads.title,
      forumId: threads.forumId,
      reason: reports.reason,
      reporterName: publicUsername(users.username, users.state, users.id),
      status: reports.status,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .innerJoin(posts, eq(posts.id, reports.postId))
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .leftJoin(users, eq(users.id, reports.reporterId))
    .where(where)
    .orderBy(desc(reports.createdAt))
    .limit(perPage)
    .offset(offset);
  return { items: rows, total, page, totalPages };
}

/** 批量忽略（M9.5）：说明统一「经核实不构成违规」，逐条独立事务（部分成功反馈）；已处置/已忽略的行跳过 */
export async function dismissReportsBulk(
  admin: ConfigActor & { userId: number },
  reportIds: number[],
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const id of reportIds) {
    const r = await handleReport(admin, id, "dismissed", "经核实不构成违规");
    if (r.ok) ok += 1;
    else failed += 1;
  }
  return { ok, failed };
}
