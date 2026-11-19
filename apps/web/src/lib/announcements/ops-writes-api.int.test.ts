// @vitest-environment node
/**
 * 运营日常 REST 服务层集成测试（M20.3 Step 3）：
 * 公告 prepareApiAnnouncementCreate/Edit/End（条件审计、not_found、published 事件）、
 * 活动 prepareApiCampaignCreate/Update/Enabled（revision 冲突在 execute、同值启停零变更）、
 * 邀请码 prepareApiInviteGenerate/Revoke/RevokeByBatch（已用拒绝、批次空撤 not_found）。
 * 幂等契约：可变状态裁决统一在 execute；审计 trace 仅 REST 传入时附加。
 * 后台入口 createAnnouncement/editAnnouncement/endAnnouncement、createCampaign 系列零回归。
 */
import "@/modules";
import { eq, sql } from "drizzle-orm";
import { announcements, auditLog, DEMO, getWebDb, inviteCodes } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import type { ConfigActor } from "@/lib/audit";
import { nowBeijingWallTime } from "@/lib/datetime";
import {
  ANNOUNCEMENTS_DENIAL_HTTP,
  createAnnouncement,
  editAnnouncement,
  endAnnouncement,
  listAnnouncementsPage,
  loadAnnouncementDetail,
  prepareApiAnnouncementCreate,
  prepareApiAnnouncementEdit,
  prepareApiAnnouncementEnd,
} from "@/lib/announcements/service";
import {
  CAMPAIGNS_DENIAL_HTTP,
  createCampaign,
  prepareApiCampaignCreate,
  prepareApiCampaignEnabled,
  prepareApiCampaignUpdate,
} from "@/lib/campaigns/admin";
import {
  INVITES_DENIAL_HTTP,
  generateInvites,
  prepareApiInviteGenerate,
  prepareApiInviteRevoke,
  prepareApiInviteRevokeByBatch,
  revokeInvite,
  type PreparedInviteWrite,
} from "@/lib/admin/invites";
import type { CampaignFields } from "@/lib/campaigns/input";

let tdb: TempDb;
const db = () => getWebDb();
const ADMIN: ConfigActor = { userId: DEMO.admin, via: "admin", ip: null };
const API_ACTOR: ConfigActor = { userId: DEMO.admin, via: "api", ip: "203.0.113.10" };
const TRACE = { requestId: "req-ops-1", tokenSuffix: "ef56" };

/** 按 REST 幂等管线形态跑 prepare → 事务(lock → execute) → 提交后 afterCommit */
async function runPrepared(
  prepared:
    | Awaited<ReturnType<typeof prepareApiAnnouncementCreate>>
    | Awaited<ReturnType<typeof prepareApiAnnouncementEdit>>
    | Awaited<ReturnType<typeof prepareApiAnnouncementEnd>>
    | Awaited<ReturnType<typeof prepareApiCampaignCreate>>
    | Awaited<ReturnType<typeof prepareApiCampaignUpdate>>
    | Awaited<ReturnType<typeof prepareApiCampaignEnabled>>
    | PreparedInviteWrite
    | { ok: false; code: string },
): Promise<{ ok: true; data: unknown } | { ok: false; code: string }> {
  if (!prepared.ok) return prepared;
  const outcome = await db().transaction(async (tx) => {
    const locked = await prepared.lock(tx);
    if (!locked.ok) return locked;
    return locked.execute();
  });
  if (outcome.ok) await outcome.afterCommit?.();
  return outcome;
}

async function campaignFields(over: Partial<CampaignFields> = {}): Promise<CampaignFields> {
  // 视觉类（theme.pack）不做重叠检查；窗口取当前时间前后一天
  const [rows] = (await db().execute(
    sql`SELECT DATE_FORMAT(NOW() - INTERVAL 1 DAY, '%Y-%m-%d %H:%i:%s') AS s, DATE_FORMAT(NOW() + INTERVAL 1 DAY, '%Y-%m-%d %H:%i:%s') AS e`,
  )) as unknown as [{ s: string; e: string }[]];
  return {
    name: "运营 REST 夹具",
    effect: "theme.pack",
    target: "default",
    startsAt: rows[0]!.s,
    endsAt: rows[0]!.e,
    priority: 0,
    ...over,
  };
}

