// @vitest-environment node
/**
 * 举报管理 REST 服务层集成测试（M20.3 Step 1）：
 * prepareApiReportHandle（prepare/lock/execute + 审计 + 通知）、REPORTS_DENIAL_HTTP 码表、
 * listReportsPage 筛选与分页、loadReportDetail 命中与 miss；后台 handleReport 路径零回归。
 * 注意：reports 唯一键 (post_id, reporter_id) = 同人同帖一次，各用例的造数组合互不重复。
 */
import "@/modules";
import { and, eq } from "drizzle-orm";
import { auditLog, DEMO, getWebDb, notifications, reports } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  handleReport,
  listReportsPage,
  loadReportDetail,
  prepareApiReportHandle,
  REPORTS_DENIAL_HTTP,
  type ApiReportHandleCode,
} from "./service";

let tdb: TempDb;
const db = () => getWebDb();
const API_ACTOR = { userId: DEMO.admin, via: "api" as const, ip: "203.0.113.10" };
const ADMIN_ACTOR = { userId: DEMO.admin, via: "admin" as const, ip: null };
const TRACE = { requestId: "req-report-1", tokenSuffix: "ab12" };

/** 造一条 pending 举报（挂种子帖，保证列表/详情 join 有数据；时间错开保证分页顺序稳定） */
async function seedReport(
  postId: number,
  reporterId: number,
  reason = "REST 域测试举报",
  at = "2026-05-04 10:00:00",
): Promise<number> {
  const [created] = (await db()
    .insert(reports)
    .values({ postId, reporterId, reason, createdAt: at })) as unknown as [{ insertId: number }];
  return Number(created.insertId);
}

/** 按 REST 管线形态跑 prepare → 事务(lock → execute) → afterCommit */
async function runPrepared(
  reportId: number,
  decision: "resolved" | "dismissed",
  note: string,
): Promise<
  | { ok: true; data: { reportId: number; decision: "resolved" | "dismissed" } }
  | { ok: false; code: ApiReportHandleCode }
