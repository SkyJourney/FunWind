import { spawnSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { withE2eDb } from "../e2e/support/db";
import { failOnPageErrors } from "../e2e/support/page-errors";
import { loginAs } from "../e2e/support/session";
import { fillBody } from "../e2e/support/editor";

/**
 * M12：安装向导与零数据部署（真实空库 → 四步向导 → 可用站点 → CLI 双路径 → 中断恢复）。
 * 编排（根 test:e2e:install）保证两个库的起点：
 *  · qysub_next_e2e：重置为空库、**不 bootstrap 不 seed**——向导自己的管线建表；
 *  · qysub_next_install_cli：同样空库，交给 install:cli。
 * STORAGE_DIR 指向专用 storage-e2e-install（无 install.lock），CLI 用同级 storage-e2e-install-cli。
 * 方案与策略切换一律经界面/子进程——站点框架缓存只有走 Action 才会失效。
 */

test.describe.configure({ mode: "serial" });
failOnPageErrors();

// Playwright 按 CJS 转译 spec（import.meta 不可用）；CLI 以 apps/web 为 cwd 运行（CLAUDE.md 已知坑）
const WEB_ROOT = process.cwd();
const INSTALL_STORAGE = process.env.STORAGE_DIR ?? path.resolve(WEB_ROOT, "../storage-e2e-install");
const CLI_STORAGE = path.resolve(INSTALL_STORAGE, "..", "storage-e2e-install-cli");
const CLI_DB = "qysub_next_install_cli";
const ADMIN = [
  "--admin-username=inst_admin",
  "--admin-email=inst-admin@example.com",
  "--admin-password=inst-pass-123",
];

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(
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
      encoding: "utf8",
      timeout: 240_000,
      env: { ...process.env, NEW_DB_NAME: CLI_DB, STORAGE_DIR: CLI_STORAGE },
    },
  );
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function dropCliDb(): void {
  const r = spawnSync(
    "pnpm",
    ["--filter", "@funwind/db", "exec", "tsx", "scripts/install-cli-reset.ts"],
    {
      cwd: WEB_ROOT,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, NEW_DB_NAME: CLI_DB },
    },
  );
  expect(r.status).toBe(0);
}

failOnPageErrors();

test("错误路径：口令与环境不一致 → 专属提示与草稿保留（G-16），不落任何数据", async ({ page }) => {
  // 连接信息以 .env 为准（运行中的实例不能换库）：表单口令与 env 不一致 → invalid-config，
  // 字段级提示指出「口令」不一致；连接真实失败（db-unreachable）由管线集成测试覆盖
  await page.goto("/install");
  await expect(page.getByRole("button", { name: "测试连接并建表" })).toBeVisible();
  const host = await page.getByLabel("主机").inputValue();
  expect(host).toContain("127.0.0.1");
  await page.getByLabel("口令").fill("wrong-password");
  await page.getByRole("button", { name: "测试连接并建表" }).click();
  // Next 的路由公告器也带 role=alert：必须过滤文本定位到 AdminFlash
  await expect(page.getByRole("alert").filter({ hasText: "提交的配置有格式问题" })).toBeVisible();
  await expect(page.getByText(/数据库连接信息与运行中实例的环境变量不一致/)).toBeVisible();
  await expect(page.getByText("口令", { exact: true })).toBeVisible();
  // 草稿保留（G-19）：主机字段仍是提交前的值
  await expect(page.getByLabel("主机")).toHaveValue(host);
  expect(existsSync(path.join(INSTALL_STORAGE, "install.lock"))).toBe(false);
});

test("向导全流程：空库 → 建库建表 → 站点设置 → 管理员 → 完成 → 防重装 404", async ({ page }) => {
  await page.goto("/install");
  // 第 1 步：环境自检与数据库（预填 .env，直接提交）
  await expect(page.getByText("环境自检")).toBeVisible();
  await page.getByRole("button", { name: "测试连接并建表" }).click();
  await expect(page).toHaveURL(/\/install\?step=2/);

  // 第 2 步：站点设置（开放注册 + 要求验证邮箱）
  await page.getByLabel("站点名称").fill("安装向导站");
  await page.getByLabel("站点 URL").fill("http://127.0.0.1:3203");
  await page.getByRole("radio", { name: /开放注册/ }).check();
  await page.getByRole("checkbox", { name: /开放注册需验证邮箱/ }).check();
  await page.getByRole("button", { name: "保存站点设置" }).click();
  await expect(page).toHaveURL(/\/install\?step=3/);

  // 第 3 步：管理员（lock 落盘后向导自动关闭，跳登录页带完成提示）
  await page.getByLabel("用户名").fill("inst_admin");
  await page.getByLabel("邮箱").fill("inst-admin@example.com");
  await page.getByLabel("密码（至少 8 位）").fill("inst-pass-123");
  await page.getByRole("button", { name: "创建管理员并完成安装" }).click();
  await expect(page).toHaveURL(/\/login\?message=/);
  await expect(page.getByText(/安装完成/).first()).toBeVisible();

  // 防重装（D2）：lock 落盘，/install 全路由 404
  expect(existsSync(path.join(INSTALL_STORAGE, "install.lock"))).toBe(true);
  const locked = await page.goto("/install");
  expect(locked?.status()).toBe(404);

  // 数据断言：管理员就位、免验证（D3）、注册策略与站点身份写入
  await withE2eDb(async (q) => {
    const [user] = await q.query<{ id: number; login_verification_required: number }>(
      "SELECT id, login_verification_required FROM users WHERE username = ?",
      ["inst_admin"],
    );
    expect(user).toBeTruthy();
    expect(user.login_verification_required).toBe(0);
    const [role] = await q.query<{ roleKey: string }>(
      "SELECT role_key AS roleKey FROM user_roles WHERE user_id = ?",
      [user.id],
    );
    expect(role.roleKey).toBe("admin");
    const [policy] = await q.query<{ value: { open: boolean; verifyEmail: boolean } }>(
      "SELECT value FROM site_settings WHERE `key` = 'register.policy'",
    );
    expect(JSON.parse(JSON.stringify(policy.value))).toEqual({
      open: true,
      invite: false,
      verifyEmail: true,
    });
  });

  // 零数据空态：首页无主题、板块目录给访客「注册账号」引导（注册开放）
  await page.goto("/");
  await expect(page.getByText("这里还没有主题")).toBeVisible();
  await page.goto("/boards");
  await expect(page.getByText("这里还没有板块")).toBeVisible();
  await expect(page.getByRole("link", { name: /注册账号/ })).toBeVisible();
});

