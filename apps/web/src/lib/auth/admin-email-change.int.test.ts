// @vitest-environment node
/**
 * 管理员代改邮箱（M11.3 清账）· 真实 MySQL 集成测试（临时库）。
 * 场景：用户注册时填错邮箱，登录门把他拦在外面，免登录重发又发回同一个错地址。
 * 管理员在后台改成正确邮箱并重新发起验证；用户点新地址里的链接，门自动解除，才能登录。
 */
import { and, eq } from "drizzle-orm";
import {
  DEMO,
  accountDeletionRequests,
  auditLog,
  emailTokens,
  getWebDb,
  sessions,
  users,
} from "@funwind/db";
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

import { changeEmailAddress } from "./email-change";
import { hashPassword } from "./password";
import { registerUser } from "./register";
import { SessionCreationError, createSession } from "./session";
import { consumeEmailToken, hashEmailKey } from "./tokens";

let tdb: TempDb;
const db = () => getWebDb();
const userRow = async (id: number) => (await db().select().from(users).where(eq(users.id, id)))[0]!;
const sessionRows = (userId: number) =>
  db().select().from(sessions).where(eq(sessions.userId, userId));
const tokensOf = (userId: number) =>
  db().select().from(emailTokens).where(eq(emailTokens.userId, userId));

const ADMIN = DEMO.admin;
const AUDIT = { actorId: ADMIN, action: "admin.user.email.change" };

let seq = 0;
/** gated=true：模拟开放注册且要求验证写下的两列；verified=true：注册后已完成验证 */
async function makeUser(opts: { gated?: boolean; verified?: boolean } = {}) {
  seq += 1;
  const email = `typo${seq}@exmaple.com`; // 故意填错的域名
  const id = await registerUser({
    username: `改邮箱${seq}`,
    email,
    passwordHash: await hashPassword("correct-horse-battery"),
    emailVerificationRequired: opts.gated ?? false,
    loginVerificationRequired: opts.gated ?? false,
    invite: null,
  });
  if (opts.verified) {
    await db()
      .update(users)
      .set({ emailVerifiedAt: new Date().toISOString().slice(0, 19).replace("T", " ") })
      .where(eq(users.id, id));
  }
  return { id, email };
}

const change = (userId: number, email: string, extra?: { allow?: () => boolean }) =>
  changeEmailAddress(userId, email, email.toLowerCase(), "203.0.113.9", extra?.allow, AUDIT);

