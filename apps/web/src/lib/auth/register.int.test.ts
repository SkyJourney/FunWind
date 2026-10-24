// @vitest-environment node
/**
 * 注册事务与邮件令牌的真实 MySQL 集成测试（临时库）：
 * 自增 id、归一化键唯一、邀请码原子核销与回滚、令牌消费记录邮箱已验证。
 */
import { eq, sql } from "drizzle-orm";
import { DEMO, getWebDb, inviteCodes, userProfiles, users } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { RegisterError, registerUser } from "./register";
import { consumeEmailToken, issueEmailToken } from "./tokens";

let tdb: TempDb;
const input = (over: Partial<Parameters<typeof registerUser>[0]> = {}) => ({
  username: "新用户",
  email: "new@example.com",
  passwordHash: "hash",
  invite: null,
  ...over,
});
const addInvite = (code: string, over: Record<string, unknown> = {}) =>
  getWebDb()
    .insert(inviteCodes)
    .values({ code, createdAt: sql`NOW()`, ...over });
const userCount = async () => (await getWebDb().select({ id: users.id }).from(users)).length;

describe.skipIf(skipDb)("注册事务 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("开放注册：自增 id（不与既有最大 id 冲突）、归一化键、资料行同时建立", async () => {
    const id = await registerUser(input());
    expect(id).toBeGreaterThan(DEMO.team); // 夹具占用 90001–90006，自增必须越过
    const [u] = await getWebDb().select().from(users).where(eq(users.id, id));
    expect(u).toMatchObject({
      username: "新用户",
      usernameKey: "新用户",
      emailKey: "new@example.com",
      state: "active",
      emailVerifiedAt: null,
    });
    expect(
      await getWebDb().select().from(userProfiles).where(eq(userProfiles.userId, id)),
    ).toHaveLength(1);
  });

  it("用户名/邮箱按归一化键唯一：大小写变体视为同一个", async () => {
    await registerUser(input({ username: "Alice9", email: "a9@example.com" }));
    await expect(
      registerUser(input({ username: "alice9", email: "other@example.com" })),
    ).rejects.toThrow(RegisterError);
    await expect(
      registerUser(input({ username: "别名", email: "A9@Example.com" })),
    ).rejects.toThrow(/已被使用/);
  });

  it("假名不碰撞：さくら 与 サクラ 可各自注册", async () => {
    await registerUser(input({ username: "さくら", email: "s1@example.com" }));
    await registerUser(input({ username: "サクラ", email: "s2@example.com" }));
  });

  it("邀请制：核销邀请码并记录使用者；同一邀请码不能二次使用", async () => {
    await addInvite("INV-ONCE");
    const id = await registerUser(
      input({ username: "邀请甲", email: "i1@example.com", invite: "INV-ONCE" }),
    );
    const [c] = await getWebDb().select().from(inviteCodes).where(eq(inviteCodes.code, "INV-ONCE"));
    expect(c?.usedBy).toBe(id);
    await expect(
      registerUser(input({ username: "邀请乙", email: "i2@example.com", invite: "INV-ONCE" })),
    ).rejects.toThrow(/邀请码无效或已被使用/);
  });

  it("邀请码无效/过期：整体回滚，不留下半成品用户", async () => {
    await addInvite("INV-EXPIRED", { expiresAt: "2000-01-01 00:00:00" });
    const before = await userCount();
    await expect(
      registerUser(input({ username: "回滚甲", email: "r1@example.com", invite: "INV-EXPIRED" })),
    ).rejects.toThrow(/邀请码/);
    await expect(
      registerUser(input({ username: "回滚乙", email: "r2@example.com", invite: "NOPE" })),
    ).rejects.toThrow(/邀请码/);
    expect(await userCount()).toBe(before);
    const rolledBack = await getWebDb().select().from(users).where(eq(users.usernameKey, "回滚甲"));
    expect(rolledBack).toHaveLength(0);
  });

  it("并发复用同一邀请码：恰有一个成功，其余回滚", async () => {
    await addInvite("INV-RACE");
    const before = await userCount();
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((i) =>
        registerUser(
          input({ username: `并发${i}`, email: `race${i}@example.com`, invite: "INV-RACE" }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await userCount()).toBe(before + 1);
  });

  it("邮件令牌：消费成功即记录邮箱已验证（reset/claim/verify 三用途）；单次有效", async () => {
    const db = getWebDb();
    const verified = async (id: number) =>
      (await db.select().from(users).where(eq(users.id, id)))[0]?.emailVerifiedAt;

    expect(await verified(DEMO.alice)).toBeNull();
    const token = await issueEmailToken(DEMO.alice, "claim");
    expect(await consumeEmailToken(token, "reset")).toBeNull(); // 用途不符
    expect(await consumeEmailToken(token, "claim")).toBe(DEMO.alice);
    expect(await verified(DEMO.alice)).not.toBeNull();
    expect(await consumeEmailToken(token, "claim")).toBeNull(); // 已用

    const t2 = await issueEmailToken(DEMO.xiaoyi, "reset");
    await consumeEmailToken(t2, "reset");
    expect(await verified(DEMO.xiaoyi)).not.toBeNull();
  });

  it("没有邮箱的用户消费令牌不会被标记为已验证", async () => {
    const db = getWebDb();
    await db.execute(
      sql`UPDATE users SET email = NULL, email_key = NULL, email_verified_at = NULL WHERE id = ${DEMO.member}`,
    );
    const t = await issueEmailToken(DEMO.member, "reset");
    expect(await consumeEmailToken(t, "reset")).toBe(DEMO.member);
    const [u] = await db.select().from(users).where(eq(users.id, DEMO.member));
    expect(u?.emailVerifiedAt).toBeNull();
  });
});
