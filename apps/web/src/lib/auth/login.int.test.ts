// @vitest-environment node
/**
 * 登录判定的真实 MySQL 集成测试（M5.6 S2，审查 C1 / C2）。
 * 每条性质都带对照组，证明测试自己能抓到问题；变异验证见 CHANGELOG。
 */
import { eq } from "drizzle-orm";
import { getWebDb, users } from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { LOGIN_LIMITS, MAX_IDENTIFIER_LENGTH, attemptLogin } from "./login";
import { hashPassword, verifyPassword } from "./password";
import { rateLimiterSize, resetRateLimiter } from "./ratelimit";
import { registerUser } from "./register";

let tdb: TempDb;
const PW = "correct-horse-battery";
let aliceId: number;

const login = (
  identifier: string,
  password: string,
  ip: string | null = "198.51.100.1",
  verify?: (h: string, p: string) => Promise<boolean>,
) => attemptLogin({ identifier, password, ip }, verify ? { verify } : {});

describe.skipIf(skipDb)("登录判定 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
    const hash = await hashPassword(PW);
    aliceId = await registerUser({
      username: "alice_s2",
      email: "alice-s2@example.com",
      passwordHash: hash,
      invite: null,
    });
    // 迁移来的账号：密码哈希为 NULL（走认领流程）
    const nohash = await registerUser({
      username: "nohash_s2",
      email: "nohash-s2@example.com",
      passwordHash: hash,
      invite: null,
    });
    await getWebDb().update(users).set({ passwordHash: null }).where(eq(users.id, nohash));
    // 已注销账号：不可登录
    const gone = await registerUser({
      username: "gone_s2",
      email: "gone-s2@example.com",
      passwordHash: hash,
      invite: null,
    });
    await getWebDb().update(users).set({ state: "deleted" }).where(eq(users.id, gone));
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(() => resetRateLimiter());

  describe("C1 · 恒定工作量（防时序枚举）", () => {
    const CASES: [string, string, string][] = [
      ["有密码的账号 · 密码错", "alice_s2", "wrong-password"],
      ["有密码的账号 · 密码对", "alice_s2", PW],
      ["用户不存在", "no-such-user", PW],
      ["密码哈希为 NULL（迁移账号）", "nohash_s2", PW],
      ["已注销账号", "gone_s2", PW],
      ["用邮箱登录", "alice-s2@example.com", PW],
      ["空标识符", "", PW],
      ["超长标识符", "x".repeat(MAX_IDENTIFIER_LENGTH + 1), PW],
    ];
    for (const [name, ident, pw] of CASES) {
      it(`${name}：恰好校验一次 argon2`, async () => {
        const verify = vi.fn(verifyPassword);
        await login(ident, pw, "198.51.100.1", verify);
        expect(verify).toHaveBeenCalledTimes(1);
      });
    }

    it("校验的对象：不存在 / 无密码时是假哈希（argon2id 格式，参数与真哈希相同），有密码时是真哈希", async () => {
      const seen: string[] = [];
      const spy = async (h: string, p: string) => {
        seen.push(h);
        return verifyPassword(h, p);
      };
      await login("alice_s2", PW, "198.51.100.1", spy);
      await login("no-such-user", PW, "198.51.100.1", spy);
      await login("nohash_s2", PW, "198.51.100.1", spy);
      const [real, dummy1, dummy2] = seen;
      expect(real).toMatch(/^\$argon2id\$/);
      expect(dummy1).toMatch(/^\$argon2id\$/);
      expect(dummy1).not.toBe(real);
      // 假哈希进程内只生成一次
      expect(dummy2).toBe(dummy1);
      // 参数段（$argon2id$v=19$m=19456,t=2,p=1$）一致：两类账号的校验开销相同
      const params = (h: string) => h.split("$").slice(1, 4).join("$");
      expect(params(dummy1!)).toBe(params(real!));
    });

    it("防护：假哈希恰好“匹配”时，无密码账号和不存在的账号也不能登录", async () => {
      const alwaysTrue = async () => true;
      expect(await login("nohash_s2", "任何密码", "198.51.100.1", alwaysTrue)).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(await login("no-such-user", "任何密码", "198.51.100.2", alwaysTrue)).toEqual({
        ok: false,
        reason: "invalid",
      });
    });

    it("对照：真实校验下，对的密码通过、错的不通过；已注销账号不能登录", async () => {
      expect(await login("alice_s2", PW)).toEqual({ ok: true, userId: aliceId });
      expect(await login("alice_s2", "nope")).toEqual({ ok: false, reason: "invalid" });
      expect(await login("gone_s2", PW)).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("C2 · 频控", () => {
    it("成功登录不消耗额度：同一 IP 连续成功 40 次都通过（对照：失败 5 次后即被挡）", async () => {
      for (let i = 0; i < 40; i++) expect(await login("alice_s2", PW)).toMatchObject({ ok: true });
      resetRateLimiter();
      const seq: string[] = [];
      for (let i = 0; i < LOGIN_LIMITS.pair.max + 2; i++) {
        const r = await login("alice_s2", "wrong");
        seq.push(r.ok ? "ok" : r.reason);
      }
      expect(seq).toEqual([
        "invalid",
        "invalid",
        "invalid",
        "invalid",
        "invalid",
        "throttled",
        "throttled",
      ]);
    });

    it("别的 IP 锁不住受害者：攻击者的 IP 被挡，受害者从另一 IP 用对的密码照常登录（对照：攻击者自己的 IP 连对的密码也被挡）", async () => {
      for (let i = 0; i < LOGIN_LIMITS.pair.max; i++)
        await login("alice_s2", "guess", "203.0.113.9");
      expect(await login("alice_s2", "guess", "203.0.113.9")).toEqual({
        ok: false,
        reason: "throttled",
      });
      expect(await login("alice_s2", PW, "203.0.113.9")).toEqual({
        ok: false,
        reason: "throttled",
      });
      expect(await login("alice_s2", PW, "192.0.2.77")).toEqual({ ok: true, userId: aliceId });
    });

    it("“尝试过于频繁”不泄露账号是否存在：存在与不存在的标识符，从 invalid 变 throttled 的时机完全一致", async () => {
      const run = async (ident: string, ip: string) => {
        const seq: string[] = [];
        for (let i = 0; i < 8; i++) {
          const r = await login(ident, "wrong", ip);
          seq.push(r.ok ? "ok" : r.reason);
        }
        return seq;
      };
      const existing = await run("alice_s2", "198.51.100.10");
      const missing = await run("ghost_s2_nobody", "198.51.100.11");
      const noHash = await run("nohash_s2", "198.51.100.12");
      expect(missing).toEqual(existing);
      expect(noHash).toEqual(existing);
      expect(existing.indexOf("throttled")).toBe(LOGIN_LIMITS.pair.max);
    });

    it("IP 桶：同一 IP 对不同账号撞库，超过上限后一律被挡（对照：另一个 IP 不受影响）", async () => {
      for (let i = 0; i < LOGIN_LIMITS.ip.max; i++) await login(`guess-${i}`, "x", "198.18.0.1");
      expect(await login("guess-new", "x", "198.18.0.1")).toEqual({
        ok: false,
        reason: "throttled",
      });
      expect(await login("alice_s2", PW, "198.18.0.1")).toEqual({ ok: false, reason: "throttled" });
      expect(await login("alice_s2", PW, "198.18.0.2")).toMatchObject({ ok: true });
    });

    it("用户总桶：分布式爆破累计 30 次失败后，连对的密码也只得到 invalid（不是 throttled）；对照：29 次时仍可登录；用户名与邮箱共用同一个桶", async () => {
      const max = LOGIN_LIMITS.user.max;
      // 15 次用用户名、14 次用邮箱，各自来自不同 IP（每个 IP 桶都远没到上限）
      for (let i = 0; i < max - 1; i++) {
        const ident = i < 15 ? "alice_s2" : "alice-s2@example.com";
        expect(await login(ident, "guess", `10.1.0.${i}`)).toEqual({
          ok: false,
          reason: "invalid",
        });
      }
      // 29 次失败：合法用户从新 IP 仍能登录（成功会退还额度）
      expect(await login("alice_s2", PW, "10.2.0.1")).toEqual({ ok: true, userId: aliceId });
      // 再来 1 次失败 → 30 次，总桶满
      expect(await login("alice-s2@example.com", "guess", "10.1.1.1")).toEqual({
        ok: false,
        reason: "invalid",
      });
      const locked = await login("alice_s2", PW, "10.2.0.2");
      expect(locked).toEqual({ ok: false, reason: "invalid" });
      // 邮箱登录同样被总桶挡住（归并到同一个用户 id）
      expect(await login("alice-s2@example.com", PW, "10.2.0.3")).toEqual({
        ok: false,
        reason: "invalid",
      });
    });

    it("标识符限长：超长随机标识符不进桶键，桶表不被撑大（对照：正常长度的标识符会各建一个桶）", async () => {
      resetRateLimiter();
      for (let i = 0; i < 50; i++)
        await login(`${"x".repeat(MAX_IDENTIFIER_LENGTH)}${i}`, "x", null);
      expect(rateLimiterSize()).toBe(0);
      for (let i = 0; i < 50; i++) await login(`short-${i}`, "x", null);
      expect(rateLimiterSize()).toBe(50);
    });

    it("并发不能绕过：20 个并发的错误猜测，恰好 5 个拿到 invalid，其余 15 个 throttled", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => login("alice_s2", "guess", "198.51.100.50")),
      );
      const invalid = results.filter((r) => !r.ok && r.reason === "invalid").length;
      const throttled = results.filter((r) => !r.ok && r.reason === "throttled").length;
      expect({ invalid, throttled }).toEqual({ invalid: LOGIN_LIMITS.pair.max, throttled: 15 });
    });

    it("无可信 IP：(IP, 标识符) 桶退化为只按标识符分桶，IP 桶不参与（共享桶会被攻击者占满，见 client-ip.ts）", async () => {
      const seq: string[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await login("alice_s2", "guess", null);
        seq.push(r.ok ? "ok" : r.reason);
      }
      expect(seq.indexOf("throttled")).toBe(LOGIN_LIMITS.pair.max);
      // 其他标识符不受影响（没有共享的 IP 桶）
      expect(await login("nohash_s2", "guess", null)).toEqual({ ok: false, reason: "invalid" });
    });
  });
});
