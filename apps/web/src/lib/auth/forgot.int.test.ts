// @vitest-environment node
/**
 * 找回 / 认领发信判定的真实 MySQL 集成测试（M5.6 S3）。
 * 核心性质：响应返回时，对存在与不存在的邮箱都还没有签发令牌、没有发信——发信被交给 defer，
 * 响应时间因此与邮箱是否存在无关（旧实现对存在的邮箱 await 发信，能枚举注册邮箱）。
 */
import { eq } from "drizzle-orm";
import { DEMO, emailTokens, getWebDb, users } from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { FORGOT_LIMITS, requestAccountEmail } from "./forgot";
import { resetRateLimiter } from "./ratelimit";
import { registerUser } from "./register";

let tdb: TempDb;
let aliceEmail: string; // 无密码（认领）
let xiaoyiEmail: string; // 已设密（重置）

type Task = () => Promise<void>;
function harness() {
  const tasks: Task[] = [];
  const delivered: { id: number; hasPassword: boolean; email: string }[] = [];
  const deps = {
    defer: (t: Task) => void tasks.push(t),
    deliver: async (u: { id: number; hasPassword: boolean }, email: string) => {
      delivered.push({ ...u, email });
    },
  };
  return { tasks, delivered, deps };
}
const runAll = async (tasks: Task[]) => {
  for (const t of tasks) await t();
};
const tokenRows = async () => (await getWebDb().select().from(emailTokens)).length;

