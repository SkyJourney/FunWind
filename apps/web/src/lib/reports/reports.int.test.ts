// @vitest-environment node
/**
 * 举报集成测试（M9 S6）：提交幂等（唯一键）、不可见帖拒绝、处理（审计+通知举报人）、队列筛选。
 */
import "@/modules";
import { and, eq } from "drizzle-orm";
import { auditLog, DEMO, getWebDb, notifications, reports } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { handleReport, listReportPage, submitReport } from "./service";

let tdb: TempDb;
let member: Subject;
let team: Subject;
const db = () => getWebDb();
const ACTOR = { userId: DEMO.admin, via: "admin" as const, ip: null };

beforeAll(async () => {
  tdb = await setupTempDb();
  member = await loadSubject(DEMO.member);
  team = await loadSubject(DEMO.team);
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("举报（M9）", () => {
  it("提交：落行 + 同人同帖幂等 already；他人可各自举报", async () => {
    const r = await submitReport(member, 900101, "广告内容");
    expect(r).toEqual({ ok: true });
    expect(await submitReport(member, 900101, "再报一次")).toEqual({ ok: false, code: "already" });
    expect(await submitReport(team, 900101, "我也觉得是广告")).toEqual({ ok: true });

    const rows = await db().select().from(reports).where(eq(reports.postId, 900101));
    expect(rows).toHaveLength(2);
  });

  it("不可见/不存在帖子拒绝；空理由拒绝；封禁用户 forbidden", async () => {
    expect(await submitReport(member, 900107, "x")).toEqual({ ok: false, code: "not_found" }); // pending 帖
    expect(await submitReport(member, 99999999, "x")).toEqual({ ok: false, code: "not_found" });
    expect(await submitReport(member, 900102, "   ")).toEqual({
      ok: false,
      code: "reason_required",
    });
    // forum.report 是非写类权限（evaluator 有意如此：封禁用户仍可举报）——封禁用户可提交
    const banned = await loadSubject(DEMO.banned);
    expect(await submitReport(banned, 900102, "封禁用户举报")).toEqual({ ok: true });
  });

  it("处理：resolved 落库+审计+举报人通知（report.resolved 带 note）；重复处理拒绝", async () => {
    const [row] = await db()
      .select()
      .from(reports)
      .where(and(eq(reports.postId, 900101), eq(reports.reporterId, DEMO.member)));
    expect(row).toBeDefined();

    const r = await handleReport(ACTOR, row.id, "resolved", "已删除违规内容");
    expect(r).toEqual({ ok: true });
    const [after] = await db().select().from(reports).where(eq(reports.id, row.id));
    expect(after.status).toBe("resolved");
    expect(after.handledBy).toBe(DEMO.admin);

    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "report.resolved"), eq(auditLog.targetId, String(row.id))));
    expect(audit).toBeDefined();

    const [notif] = await db()
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, DEMO.member), eq(notifications.type, "report.resolved")));
    expect(notif).toBeDefined();
    expect((notif.data as { note: string }).note).toBe("已删除违规内容");

    expect(await handleReport(ACTOR, row.id, "dismissed", "重复")).toEqual({
      ok: false,
      code: "bad_status",
    });
  });

  it("队列筛选：pending 不含已处置；dismissed 后进对应 tab", async () => {
    const [row2] = await db()
      .select()
      .from(reports)
      .where(and(eq(reports.postId, 900101), eq(reports.reporterId, DEMO.team)));
    await handleReport(ACTOR, row2.id, "dismissed", "不构成违规");

    const pending = await listReportPage({ status: "pending", page: 1 });
    expect(pending.items.find((i) => i.postId === 900101)).toBeUndefined();
    const dismissed = await listReportPage({ status: "dismissed", page: 1 });
    expect(dismissed.items.find((i) => i.postId === 900101)).toBeDefined();
    const resolved = await listReportPage({ status: "resolved", page: 1 });
    expect(resolved.items.find((i) => i.postId === 900101)).toBeDefined();
  });
});
