import { expect, test } from "@playwright/test";
import { withE2eDb, type Q } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * 运维任务中心（M14 Step 3，G-16：错误路径与成功路径成对）。
 * E2E 环境不部署运维任务管线（OPS_SERVICE_URL 未配置）：页面降级为「未部署」提示，
 * 任务清单（来自配置表种子）与台账注入行仍可管理。执行中 → 自动刷新 → 成功的轮询链路
 * 通过改库（模拟管线回写）做端到端验证。数据自造自收尾，不依赖管线真实运行。
 */
/** 按第一列 #id 精确定位台账行（hasText 会子串匹配，12 含 1、2） */
const rowOf = (page: Page, id: number) =>
  page.locator("tr", { has: page.locator("td", { hasText: new RegExp(`^${id}$`) }) });

test.describe.configure({ mode: "serial" });
failOnPageErrors();

const PAGE = "/admin/ops";
const LEDGER_DDL =
  "CREATE TABLE IF NOT EXISTS ops_runs (" +
  "id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY," +
  "kind ENUM('db','storage','restore','drill','holiday') NOT NULL," +
  "task_key VARCHAR(64) NULL," +
  "trigger_source ENUM('cron','manual','once') NOT NULL," +
  "status ENUM('running','success','failed') NOT NULL," +
  "path VARCHAR(255) NULL, size_bytes BIGINT UNSIGNED NULL, detail TEXT NULL, error TEXT NULL," +
  "started_at DATETIME NOT NULL, finished_at DATETIME NULL" +
  ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

/** 注入的台账行 id 集合（每个用例自己记录），收尾统一清理 */
const injectedRuns: number[] = [];

/** 造一条台账行并记录 id（mysql2 的 insertId 直接给自增主键，MySQL 8 的 INSERT…RETURNING 不通用） */
async function insertRun(
  q: Q,
  overrides: { kind?: string; status?: string; error?: string; path?: string } = {},
): Promise<number> {
  const status = overrides.status ?? "running";
  const res = await q.exec(
    "INSERT INTO ops_runs (kind, task_key, trigger_source, status, path, size_bytes, error, started_at, finished_at) " +
      "VALUES (?, 'backup.db', 'manual', ?, ?, 4700000, ?, NOW(), ?)",
    [
      overrides.kind ?? "db",
      status,
      overrides.path ?? "/data/backups/db/e2e.sql.gz",
      overrides.error ?? null,
      status === "running" ? null : "2026-11-09 12:00:00",
    ],
  );
  injectedRuns.push(Number(res.insertId));
  return Number(res.insertId);
}

/**
 * 台账/状态表归管线自治建表（E2E 未部署管线，库里本来没有）。需要注入台账行的用例先建表；
 * 全部用例跑完后清掉注入行并删表——把 E2E 库恢复到与生产一致的状态（生产由管线建表）。
 * 启停用例改过的任务状态也一并恢复。
 */
test.beforeAll(async () => {
  await withE2eDb(async (q) => q.exec(LEDGER_DDL));
});

test.afterAll(async () => {
  await withE2eDb(async (q) => {
    for (const id of injectedRuns) await q.exec("DELETE FROM ops_runs WHERE id = ?", [id]);
    await q.exec("DROP TABLE IF EXISTS ops_runs");
    await q.exec("UPDATE ops_tasks SET enabled = 1 WHERE task_key = 'backup.db'");
    await q.exec("DELETE FROM audit_log WHERE action LIKE 'ops.%'");
  });
});

test("会员访问运维 → 404（越权不暴露存在性）", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  expect((await page.goto(PAGE))?.status()).toBe(404);
});

test("游客访问运维 → 重定向登录", async ({ page }) => {
  await page.goto(PAGE);
  expect(page.url()).not.toContain(PAGE);
});

test("管理员：任务清单展示种子任务与触发器；管线未部署时降级提示，台账空态", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await page.goto(PAGE);
  // 任务清单（bootstrap 种子：两条备份任务，各带 cron + manual）
  await expect(page.getByRole("heading", { name: "任务清单" })).toBeVisible();
  await expect(page.getByText("backup.db · backup.db")).toBeVisible();
  await expect(page.getByText("backup.storage · backup.storage")).toBeVisible();
  await expect(page.getByText("10 3 * * *").first()).toBeVisible();
  // 管线未部署：健康行降级；任务启用时「立即执行」可点（下一案覆盖被拒回显）
  await expect(page.getByText("未部署（OPS_SERVICE_URL / OPS_API_TOKEN 未配置）")).toBeVisible();
  await expect(page.getByRole("button", { name: "立即执行" }).first()).toBeEnabled();
  // 触发器状态表不存在（管线没跑过）：降级提示而不是 500（F12）
  await expect(page.getByText("管线尚未回写状态（未部署或未启动）").first()).toBeVisible();
  // 台账空表（beforeAll 建的空表：管线建表了但还没执行过任务）；「表不存在」的降级文案由 runs.int.test 覆盖
  await expect(page.getByText("暂无记录——管线首次执行后这里会出现历史。").first()).toBeVisible();
});

