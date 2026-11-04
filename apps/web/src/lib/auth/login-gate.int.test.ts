// @vitest-environment node
/**
 * 登录验证门（M11.3）· 真实 MySQL 集成测试（临时库）。
 * 门放在 createSessionInTx（唯一会话创建入口）：标记为真的账号在首次验证成功前不能建会话；
 * 首次验证成功即清除，之后改绑邮箱不再被拦；导入（历史）账号标记为 false，登录不受影响。
 */
import { eq } from "drizzle-orm";
import { DEMO, getWebDb, sessions, users } from "@funwind/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

// 会话创建会写 cookie；用内存罐替身，其余全是真实代码与真实数据库
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

import { attemptLogin } from "./login";
import { changeEmailAddress } from "./email-change";
import { hashPassword } from "./password";
import { registerUser } from "./register";
import { SessionCreationError, createSession } from "./session";
import { consumeEmailToken, issueEmailToken } from "./tokens";

let tdb: TempDb;
const db = () => getWebDb();
const sessionRows = (userId: number) =>
  db().select().from(sessions).where(eq(sessions.userId, userId));
const userRow = async (id: number) => (await db().select().from(users).where(eq(users.id, id)))[0]!;

let seq = 0;
/** 注册一个账号；gated=true 模拟「开放注册且站点要求验证」写下的两列 */
async function makeUser(gated: boolean, password = "correct-horse-battery") {
  seq += 1;
  const email = `gate${seq}@example.com`;
  const id = await registerUser({
    username: `登录门${seq}`,
    email,
    passwordHash: await hashPassword(password),
    emailVerificationRequired: gated,
    loginVerificationRequired: gated,
    invite: null,
  });
  return { id, email, password };
}

describe.skipIf(skipDb)("登录验证门 · 真实 MySQL", () => {
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });
  beforeEach(async () => {
    jar.clear();
    await db().delete(sessions);
  });

  describe("createSession（唯一入口）", () => {
    it("标记为真且未验证 → email_unverified，不写会话也不写 cookie", async () => {
      const u = await makeUser(true);
      await expect(createSession(u.id)).rejects.toMatchObject({
        name: "SessionCreationError",
        code: "email_unverified",
      });
      expect(await sessionRows(u.id)).toHaveLength(0);
      expect(jar.size).toBe(0);
    });

    it("标记为假（邀请注册 / 站点没开验证）→ 正常建会话，即使 email_verified_at 为空", async () => {
      const u = await makeUser(false);
      expect((await userRow(u.id)).emailVerifiedAt).toBeNull();
      await createSession(u.id);
      expect(await sessionRows(u.id)).toHaveLength(1);
    });

    it("导入的历史账号（夹具用户，标记默认 false）登录不受影响——防止一次性锁死全部导入用户", async () => {
      expect((await userRow(DEMO.member)).loginVerificationRequired).toBe(false);
      await createSession(DEMO.member);
      expect(await sessionRows(DEMO.member)).toHaveLength(1);
    });
  });

  describe("首次验证成功即清除标记", () => {
    it("消费 verify 令牌 → 同时写 email_verified_at 并清除标记 → 之后可以登录", async () => {
      const u = await makeUser(true);
      await expect(createSession(u.id)).rejects.toBeInstanceOf(SessionCreationError);

      const token = await issueEmailToken(u.id, "verify", u.email);
      expect(await consumeEmailToken(token, "verify")).toBe(u.id);

      const after = await userRow(u.id);
      expect(after.emailVerifiedAt).not.toBeNull();
      expect(after.loginVerificationRequired).toBe(false);
      await createSession(u.id);
      expect(await sessionRows(u.id)).toHaveLength(1);
    });

    it("回归：早已验证的用户改绑邮箱后仍可登录（改绑只拦写权限，不拦登录）", async () => {
      const u = await makeUser(true);
      await consumeEmailToken(await issueEmailToken(u.id, "verify", u.email), "verify");

      const changed = await changeEmailAddress(
        u.id,
        "changed-gate@example.com",
        "changed-gate@example.com",
        null,
      );
      expect(changed.kind).toBe("changed");
      const row = await userRow(u.id);
      // 改绑把验证状态重置了，也把写权限门置真……
      expect(row.emailVerifiedAt).toBeNull();
      expect(row.emailVerificationRequired).toBe(true);
      // ……但登录门已在首次验证时清除，改绑不会把它重新拦住
      expect(row.loginVerificationRequired).toBe(false);
      await createSession(u.id);
      expect(await sessionRows(u.id)).toHaveLength(1);
    });

    it("改绑邮箱本身从不写登录门：对一个没有标记的账号改绑，标记仍为 false", async () => {
      const u = await makeUser(false);
      await changeEmailAddress(u.id, "other-gate@example.com", "other-gate@example.com", null);
      expect((await userRow(u.id)).loginVerificationRequired).toBe(false);
    });
  });

  describe("attemptLogin 的密码校验先于验证状态判定（防枚举）", () => {
    it("密码正确的未验证账号：attemptLogin 通过密码校验，是会话创建阶段才被门拦下", async () => {
      const u = await makeUser(true);
      const outcome = await attemptLogin({ identifier: u.email, password: u.password, ip: null });
      expect(outcome).toMatchObject({ ok: true, userId: u.id });
      await expect(createSession(u.id)).rejects.toMatchObject({ code: "email_unverified" });
    });

    it("密码错误的未验证账号：与不存在的账号一样只得到 invalid，看不到任何「未验证」信息", async () => {
      const u = await makeUser(true);
      const wrong = await attemptLogin({
        identifier: u.email,
        password: "wrong-password",
        ip: null,
      });
      const ghost = await attemptLogin({
        identifier: "nobody-here@example.com",
        password: "wrong-password",
        ip: null,
      });
      expect(wrong).toEqual({ ok: false, reason: "invalid" });
      expect(ghost).toEqual(wrong);
    });
  });
});
