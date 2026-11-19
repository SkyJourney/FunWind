// @vitest-environment node
/**
 * 用户治理 REST 服务层集成测试（M20.3 Step 2）：
 * prepareApiRestriction / prepareApiRestrictionLift / prepareApiSessionRevoke /
 * prepareApiAppealResolve 的 prepare/lock/execute 三段、审计 trace、事件入队，
 * 幂等契约（lock 只做存在性与归属、状态裁决在 execute）、两张域码表与拒绝码全集对齐。
 * 后台 createRestriction / liftRestriction / revokeUserSessionByAdmin / resolveUserAppeal 零回归。
 */
import "@/modules";
import { eq } from "drizzle-orm";
import {
  auditLog,
  DEMO,
  eventOutbox,
  getWebDb,
  insertIdOf,
  sessions,
  userAppeals,
  userRestrictions,
} from "@funwind/db";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { makeActiveUser } from "@/lib/manage/int-fixtures";
import { nowBeijingWallTime } from "@/lib/datetime";
import {
  prepareApiRestriction,
  prepareApiRestrictionLift,
  prepareApiSessionRevoke,
  RESTRICTIONS_DENIAL_HTTP,
  type PreparedApiLift,
  type PreparedApiRestriction,
  type PreparedApiSessionRevoke,
  type RestrictionKind,
} from "./restrictions-admin";
import {
  APPEALS_DENIAL_HTTP,
  prepareApiAppealResolve,
  type PreparedApiAppealResolve,
} from "./appeals";

let tdb: TempDb;
const db = () => getWebDb();
const API_ACTOR = { userId: DEMO.admin, via: "api" as const, ip: "203.0.113.10" };
const TRACE = { requestId: "req-user-writes-1", tokenSuffix: "cd34" };
const FUTURE_ENDS_AT = "2027-01-01 08:00:00";

/** 按 REST 幂等管线形态跑 prepare → 事务(lock → execute) → 提交后 afterCommit
 * （afterCommit 必须在事务提交后执行：dispatchOutboxRows 更新本事务新插的 outbox 行，
 *   事务内调用会对自身行锁死等——runIdempotentManageWrite 即在提交后调用。） */
async function runPrepared(
  prepared:
    | PreparedApiRestriction
    | PreparedApiLift
    | PreparedApiSessionRevoke
    | PreparedApiAppealResolve
    | { ok: false; code: string },
): Promise<
  { ok: true; data: unknown; afterCommit?: () => Promise<void> } | { ok: false; code: string }
> {
  if (!prepared.ok) return prepared;
  const outcome = await db().transaction(async (tx) => {
    const locked = await prepared.lock(tx);
    if (!locked.ok) return locked;
    return locked.execute();
  });
  if (outcome.ok) await outcome.afterCommit?.();
  return outcome;
}

/** 直接落行造一条生效限制（绕开后台入口，避免 last-admin 语义在测试间互相牵连） */
async function seedRestriction(
  userId: number,
  kind: RestrictionKind,
  scopeId = 0,
  endsAt: string | null = null,
): Promise<number> {
  const id = insertIdOf(
    await db().insert(userRestrictions).values({
      userId,
      kind,
      scopeId,
      reason: "测试夹具",
      startsAt: nowBeijingWallTime(),
      endsAt,
      createdBy: DEMO.admin,
      createdAt: nowBeijingWallTime(),
    }),
  );
  return Number(id);
}

/** 造一台活动 session（id 为 64 位 hex，形态与真实登录一致） */
async function seedSession(userId: number): Promise<string> {
  const id = randomBytes(32).toString("hex");
  await db().insert(sessions).values({
    id,
    userId,
    createdAt: nowBeijingWallTime(),
    expiresAt: "2027-01-01 08:00:00",
    lastSeenAt: nowBeijingWallTime(),
  });
  return id;
}