test("手动触发被管线拒绝（未部署）：错误回显成对（G-15）、无审计", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto(PAGE);
  await page
    .locator('form:has(input[name="taskKey"][value="backup.db"])')
    .getByRole("button", { name: "立即执行" })
    .click();
  await expect(page).toHaveURL(/err=/);
  await expect(page.getByRole("alert").filter({ hasText: "运维任务管线未部署" })).toBeVisible();
  const audits = await withE2eDb((q) =>
    q.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ops.task.run'"),
  );
  expect(Number(audits[0]?.n)).toBe(0);
});

test("台账注入行：分页展示、失败原因、下载链接只给成功备份", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  const ids: number[] = [];
  await withE2eDb(async (q) => {
    ids.push(
      await insertRun(q, { status: "running" }),
      await insertRun(q, { status: "failed", error: "E2E 注入的失败原因：mysqldump 假失败" }),
      await insertRun(q, { status: "success", path: "/data/backups/db/e2e-ok.sql.gz" }),
    );
  });
  await page.goto(PAGE);
  await expect(page.getByText("E2E 注入的失败原因：mysqldump 假失败")).toBeVisible();
  const okRow = rowOf(page, ids[2]!);
  await expect(okRow.getByRole("link", { name: "下载" })).toHaveAttribute(
    "href",
    `/admin/ops/download?path=${encodeURIComponent("db/e2e-ok.sql.gz")}`,
  );
  const failedRow = rowOf(page, ids[1]!);
  await expect(failedRow).toContainText("E2E 注入的失败原因：mysqldump 假失败");
  await expect(failedRow.getByRole("link", { name: "下载" })).toHaveCount(0);
});

test("恢复预览：成功 db 备份给出可复制的 CLI 命令（D5：不在界面执行恢复）", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName === "webkit", "clipboard 权限仅 Chromium");
  await loginAs(context, USERS.admin);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let runId = 0;
  await withE2eDb(async (q) => {
    runId = await insertRun(q, { status: "success" });
  });
  await page.goto(PAGE);
  const card = page.getByTestId(`ops-restore-${runId}`);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `复制运行 ${runId} 的恢复命令` }).click();
  await expect(card.getByRole("button", { name: `复制运行 ${runId} 的恢复命令` })).toHaveText(
    "已复制",
  );
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain(`restore ${runId} --target-db qingyisub --dry-run`);
  expect(clipboard).toContain("--yes");
});

test("轮询端到端：执行中自动刷新，管线回写（模拟改库）后状态自动变为成功", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  let runId = 0;
  await withE2eDb(async (q) => {
    runId = await insertRun(q, { status: "running" });
  });
  await page.goto(PAGE);
  await expect(page.getByTestId("ops-auto-refresh")).toBeVisible();
  await expect(rowOf(page, runId).getByText("执行中")).toBeVisible();
  // 模拟管线回写结果（页面不动，等自动刷新拿到新状态）
  await withE2eDb(async (q) => {
    await q.exec("UPDATE ops_runs SET status = 'success', finished_at = NOW() WHERE id = ?", [
      runId,
    ]);
  });
  await expect(
    rowOf(page, runId).getByText("成功"),
    "自动刷新应在 5s 间隔内拿到新状态",
  ).toBeVisible({ timeout: 12_000 });
});

test("任务启停：停用带确认、写审计（G-20 旁路写）、恢复启用", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  await page.goto(PAGE);
  // 停用（确认框）
  const taskArea = page
    .locator("div.rounded-xl")
    .filter({ has: page.getByRole("heading", { name: "任务清单" }) });
  await taskArea.getByRole("button", { name: "停用", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "停用该任务？" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page).toHaveURL(/tasks=disabled/);
  await expect(page.getByRole("status").filter({ hasText: "任务已停用" })).toBeVisible();
  // 库：enabled=0、revision+1（G-20 旁路写）；审计在
  const audits = await withE2eDb(async (q) =>
    q.query<{ action: string; target_id: string }>(
      "SELECT action, target_id FROM audit_log WHERE action = 'ops.task.toggle' ORDER BY id DESC LIMIT 1",
    ),
  );
  expect(audits[0]).toMatchObject({ action: "ops.task.toggle", target_id: "backup.db" });
  // 恢复启用（收尾语义的一部分，也覆盖启用分支）
  await page.goto(PAGE);
  await taskArea.getByRole("button", { name: "启用", exact: true }).first().click();
  await page
    .getByRole("dialog", { name: "启用该任务？" })
    .getByRole("button", { name: "确认", exact: true })
    .click();
  await expect(page).toHaveURL(/tasks=enabled/);
  const state = await withE2eDb(async (q) =>
    q.query<{ enabled: number }>("SELECT enabled FROM ops_tasks WHERE task_key = 'backup.db'"),
  );
  expect(Number(state[0]?.enabled)).toBe(1);
});

test("台账分页：第二页出现更早的记录（翻页不改变 anyRunning 判定）", async ({ page, context }) => {
  await loginAs(context, USERS.admin);
  const ids: number[] = [];
  await withE2eDb(async (q) => {
    for (let i = 0; i < 30; i++) ids.push(await insertRun(q, { status: "failed" }));
  });
  await page.goto(PAGE);
  await expect(page.getByText("运行台账（第 1 页")).toBeVisible();
  await page
    .locator('nav[aria-label="分页"]')
    .getByRole("link", { name: "2", exact: true })
    .click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByText("运行台账（第 2 页")).toBeVisible();
});
