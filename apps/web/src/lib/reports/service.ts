import { and, desc, eq, gte, like, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { getWebDb, posts, reports, threads, users } from "@funwind/db";
import type { ConfigActor, DbTx } from "@/lib/audit";
import { writeAudit } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import { isDuplicateKey } from "@/lib/auth/register";
import { checkPermission } from "@/lib/authz/service";
import type { Subject } from "@/lib/authz/types";
import { POINTS_TX_OPTIONS, withDeadlockRetry } from "@/lib/points/retry";
import { sweepPending } from "@/lib/events/outbox";
import { notify } from "@/lib/notifications/notify";
import { publicUsername } from "@/lib/identity-expr";
import { pageBounds } from "@/lib/paging";
import type {
  ModerationApiTrace,
  ModerationWriteDenial,
  PreparedModerationWrite,
} from "@/lib/moderation/contents";

/**
 * 举报（M9）：前台提交（唯一键 (post_id, reporter_id) 幂等——同人同帖一次）与后台处理。
 * 处理结果经 notify() 直接通知举报人（report.resolved，非事件链——处理是低频管理动作，
 * 直接通知即可；dedup 键按处理动作天然一次）。
 * M20.3：处置抽为后台/REST 双入口共享内核（prepare/lock/execute），并补列表/详情读服务。
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
  | { ok: true }
  | { ok: false; code: "not_found" | "note_required" | "note_too_long" | "bad_status" };

// ============================================================
// 处置共享内核（M20.3）：后台 handleReport 与管理 REST prepareApiReportHandle
// 双入口共用同一写入/通知语义（沿用 moderation 域 applyThreadFlags 先例）。
// ============================================================

type ReportHandleDecision = "resolved" | "dismissed";

/** 处置说明约束（后台与 REST 同一规则）：trim 后必填，1–255 字（DB 列 varchar(255) 上限） */
function checkHandleNote(
  note: string,
): { ok: true; note: string } | { ok: false; code: "note_required" | "note_too_long" } {
  const trimmed = note.trim();
  if (!trimmed) return { ok: false, code: "note_required" };
  if (trimmed.length > 255) return { ok: false, code: "note_too_long" };
  return { ok: true, note: trimmed };
}

/** 锁内/事务内共享写入：状态迁移 + 审计；API 追踪字段仅在传入 trace 时附加（后台审计零变化） */
async function applyReportHandle(
  tx: DbTx,
  reportId: number,
  target: { postId: number; reporterId: number },
  decision: ReportHandleDecision,
  note: string,
  actor: ConfigActor & { userId: number },
  trace?: ModerationApiTrace,
): Promise<void> {
  await tx
    .update(reports)
    .set({
      status: decision,
      handledBy: actor.userId,
      handledNote: note,
      handledAt: nowBeijingWallTime(),
    })
    .where(eq(reports.id, reportId));
  await writeAudit(tx, {
    actorId: actor.userId,
    action: `report.${decision}`,
    targetType: "report",
    targetId: reportId,
    after: {
      postId: target.postId,
      reporterId: target.reporterId,
      note,
      via: actor.via,
      ...(trace ? { requestId: trace.requestId, tokenSuffix: trace.tokenSuffix } : {}),
    },
    ip: actor.ip,
  });
}

/**
 * 提交后通知举报人（通知类型恒为 report.resolved，说明随处置不同）。
 * 状态与审计已提交，通知故障只记日志，不得把本次处理伪报为失败。
 */
async function notifyReportHandled(
  reportId: number,
  outcome: ReportHandleDecision,
  note: string,
  actorId: number,
): Promise<void> {
  try {
    await notify({
      type: "report.resolved",
      recipients: [(await reportReporter(reportId))!],
      actorId,
      targetType: "report",
      targetId: reportId,
      dedupKey: (uid) => `report:${reportId}:${uid}`,
      data: { note },
    });
  } catch (error) {
    console.error(
      "[reports] 处理已提交，但举报结果通知失败:",
      { reportId, outcome, actorId },
      error,
    );
  }
  await sweepPending();
}

/** 后台处理（resolved=已处置 / dismissed=忽略）；说明回给举报人通知 */
export async function handleReport(
  admin: ConfigActor & { userId: number },
  reportId: number,
  outcome: "resolved" | "dismissed",
  note: string,
): Promise<HandleReportResult> {
  const noteCheck = checkHandleNote(note);
  if (!noteCheck.ok) return { ok: false, code: noteCheck.code };
  if (outcome !== "resolved" && outcome !== "dismissed") return { ok: false, code: "bad_status" };

  const failure = await withDeadlockRetry(() =>
    getWebDb().transaction(async (tx): Promise<HandleReportResult | null> => {
      const [row] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("update");
      if (!row) return { ok: false, code: "not_found" };
      if (row.status !== "pending") return { ok: false, code: "bad_status" };

      await applyReportHandle(tx, reportId, row, outcome, noteCheck.note, admin);
      return null;
    }, POINTS_TX_OPTIONS),
  );
  if (failure) return failure;

  await notifyReportHandled(reportId, outcome, noteCheck.note, admin.userId);
  return { ok: true };
}

// —— 管理 REST 写端点（M20.3 Step 1）：POST /reports/{id}/resolve、POST /reports/{id}/dismiss ——

export type ApiReportHandleInput = { decision: ReportHandleDecision; note: string };
export type ApiReportHandleData = { reportId: number; decision: ReportHandleDecision };
export type ApiReportHandleCode = "not_found" | "bad_state" | "note_required" | "note_too_long";
type PreparedApiReportHandle = PreparedModerationWrite<ApiReportHandleData, ApiReportHandleCode>;

/**
 * 业务拒绝码 → REST 信封码表（lib/manage/content-writes 的 DenialHttpMap 语义）：
 * 不存在 → 404；状态冲突（重复处置）→ 409；说明缺失/超长 → 400。
 */
export const REPORTS_DENIAL_HTTP: Record<string, string> = {
  not_found: "not_found",
  bad_state: "state_conflict",
  note_required: "bad_request",
  note_too_long: "bad_request",
};

/**
 * 举报处置（Pending → resolved/dismissed）的 prepare/lock/execute 内核：
 * 事务外 prepare 校验说明与存在性/pending 预检 → 幂等事务（REST 管线提供）内 lock 用 FOR UPDATE
 * 复验仍 pending（竞态以锁内为准）→ execute 走共享 applyReportHandle 完成状态迁移与审计，
 * afterCommit 通知举报人。与后台 handleReport 完全同语义：审计字段与举报者通知一个不少。
 */
export async function prepareApiReportHandle(
  actor: ConfigActor,
  reportId: number,
  input: ApiReportHandleInput,
  trace: ModerationApiTrace,
): Promise<PreparedApiReportHandle | ModerationWriteDenial<ApiReportHandleCode>> {
  const notFound: ModerationWriteDenial<ApiReportHandleCode> = {
    ok: false,
    code: "not_found",
    message: "举报不存在",
  };
  // handledBy/审计 actorId 需要具体用户；API 操作者恒为 token 持有人
  if (actor.userId === null) return notFound;
  const noteCheck = checkHandleNote(input.note);
  if (!noteCheck.ok) {
    return {
      ok: false,
      code: noteCheck.code,
      message: noteCheck.code === "note_required" ? "必须填写处理说明" : "处理说明太长（≤255 字）",
    };
  }
  // 事务外预检只核验存在性（无锁快照）：状态裁决统一在 execute——幂等回放会在
  // prepare/lock 之后命中缓存结果，任何一处提前判状态都会把合法回放误拒为 409。
  const [row] = await getWebDb()
    .select({ id: reports.id })
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);
  if (!row) return notFound;
  const apiActor: ConfigActor & { userId: number } = { ...actor, userId: actor.userId };

  return {
    ok: true,
    async lock(tx) {
      // 锁内只核验目标存在与归属；pending 状态检查移到 execute——幂等回放命中时
      // 首次执行已把报告处置完毕，此处若再判状态会把合法回放误拒为 409。
      const [locked] = await tx
        .select({ postId: reports.postId, reporterId: reports.reporterId, status: reports.status })
        .from(reports)
        .where(eq(reports.id, reportId))
        .for("update");
      if (!locked) return notFound;
      return {
        ok: true,
        async execute() {
          if (locked.status !== "pending") {
            return { ok: false, code: "bad_state", message: "举报已处理，不能重复处置" };
          }
          await applyReportHandle(
            tx,
            reportId,
            locked,
            input.decision,
            noteCheck.note,
            apiActor,
            trace,
          );
          return {
            ok: true,
            data: { reportId, decision: input.decision },
            async afterCommit() {
              await notifyReportHandled(reportId, input.decision, noteCheck.note, apiActor.userId);
            },
          };
        },
      };
    },
  };
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
  reporterId: number;
  threadId: number;
  threadTitle: string;
  reason: string;
  reporterName: string | null;
  status: string;
  createdAt: string;
  handledBy: number | null;
  handledNote: string | null;
  handledAt: string | null;
}

