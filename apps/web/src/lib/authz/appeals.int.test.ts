// @vitest-environment node
import "@/modules";
import { and, eq, sql } from "drizzle-orm";
import {
  accountDeletionRequests,
  auditLog,
  DEMO,
  getWebDb,
  insertIdOf,
  notifications,
  userAppeals,
  userRestrictions,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildLegacyStorage,
  hashPassword,
  legacyHashHex,
  verifyPassword,
} from "@/lib/auth/password";
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
let passwordHash: string;
const ADMIN = { userId: DEMO.admin, via: "admin" as const, ip: "203.0.113.9" };

beforeAll(async () => {
  tdb = await setupTempDb();
  passwordHash = await hashPassword(PASSWORD);
  await db()
    .update(users)
    .set({ passwordHash, legacyPasswordHash: null, legacyPasswordPending: false })
    .where(eq(users.id, DEMO.member));
});

afterAll(async () => {
  await tdb?.teardown();
});

describe.skipIf(skipDb)("账号申诉 · 真实 MySQL", () => {
  it("标识符密码路径：缺失、无密码和 legacy-only 恰好校验一次 dummy 且不能申诉", async () => {
    const [before] = await db()
      .select({
        passwordHash: users.passwordHash,
        legacyPasswordHash: users.legacyPasswordHash,
        legacyPasswordPending: users.legacyPasswordPending,
        state: users.state,
      })
      .from(users)
      .where(eq(users.id, DEMO.member));
    const oldPassword = "Appeal-Legacy-Only-42";
    const legacyHash = buildLegacyStorage(legacyHashHex(oldPassword, "Ab3dEf"), "Ab3dEf");
    const cases = [
      {
        identifier: "appeal-no-such-user",
        hash: null,
        legacy: null,
        pending: false,
        password: PASSWORD,
      },
      { identifier: "demo_member", hash: null, legacy: null, pending: false, password: PASSWORD },
      { identifier: "demo_member", hash: "", legacy: null, pending: false, password: PASSWORD },
      {
        identifier: "demo_member",
        hash: null,
        legacy: legacyHash,
        pending: true,
        password: oldPassword,
      },
      {
        identifier: "demo_member",
        hash: null,
        legacy: legacyHash,
        pending: false,
        password: oldPassword,
      },
    ];
    try {
      for (const c of cases) {
        await db()
          .update(users)
          .set({
            passwordHash: c.hash,
            legacyPasswordHash: c.legacy,
            legacyPasswordPending: c.pending,
            state: "active",
          })
          .where(eq(users.id, DEMO.member));
        const verify = vi.fn(verifyPassword);
        await expect(
          submitAppealWithPassword(c.identifier, c.password, "测试复核理由", null, { verify }),
        ).rejects.toMatchObject({ code: "invalid_credentials" });
        expect(verify).toHaveBeenCalledTimes(1);
        const [target, password] = verify.mock.calls[0]!;
        expect(password).toBe(c.password);
        expect(target).not.toBe(passwordHash);
        expect(target.split("$").slice(1, 4)).toEqual(passwordHash.split("$").slice(1, 4));
        const alwaysTrue = vi.fn(async () => true);
        await expect(
          submitAppealWithPassword(c.identifier, c.password, "不得因假匹配通过", null, {
            verify: alwaysTrue,
          }),
        ).rejects.toMatchObject({ code: "invalid_credentials" });
        expect(alwaysTrue).toHaveBeenCalledExactlyOnceWith(target, c.password);
      }

      for (const [identifier, password] of [
        ["", PASSWORD],
        ["demo_member", ""],
      ]) {
        const verify = vi.fn(verifyPassword);
        await expect(
          submitAppealWithPassword(identifier, password, "测试复核理由", null, { verify }),
        ).rejects.toMatchObject({ code: "invalid_credentials" });
        expect(verify).toHaveBeenCalledTimes(1);
        expect(verify.mock.calls[0]![0].split("$").slice(1, 4)).toEqual(
          passwordHash.split("$").slice(1, 4),
        );
      }
    } finally {
      await db().update(users).set(before!).where(eq(users.id, DEMO.member));
    }
  });

  it("错误现代密码只校验真实哈希一次；deleted 用户即使密码匹配仍被状态门拒绝", async () => {
    const [before] = await db()
      .select({ state: users.state })
      .from(users)
      .where(eq(users.id, DEMO.member));
    try {
      const wrongVerify = vi.fn(verifyPassword);
      await expect(
        submitAppealWithPassword("demo_member", "wrong-password", "不应通过", null, {
          verify: wrongVerify,
        }),
      ).rejects.toMatchObject({ code: "invalid_credentials" });
      expect(wrongVerify).toHaveBeenCalledExactlyOnceWith(passwordHash, "wrong-password");

      await db().update(users).set({ state: "deleted" }).where(eq(users.id, DEMO.member));
      const correctVerify = vi.fn(verifyPassword);
      await expect(
        submitAppealWithPassword("demo_member", PASSWORD, "deleted 账号不可申诉", null, {
          verify: correctVerify,
        }),
      ).rejects.toMatchObject({ code: "invalid_credentials" });
      expect(correctVerify).toHaveBeenCalledExactlyOnceWith(passwordHash, PASSWORD);
    } finally {
      await db().update(users).set({ state: before!.state }).where(eq(users.id, DEMO.member));
    }
  });

  it("空理由仍先报必填；待注销账号通过真实密码复验后仍不能提交申诉", async () => {
    const verify = vi.fn(verifyPassword);
    await expect(
      submitAppealWithPassword("demo_member", PASSWORD, "   ", null, { verify }),
    ).rejects.toMatchObject({ code: "result_required" });
    expect(verify).not.toHaveBeenCalled();

    const requestId = insertIdOf(
      await db()
        .insert(accountDeletionRequests)
        .values({
          userId: DEMO.member,
          status: "pending",
          requestedAt: sql`NOW()`,
          scheduledAt: sql`NOW() + INTERVAL 30 DAY`,
        }),
    );
    try {
      await expect(
        submitAppealWithPassword("demo_member", PASSWORD, "待注销账号不能申诉", null, { verify }),
      ).rejects.toMatchObject({ code: "invalid_credentials" });
      expect(verify).toHaveBeenCalledExactlyOnceWith(passwordHash, PASSWORD);
      expect(
        await db().select().from(userAppeals).where(eq(userAppeals.userId, DEMO.member)),
      ).toHaveLength(0);
    } finally {
      await db().delete(accountDeletionRequests).where(eq(accountDeletionRequests.id, requestId));
    }
  });

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

    const verify = vi.fn(verifyPassword);
    const submitted = await submitAppealWithPassword(
      "demo_member",
      PASSWORD,
      "我已理解规则，希望人工复核这项限制。",
      "203.0.113.8",
      { verify },
    );
    expect(verify).toHaveBeenCalledExactlyOnceWith(passwordHash, PASSWORD);
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
