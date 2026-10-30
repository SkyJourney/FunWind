// @vitest-environment node
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  DEMO,
  getWebDb,
  notifications,
  userAppeals,
  userRestrictions,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@/lib/auth/password";
import { adminUserDetail } from "./restrictions-admin";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import {
  AppealError,
  listPendingUserAppeals,
  resolveUserAppeal,
  submitAppealAsUser,
  submitAppealWithPassword,
} from "./appeals";

let tdb: TempDb;
const db = () => getWebDb();
const PASSWORD = "M9.6-Appeal-Password-42";
const ADMIN = { userId: DEMO.admin, via: "admin" as const, ip: "203.0.113.9" };

beforeAll(async () => {
  tdb = await setupTempDb();
  await db()
    .update(users)
    .set({ passwordHash: await hashPassword(PASSWORD), legacyPasswordPending: false })
    .where(eq(users.id, DEMO.member));
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("账号申诉 · 真实 MySQL", () => {
  it("已登录申诉只针对当前有效限制，空理由或无限制账号拒绝", async () => {
    await expect(submitAppealAsUser(DEMO.alice, "   ", null)).rejects.toMatchObject({
      code: "result_required",
    });
    await expect(submitAppealAsUser(DEMO.alice, "无有效限制", null)).rejects.toMatchObject({
      code: "no_active_restrictions",
    });

    await db()
      .insert(userRestrictions)
      .values({
        userId: DEMO.team,
        kind: "mute",
        scopeId: 0,
        reason: "登录申诉集成测试限制",
        startsAt: sql`NOW()`,
        endsAt: null,
        createdBy: DEMO.admin,
        createdAt: sql`NOW()`,
      });
    expect(await submitAppealAsUser(DEMO.team, "请复核禁言范围。", null)).toEqual({ submitted: 1 });
  });

  it("重新验证后登记当前限制申诉，后台复核写审计并经 outbox 通知本人", async () => {
    await expect(resolveUserAppeal(ADMIN, 99999999, "approved", "   ")).rejects.toMatchObject({
      code: "result_required",
    });
    await expect(
      resolveUserAppeal(ADMIN, 99999999, "approved", "不存在的申诉"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      submitAppealWithPassword("demo_member", "wrong-password", "不应通过", "203.0.113.8"),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
    await db()
      .insert(userRestrictions)
      .values({
        userId: DEMO.member,
        kind: "ban",
        scopeId: 0,
        reason: "申诉集成测试限制",
        startsAt: sql`NOW()`,
        endsAt: null,
        createdBy: DEMO.admin,
        createdAt: sql`NOW()`,
      });

    const submitted = await submitAppealWithPassword(
      "demo_member",
      PASSWORD,
      "我已理解规则，希望人工复核这项限制。",
      "203.0.113.8",
    );
    expect(submitted.submitted).toBe(1);
    const [appeal] = await db()
      .select()
      .from(userAppeals)
      .where(and(eq(userAppeals.userId, DEMO.member), eq(userAppeals.status, "pending")));
    expect(appeal).toMatchObject({
      targetType: "restriction",
      reason: "我已理解规则，希望人工复核这项限制。",
    });
    expect(await listPendingUserAppeals()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: appeal!.id, userId: DEMO.member, username: "demo_member" }),
      ]),
    );
    expect((await adminUserDetail(DEMO.member))?.appeals).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: appeal!.id, status: "pending" })]),
    );

    await expect(
      submitAppealWithPassword("demo_member", PASSWORD, "重复申诉", "203.0.113.8"),
    ).rejects.toBeInstanceOf(AppealError);

    await resolveUserAppeal(ADMIN, appeal!.id, "approved", "经复核，同意解除该项限制。");
    const [resolved] = await db().select().from(userAppeals).where(eq(userAppeals.id, appeal!.id));
    expect(resolved).toMatchObject({
      status: "approved",
      handledBy: DEMO.admin,
      result: "经复核，同意解除该项限制。",
    });
    expect((await adminUserDetail(DEMO.member))?.appeals).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: appeal!.id, status: "approved" })]),
    );
    expect((await listPendingUserAppeals()).some((item) => item.id === appeal!.id)).toBe(false);
    await expect(
      resolveUserAppeal(ADMIN, appeal!.id, "rejected", "重复处理"),
    ).rejects.toMatchObject({ code: "already_handled" });
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "user.appeal.resolve"),
            eq(auditLog.targetId, String(appeal!.id)),
          ),
        ),
    ).toHaveLength(1);
    const sent = await db()
      .select({ type: notifications.type })
      .from(notifications)
      .where(eq(notifications.userId, DEMO.member));
    expect(sent.map((row) => row.type)).toEqual(
      expect.arrayContaining(["account.appeal_submitted", "account.appeal_resolved"]),
    );

    await db().update(users).set({ state: "deleted" }).where(eq(users.id, DEMO.member));
    try {
      await expect(
        submitAppealWithPassword("demo_member", PASSWORD, "已注销账号不能再申诉", "203.0.113.8"),
      ).rejects.toMatchObject({ code: "invalid_credentials" });
    } finally {
      await db().update(users).set({ state: "active" }).where(eq(users.id, DEMO.member));
    }
  });
});
