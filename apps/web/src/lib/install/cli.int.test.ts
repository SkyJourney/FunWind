// @vitest-environment node
/**
 * install:cli 的进程级集成测试（M12 Step 2）：真实 spawn CLI 子进程，
 * 覆盖配置缺失、SIGKILL 中断恢复（杀在 admin 步骤开始 → 重跑收敛）、防重装提示、
 * --unlock --yes 重装语义（同管理员收敛；换管理员被 users-exist 拒绝且旧管理员不动）。
 * 用独立的临时库与独立 STORAGE_DIR：测试进程不经 getWebDb（避免污染运行时单例池），
 * 断言走专用 drizzle 连接。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, createPool, newDbConfig, userRoles, users } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isInstalled, removeInstallLock, writeInstallLock } from "./lock";

const base = newDbConfig();
const dbName = `funwind_install_cli_it_${randomBytes(4).toString("hex")}`;
const storageDir = mkdtempSync(path.join(tmpdir(), "funwind-install-cli-it-"));
const WEB_ROOT = path.join(import.meta.dirname, "../../..");
const adminPool = createPool({ ...base, database: "information_schema" });
const cliPool = createPool({ ...base, database: dbName });
const cliDb = createDb(cliPool);

const ADMIN = [
  "--admin-username=cli_admin",
  "--admin-email=cli@example.com",
  "--admin-password=cli-pass-123",
];
const cliEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  NEW_DB_NAME: dbName,
  STORAGE_DIR: storageDir,
});

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs = 180_000): Promise<CliRun & { child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [
        "--import",
        "./scripts/server-only-register.mjs",
        "--import",
        "tsx",
        "scripts/install.mts",
        ...args,
      ],
      {
        cwd: WEB_ROOT,
        env: cliEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, child });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 等 CLI 打印出指定标记行（供 SIGKILL 定位）；进程提前退出则抛错并携带已收集输出 */
function waitForLine(child: ChildProcess, marker: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let collected = "";
    const onData = (chunk: string) => {
      collected += chunk;
      if (collected.includes(marker)) {
        cleanup();
        resolve(collected);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待「${marker}」超时，已收集输出：\n${collected}`));
    }, timeoutMs);
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`CLI 在出现「${marker}」前退出（code=${code}）：\n${collected}`));
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      clearTimeout(timer);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", onData);
    child.on("exit", onExit);
  });
}

const adminRoleOf = async (userId: number) =>
  cliDb
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(
      and(eq(userRoles.userId, userId), eq(userRoles.roleKey, "admin"), eq(userRoles.scopeId, 0)),
    );

beforeAll(async () => {
  await adminPool.query(
    `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
});

afterAll(async () => {
  await cliPool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await adminPool.end();
  rmSync(storageDir, { recursive: true, force: true });
});

describe.skipIf(process.env.SKIP_DB_TESTS === "1")("install:cli（M12 Step 2，真实子进程）", () => {
  it("配置缺失 → 退出码 1，按字段打印问题清单（不落库不写锁）", { timeout: 120_000 }, async () => {
    const r = await runCli([]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("安装配置无效");
    expect(r.stderr).toContain("admin.username");
    expect(r.stderr).toContain("--admin-username");
    expect(existsSync(path.join(storageDir, "install.lock"))).toBe(false);
  });

  it(
    "中断恢复：SIGKILL 杀在 admin 步骤开始 → 重跑收敛（管理员就位、lock 落盘）",
    { timeout: 300_000 },
    async () => {
      const args = [
        "--site-name=CLI 安装站",
        "--theme=qy2010",
        "--registration=open",
        "--verify-email",
        ...ADMIN,
      ];
      const child = spawn(
        "node",
        [
          "--import",
          "./scripts/server-only-register.mjs",
          "--import",
          "tsx",
          "scripts/install.mts",
          ...args,
        ],
        {
          cwd: WEB_ROOT,
          env: cliEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.setEncoding("utf8");
      const collected = await waitForLine(child, "开始 step=admin");
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.on("close", () => resolve()));
      // 杀点之前 settings 已完成、admin 已开始：输出可证伪
      expect(collected).toContain("✔ step=site-settings 完成");
      expect(collected).not.toContain("安装完成");
      expect(await isInstalled(cliEnv())).toBe(false);

      // 重跑：各步骤幂等，直接收敛
      const rerun = await runCli(args);
      expect(rerun.code).toBe(0);
      expect(rerun.stdout).toContain("安装完成");
      const [user] = await cliDb.select().from(users).where(eq(users.username, "cli_admin"));
      expect(user).toBeTruthy();
      expect(await adminRoleOf(user!.id)).toHaveLength(1);
      expect(await isInstalled(cliEnv())).toBe(true);
    },
  );

  it(
    "已安装后直接运行 → 退出码 1 并提示 --unlock；--unlock --yes 同管理员重装收敛",
    { timeout: 300_000 },
    async () => {
      const refused = await runCli(ADMIN);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("--unlock");

      const reinstall = await runCli(["--unlock", "--yes", "--site-name=CLI 安装站", ...ADMIN]);
      expect(reinstall.code).toBe(0);
      expect(reinstall.stdout).toContain("安装锁已删除");
      // 同管理员：重装幂等（不重复建用户）
      expect(await cliDb.select().from(users).where(eq(users.username, "cli_admin"))).toHaveLength(
        1,
      );
    },
  );

  it(
    "--unlock --yes 换管理员重装 → users-exist 拒绝（旧管理员与角色不动）",
    { timeout: 300_000 },
    async () => {
      const before = await cliDb.select().from(users);
      const replaced = await runCli([
        "--unlock",
        "--yes",
        "--admin-username=other_admin",
        "--admin-email=other@example.com",
        "--admin-password=other-pass-123",
      ]);
      expect(replaced.code).toBe(1);
      expect(replaced.stderr).toContain("users-exist");
      // 旧管理员完好；锁被上次拒绝前的流程重写了吗——拒绝发生在 site-settings/admin（lock 之前），锁仍缺失
      expect(await cliDb.select().from(users)).toHaveLength(before.length);
      const [oldAdmin] = await cliDb.select().from(users).where(eq(users.username, "cli_admin"));
      expect(await adminRoleOf(oldAdmin!.id)).toHaveLength(1);
      // 恢复已安装状态
      await writeInstallLock({ installedAt: new Date().toISOString() }, cliEnv());
      expect(await isInstalled(cliEnv())).toBe(true);
    },
  );

  it("换锁一致性：removeInstallLock / writeInstallLock 对 CLI 的 env 生效", async () => {
    expect(await removeInstallLock(cliEnv())).toBe(true);
    expect(await isInstalled(cliEnv())).toBe(false);
    await writeInstallLock({ installedAt: "x" }, cliEnv());
    expect(await isInstalled(cliEnv())).toBe(true);
  });
});