test("管理员登录 → 建第一个版块 → 发第一帖 → 板块目录脱离空态", async ({ page, context }) => {
  const [u] = await withE2eDb((q) =>
    q.query<{ id: number }>("SELECT id FROM users WHERE username = ?", ["inst_admin"]),
  );
  await loginAs(context, u.id);

  // 板块目录（管理员视角）：主行动直达后台
  await page.goto("/boards");
  await page.getByRole("link", { name: /进后台创建第一个版块/ }).click();
  await expect(page).toHaveURL(/\/admin\/forums/);
  await page.getByLabel("名称").fill("M12 首个板块");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(page.getByText(/M12 首个板块/).first()).toBeVisible();

  const [f] = await withE2eDb((q) =>
    q.query<{ id: number }>("SELECT id FROM forums WHERE name = ?", ["M12 首个板块"]),
  );
  expect(f.id).toBeGreaterThan(0);

  // 发第一帖（零数据站点从此可用）
  await page.goto(`/f/${f.id}/new`);
  await page.locator("#thread-title").fill(`M12 首帖 ${Date.now()}`);
  await fillBody(page, "零数据安装后的第一帖正文");
  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);

  // 板块目录脱离空态
  await page.goto("/boards");
  await expect(page.getByText("这里还没有板块")).toHaveCount(0);
  await expect(page.getByText(/1 个板块/)).toBeVisible();
});

test("CLI 路径：SIGKILL 中断恢复 → 收敛 → 防重装 → unlock 重装语义（同管理员收敛 / 换管理员拒绝）", async () => {
  // 独立库：先清掉可能的历史残留
  dropCliDb();
  rmSync(CLI_STORAGE, { recursive: true, force: true });
  const args = ["--site-name=CLI 安装站", "--registration=open", ...ADMIN];

  // 1) 全新安装进行到 admin 步骤时 SIGKILL
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
    { cwd: WEB_ROOT, env: { ...process.env, NEW_DB_NAME: CLI_DB, STORAGE_DIR: CLI_STORAGE } },
  );
  child.stdout?.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let collected = "";
    const onData = (chunk: string) => {
      collected += chunk;
      if (collected.includes("开始 step=admin")) {
        child.removeAllListeners("exit");
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.on("exit", () => reject(new Error(`安装在中断点之前意外结束：\n${collected}`)));
  });
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("close", () => resolve()));
  expect(existsSync(path.join(CLI_STORAGE, "install.lock"))).toBe(false);

  // 2) 重跑收敛
  const rerun = runCli(args);
  expect(rerun.code).toBe(0);
  expect(rerun.stdout).toContain("安装完成");
  expect(existsSync(path.join(CLI_STORAGE, "install.lock"))).toBe(true);

  // 3) 已安装直接运行 → 拒绝并提示 --unlock
  const refused = runCli(ADMIN);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("--unlock");

  // 4) --unlock --yes 同管理员重装 → 收敛且不重复建用户
  const reinstall = runCli(["--unlock", "--yes", ...args]);
  expect(reinstall.code).toBe(0);
  expect(reinstall.stdout).toContain("安装锁已删除");

  // 5) --unlock --yes 换管理员 → users-exist 拒绝（旧管理员与角色不动），恢复锁
  const replaced = runCli([
    "--unlock",
    "--yes",
    "--admin-username=other_admin",
    "--admin-email=other@example.com",
    "--admin-password=other-pass-123",
  ]);
  expect(replaced.code).toBe(1);
  expect(replaced.stderr).toContain("users-exist");
  // CLI 库的 DB 级断言已由 cli.int.test.ts 覆盖；此处以退出码 + CLI 自身输出为证据。
  // 恢复 CLI 库的安装态：重跑同管理员（lock 缺失 → 管线重写）
  const restore = runCli(["--unlock", "--yes", ...args]);
  expect(restore.code).toBe(0);
  expect(existsSync(path.join(CLI_STORAGE, "install.lock"))).toBe(true);
});