describe.skipIf(skipDb)("找回 / 认领 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    const [a] = await getWebDb()
      .select({ e: users.email })
      .from(users)
      .where(eq(users.id, DEMO.alice));
    const [x] = await getWebDb()
      .select({ e: users.email })
      .from(users)
      .where(eq(users.id, DEMO.xiaoyi));
    aliceEmail = a!.e!;
    xiaoyiEmail = x!.e!;
    // 夹具里 xiaoyi 需要有密码才走“重置”分支
    await getWebDb().update(users).set({ passwordHash: "hash" }).where(eq(users.id, DEMO.xiaoyi));
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(() => resetRateLimiter());

  it("响应返回时还没有签发令牌也没有发信：存在与不存在的邮箱表现完全一致（旧实现对存在的邮箱 await 发信）", async () => {
    const before = await tokenRows();
    const missing = harness();
    await requestAccountEmail("nobody@example.com", "198.51.100.1", missing.deps);
    const existing = harness();
    await requestAccountEmail(xiaoyiEmail, "198.51.100.2", existing.deps);

    // 返回时：都没有发信，也没有写令牌
    expect(missing.delivered).toHaveLength(0);
    expect(existing.delivered).toHaveLength(0);
    expect(await tokenRows()).toBe(before);
    // 区别只在“是否登记了延后任务”，这对外不可见
    expect(missing.tasks).toHaveLength(0);
    expect(existing.tasks).toHaveLength(1);
    // 对照：延后任务运行后才真正发信
    await runAll(existing.tasks);
    expect(existing.delivered).toEqual([
      { id: DEMO.xiaoyi, hasPassword: true, email: xiaoyiEmail },
    ]);
  });

  it("慢速投递不拖慢响应：投递要 300ms，请求仍在远小于此的时间内返回", async () => {
    const tasks: Task[] = [];
    const slow = async () => new Promise<void>((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await requestAccountEmail(xiaoyiEmail, "198.51.100.3", {
      defer: (t) => void tasks.push(t),
      deliver: slow,
    });
    expect(Date.now() - t0).toBeLessThan(150);
    const t1 = Date.now();
    await runAll(tasks);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(280); // 对照：投递本身确实慢
  });

  it("老账号（无密码）走认领分支，已设密账号走重置分支", async () => {
    const h = harness();
    await requestAccountEmail(aliceEmail, "198.51.100.4", h.deps);
    await runAll(h.tasks);
    expect(h.delivered[0]).toMatchObject({ id: DEMO.alice, hasPassword: false });
  });

  it("投递失败只记日志，不抛出（响应早已发出）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const tasks: Task[] = [];
      await requestAccountEmail(xiaoyiEmail, "198.51.100.5", {
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

  describe("频控", () => {
    it("同一账号：2 分钟冷却内第二次请求不再发信（对照：第一次发了）", async () => {
      const h = harness();
      await requestAccountEmail(xiaoyiEmail, "198.51.100.6", h.deps);
      await requestAccountEmail(xiaoyiEmail, "198.51.100.7", h.deps); // 换 IP 也一样：按账号限
      expect(h.tasks).toHaveLength(FORGOT_LIMITS.cooldown.max);
    });

    it("IP 桶：同一 IP 超过上限后一律不发（对照：另一个 IP 不受影响）", async () => {
      const noise = harness();
      for (let i = 0; i < FORGOT_LIMITS.ip.max; i++)
        await requestAccountEmail(`noise${i}@example.com`, "203.0.113.50", noise.deps);
      const blocked = harness();
      await requestAccountEmail(xiaoyiEmail, "203.0.113.50", blocked.deps);
      expect(blocked.tasks).toHaveLength(0);
      const other = harness();
      await requestAccountEmail(xiaoyiEmail, "203.0.113.51", other.deps);
      expect(other.tasks).toHaveLength(1);
    });

    it("无可信 IP：全局兜底桶只对真实账号计数——随机邮箱烧不掉它（否则一个客户端就能让所有人收不到邮件）", async () => {
      // 攻击者灌 500 个不存在的邮箱：查不到账号就返回，不占全局名额
      const noise = harness();
      for (let i = 0; i < 500; i++)
        await requestAccountEmail(`nobody${i}@example.com`, null, noise.deps);
      expect(noise.tasks).toHaveLength(0);
      // 对照：真实用户此时仍然能收到邮件
      const real = harness();
      await requestAccountEmail(xiaoyiEmail, null, real.deps);
      expect(real.tasks).toHaveLength(1);
    });

    it("无可信 IP：真实账号的请求累计超过全局上限后不再发（整体发信量有上限）；对账号的重复请求先被冷却挡住、不占全局名额；有可信 IP 的访客不受影响", async () => {
      // 造足够多的真实账号（只要有邮箱即可）
      const emails: string[] = [];
      for (let i = 0; i < FORGOT_LIMITS.global.max; i++) {
        const email = `bulk${i}@example.com`;
        await registerUser({ username: `bulk_${i}`, email, passwordHash: "x", invite: null });
        emails.push(email);
      }
      const h = harness();
      for (const e of emails) await requestAccountEmail(e, null, h.deps);
      expect(h.tasks).toHaveLength(FORGOT_LIMITS.global.max); // 恰好用满
      // 对第 1 个账号再请求：被账号冷却挡住（在全局桶之前），不会多占名额
      await requestAccountEmail(emails[0]!, null, h.deps);
      expect(h.tasks).toHaveLength(FORGOT_LIMITS.global.max);
      // 全局名额已满：另一个真实账号（从未请求过）被丢弃
      await requestAccountEmail(xiaoyiEmail, null, h.deps);
      expect(h.tasks).toHaveLength(FORGOT_LIMITS.global.max);
      // 有可信 IP 的访客走 IP 桶，不受全局桶影响
      const withIp = harness();
      await requestAccountEmail(aliceEmail, "198.51.100.8", withIp.deps);
      expect(withIp.tasks).toHaveLength(1);
    });

    it("空邮箱与超长邮箱直接忽略：不查库、不占用账号额度", async () => {
      const h = harness();
      await requestAccountEmail("", "198.51.100.9", h.deps);
      await requestAccountEmail(`${"a".repeat(300)}@example.com`, "198.51.100.9", h.deps);
      expect(h.tasks).toHaveLength(0);
      await requestAccountEmail(xiaoyiEmail, "198.51.100.9", h.deps); // 额度仍在
      expect(h.tasks).toHaveLength(1);
    });
  });
});
