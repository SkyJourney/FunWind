// @vitest-environment node
/**
 * 超期未验证账号清理（M11.3 清账）· 真实 MySQL 集成测试（临时库）。
 * 重点是「不该清的一个都不能清」：已验证、已登录、有会话、邀请注册、导入的历史账号、天数不足。
 */
import { and, eq, sql } from "drizzle-orm";
import {
  DEMO,
  auditLog,
  emailTokens,
  getWebDb,
  sessions,
  userProfiles,
  userStats,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { hashPassword } from "./password";
import { registerUser } from "./register";
import { issueEmailToken } from "./tokens";
import {
  DEFAULT_UNVERIFIED_TTL_DAYS,
  assertValidDays,
  findOverdueUnverifiedAccounts,
  purgeOverdueAccountIfStillEligible,
  purgeOverdueUnverifiedAccounts,
} from "./unverified-cleanup";

let tdb: TempDb;
const db = () => getWebDb();
const userRow = async (id: number) => (await db().select().from(users).where(eq(users.id, id)))[0]!;

let seq = 0;
/** 造一个开放注册且要求验证的账号，并把注册时间回拨 ageDays 天（用 SQL 的 NOW() 保证与被测代码同一时区口径） */
async function makeGated(ageDays: number, hoursExtra = 0) {
  seq += 1;
  const email = `cleanup${seq}@example.com`;
  const id = await registerUser({
    username: `待清理${seq}`,
    email,
    passwordHash: await hashPassword("correct-horse-battery"),
    emailVerificationRequired: true,
    loginVerificationRequired: true,
    invite: null,
  });
  await db()
    .update(users)
    .set({ createdAt: sqlAgo(ageDays, hoursExtra) })
    .where(eq(users.id, id));
  await issueEmailToken(id, "verify", email);
  return { id, email };
}
const sqlAgo = (days: number, hours = 0) =>
  sql`NOW() - INTERVAL ${sql.raw(String(days))} DAY - INTERVAL ${sql.raw(String(hours))} HOUR`;

const idsOf = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

describe("assertValidDays（纯逻辑）", () => {
  it.each([0, -1, 1.5, Number.NaN, Infinity])("拒绝 %s", (value) => {
    expect(() => assertValidDays(value)).toThrow(RangeError);
  });
  it("接受不小于 1 的整数", () => {
    expect(assertValidDays(1)).toBe(1);
    expect(assertValidDays(30)).toBe(30);
  });
  it("默认 7 天（站长拍板）", () => {
    expect(DEFAULT_UNVERIFIED_TTL_DAYS).toBe(7);
  });
});

describe.skipIf(skipDb)("超期未验证账号清理 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("按天数边界选出：超过 7 天选中，不足 7 天不选", async () => {
    const old = await makeGated(8);
    const justOver = await makeGated(7, 1); // 7 天又 1 小时
    const justUnder = await makeGated(6, 23); // 6 天又 23 小时
    const fresh = await makeGated(0);
    const found = idsOf(await findOverdueUnverifiedAccounts(7));
    expect(found).toContain(old.id);
    expect(found).toContain(justOver.id);
    expect(found).not.toContain(justUnder.id);
    expect(found).not.toContain(fresh.id);
  });

  it("只报告模式（apply=false）不改任何数据", async () => {
    const a = await makeGated(10);
    const before = await userRow(a.id);
    const result = await purgeOverdueUnverifiedAccounts({ apply: false, days: 7 });
    expect(result).toMatchObject({ dryRun: true, purged: 0, failed: 0 });
    expect(result.ids).toContain(a.id);
    expect(await userRow(a.id)).toEqual(before);
  });

  it("正式清理：释放用户名与邮箱、标记已注销、清掉令牌与资料，并写不含邮箱的审计", async () => {
    const a = await makeGated(10);
    const result = await purgeOverdueUnverifiedAccounts({ apply: true, days: 7 });
    expect(result.ids).toContain(a.id);

    const row = await userRow(a.id);
    expect(row).toMatchObject({
      state: "deleted",
      username: `已注销用户#${a.id}`,
      email: null,
      emailKey: null,
      passwordHash: null,
      emailVerificationRequired: false,
      loginVerificationRequired: false, // 清理后的行是干净的
    });
    expect(await db().select().from(emailTokens).where(eq(emailTokens.userId, a.id))).toHaveLength(
      0,
    );
    expect(
      await db().select().from(userProfiles).where(eq(userProfiles.userId, a.id)),
    ).toHaveLength(0);
    expect(await db().select().from(userStats).where(eq(userStats.userId, a.id))).toHaveLength(0);

    const [audit] = await db()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "account.unverified.purged"), eq(auditLog.targetId, String(a.id))),
      );
    expect(audit).toBeDefined();
    expect(audit!.actorId).toBeNull();
    expect(JSON.stringify(audit!.afterJson)).not.toContain(a.email);
  });

  it("清理后用户名和邮箱可被重新注册（这才是清理的目的）", async () => {
    const a = await makeGated(10);
    await purgeOverdueUnverifiedAccounts({ apply: true, days: 7 });
    const reborn = await registerUser({
      username: `待清理${seq}`, // 与被清理账号同名
      email: a.email, // 同一个邮箱
      passwordHash: await hashPassword("another-password-123"),
      emailVerificationRequired: false,
      loginVerificationRequired: false,
      invite: null,
    });
    expect(reborn).toBeGreaterThan(a.id);
  });

  describe("不该清的一个都不能清", () => {
    it("已验证过的账号", async () => {
      const a = await makeGated(30);
      await db()
        .update(users)
        .set({ emailVerifiedAt: sqlAgo(1) })
        .where(eq(users.id, a.id));
      expect(idsOf(await findOverdueUnverifiedAccounts(7))).not.toContain(a.id);
    });

    it("登录门已解除的账号（首次验证成功会清除标记）", async () => {
      const a = await makeGated(30);
      await db().update(users).set({ loginVerificationRequired: false }).where(eq(users.id, a.id));
      expect(idsOf(await findOverdueUnverifiedAccounts(7))).not.toContain(a.id);
    });

    it("登录过的账号", async () => {
      const a = await makeGated(30);
      await db()
        .update(users)
        .set({ lastLoginAt: sqlAgo(2) })
        .where(eq(users.id, a.id));
      expect(idsOf(await findOverdueUnverifiedAccounts(7))).not.toContain(a.id);
    });

    it("存在会话行的账号", async () => {
      const a = await makeGated(30);
      await db()
        .insert(sessions)
        .values({
          id: "f".repeat(64),
          userId: a.id,
          createdAt: sqlAgo(3),
          expiresAt: sql`NOW() + INTERVAL 1 DAY`,
          lastSeenAt: sqlAgo(1),
        });
      expect(idsOf(await findOverdueUnverifiedAccounts(7))).not.toContain(a.id);
      await db().delete(sessions).where(eq(sessions.userId, a.id));
    });

    it("邀请注册的账号（没有登录门标记）与导入的历史账号（夹具用户）", async () => {
      seq += 1;
      const invited = await registerUser({
        username: `邀请注册${seq}`,
        email: `invited${seq}@example.com`,
        passwordHash: await hashPassword("correct-horse-battery"),
        emailVerificationRequired: false,
        loginVerificationRequired: false,
        invite: null,
      });
      await db()
        .update(users)
        .set({ createdAt: sqlAgo(400) })
        .where(eq(users.id, invited));
      const found = idsOf(await findOverdueUnverifiedAccounts(7, 1000));
      expect(found).not.toContain(invited);
      expect(found).not.toContain(DEMO.alice);
      expect(found).not.toContain(DEMO.admin);
    });

    it("已注销的账号", async () => {
      const a = await makeGated(30);
      await db().update(users).set({ state: "deleted" }).where(eq(users.id, a.id));
      expect(idsOf(await findOverdueUnverifiedAccounts(7))).not.toContain(a.id);
    });
  });

  it("竞态：选出之后、清理之前用户完成了验证 → 事务内重新核对，放过这个账号", async () => {
    const a = await makeGated(10);
    const candidates = idsOf(await findOverdueUnverifiedAccounts(7));
    expect(candidates).toContain(a.id);
    // 模拟用户恰好在此刻点了验证链接：首次验证成功会同时写 email_verified_at 并清除标记
    await db()
      .update(users)
      .set({ emailVerifiedAt: sqlAgo(0), loginVerificationRequired: false })
      .where(eq(users.id, a.id));
    expect(await purgeOverdueAccountIfStillEligible(a.id, 7)).toBe(false);
    const row = await userRow(a.id);
    expect(row.state).toBe("active");
    expect(row.email).toBe(a.email);
  });

  it("limit 生效，且最早注册的优先", async () => {
    const first = await makeGated(50);
    await makeGated(49);
    const found = await findOverdueUnverifiedAccounts(7, 1);
    expect(found).toHaveLength(1);
    // 之前的用例可能留下更早的候选；至少断言按注册时间升序
    const all = await findOverdueUnverifiedAccounts(7, 1000);
    const times = all.map((r) => r.createdAt);
    expect([...times].sort()).toEqual(times);
    expect(all.map((r) => r.id)).toContain(first.id);
  });

  it("非法天数在入口就被拒绝，不会误清刚注册的账号", async () => {
    const fresh = await makeGated(0);
    await expect(purgeOverdueUnverifiedAccounts({ apply: true, days: 0 })).rejects.toThrow(
      RangeError,
    );
    expect((await userRow(fresh.id)).state).toBe("active");
  });
});
