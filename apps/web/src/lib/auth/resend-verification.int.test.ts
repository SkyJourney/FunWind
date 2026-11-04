// @vitest-environment node
/**
 * 免登录重发验证邮件（M11.3）· 真实 MySQL 集成测试。
 * 核心性质（同 forgot.int.test）：响应返回时对存在与不存在的邮箱都还没有签发令牌、没有发信，发信交给 defer。
 * 另有本功能特有的：只对「登录验证门仍然关着」的账号发信，且限流与找回密码互不占用。
 */
import { eq } from "drizzle-orm";
import { emailTokens, getWebDb, users } from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { FORGOT_LIMITS, requestAccountEmail } from "./forgot";
import { resetRateLimiter } from "./ratelimit";
import { registerUser } from "./register";
import { RESEND_VERIFY_LIMITS, requestVerificationResend } from "./resend-verification";

let tdb: TempDb;
let seq = 0;
type Task = () => Promise<void>;

function harness() {
  const tasks: Task[] = [];
  const delivered: { id: number; email: string }[] = [];
  const deps = {
    defer: (t: Task) => void tasks.push(t),
    deliver: async (u: { id: number }, email: string) => {
      delivered.push({ id: u.id, email });
    },
  };
  return { tasks, delivered, deps };
}
const runAll = async (tasks: Task[]) => {
  for (const t of tasks) await t();
};
const tokenRows = async () => (await getWebDb().select().from(emailTokens)).length;

/** 注册一个账号；gated=true 即「开放注册且站点要求验证」写下的登录门标记 */
async function makeUser(gated: boolean) {
  seq += 1;
  const email = `resend${seq}@example.com`;
  const id = await registerUser({
    username: `重发${seq}`,
    email,
    passwordHash: "hash",
    emailVerificationRequired: gated,
    loginVerificationRequired: gated,
    invite: null,
  });
  return { id, email };
}

describe.skipIf(skipDb)("免登录重发验证邮件 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(() => resetRateLimiter());

  it("只对待验证（登录门仍关着）的账号发信；不存在 / 本来无需验证 / 已验证一律静默", async () => {
    const pending = await makeUser(true);
    const plain = await makeUser(false);
    const verified = await makeUser(true);
    await getWebDb()
      .update(users)
      .set({
        loginVerificationRequired: false,
        emailVerifiedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
      })
      .where(eq(users.id, verified.id));

    const cases = [
      { email: pending.email, ip: "198.51.100.10", expectTask: true },
      { email: plain.email, ip: "198.51.100.11", expectTask: false },
      { email: verified.email, ip: "198.51.100.12", expectTask: false },
      { email: "nobody@example.com", ip: "198.51.100.13", expectTask: false },
    ];
    for (const c of cases) {
      const h = harness();
      await requestVerificationResend(c.email, c.ip, h.deps);
      expect(h.tasks.length, c.email).toBe(c.expectTask ? 1 : 0);
    }
  });

  it("响应返回时还没有签发令牌也没有发信：待验证与不存在的邮箱对外表现一致", async () => {
    const pending = await makeUser(true);
    const before = await tokenRows();
    const missing = harness();
    await requestVerificationResend("nobody@example.com", "198.51.100.20", missing.deps);
    const existing = harness();
    await requestVerificationResend(pending.email, "198.51.100.21", existing.deps);

    expect(missing.delivered).toHaveLength(0);
    expect(existing.delivered).toHaveLength(0);
    expect(await tokenRows()).toBe(before);
    await runAll(existing.tasks);
    expect(existing.delivered).toEqual([{ id: pending.id, email: pending.email }]);
  });

  it("账号冷却：2 分钟内重复申请被静默丢弃，不签发第二次", async () => {
    const pending = await makeUser(true);
    const first = harness();
    await requestVerificationResend(pending.email, "198.51.100.30", first.deps);
    const second = harness();
    await requestVerificationResend(pending.email, "198.51.100.31", second.deps);
    expect(first.tasks).toHaveLength(1);
    expect(second.tasks).toHaveLength(0);
    expect(RESEND_VERIFY_LIMITS.cooldown.max).toBe(1);
  });

  it("IP 限额：同一 IP 超过上限后，连真实待验证账号也不再发信", async () => {
    const accounts = [] as { id: number; email: string }[];
    for (let i = 0; i < RESEND_VERIFY_LIMITS.ip.max + 1; i++) accounts.push(await makeUser(true));
    const results: number[] = [];
    for (const a of accounts) {
      const h = harness();
      await requestVerificationResend(a.email, "198.51.100.40", h.deps);
      results.push(h.tasks.length);
    }
    expect(results.slice(0, RESEND_VERIFY_LIMITS.ip.max).every((n) => n === 1)).toBe(true);
    expect(results.at(-1)).toBe(0);
  });

  it("无可信 IP（null）：账号冷却仍然生效；输入异常（空、超长）直接返回", async () => {
    const pending = await makeUser(true);
    const a = harness();
    await requestVerificationResend(pending.email, null, a.deps);
    const b = harness();
    await requestVerificationResend(pending.email, null, b.deps);
    expect([a.tasks.length, b.tasks.length]).toEqual([1, 0]);

    for (const bad of ["", "   ", `${"a".repeat(400)}@example.com`]) {
      const h = harness();
      await requestVerificationResend(bad, "198.51.100.41", h.deps);
      expect(h.tasks).toHaveLength(0);
    }
  });

  it("额度独立：用完找回密码的 IP 额度，不影响重发验证；反之亦然", async () => {
    const pending = await makeUser(true);
    const ip = "198.51.100.50";
    // 把找回密码这个 IP 的额度烧光
    for (let i = 0; i < FORGOT_LIMITS.ip.max + 1; i++) {
      await requestAccountEmail(`ghost${i}@example.com`, ip, { defer: () => undefined });
    }
    const forgotBlocked = harness();
    await requestAccountEmail(pending.email, ip, forgotBlocked.deps);
    expect(forgotBlocked.tasks).toHaveLength(0); // 找回确实被限额挡住了

    const h = harness();
    await requestVerificationResend(pending.email, ip, h.deps);
    expect(h.tasks).toHaveLength(1); // 重发验证不受影响
  });

  it("投递失败只记日志，不抛出（响应早已发出）", async () => {
    const pending = await makeUser(true);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const tasks: Task[] = [];
      await requestVerificationResend(pending.email, "198.51.100.60", {
        defer: (t) => void tasks.push(t),
        deliver: async () => {
          throw new Error("smtp down");
        },
      });
      await expect(runAll(tasks)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