beforeAll(async () => {
  tdb = await setupTempDb({ demo: true });
});

afterAll(() => {
  tdb?.teardown();
});

describe.skipIf(skipDb)("运营日常 REST 服务层（M20.3 Step 3）", () => {
  it("三张域码表与拒绝码全集对齐", () => {
    expect(ANNOUNCEMENTS_DENIAL_HTTP).toEqual({
      not_found: "not_found",
      bad_title: "bad_request",
      bad_body: "bad_request",
      bad_window: "bad_request",
    });
    expect(CAMPAIGNS_DENIAL_HTTP).toEqual({
      "bad-name": "bad_request",
      "bad-effect": "bad_request",
      "bad-target": "bad_request",
      "bad-start": "bad_request",
      "bad-end": "bad_request",
      "bad-window": "bad_request",
      "bad-priority": "bad_request",
      "missing-ref": "bad_request",
      "not-found": "not_found",
      conflict: "state_conflict",
      overlap: "state_conflict",
    });
    expect(INVITES_DENIAL_HTTP).toEqual({
      not_found: "not_found",
      already_used: "state_conflict",
    });
  });

  it("公告：输入校验在 prepare；创建写审计（trace）并入队 published；列表与详情可查", async () => {
    expect(
      await prepareApiAnnouncementCreate(
        API_ACTOR,
        {
          title: "  ",
          bodyMd: "",
          level: "info",
          audience: "all",
          showBanner: false,
          startsAt: null,
          endsAt: null,
        },
        TRACE,
      ),
    ).toEqual({ ok: false, code: "bad_title" });
    // 公告允许过去时间补发；bad_window 只拒绝格式非法的窗口值
    expect(
      await prepareApiAnnouncementCreate(
        API_ACTOR,
        {
          title: "窗口",
          bodyMd: "",
          level: "info",
          audience: "all",
          showBanner: false,
          startsAt: "not-a-datetime",
          endsAt: null,
        },
        TRACE,
      ),
    ).toEqual({ ok: false, code: "bad_window" });

    const created = await prepareApiAnnouncementCreate(
      API_ACTOR,
      {
        title: "运营 REST 公告",
        bodyMd: "正文",
        level: "important",
        audience: "members",
        showBanner: true,
        startsAt: null,
        endsAt: null,
      },
      TRACE,
    );
    expect(created.ok).toBe(true);
    const executed = await runPrepared(created);
    expect(executed).toMatchObject({ ok: true, data: { announcementId: expect.any(Number) } });
    const [row] = await db()
      .select({ title: announcements.title, level: announcements.level })
      .from(announcements)
      .where(eq(announcements.title, "运营 REST 公告"));
    expect(row.level).toBe("important");
    const audits = await db()
      .select({ after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "announcement.create"));
    const audit = audits.find((r) => (r.after as { title?: string }).title === "运营 REST 公告");
    expect(audit?.after).toMatchObject({
      title: "运营 REST 公告",
      via: "api",
      requestId: TRACE.requestId,
      tokenSuffix: TRACE.tokenSuffix,
    });

    const list = await listAnnouncementsPage({ page: 1, perPage: 10 });
    expect(list.items.some((i) => i.title === "运营 REST 公告" && i.status === "active")).toBe(
      true,
    );
    const [item] = list.items.filter((i) => i.title === "运营 REST 公告");
    const detail = await loadAnnouncementDetail(item.id);
    expect(detail).toMatchObject({ id: item.id, bodyMd: "正文", status: "active" });
    expect(await loadAnnouncementDetail(99999999)).toBeNull();
  });

  it("公告编辑：值未变不写审计（条件审计契约）；值变化写；不存在 not_found 在锁段", async () => {
    const base = {
      title: "条件审计公告",
      bodyMd: "v1",
      level: "info" as const,
      audience: "all" as const,
      showBanner: false,
      startsAt: nowBeijingWallTime(),
      endsAt: null,
    };
    const { announcementId } = await createAnnouncement(ADMIN, base);
    // 后台编辑入口零回归：同值编辑 changed:false 且不新增 audit
    const auditsBefore = await db()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "announcement.edit"));
    const same = await editAnnouncement(ADMIN, announcementId, { ...base });
    expect(same).toEqual({ ok: true, changed: false });
    const auditsAfterSame = await db()
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.action, "announcement.edit"));
    expect(auditsAfterSame).toHaveLength(auditsBefore.length);

    // REST 变体：值变化 → 审计含 trace
    const changedPrepared = await prepareApiAnnouncementEdit(
      API_ACTOR,
      announcementId,
      { ...base, bodyMd: "v2" },
      TRACE,
    );
    expect(changedPrepared.ok).toBe(true);
    const changed = await runPrepared(changedPrepared);
    expect(changed).toMatchObject({ ok: true, data: { announcementId, changed: true } });
    const editAudits = await db()
      .select({ after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "announcement.edit"));
    const editAudit = editAudits.find(
      (r) => (r.after as { requestId?: string }).requestId === TRACE.requestId,
    );
    expect(editAudit?.after).toMatchObject({ requestId: TRACE.requestId, via: "api" });

    // 不存在 → 锁段 not_found
    const missing = await prepareApiAnnouncementEnd(API_ACTOR, 99999999, TRACE);
    expect(missing.ok).toBe(true);
    expect(await runPrepared(missing)).toEqual({ ok: false, code: "not_found" });
  });

  it("公告下线：后台入口 endsAt 提前；REST 变体审计含 trace", async () => {
    const base = {
      title: "下线公告",
      bodyMd: "",
      level: "info" as const,
      audience: "all" as const,
      showBanner: false,
      startsAt: nowBeijingWallTime(),
      endsAt: null,
    };
    const { announcementId } = await createAnnouncement(ADMIN, base);
    const ended = await endAnnouncement(ADMIN, announcementId);
    expect(ended.ok).toBe(true);
    const [row] = await db()
      .select({ endsAt: announcements.endsAt })
      .from(announcements)
      .where(eq(announcements.id, announcementId));
    expect(row.endsAt).not.toBeNull();

    const second = await prepareApiAnnouncementCreate(
      API_ACTOR,
      { ...base, title: "下线公告 B" },
      TRACE,
    );
    const executed = await runPrepared(second);
    const createdId = (executed as { ok: true; data: { announcementId: number } }).data
      .announcementId;
    const viaApi = await prepareApiAnnouncementEnd(API_ACTOR, createdId, TRACE);
    expect(viaApi.ok).toBe(true);
    const done = await runPrepared(viaApi);
    expect(done).toMatchObject({ ok: true, data: { announcementId: createdId } });
    const endAudits = await db()
      .select({ after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "announcement.end"));
    const endAudit = endAudits.find(
      (r) => (r.after as { requestId?: string }).requestId === TRACE.requestId,
    );
    expect(endAudit?.after).toMatchObject({ requestId: TRACE.requestId, via: "api" });
  });

  it("活动：revision 冲突与同值启停在 execute 裁决；创建审计含 trace；后台入口零回归", async () => {
    // 后台入口零回归（campaigns 原测试已覆盖 19 项，这里只验证 REST 变体）
    const fields1 = await campaignFields({ name: "REST 活动 A" });
    const createdPrepared = await prepareApiCampaignCreate(fields1, API_ACTOR, TRACE);
    expect(createdPrepared.ok, JSON.stringify(createdPrepared)).toBe(true);
    const created = await runPrepared(createdPrepared);
    expect(created).toMatchObject({ ok: true, data: { revision: 1 } });
    const idA = (created as { ok: true; data: { id: number } }).data.id;

    // 后台创建同域另一条（供 revision 冲突场景）
    const createdB = await createCampaign(await campaignFields({ name: "后台活动 B" }), ADMIN);
    expect(createdB.ok, JSON.stringify(createdB)).toBe(true);
    const idB = createdB.ok ? createdB.value.id : 0;

    // REST 编辑：旧 revision → conflict（状态裁决在 execute，lock 放行）
    const stale = await prepareApiCampaignUpdate(idA, 99, fields1, API_ACTOR, TRACE);
    expect(stale.ok).toBe(true);
    expect(await runPrepared(stale)).toEqual({ ok: false, code: "conflict" });

    // 新 revision 编辑成功 → revision+1 + 审计含 trace
    const fresh = await prepareApiCampaignUpdate(idA, 1, fields1, API_ACTOR, TRACE);
    expect(fresh.ok).toBe(true);
    const updated = await runPrepared(fresh);
    expect(updated).toMatchObject({ ok: true, data: { id: idA, revision: 2 } });

    // 同值启停：changed:false 且 revision 不变
    const sameToggle = await prepareApiCampaignEnabled(idA, true, API_ACTOR, TRACE);
    expect(sameToggle.ok).toBe(true);
    const same = await runPrepared(sameToggle);
    expect(same).toMatchObject({ ok: true, data: { id: idA, changed: false, revision: 2 } });
    // 异值启停：changed:true + revision+1
    const off = await prepareApiCampaignEnabled(idA, false, API_ACTOR, TRACE);
    const offResult = await runPrepared(off);
    expect(offResult).toMatchObject({ ok: true, data: { id: idA, changed: true, revision: 3 } });
    expect(idB).toBeGreaterThan(0);
    const [audit] = await db()
      .select({ after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "campaign.toggle"));
    expect(audit.after).toMatchObject({ requestId: TRACE.requestId, via: "api" });

    // 不存在 → 锁段 not-found
    const missing = await prepareApiCampaignEnabled(99999999, true, API_ACTOR, TRACE);
    expect(missing.ok).toBe(true);
    expect(await runPrepared(missing)).toEqual({ ok: false, code: "not-found" });
  });

  it("邀请码：生成落审计（trace）；已用拒绝在 execute；批次空撤 not_found 在 execute；后台入口零回归", async () => {
    const genPrepared = await prepareApiInviteGenerate(
      API_ACTOR,
      { count: 2, days: 30, batch: "rest-生成" },
      TRACE,
    );
    expect(genPrepared.ok).toBe(true);
    const gen = await runPrepared(genPrepared);
    const codes = (gen as { ok: true; data: { codes: string[] } }).data.codes;
    expect(codes).toHaveLength(2);

    const [genAudit] = await db()
      .select({ after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "invite.generate"));
    expect(genAudit.after).toMatchObject({
      count: 2,
      requestId: TRACE.requestId,
      tokenSuffix: TRACE.tokenSuffix,
    });

    // 后台入口零回归：标记已用 → REST 吊销 execute 拒绝 already_used
    await db()
      .update(inviteCodes)
      .set({ usedBy: DEMO.member, usedAt: nowBeijingWallTime() })
      .where(eq(inviteCodes.code, codes[0]));
    const usedPrepared = await prepareApiInviteRevoke(API_ACTOR, codes[0], TRACE);
    expect(usedPrepared.ok).toBe(true);
    expect(await runPrepared(usedPrepared)).toEqual({ ok: false, code: "already_used" });
    // 后台 revokeInvite 对已用码仍拒绝（零回归）
    expect(await revokeInvite(ADMIN, codes[0])).toEqual({ ok: false, code: "already_used" });

    // 未用码 REST 吊销成功 + 审计 trace
    const okPrepared = await prepareApiInviteRevoke(API_ACTOR, codes[1], TRACE);
    expect(okPrepared.ok).toBe(true);
    expect(await runPrepared(okPrepared)).toMatchObject({ ok: true, data: { revoked: true } });

    // 批次吊销：可用码 0 → execute not_found；有可用码 → revoked 计数
    const batchPrepared = await prepareApiInviteRevokeByBatch(API_ACTOR, "rest-生成", TRACE);
    expect(await runPrepared(batchPrepared)).toEqual({ ok: false, code: "not_found" });
    const seed = await generateInvites(ADMIN, { count: 2, days: 0, batch: "rest-批次" });
    expect(seed.codes).toHaveLength(2);
    const seeded = await db()
      .select({ code: inviteCodes.code })
      .from(inviteCodes)
      .where(eq(inviteCodes.batch, "rest-批次"));
    expect(seeded, JSON.stringify(seeded)).toHaveLength(2);
    const batchOk = await prepareApiInviteRevokeByBatch(API_ACTOR, "rest-批次", TRACE);
    expect(batchOk.ok).toBe(true);
    expect(await runPrepared(batchOk)).toMatchObject({
      ok: true,
      data: { batch: "rest-批次", revoked: seed.codes.length },
    });
  });
});
