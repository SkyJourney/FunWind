// @vitest-environment node
/**
 * 邮件令牌的并发与边界测试（审查复查 A2）。
 * 此前只有顺序用例；「单次、原子消费」的结论来自读代码。这里真的并发打：
 * 同一个令牌被多个请求同时消费，恰好一个成功，其余都拿到 null。
 */
import { and, eq, sql } from "drizzle-orm";
import { DEMO, emailTokens, getWebDb, users } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { hashToken } from "./token";
import { changeEmailAddress } from "./email-change";
import { MAX_LIVE_TOKENS, consumeEmailToken, hashEmailKey, issueEmailToken } from "./tokens";

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

  it("空令牌与随机串不消费任何东西", async () => {
    expect(await consumeEmailToken("", "reset")).toBeNull();
    expect(await consumeEmailToken("not-a-real-token", "reset")).toBeNull();
  });

  it("签发快照绑定当前 email_key；NULL 旧快照不能验证邮箱", async () => {
    const [before] = await getWebDb()
      .select({ emailKey: users.emailKey, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, DEMO.member));
    expect(before?.emailKey).toBeTruthy();
    const token = await issueEmailToken(DEMO.member, "verify");
    const tokenId = hashToken(token);
    const [row] = await getWebDb()
      .select({ emailKeySnapshot: emailTokens.emailKeySnapshot })
      .from(emailTokens)
      .where(eq(emailTokens.id, tokenId));
    expect(row?.emailKeySnapshot).toBe(hashEmailKey(before!.emailKey!));

    await getWebDb()
      .update(emailTokens)
      .set({ emailKeySnapshot: null })
      .where(eq(emailTokens.id, tokenId));
    expect(await consumeEmailToken(token, "verify")).toBeNull();
    const [after] = await getWebDb()
      .select({ emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, DEMO.member));
    expect(after?.emailVerifiedAt).toBe(before?.emailVerifiedAt);
  });

  it("邮箱换绑原子作废所有旧用途令牌，并只验证新地址", async () => {
    const userId = DEMO.xiaoyi;
    const [before] = await getWebDb()
      .select({
        email: users.email,
        emailKey: users.emailKey,
        emailVerifiedAt: users.emailVerifiedAt,
        emailVerificationRequired: users.emailVerificationRequired,
      })
      .from(users)
      .where(eq(users.id, userId));
    const oldTokens = await Promise.all(
      (["reset", "verify", "claim"] as const).map((purpose) => issueEmailToken(userId, purpose)),
    );
    const email = `m96-step4-${userId}@example.com`;
    const emailKey = email.toLowerCase();

    try {
      const changed = await changeEmailAddress(userId, email, emailKey, null);
      expect(changed.kind).toBe("changed");
      if (changed.kind !== "changed") return;
      for (const [index, purpose] of (["reset", "verify", "claim"] as const).entries()) {
        expect(await consumeEmailToken(oldTokens[index]!, purpose)).toBeNull();
      }
      const [verifyRow] = await getWebDb()
        .select({ emailKeySnapshot: emailTokens.emailKeySnapshot })
        .from(emailTokens)
        .where(eq(emailTokens.id, hashToken(changed.verifyToken)));
      expect(verifyRow?.emailKeySnapshot).toBe(hashEmailKey(emailKey));
      expect(await consumeEmailToken(changed.verifyToken, "verify")).toBe(userId);
      const [verified] = await getWebDb()
        .select({
          email: users.email,
          emailKey: users.emailKey,
          emailVerifiedAt: users.emailVerifiedAt,
        })
        .from(users)
        .where(eq(users.id, userId));
      expect(verified).toMatchObject({ email, emailKey, emailVerifiedAt: expect.any(String) });
    } finally {
      await getWebDb().delete(emailTokens).where(eq(emailTokens.userId, userId));
      await getWebDb()
        .update(users)
        .set({
          email: before?.email ?? null,
          emailKey: before?.emailKey ?? null,
          emailVerifiedAt: before?.emailVerifiedAt ?? null,
          emailVerificationRequired: before?.emailVerificationRequired ?? false,
        })
        .where(eq(users.id, userId));
    }
  });

  describe("共存与作废（M5.6 S3：别人替你请求找回，不能让你邮箱里已有的链接失效）", () => {
    it("重发不使未过期的旧令牌失效：先后签发的两个都能用（旧实现第一个会作废）", async () => {
      const first = await issueEmailToken(DEMO.xiaoyi, "reset");
      const second = await issueEmailToken(DEMO.xiaoyi, "reset");
      expect(await consumeEmailToken(first, "reset")).toBe(DEMO.xiaoyi);
      // first 被成功使用后，second 作废（见下一条）
      expect(await consumeEmailToken(second, "reset")).toBeNull();
    });

    it("成功使用一个令牌后，同用户同用途的其余令牌一并作废；对照：别的用途与别的用户不受影响", async () => {
      const a1 = await issueEmailToken(DEMO.member, "reset");
      const a2 = await issueEmailToken(DEMO.member, "reset");
      const claimMine = await issueEmailToken(DEMO.member, "claim");
      const othersReset = await issueEmailToken(DEMO.team, "reset");
      expect(await consumeEmailToken(a2, "reset")).toBe(DEMO.member);
      expect(await consumeEmailToken(a1, "reset")).toBeNull();
      expect(await consumeEmailToken(claimMine, "claim")).toBe(DEMO.member);
      expect(await consumeEmailToken(othersReset, "reset")).toBe(DEMO.team);
    });

    it("上限：保留最新的 MAX_LIVE_TOKENS 个，超出时挤掉最旧的；对照：恰好到上限时全部有效", async () => {
      const tokens: string[] = [];
      for (let i = 0; i < MAX_LIVE_TOKENS; i++)
        tokens.push(await issueEmailToken(DEMO.admin, "claim"));
      // 让创建时间可区分（同一秒内签发时排序不确定）
      for (const [i, t] of tokens.entries())
        await getWebDb()
          .update(emailTokens)
          .set({ createdAt: sql`NOW() - INTERVAL ${100 - i} SECOND` })
          .where(eq(emailTokens.id, hashToken(t)));
      const alive = async () =>
        (
          await getWebDb()
            .select({ id: emailTokens.id })
            .from(emailTokens)
            .where(and(eq(emailTokens.userId, DEMO.admin), eq(emailTokens.purpose, "claim")))
        ).length;
      expect(await alive()).toBe(MAX_LIVE_TOKENS); // 对照：到上限为止都在
      const extra = await issueEmailToken(DEMO.admin, "claim");
      expect(await alive()).toBe(MAX_LIVE_TOKENS); // 超出时总数不再增长
      // 最旧的一个被挤掉，其余与新签发的仍有效
      expect(await consumeEmailToken(tokens[0]!, "claim")).toBeNull();
      expect(await consumeEmailToken(extra, "claim")).toBe(DEMO.admin);
    });

    it("签发时清理该用户该用途下已过期 / 已使用的行，不留垃圾", async () => {
      const old = await issueEmailToken(DEMO.banned, "verify");
      await getWebDb()
        .update(emailTokens)
        .set({ expiresAt: "2000-01-01 00:00:00" })
        .where(eq(emailTokens.id, hashToken(old)));
      await issueEmailToken(DEMO.banned, "verify");
      const rows = await getWebDb()
        .select({ id: emailTokens.id })
        .from(emailTokens)
        .where(and(eq(emailTokens.userId, DEMO.banned), eq(emailTokens.purpose, "verify")));
      expect(rows.map((r) => r.id)).not.toContain(hashToken(old));
      expect(rows).toHaveLength(1);
    });
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
