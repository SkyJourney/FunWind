// @vitest-environment node
/**
 * 邮件令牌的并发与边界测试（审查复查 A2）。
 * 此前只有顺序用例；「单次、原子消费」的结论来自读代码。这里真的并发打：
 * 同一个令牌被多个请求同时消费，恰好一个成功，其余都拿到 null。
 */
import { and, eq } from "drizzle-orm";
import { DEMO, emailTokens, getWebDb, users } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { hashToken } from "./token";
import { consumeEmailToken, issueEmailToken } from "./tokens";

let tdb: TempDb;

describe.skipIf(skipDb)("邮件令牌 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it("并发消费同一令牌：30 个请求同时到达，恰好 1 个成功", async () => {
    const token = await issueEmailToken(DEMO.alice, "claim");
    const results = await Promise.all(
      Array.from({ length: 30 }, () => consumeEmailToken(token, "claim")),
    );
    expect(results.filter((r) => r === DEMO.alice)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(29);
    // 之后再用也是 null
    expect(await consumeEmailToken(token, "claim")).toBeNull();
  });

  it("多轮并发都成立（不是碰巧）：10 个令牌 × 每个 10 个并发请求", async () => {
    for (let round = 0; round < 10; round++) {
      const token = await issueEmailToken(DEMO.xiaoyi, "reset");
      const results = await Promise.all(
        Array.from({ length: 10 }, () => consumeEmailToken(token, "reset")),
      );
      expect(
        results.filter((r) => r !== null),
        `第 ${round + 1} 轮`,
      ).toHaveLength(1);
    }
  });

  it("用途不符不消费：错误用途的请求失败后，令牌仍可按正确用途使用一次", async () => {
    const token = await issueEmailToken(DEMO.member, "verify");
    expect(await consumeEmailToken(token, "reset")).toBeNull();
    expect(await consumeEmailToken(token, "claim")).toBeNull();
    expect(await consumeEmailToken(token, "verify")).toBe(DEMO.member);
  });

  it("过期令牌不可用，并且被拒绝的尝试不会把它标记为已用", async () => {
    const token = await issueEmailToken(DEMO.team, "reset");
    await getWebDb()
      .update(emailTokens)
      .set({ expiresAt: "2000-01-01 00:00:00" })
      .where(eq(emailTokens.id, hashToken(token)));
    expect(await consumeEmailToken(token, "reset")).toBeNull();
    const [row] = await getWebDb()
      .select({ usedAt: emailTokens.usedAt })
      .from(emailTokens)
      .where(eq(emailTokens.id, hashToken(token)));
    expect(row?.usedAt).toBeNull();
  });

  it("重签使旧令牌作废；空令牌与随机串不消费任何东西", async () => {
    const first = await issueEmailToken(DEMO.alice, "reset");
    const second = await issueEmailToken(DEMO.alice, "reset");
    expect(await consumeEmailToken(first, "reset")).toBeNull();
    expect(await consumeEmailToken(second, "reset")).toBe(DEMO.alice);
    expect(await consumeEmailToken("", "reset")).toBeNull();
    expect(await consumeEmailToken("not-a-real-token", "reset")).toBeNull();
  });

  it("消费成功才记邮箱已验证：并发消费后 emailVerifiedAt 只被置一次且不为空", async () => {
    const [before] = await getWebDb()
      .select({ at: users.emailVerifiedAt, email: users.email })
      .from(users)
      .where(eq(users.id, DEMO.team));
    expect(before?.email).toBeTruthy();
    const token = await issueEmailToken(DEMO.team, "verify");
    await Promise.all(Array.from({ length: 8 }, () => consumeEmailToken(token, "verify")));
    const [after] = await getWebDb()
      .select({ at: users.emailVerifiedAt })
      .from(users)
      .where(and(eq(users.id, DEMO.team)));
    expect(after?.at).toBeTruthy();
  });
});
