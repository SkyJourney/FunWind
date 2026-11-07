// @vitest-environment node
/**
 * 安装管线的真实 MySQL 集成测试（M12 Step 1）：
 * 从「只建库、不 bootstrap」的空库出发走完六个步骤，覆盖幂等重入、崩溃窗口自愈、
 * 防重装保护（users 非空拒绝）、向导写入的 register.policy 经 getRegisterPolicy 读出生效、
 * lock 后所有步骤拒绝。与 temp-db.ts 同套路，但**不做 bootstrap**——空库正是安装管线的起点。
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLog,
  createPool,
  getWebDb,
  getWebPool,
  newDbConfig,
  normalizeKey,
  siteSettings,
  userRoles,
  users,
} from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "@/lib/auth/password";
import { registerUser } from "@/lib/auth/register";
import { getRegisterPolicy } from "@/lib/auth/settings";
import { isInstalled, removeInstallLock, writeInstallLock } from "./lock";
import { INSTALL_STEPS, runInstall, runInstallStep } from "./run-install";
import { installConfigFromEnv, type InstallConfig } from "./schema";

const base = newDbConfig();
const dbName = `funwind_install_it_${randomBytes(4).toString("hex")}`;
const storageDir = mkdtempSync(path.join(tmpdir(), "funwind-install-it-"));
const adminPool = createPool({ ...base, database: "information_schema" });

const config: InstallConfig = installConfigFromEnv({
  site: { name: "安装测试站", tagline: "集成测试", url: "http://127.0.0.1:3203" },
  themePack: "qy2010",
  registration: { mode: "open", verifyEmail: true },
  admin: { username: "inst_admin", email: "inst-admin@example.com", password: "install-pass-123" },
});

beforeAll(async () => {
  await adminPool.query(
    `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
  );
  // 运行时单例池与管线的 newDbConfig() 都读 env：必须在任何 getWebDb() 之前指到临时库
  process.env.NEW_DB_NAME = dbName;
  process.env.STORAGE_DIR = storageDir;
});

afterAll(async () => {
  try {
    await getWebPool().end();
  } catch {
    /* 未建池则跳过 */
  }
  (globalThis as unknown as { __funwindPool?: unknown }).__funwindPool = undefined;
  await adminPool.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await adminPool.end();
  rmSync(storageDir, { recursive: true, force: true });
  delete process.env.STORAGE_DIR;
  if (process.env.NEW_DB_NAME === dbName) delete process.env.NEW_DB_NAME;
});

const adminRoleOf = async (userId: number) =>
  getWebDb()
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(eq(userRoles.userId, userId), eq(userRoles.roleKey, "admin"), eq(userRoles.scopeId, 0)),
    );