describe.skipIf(skipDb)("管理员代改邮箱 · 真实 MySQL", () => {
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

  it("登录门账号：改邮箱后门仍关着，新令牌指向新地址，旧令牌作废", async () => {
    const u = await makeUser({ gated: true });
    const oldTokens = await tokensOf(u.id);
    const r = await change(u.id, "right@example.com");
    expect(r).toMatchObject({ kind: "changed", emailChanged: true, previouslyVerified: false });

    const row = await userRow(u.id);
    expect(row.email).toBe("right@example.com");
    expect(row.emailKey).toBe("right@example.com");
    expect(row.emailVerifiedAt).toBeNull();
    expect(row.emailVerificationRequired).toBe(true);
    expect(row.loginVerificationRequired).toBe(true); // 门仍关着：必须点新地址里的链接
    const live = await tokensOf(u.id);
    expect(live).toHaveLength(1);
    expect(live.map((t) => t.id)).not.toEqual(oldTokens.map((t) => t.id));
    await expect(createSession(u.id)).rejects.toBeInstanceOf(SessionCreationError);
  });

  it("自救闭环：用新令牌完成首次验证 → 登录门解除 → 能建会话", async () => {
    const u = await makeUser({ gated: true });
    const r = await change(u.id, "rescued@example.com");
    if (r.kind !== "changed") throw new Error("应为 changed");

    expect(await consumeEmailToken(r.verifyToken, "verify")).toBe(u.id);
    const row = await userRow(u.id);
    expect(row.emailVerifiedAt).not.toBeNull();
    expect(row.loginVerificationRequired).toBe(false);
    await createSession(u.id);
    expect(await sessionRows(u.id)).toHaveLength(1);
  });

  it("审计：操作者是管理员、动作名为 admin.user.email.change，邮箱只记哈希不记明文", async () => {
    const u = await makeUser({ gated: true });
    await change(u.id, "audit-me@example.com");
    const [row] = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetType, "user"),
          eq(auditLog.targetId, String(u.id)),
          eq(auditLog.action, "admin.user.email.change"),
        ),
      );
    expect(row).toBeDefined();
    expect(row!.actorId).toBe(ADMIN);
    const body = JSON.stringify([row!.beforeJson, row!.afterJson]);
    expect(body).toContain(hashEmailKey("audit-me@example.com"));
    expect(body).not.toContain("audit-me@example.com");
    expect(body).not.toContain(u.email);
  });

  it("已验证账号：改邮箱回到写权限受限，不拦登录；返回 previouslyVerified 供上层发告警", async () => {
    const u = await makeUser({ verified: true });
    const r = await change(u.id, "new-verified@example.com");
    expect(r).toMatchObject({ kind: "changed", previouslyVerified: true, beforeEmail: u.email });
    const row = await userRow(u.id);
    expect(row.emailVerifiedAt).toBeNull();
    expect(row.emailVerificationRequired).toBe(true);
    expect(row.loginVerificationRequired).toBe(false); // 改绑只拦写权限（Q9b）
    await createSession(u.id);
    expect(await sessionRows(u.id)).toHaveLength(1);
  });

  it("未验证账号提交同一个邮箱 = 重发：邮箱不变，旧令牌作废、签发新令牌", async () => {
    const u = await makeUser({ gated: true });
    const before = await tokensOf(u.id);
    const r = await change(u.id, u.email);
    expect(r).toMatchObject({ kind: "changed", emailChanged: false });
    const after = await tokensOf(u.id);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(before[0]?.id);
  });

  it("已验证账号提交同一个邮箱 → unchanged，什么都不改", async () => {
    const u = await makeUser({ verified: true });
    expect(await change(u.id, u.email)).toEqual({ kind: "unchanged" });
    expect((await userRow(u.id)).emailVerifiedAt).not.toBeNull();
  });

  it("邮箱已被其他账号占用 → taken，原邮箱与令牌不动", async () => {
    const a = await makeUser({ gated: true });
    const b = await makeUser({ gated: true });
    const tokensBefore = await tokensOf(a.id);
    expect(await change(a.id, b.email)).toEqual({ kind: "taken" });
    expect((await userRow(a.id)).email).toBe(a.email);
    expect((await tokensOf(a.id)).map((t) => t.id)).toEqual(tokensBefore.map((t) => t.id));
  });

  it("邮箱大小写不同也算占用（按归一化键比较）", async () => {
    const a = await makeUser({ gated: true });
    const b = await makeUser({ gated: true });
    expect(
      await changeEmailAddress(
        a.id,
        b.email.toUpperCase(),
        b.email.toLowerCase(),
        null,
        undefined,
        AUDIT,
      ),
    ).toEqual({ kind: "taken" });
  });

  it("目标地址限流 → rate_limited，整个事务回滚（邮箱不变、不留审计）", async () => {
    const u = await makeUser({ gated: true });
    const r = await change(u.id, "limited@example.com", { allow: () => false });
    expect(r).toEqual({ kind: "rate_limited" });
    expect((await userRow(u.id)).email).toBe(u.email);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.targetId, String(u.id)), eq(auditLog.action, "admin.user.email.change")),
      );
    expect(audits).toHaveLength(0);
  });

  it("账号不存在 / 已注销 / 注销冷静期 → missing（与限制、角色授予同口径）", async () => {
    expect(await change(987654321, "ghost@example.com")).toEqual({ kind: "missing" });

    const deleted = await makeUser({ gated: true });
    await db().update(users).set({ state: "deleted" }).where(eq(users.id, deleted.id));
    expect(await change(deleted.id, "deleted@example.com")).toEqual({ kind: "missing" });

    const closing = await makeUser({ gated: true });
    await db()
      .insert(accountDeletionRequests)
      .values({
        userId: closing.id,
        status: "pending",
        requestedAt: new Date().toISOString().slice(0, 19).replace("T", " "),
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString().slice(0, 19).replace("T", " "),
      });
    expect(await change(closing.id, "closing@example.com")).toEqual({ kind: "missing" });
    expect((await userRow(closing.id)).email).toBe(closing.email);
  });

  it("自助改邮箱路径不受影响：不传审计参数时仍记用户本人与 user.email.change，且不检查注销冷静期", async () => {
    const u = await makeUser({ gated: true });
    const r = await changeEmailAddress(u.id, "self@example.com", "self@example.com", null);
    expect(r).toMatchObject({ kind: "changed" });
    const [row] = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.targetId, String(u.id)), eq(auditLog.action, "user.email.change")));
    expect(row!.actorId).toBe(u.id);
  });
});