/** 举报队列分页参数（M9.5；M19 S4 加关键词与日期范围）：
 *  状态 tab（M20.3 起可省略 = 全部状态，后台页面恒传具体状态）+ 板块 +
 *  被举报内容标题关键词 + 举报时间范围（idx_reports_status 支撑状态+时间） */
export type ReportPageFilters = {
  status?: "pending" | "resolved" | "dismissed";
  forumId?: number;
  /** 被举报内容标题关键词（包含匹配） */
  q?: string;
  /** 举报时间下界（含） */
  since?: string;
  /** 举报时间上界（含当天——调用方传 `${date} 23:59:59`） */
  until?: string;
  page: number;
  perPage?: number;
};

/** 举报队列（M9.5 改分页）：SQL where（状态 + 板块 + 关键词 + 时间）+ COUNT，替代无上限拉取 */
export async function listReportPage(
  filters: ReportPageFilters,
): Promise<{ items: ReportQueueItem[]; total: number; page: number; totalPages: number }> {
  const perPage = filters.perPage ?? 20;
  const conds = [];
  if (filters.status) conds.push(eq(reports.status, filters.status));
  if (filters.forumId) conds.push(eq(threads.forumId, filters.forumId));
  const q = filters.q?.trim();
  if (q) conds.push(like(threads.title, `%${q}%`));
  if (filters.since) conds.push(gte(reports.createdAt, filters.since));
  if (filters.until) conds.push(lte(reports.createdAt, filters.until));
  const where = conds.length > 0 ? and(...conds) : undefined;

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
      reporterId: reports.reporterId,
      threadId: threads.id,
      threadTitle: threads.title,
      forumId: threads.forumId,
      reason: reports.reason,
      reporterName: publicUsername(users.username, users.state, users.id),
      status: reports.status,
      createdAt: reports.createdAt,
      handledBy: reports.handledBy,
      handledNote: reports.handledNote,
      handledAt: reports.handledAt,
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

// —— 管理 REST 读端点（M20.3 Step 1）：GET /reports ——

/** 管理举报列表筛选：状态可选（缺省 = 全部状态） */
export type ReportApiListFilters = {
  status?: "pending" | "resolved" | "dismissed";
  /** 举报目标类型；reports 现只挂帖子（post），其余值按无数据返回空页 */
  targetType?: string;
};

/** 管理举报列表（M20.3）：与后台队列同源查询层（listReportPage）的参数化复用 */
export async function listReportsPage(
  filters: ReportApiListFilters,
  page: number,
  perPage?: number,
): Promise<{ items: ReportQueueItem[]; total: number; page: number; totalPages: number }> {
  if (filters.targetType !== undefined && filters.targetType !== "post") {
    // 举报目标类型只有帖子一种，未知类型没有对应数据行，与空队列同型返回
    return { items: [], total: 0, page: 1, totalPages: 1 };
  }
  return listReportPage({ status: filters.status, page, perPage });
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

// —— 管理 REST 读端点（M20.3 Step 1）：GET /reports/{id} ——

/** 举报详情（报告行 + 被举报帖摘要 + 举报人 + 处置记录） */
export type ReportDetail = {
  id: number;
  postId: number;
  reason: string;
  status: string;
  createdAt: string;
  reporter: {
    reporterId: number;
    reporterName: string | null;
  };
  /** 被举报帖摘要（正文截前 80 字） */
  target: {
    postId: number;
    threadId: number;
    threadTitle: string;
    threadState: string;
    forumId: number;
    postState: string;
    postAuthorId: number;
    postAuthorName: string | null;
    excerpt: string | null;
    postCreatedAt: string;
  };
  /** 处置记录：pending（未处置）为 null */
  handling: {
    handledBy: number;
    handledByName: string | null;
    handledNote: string;
    handledAt: string;
  } | null;
};

/**
 * 举报行级详情（M20.3，管理 API 用；后台页面无详情路由）。
 * 帖子被硬删时随 innerJoin 一起 miss（与队列列表同语义；本系统删帖为软删 state，行仍在）。
 */
export async function loadReportDetail(reportId: number): Promise<ReportDetail | null> {
  const handler = alias(users, "report_handler");
  const author = alias(users, "report_post_author");
  const [row] = await getWebDb()
    .select({
      id: reports.id,
      postId: reports.postId,
      reason: reports.reason,
      status: reports.status,
      createdAt: reports.createdAt,
      reporterId: reports.reporterId,
      reporterName: publicUsername(users.username, users.state, users.id),
      handledBy: reports.handledBy,
      handledByName: publicUsername(handler.username, handler.state, handler.id),
      handledNote: reports.handledNote,
      handledAt: reports.handledAt,
      threadId: threads.id,
      threadTitle: threads.title,
      threadState: threads.state,
      forumId: threads.forumId,
      postState: posts.state,
      postAuthorId: posts.authorId,
      postAuthorName: publicUsername(author.username, author.state, author.id),
      excerpt: sql<string | null>`SUBSTRING(${posts.bodyMd}, 1, 80)`,
      postCreatedAt: posts.createdAt,
    })
    .from(reports)
    .innerJoin(posts, eq(posts.id, reports.postId))
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .leftJoin(users, eq(users.id, reports.reporterId))
    .leftJoin(handler, eq(handler.id, reports.handledBy))
    .leftJoin(author, eq(author.id, posts.authorId))
    .where(eq(reports.id, reportId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    postId: row.postId,
    reason: row.reason,
    status: row.status,
    createdAt: row.createdAt,
    reporter: { reporterId: row.reporterId, reporterName: row.reporterName },
    target: {
      postId: row.postId,
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      threadState: row.threadState,
      forumId: row.forumId,
      postState: row.postState,
      postAuthorId: row.postAuthorId,
      postAuthorName: row.postAuthorName,
      excerpt: row.excerpt,
      postCreatedAt: row.postCreatedAt,
    },
    // handledAt 非空即视为已有处置记录（handleReport 同事务写齐 handledBy/note/at）
    handling: row.handledAt
      ? {
          handledBy: row.handledBy ?? 0,
          handledByName: row.handledByName,
          handledNote: row.handledNote ?? "",
          handledAt: row.handledAt,
        }
      : null,
  };
}