/** 造一条 pending 限制申诉（targetType=restriction，targetId 指向限制行） */
async function seedRestrictionAppeal(userId: number, restrictionId: number): Promise<number> {
  const id = insertIdOf(
    await db().insert(userAppeals).values({
      userId,
      targetType: "restriction",
      targetId: restrictionId,
      reason: "请求解除禁言",
      status: "pending",
      createdAt: nowBeijingWallTime(),
    }),
  );
  return Number(id);
}

beforeAll(async () => {
  tdb = await setupTempDb();
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("用户治理 REST 服务层（M20.3 Step 2）", () => {
  it("两张域码表与拒绝码全集对齐", () => {
    expect(RESTRICTIONS_DENIAL_HTTP).toEqual({
      not_found: "not_found",
      session_not_found: "not_found",
      bad_kind: "bad_request",
      reason_required: "bad_request",
      reason_too_long: "bad_request",
      bad_scope: "bad_request",
      bad_ends_at: "bad_request",
      already: "state_conflict",
      bad_state: "state_conflict",
      last_admin: "state_conflict",
    });
    expect(APPEALS_DENIAL_HTTP).toEqual({
      not_found: "not_found",
      already_handled: "state_conflict",
      result_required: "bad_request",
    });
  });

  it("创建限制：输入校验矩阵在 prepare 拒绝（kind/理由/scope 配对/过期时间）", async () => {
    const userId = await makeActiveUser("urest-input");
    const cases: {
      input: {
        userId: number;
        kind: string;
        reason: string;
        endsAt: string | null;
        scopeId?: number;
      };
      code: string;
    }[] = [
      { input: { userId, kind: "banned", reason: "r", endsAt: null }, code: "bad_kind" },
      { input: { userId, kind: "ban", reason: "  ", endsAt: null }, code: "reason_required" },
      {
        input: { userId, kind: "ban", reason: "x".repeat(256), endsAt: null },
        code: "reason_too_long",
      },
      {
        input: { userId, kind: "ban", reason: "r", endsAt: null, scopeId: 906 },
        code: "bad_scope",
      },
      {
        input: { userId, kind: "forum_ban", reason: "r", endsAt: null, scopeId: 0 },
        code: "bad_scope",
      },
      {
        input: { userId, kind: "mute", reason: "r", endsAt: null, scopeId: -1 },
        code: "bad_scope",
      },
      {
        input: { userId, kind: "mute", reason: "r", endsAt: "2020-01-01 00:00:00" },
        code: "bad_ends_at",
      },
    ];
    for (const { input, code } of cases) {
      const prepared = await prepareApiRestriction(API_ACTOR, input, TRACE);
      expect(prepared, JSON.stringify(input)).toEqual({ ok: false, code });
    }
    // 不存在的用户：存在性在锁段拒绝
    const missing = await prepareApiRestriction(
      API_ACTOR,
      { userId: 99999999, kind: "mute", reason: "r", endsAt: null },
      TRACE,
    );
    expect(missing.ok).toBe(true);
    const executed = await runPrepared(missing);
    expect(executed).toEqual({ ok: false, code: "not_found" });
  });

  it("创建禁言：写入+审计（含 API trace）+事件入队，afterCommit 派发", async () => {
    const userId = await makeActiveUser("urest-create");
    const prepared = await prepareApiRestriction(
      API_ACTOR,
      { userId, kind: "mute", reason: "刷屏", endsAt: FUTURE_ENDS_AT },
      TRACE,
    );
    expect(prepared.ok).toBe(true);
    const executed = await runPrepared(prepared);
    expect(executed).toMatchObject({
      ok: true,
      data: { userId, kind: "mute", scopeId: 0, endsAt: FUTURE_ENDS_AT },
    });
    const [row] = await db()
      .select({ reason: userRestrictions.reason, createdBy: userRestrictions.createdBy })
      .from(userRestrictions)
      .where(eq(userRestrictions.userId, userId));
    expect(row).toEqual({ reason: "刷屏", createdBy: DEMO.admin });
    const [audit] = await db()
      .select({ action: auditLog.action, after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.targetType, "user"));
    expect(audit.action).toBe("restriction.create");
    expect(audit.after).toMatchObject({
      kind: "mute",
      via: "api",
      requestId: TRACE.requestId,
      tokenSuffix: TRACE.tokenSuffix,
    });
    const [event] = await db()
      .select({ eventName: eventOutbox.eventName })
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "restriction.changed"));
    expect(event.eventName).toBe("restriction.changed");
  });

  it("幂等契约：already/last_admin 状态裁决在 execute（lock 放行）", async () => {
    const userId = await makeActiveUser("urest-already");
    await seedRestriction(userId, "mute");
    const prepared = await prepareApiRestriction(
      API_ACTOR,
      { userId, kind: "mute", reason: "重复", endsAt: null },
      TRACE,
    );
    expect(prepared.ok).toBe(true);
    const executed = await runPrepared(prepared);
    expect(executed).toEqual({ ok: false, code: "already" });

    // last_admin：唯一站点管理员不可全站封禁（prepare/lock 放行，execute 裁决）
    const lastAdmin = await prepareApiRestriction(
      API_ACTOR,
      { userId: DEMO.admin, kind: "ban", reason: "自封", endsAt: null },
      TRACE,
    );
    expect(lastAdmin.ok).toBe(true);
    expect(await runPrepared(lastAdmin)).toEqual({ ok: false, code: "last_admin" });
  });

  it("解除限制：归属不匹配与不存在在锁段 404 同型；过期行裁决在 execute；成功留痕+事件", async () => {
    const owner = await makeActiveUser("urest-lift-a");
    const other = await makeActiveUser("urest-lift-b");
    const rid = await seedRestriction(owner, "mute", 0, FUTURE_ENDS_AT);

    // 归属不匹配（REST 路径 uid ≠ 行归属）→ not_found
    const foreign = await prepareApiRestrictionLift(API_ACTOR, other, rid, "越权", TRACE);
    expect(foreign.ok).toBe(true);
    expect(await runPrepared(foreign)).toEqual({ ok: false, code: "not_found" });

    // 不存在
    const missing = await prepareApiRestrictionLift(API_ACTOR, owner, 99999999, "不存在", TRACE);
    expect(missing.ok).toBe(true);
    expect(await runPrepared(missing)).toEqual({ ok: false, code: "not_found" });

    // 已过期行：lock 放行、execute already（幂等契约）
    const expiredId = await seedRestriction(owner, "no_avatar", 0, "2020-01-01 00:00:00");
    const expired = await prepareApiRestrictionLift(API_ACTOR, owner, expiredId, "过期", TRACE);
    expect(expired.ok).toBe(true);
    expect(await runPrepared(expired)).toEqual({ ok: false, code: "already" });

    // note 空在 prepare 拒绝
    const emptyNote = await prepareApiRestrictionLift(API_ACTOR, owner, rid, "  ", TRACE);
    expect(emptyNote).toEqual({ ok: false, code: "reason_required" });

    // 成功解除：endsAt 提前到当前 + 审计（含 trace）+ restriction.changed(lifted)
    const ok = await prepareApiRestrictionLift(API_ACTOR, owner, rid, "已改正", TRACE);
    expect(ok.ok).toBe(true);
    const executed = await runPrepared(ok);
    expect(executed).toMatchObject({
      ok: true,
      data: { restrictionId: rid, userId: owner, kind: "mute" },
    });
    const [row] = await db()
      .select({ endsAt: userRestrictions.endsAt })
      .from(userRestrictions)
      .where(eq(userRestrictions.id, rid));
    expect(row.endsAt).not.toBe(FUTURE_ENDS_AT);
    const [event] = await db()
      .select({ payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "restriction.changed"));
    expect(event).toBeDefined();
    const [audit] = await db()
      .select({ action: auditLog.action, after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "restriction.lift"));
    expect(audit.after).toMatchObject({ reason: "已改正", via: "api", requestId: TRACE.requestId });
  });

  it("会话吊销：行删除+审计；不存在与越权（他人 session）同型 404", async () => {
    const owner = await makeActiveUser("urest-sess-a");
    const other = await makeActiveUser("urest-sess-b");
    const sid = await seedSession(owner);

    // 他人 session（归属不匹配）→ session_not_found
    const foreign = await prepareApiSessionRevoke(API_ACTOR, other, sid, TRACE);
    expect(foreign.ok).toBe(true);
    expect(await runPrepared(foreign)).toEqual({ ok: false, code: "session_not_found" });

    // 成功吊销：行删除 + 审计（trace 附加）
    const ok = await prepareApiSessionRevoke(API_ACTOR, owner, sid, TRACE);
    expect(ok.ok).toBe(true);
    const executed = await runPrepared(ok);
    expect(executed).toMatchObject({
      ok: true,
      data: { sessionId: sid, userId: owner, revoked: true },
    });
    const rows = await db().select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sid));
    expect(rows).toHaveLength(0);
    const [audit] = await db()
      .select({ after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "session.revoke"));
    expect(audit.after).toMatchObject({
      revoked: true,
      via: "api",
      requestId: TRACE.requestId,
      tokenSuffix: TRACE.tokenSuffix,
    });

    // 已吊销后再发新意图 → session_not_found
    const again = await prepareApiSessionRevoke(API_ACTOR, owner, sid, TRACE);
    expect(again.ok).toBe(true);
    expect(await runPrepared(again)).toEqual({ ok: false, code: "session_not_found" });
  });

  it("申诉处置：pending 成功+事件；already_handled 裁决在 execute；归属与入参在 prepare/lock 拒绝", async () => {
    const owner = await makeActiveUser("urest-appeal");
    const other = await makeActiveUser("urest-appeal-b");
    const rid = await seedRestriction(owner, "mute");
    const appealId = await seedRestrictionAppeal(owner, rid);

    // 空与超长的 result 在 prepare 拒绝
    expect(
      await prepareApiAppealResolve(API_ACTOR, owner, appealId, "approved", "  ", TRACE),
    ).toEqual({
      ok: false,
      code: "result_required",
    });
    expect(
      await prepareApiAppealResolve(
        API_ACTOR,
        owner,
        appealId,
        "approved",
        "r".repeat(1001),
        TRACE,
      ),
    ).toEqual({ ok: false, code: "result_required" });

    // 归属不匹配 → not_found
    const foreign = await prepareApiAppealResolve(
      API_ACTOR,
      other,
      appealId,
      "approved",
      "同意",
      TRACE,
    );
    expect(foreign.ok).toBe(true);
    expect(await runPrepared(foreign)).toEqual({ ok: false, code: "not_found" });

    // 成功处置：状态落库 + 审计（trace）+ account.appeal.resolved
    const ok = await prepareApiAppealResolve(
      API_ACTOR,
      owner,
      appealId,
      "approved",
      "同意解除",
      TRACE,
    );
    expect(ok.ok).toBe(true);
    const executed = await runPrepared(ok);
    expect(executed).toMatchObject({ ok: true, data: { appealId, status: "approved" } });
    const [row] = await db()
      .select({ status: userAppeals.status, handledBy: userAppeals.handledBy })
      .from(userAppeals)
      .where(eq(userAppeals.id, appealId));
    expect(row).toEqual({ status: "approved", handledBy: DEMO.admin });
    const [event] = await db()
      .select({ payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(eq(eventOutbox.eventName, "account.appeal.resolved"));
    expect(event).toBeDefined();
    const [audit] = await db()
      .select({ after: auditLog.afterJson })
      .from(auditLog)
      .where(eq(auditLog.action, "user.appeal.resolve"));
    expect(audit.after).toMatchObject({
      status: "approved",
      via: "api",
      requestId: TRACE.requestId,
      tokenSuffix: TRACE.tokenSuffix,
    });

    // 重复处置：prepare/lock 放行，execute already_handled（幂等契约）
    const again = await prepareApiAppealResolve(
      API_ACTOR,
      owner,
      appealId,
      "rejected",
      "改判",
      TRACE,
    );
    expect(again.ok).toBe(true);
    expect(await runPrepared(again)).toEqual({ ok: false, code: "already_handled" });
  });
});