> {
  const prepared = await prepareApiReportHandle(API_ACTOR, reportId, { decision, note }, TRACE);
  if (!prepared.ok) return prepared;
  return db().transaction(async (tx) => {
    const locked = await prepared.lock(tx);
    if (!locked.ok) return locked;
    const result = await locked.execute();
    if (result.ok) await result.afterCommit?.();
    return result;
  });
}

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("举报管理 REST 服务层（M20.3）", () => {
  it("REPORTS_DENIAL_HTTP 码表与拒绝码全集对齐", () => {
    expect(REPORTS_DENIAL_HTTP).toEqual({
      not_found: "not_found",
      bad_state: "state_conflict",
      note_required: "bad_request",
      note_too_long: "bad_request",
    });
  });

  it.each([
    {
      decision: "resolved" as const,
      postId: 900101,
      reporterId: DEMO.member,
      note: "已删除违规内容",
    },
    {
      decision: "dismissed" as const,
      postId: 900101,
      reporterId: DEMO.team,
      note: "经核实不构成违规",
    },
  ])(
    "pending 处置 $decision：状态+审计（含 API 追踪字段）+举报者通知一个不少",
    async ({ decision, postId, reporterId, note }) => {
      const reportId = await seedReport(postId, reporterId);
      const result = await runPrepared(reportId, decision, note);
      expect(result).toMatchObject({ ok: true, data: { reportId, decision } });

      // 状态迁移
      const [row] = await db().select().from(reports).where(eq(reports.id, reportId));
      expect(row.status).toBe(decision);
      expect(row.handledBy).toBe(DEMO.admin);
      expect(row.handledNote).toBe(note);
      expect(row.handledAt).not.toBeNull();

      // 审计：基础字段与后台同语义，API 路径另附 via=api + 追踪字段
      const [audit] = await db()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, `report.${decision}`), eq(auditLog.targetId, String(reportId))),
        );
      expect(audit).toBeDefined();
      expect(audit.afterJson).toEqual({
        postId,
        reporterId,
        note,
        via: "api",
        requestId: TRACE.requestId,
        tokenSuffix: TRACE.tokenSuffix,
      });

      // 举报者通知（类型恒为 report.resolved，说明随处置不同）
      const [notif] = await db()
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, reporterId), eq(notifications.targetId, reportId)));
      expect(notif).toBeDefined();
      expect(notif.type).toBe("report.resolved");
      expect(notif.dedupKey).toBe(`report:${reportId}:${reporterId}`);
      expect((notif.data as { note: string }).note).toBe(note);
      expect(notif.actorId).toBe(DEMO.admin);
    },
  );

  it("重复处置：prepare/lock 不判状态（幂等回放契约），状态拒绝统一在 execute；不存在 → not_found", async () => {
    const reportId = await seedReport(900102, DEMO.member);
    expect(await runPrepared(reportId, "resolved", "先处置")).toMatchObject({ ok: true });

    // 已处置报告上发起新意图（新键）：prepare/lock 均放行，由 execute 拒绝 bad_state
    const again = await prepareApiReportHandle(
      API_ACTOR,
      reportId,
      { decision: "dismissed", note: "重复" },
      TRACE,
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const againExecuted = await db().transaction(async (tx) => {
      const lockResult = await again.lock(tx);
      if (!lockResult.ok) return lockResult;
      return lockResult.execute();
    });
    expect(againExecuted).toEqual({
      ok: false,
      code: "bad_state",
      message: "举报已处理，不能重复处置",
    });

    // 锁内复验：prepare 通过后被后台抢先处理 → lock 放行（幂等契约：回放不判断状态），
    // 状态拒绝移到 execute——后台抢先处置后 API 不得重复落账
    const race = await seedReport(900103, DEMO.member);
    const prepared = await prepareApiReportHandle(
      API_ACTOR,
      race,
      { decision: "dismissed", note: "竞态用例" },
      TRACE,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await handleReport(ADMIN_ACTOR, race, "resolved", "后台抢先处理");
    const executed = await db().transaction(async (tx) => {
      const lockResult = await prepared.lock(tx);
      if (!lockResult.ok) return lockResult;
      return lockResult.execute();
    });
    expect(executed).toEqual({
      ok: false,
      code: "bad_state",
      message: "举报已处理，不能重复处置",
    });

    // 不存在的举报 → not_found
    expect(await runPrepared(99999999, "resolved", "不存在")).toEqual({
      ok: false,
      code: "not_found",
      message: "举报不存在",
    });
  });

  it("note 空与超长拒绝且不落任何写入；255 字边界可用（trim 后落库）", async () => {
    const id = await seedReport(900102, DEMO.team);
    expect(await runPrepared(id, "resolved", "   ")).toEqual({
      ok: false,
      code: "note_required",
      message: "必须填写处理说明",
    });
    expect(await runPrepared(id, "dismissed", "超".repeat(256))).toEqual({
      ok: false,
      code: "note_too_long",
      message: "处理说明太长（≤255 字）",
    });
    // 拒绝路径不产生状态迁移与审计
    const [untouched] = await db().select().from(reports).where(eq(reports.id, id));
    expect(untouched.status).toBe("pending");
    const audits = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, String(id)));
    expect(audits).toHaveLength(0);

    // 边界：trim 后恰 255 字可用，且 trim 生效（前后空白被去除）
    const note255 = `  ${"一".repeat(255)}  `;
    expect(note255.trim()).toHaveLength(255);
    expect(await runPrepared(id, "resolved", note255)).toMatchObject({ ok: true });
    const [after] = await db().select().from(reports).where(eq(reports.id, id));
    expect(after.handledNote).toHaveLength(255);
  });

  it("后台 handleReport 路径零回归：审计无 API 追踪字段；note 校验语义与后台码一致", async () => {
    const id = await seedReport(900103, DEMO.team);
    expect(await handleReport(ADMIN_ACTOR, id, "resolved", "后台处置")).toEqual({ ok: true });
    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "report.resolved"), eq(auditLog.targetId, String(id))));
    expect(audit.afterJson).toEqual({
      postId: 900103,
      reporterId: DEMO.team,
      note: "后台处置",
      via: "admin",
    });

    const id2 = await seedReport(900102, DEMO.alice);
    expect(await handleReport(ADMIN_ACTOR, id2, "dismissed", "超".repeat(256))).toEqual({
      ok: false,
      code: "note_too_long",
    });
    expect(await handleReport(ADMIN_ACTOR, id2, "resolved", "   ")).toEqual({
      ok: false,
      code: "note_required",
    });
    expect(await handleReport(ADMIN_ACTOR, id2, "resolved", "ok")).toEqual({ ok: true });
  });

  it("listReportsPage：状态筛选（省略=全部）、targetType 过滤与分页", async () => {
    const a = await seedReport(900101, DEMO.alice, "list-a", "2026-05-06 10:00:00");
    const b = await seedReport(900102, DEMO.xiaoyi, "list-b", "2026-05-06 11:00:00");
    const c = await seedReport(900103, DEMO.xiaoyi, "list-c", "2026-05-06 12:00:00");
    await runPrepared(b, "resolved", "处置一条");

    // 状态筛选：pending 不含已处置
    const pending = await listReportsPage({ status: "pending" }, 1);
    const pendingIds = pending.items.map((i) => i.id);
    expect(pendingIds).toContain(a);
    expect(pendingIds).toContain(c);
    expect(pendingIds).not.toContain(b);
    const resolved = await listReportsPage({ status: "resolved" }, 1);
    expect(resolved.items.map((i) => i.id)).toContain(b);
    expect(resolved.items.find((i) => i.id === b)?.handledBy).toBe(DEMO.admin);

    // 省略 status = 全部状态
    const all = await listReportsPage({}, 1, 50);
    const allIds = all.items.map((i) => i.id);
    expect(allIds).toContain(a);
    expect(allIds).toContain(b);
    const dismissed = await listReportsPage({ status: "dismissed" }, 1, 50);
    expect(all.total).toBe(pending.total + resolved.total + dismissed.total);

    // targetType：post 与缺省同结果；未知类型返回空页同型
    expect(await listReportsPage({ targetType: "post" }, 1, 50)).toMatchObject({
      total: all.total,
      page: 1,
    });
    expect(await listReportsPage({ targetType: "thread" }, 1)).toEqual({
      items: [],
      total: 0,
      page: 1,
      totalPages: 1,
    });

    // 分页：perPage=1 时 pending 首页/次页行不同，越界页码收束到最后一页
    expect(pending.total).toBeGreaterThanOrEqual(2);
    const p1 = await listReportsPage({ status: "pending" }, 1, 1);
    const p2 = await listReportsPage({ status: "pending" }, 2, 1);
    expect(p1.items).toHaveLength(1);
    expect(p1.totalPages).toBeGreaterThan(1);
    expect(p2.items[0]?.id).not.toBe(p1.items[0]?.id);
    const over = await listReportsPage({ status: "pending" }, 99, 1);
    expect(over.page).toBe(over.totalPages);
    expect(over.items[0]?.id).not.toBe(p1.items[0]?.id);
  });

  it("loadReportDetail：miss 为 null；命中含报告行+帖摘要+举报人+处置记录", async () => {
    expect(await loadReportDetail(99999999)).toBeNull();

    const id = await seedReport(900101, DEMO.xiaoyi, "detail 用例", "2026-05-07 09:00:00");
    const pendingDetail = await loadReportDetail(id);
    expect(pendingDetail).not.toBeNull();
    expect(pendingDetail).toMatchObject({
      id,
      postId: 900101,
      reason: "detail 用例",
      status: "pending",
      createdAt: "2026-05-07 09:00:00",
      reporter: { reporterId: DEMO.xiaoyi, reporterName: "demo_小翼" },
      target: {
        postId: 900101,
        threadId: 900001,
        threadTitle: "欢迎来到新青翼：FunWind 上线指南",
        threadState: "visible",
        postState: "visible",
        postAuthorId: DEMO.alice,
        postAuthorName: "demo_alice",
      },
    });
    // pending：无处置记录
    expect(pendingDetail!.handling).toBeNull();
    // 帖子摘要：正文前 80 字
    expect(pendingDetail!.target.excerpt).toContain("欢迎回来");

    // 处置后：handling 记录出现（处理人姓名可反查）
    await runPrepared(id, "dismissed", "忽略理由");
    const handled = await loadReportDetail(id);
    expect(handled!.status).toBe("dismissed");
    expect(handled!.handling).toMatchObject({
      handledBy: DEMO.admin,
      handledByName: "demo_admin",
      handledNote: "忽略理由",
      handledAt: expect.any(String),
    });
  });
});