describe.skipIf(process.env.SKIP_DB_TESTS === "1")("安装管线（真实 MySQL，M12 Step 1）", () => {
  it("步骤顺序常量与文档一致（六步）", () => {
    expect([...INSTALL_STEPS]).toEqual([
      "connection",
      "create-db",
      "bootstrap",
      "site-settings",
      "admin",
      "lock",
    ]);
  });

  it(
    "connection → create-db（重复执行幂等）→ bootstrap：空库成为可用 schema，users 为空",
    // bootstrap 跑 25 个迁移的 DDL：全量并发压库时远超默认 5 秒单测超时
    { timeout: 120_000 },
    async () => {
      expect(await isInstalled()).toBe(false);
      expect((await runInstallStep("connection", config)).ok).toBe(true);
      expect((await runInstallStep("create-db", config)).ok).toBe(true);
      expect((await runInstallStep("create-db", config)).ok).toBe(true); // IF NOT EXISTS 重入
      expect((await runInstallStep("bootstrap", config)).ok).toBe(true);
      const [row] = await getWebDb().select({ n: users.id }).from(users).limit(1);
      expect(row).toBeUndefined();
    },
  );

  it(
    "故障分支：数据库不可达时 connection / create-db / bootstrap 分别给出专属错误码",
    { timeout: 60_000 },
    async () => {
      const prevPort = process.env.NEW_DB_PORT;
      process.env.NEW_DB_PORT = "1"; // 本机必然拒绝连接的端口
      try {
        expect(await runInstallStep("connection", config)).toMatchObject({
          ok: false,
          code: "db-unreachable",
        });
        expect(await runInstallStep("create-db", config)).toMatchObject({
          ok: false,
          code: "db-create-denied",
        });
        expect(await runInstallStep("bootstrap", config)).toMatchObject({
          ok: false,
          code: "bootstrap-failed",
        });
      } finally {
        if (prevPort === undefined) delete process.env.NEW_DB_PORT;
        else process.env.NEW_DB_PORT = prevPort;
      }
      // 环境还原后管线继续可用
      expect((await runInstallStep("connection", config)).ok).toBe(true);
    },
  );

  it("site-settings：users 为空时写入三键，getRegisterPolicy 读出生效值", async () => {
    expect((await runInstallStep("site-settings", config)).ok).toBe(true);
    const byKey = new Map(
      (await getWebDb().select().from(siteSettings)).map((r) => [r.key, r.value]),
    );
    expect(byKey.get("register.policy")).toEqual({ open: true, invite: false, verifyEmail: true });
    expect(byKey.get("site.identity")).toEqual({
      name: "安装测试站",
      tagline: "集成测试",
      url: "http://127.0.0.1:3203",
    });
    expect(byKey.get("site.theme")).toEqual({ pack: "qy2010" });
    // 运行时读取（React cache 在 node 环境=每调用独立，读到的是刚写入的值）
    expect(await getRegisterPolicy()).toEqual({ open: true, invite: false, verifyEmail: true });
    // 另两种模式的策略键值（users 仍为空，重复执行设置步骤合法）
    expect(
      (await runInstallStep("site-settings", { ...config, registration: { mode: "invite" } })).ok,
    ).toBe(true);
    expect(await getRegisterPolicy()).toEqual({ open: false, invite: true, verifyEmail: false });
    expect(
      (await runInstallStep("site-settings", { ...config, registration: { mode: "closed" } })).ok,
    ).toBe(true);
    expect(await getRegisterPolicy()).toEqual({ open: false, invite: false, verifyEmail: false });
    // 还原为本用例的目标模式（后续用例依赖）
    expect((await runInstallStep("site-settings", config)).ok).toBe(true);
  });

  it(
    "runInstall 全量（users 为空）：一次跑通建管理员与写锁，审计齐备",
    { timeout: 120_000 },
    async () => {
      expect((await runInstall(config)).ok).toBe(true);
      const [user] = await getWebDb()
        .select()
        .from(users)
        .where(eq(users.username, config.admin.username));
      expect(user).toBeTruthy();
      expect(user?.email).toBe(config.admin.email);
      // 密码已按 argon2id 哈希（与注册口径一致），且登录验证门未启用（D3：立即可登录）
      expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user?.loginVerificationRequired).toBe(false);
      expect(await adminRoleOf(user!.id)).toHaveLength(1);
      expect(await isInstalled()).toBe(true);
      expect(existsSync(path.join(storageDir, "install.lock"))).toBe(true);
      const audits = await getWebDb()
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(inArray(auditLog.action, ["install.admin", "install.locked"]));
      expect(audits.map((a) => a.action).sort()).toEqual(["install.admin", "install.locked"]);
    },
  );

  it("lock 后全路由拒绝：逐步骤与再跑全量都 already-installed", async () => {
    for (const step of INSTALL_STEPS) {
      expect(await runInstallStep(step, config)).toEqual({
        ok: false,
        code: "already-installed",
        message: expect.stringContaining("install.lock"),
      });
    }
    expect(await runInstall(config)).toMatchObject({ ok: false, code: "already-installed" });
  });

  it("崩溃窗口自愈：lock 移除后，目标管理员缺角色行 → admin 步骤补齐", async () => {
    await removeInstallLock();
    const [user] = await getWebDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, config.admin.username));
    await getWebDb().delete(userRoles).where(eq(userRoles.userId, user!.id));
    expect(await adminRoleOf(user!.id)).toHaveLength(0);
    expect((await runInstallStep("admin", config)).ok).toBe(true);
    expect(await adminRoleOf(user!.id)).toHaveLength(1);
  });

  it("防重装保护：lock 移除后设置与管理员步骤仍因 users 非空被拒；重入自愈与多用户拒绝", async () => {
    // 上一用例已移除 lock 且未恢复：确认未安装状态
    expect(await isInstalled()).toBe(false);
    const settings = await runInstallStep("site-settings", config);
    expect(settings).toMatchObject({ ok: false, code: "users-exist" });
    // 唯一用户但用户名不匹配（他人）→ admin 步骤拒绝；改回后重入自愈跳过
    const [adminRow] = await getWebDb()
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.username, config.admin.username));
    await getWebDb()
      .update(users)
      .set({ username: "renamed_user", usernameKey: normalizeKey("renamed_user") })
      .where(eq(users.id, adminRow!.id));
    expect(await runInstallStep("admin", config)).toMatchObject({ ok: false, code: "users-exist" });
    await getWebDb()
      .update(users)
      .set({ username: config.admin.username, usernameKey: normalizeKey(config.admin.username) })
      .where(eq(users.id, adminRow!.id));
    // 唯一用户恰是目标管理员：admin 步骤幂等跳过（这一步在 lock 场景外仍可用）
    expect((await runInstallStep("admin", config)).ok).toBe(true);
    // 陌生用户场景：再来一个非目标用户 → admin 步骤拒绝，且陌生人不带角色
    await registerUser({
      username: "stranger",
      email: "stranger@example.com",
      passwordHash: await hashPassword("stranger-pass-123"),
      invite: null,
    });
    const refused = await runInstallStep("admin", config);
    expect(refused).toMatchObject({ ok: false, code: "users-exist" });
    const [stranger] = await getWebDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, "stranger"));
    expect(await adminRoleOf(stranger!.id)).toHaveLength(0);
    // 恢复已安装状态（不影响后续用例/其他文件）
    await writeInstallLock({ installedAt: new Date().toISOString() });
    expect(await isInstalled()).toBe(true);
  });
});
