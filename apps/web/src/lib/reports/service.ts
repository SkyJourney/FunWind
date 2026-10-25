import { desc, eq } from "drizzle-orm";
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

/**
 * 举报（M9）：前台提交（唯一键 (post_id, reporter_id) 幂等——同人同帖一次）与后台处理。
 * 处理结果经 notify() 直接通知举报人（report.resolved，非事件链——处理是低频管理动作，
 * 直接通知即可；dedup 键按处理动作天然一次）。
 */

export type SubmitReportResult =
  | { ok: true }
  | { ok: false; code: "login" | "not_found" | "forbidden" | "already" | "reason_required" };

/** 前台举报：member 基线权限 forum.report；帖子必须存在且可见（不可见内容举报无意义且泄露存在性） */
export async function submitReport(
  viewer: Subject,
  postId: number,
  reason: string,
): Promise<SubmitReportResult> {
  if (viewer.userId === null) return { ok: false, code: "login" };
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, code: "reason_required" };
  if (!(await checkPermission(viewer, "forum.report")).allowed) {
    return { ok: false, code: "forbidden" };
  }
  const [post] = await getWebDb()
    .select({ id: posts.id, state: posts.state })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  if (!post || post.state !== "visible") return { ok: false, code: "not_found" };

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

/** 举报队列（后台，按状态筛选） */
export async function reportQueue(
  status: "pending" | "resolved" | "dismissed",
  limit = 50,
): Promise<ReportQueueItem[]> {
  const rows = await getWebDb()
    .select({
      id: reports.id,
      postId: reports.postId,
      threadId: threads.id,
      threadTitle: threads.title,
      reason: reports.reason,
      reporterName: users.username,
      status: reports.status,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .innerJoin(posts, eq(posts.id, reports.postId))
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .leftJoin(users, eq(users.id, reports.reporterId))
    .where(eq(reports.status, status))
    .orderBy(desc(reports.createdAt))
    .limit(limit);
  return rows;
}
