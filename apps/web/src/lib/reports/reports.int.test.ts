// @vitest-environment node
/**
 * 举报集成测试（M9 S6）：提交幂等（唯一键）、不可见帖拒绝、处理（审计+通知举报人）、队列筛选。
 */
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import { auditLog, DEMO, getWebDb, notifications, reports, userRestrictions } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import type { Subject } from "@/lib/authz/types";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  dismissReportsBulk,
  handleReport,
  listReportPage,
  reportPostTarget,
  submitReport,
} from "./service";

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

  it("举报确认与提交均要求登录；不存在目标的确认页返回空", async () => {
    const guest = await loadSubject(null);
    expect(await reportPostTarget(guest, 900101)).toBeNull();
    expect(await submitReport(guest, 900101, "游客举报")).toEqual({ ok: false, code: "login" });
    expect(await reportPostTarget(member, 99999999)).toBeNull();
  });

  it("不可见/不存在帖子拒绝；空理由拒绝；全站封禁用户不能举报", async () => {
    expect(await submitReport(member, 900107, "x")).toEqual({ ok: false, code: "not_found" }); // pending 帖
    expect(await submitReport(member, 99999999, "x")).toEqual({ ok: false, code: "not_found" });
    expect(await submitReport(member, 900102, "   ")).toEqual({
      ok: false,
      code: "reason_required",
    });
    const banned = await loadSubject(DEMO.banned);
    expect(await submitReport(banned, 900102, "封禁用户举报")).toEqual({
      ok: false,
      code: "not_found",
    });
  });

  it("forum_ban 阻止读取被禁版块中的可举报对象，不影响其他版块", async () => {
    const reason = "m9.6-report-forum-ban";
    await db()
      .insert(userRestrictions)
      .values({
        userId: DEMO.member,
        kind: "forum_ban",
        scopeId: 901,
        reason,
        startsAt: sql`NOW()`,
        endsAt: null,
        createdBy: DEMO.admin,
        createdAt: sql`NOW()`,
      });
    try {
      const bannedMember = await loadSubject(DEMO.member);
      expect(await reportPostTarget(bannedMember, 900101)).toBeNull();
      expect(await reportPostTarget(bannedMember, 900102)).toMatchObject({ threadId: 900002 });
      expect(await submitReport(bannedMember, 900101, "禁入版块不能举报")).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(await submitReport(bannedMember, 900102, "其他版块仍可举报")).toEqual({ ok: true });
    } finally {
      await db()
        .delete(userRestrictions)
        .where(and(eq(userRestrictions.userId, DEMO.member), eq(userRestrictions.reason, reason)));
      await db()
        .delete(reports)
        .where(and(eq(reports.reporterId, DEMO.member), eq(reports.postId, 900102)));
    }
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

  it("dismissReportsBulk：批量忽略可用行，已处理行跳过并计数（M9.5）", async () => {
    // 造两条 pending：一条将被批量忽略、一条先手工处置制造「跳过」分支
    const mk = async (postId: number, reporterId: number) => {
      const [r] = (await db().insert(reports).values({
        postId,
        reporterId,
        reason: "批量测试",
        createdAt: "2026-05-03 10:00:00",
      })) as unknown as [{ insertId: number }];
      return Number(r.insertId);
    };
    const a = await mk(900201, DEMO.member);
    const b = await mk(900202, DEMO.team);
    await handleReport(ACTOR, b, "resolved", "先处置一条");

    const r = await dismissReportsBulk(ACTOR, [a, b]);
    expect(r).toEqual({ ok: 1, failed: 1 });
    // 行级断言（列表页按时间倒序分页，早时间行可能不在首页）
    // 批量忽略的说明是统一文案
    const [row] = await db().select().from(reports).where(eq(reports.id, a));
    expect(row.handledNote).toBe("经核实不构成违规");
  });
});
