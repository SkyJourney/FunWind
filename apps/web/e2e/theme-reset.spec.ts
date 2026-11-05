import { expect, test, type Locator, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { hydrated } from "./support/hydration";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * M11.6 Step 3f：内置主题包「重置为内置定义」（G-16：成功路径与错误路径成对）。
 * 用内置的 qy2010 包：先直接改库把它弄成「被改过」的样子，再走真实界面重置。
 * 成功路径：取消不动库；确认后定义回到内置、版本 +1、写审计、名称说明启停素材不变。
 * 错误路径：页面加载之后别人又改了这个包（版本冲突）→ 提示冲突、库与审计原样；刷新重试可以成功。
 * 目录缓存的失效、事务回滚、并发由集成测试覆盖（lib/theme/pack-reset.int.test.ts）。
 */
failOnPageErrors();

const PACK = "qy2010";
/** 篡改用的标记色：内置定义里不会出现 */
const MARK = "#112233";

type Definition = { surfaces: Record<string, unknown>; [key: string]: unknown };
type PackRow = {
  revision: number;
  name: string;
  description: string;
  enabled: number;
  definition: Definition;
  assets: unknown;
};
type AuditRow = {
  actor_id: number | null;
  target_type: string;
  before_json: unknown;
  after_json: unknown;
};

async function readPack(): Promise<PackRow> {
  const [row] = await withE2eDb((q) =>
    q.query<PackRow>(
      "SELECT revision, name, description, enabled, definition, assets FROM theme_packages WHERE id = ?",
      [PACK],
    ),
  );
  return row!;
}

/** 写回内容列（JSON 列用 CAST 传文本，`?` 不放在引号里） */
async function writePack(row: PackRow): Promise<void> {
  await withE2eDb((q) =>
    q.exec(
      "UPDATE theme_packages SET revision = ?, name = ?, description = ?, enabled = ?, definition = CAST(? AS JSON), assets = CAST(? AS JSON) WHERE id = ?",
      [
        row.revision,
        row.name,
        row.description,
        row.enabled,
        JSON.stringify(row.definition),
        JSON.stringify(row.assets),
        PACK,
      ],
    ),
  );
}

/** 模拟「已被改过」的包：顶部导航改成标记色，版本号抬高（和快照的版本明显区分开） */
function tampered(row: PackRow): PackRow {
  const definition = structuredClone(row.definition);
  definition.surfaces.header = { light: { fill: { type: "solid", color: MARK } } };
  return { ...row, definition, revision: row.revision + 6 };
}

const resetAudits = () =>
  withE2eDb((q) =>
    q.query<AuditRow>(
      "SELECT actor_id, target_type, before_json, after_json FROM audit_log WHERE action = 'theme.pack.reset' AND target_id = ?",
      [PACK],
    ),
  );

let snapshot: PackRow;

test.beforeAll(async () => {
  snapshot = await readPack();
  expect(
    JSON.stringify(snapshot.definition),
    "qy2010 起点就带着标记色：上一次运行没有还原，或别的用例改了它",
  ).not.toContain(MARK);
});

test.afterEach(async () => {
  await writePack(snapshot);
  await withE2eDb((q) =>
    q.exec("DELETE FROM audit_log WHERE action = 'theme.pack.reset' AND target_id = ?", [PACK]),
  );
});

/** 这个包在列表里的重置表单：同时带 id 与 revision 两个隐藏字段 */
function resetForm(page: Page): Locator {
  return page.locator(`form:has(input[name="id"][value="${PACK}"]):has(input[name="revision"])`);
}

/** 水合之前点击重置按钮会绕过确认框、直接原生提交，所以等水合完成再操作 */
async function openList(page: Page) {
  await page.goto("/admin/themes");
  const form = resetForm(page);
  const trigger = form.getByRole("button", { name: "重置为内置定义", exact: true });
  await expect(trigger).toBeVisible();
  await hydrated(trigger);
  return { form, trigger };
}

const confirmDialog = (page: Page) => page.getByRole("dialog", { name: "重置为内置定义？" });

const savedReset = (url: URL) =>
  url.pathname === "/admin/themes" && url.searchParams.get("saved") === "reset";

test("重置内置包：取消不动库；确认后定义回到内置、版本 +1、写审计，名称说明启停素材不变", async ({
  page,
  context,
}) => {
  const stale = tampered(snapshot);
  await writePack(stale);
  await loginAs(context, USERS.admin);

  const { form, trigger } = await openList(page);
  await expect(form.locator('input[name="revision"]')).toHaveValue(String(stale.revision));

  // 取消：库与审计原样
  await trigger.click();
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(await readPack(), "取消没有动库").toEqual(stale);
  expect(await resetAudits(), "取消没有写审计").toEqual([]);

  // Radix 关闭时用 setTimeout(0) 把焦点还给触发按钮，紧接着重开会被关掉，先等一个 tick
  await page.waitForTimeout(150);
  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "确认", exact: true }).click();

  await expect(page).toHaveURL(savedReset);
  await expect(page.getByRole("status").filter({ hasText: "已重置为内置定义" })).toBeVisible();

  const after = await readPack();
  expect(after.definition, "定义回到内置").toEqual(snapshot.definition);
  expect(JSON.stringify(after.definition)).not.toContain(MARK);
  expect(after.revision, "版本 +1").toBe(stale.revision + 1);
  expect(
    { name: after.name, description: after.description, enabled: after.enabled },
    "名称、说明、启停不变",
  ).toEqual({
    name: snapshot.name,
    description: snapshot.description,
    enabled: snapshot.enabled,
  });
  expect(after.assets, "素材清单不变").toEqual(snapshot.assets);

  expect(await resetAudits()).toEqual([
    {
      actor_id: USERS.admin,
      target_type: "theme_pack",
      before_json: { revision: stale.revision, definition: stale.definition },
      after_json: { revision: stale.revision + 1 },
    },
  ]);
});

test("版本冲突：页面加载后别人又改了这个包 → 提示冲突、库与审计原样；刷新重试可以成功", async ({
  page,
  context,
}) => {
  const stale = tampered(snapshot);
  await writePack(stale);
  await loginAs(context, USERS.admin);

  const { form, trigger } = await openList(page);
  await expect(form.locator('input[name="revision"]')).toHaveValue(String(stale.revision));

  // 页面加载之后，别人保存了这个包（版本 +1）
  await withE2eDb((q) =>
    q.exec("UPDATE theme_packages SET revision = revision + 1 WHERE id = ?", [PACK]),
  );
  const bumped = await readPack();
  expect(bumped.revision).toBe(stale.revision + 1);

  await trigger.click();
  await confirmDialog(page).getByRole("button", { name: "确认", exact: true }).click();

  await expect(page).toHaveURL(
    (url) => url.pathname === "/admin/themes" && url.searchParams.get("err") === "conflict",
  );
  await expect(page.getByRole("alert").filter({ hasText: "版本冲突" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "已重置为内置定义" })).toHaveCount(0);
  expect(await readPack(), "冲突时没有动库").toEqual(bumped);
  expect(await resetAudits(), "冲突时没有写审计").toEqual([]);

  // 刷新后拿到新版本，重试成功
  const retry = await openList(page);
  await expect(retry.form.locator('input[name="revision"]')).toHaveValue(String(bumped.revision));
  await retry.trigger.click();
  await confirmDialog(page).getByRole("button", { name: "确认", exact: true }).click();
  await expect(page).toHaveURL(savedReset);
  const after = await readPack();
  expect(after.definition).toEqual(snapshot.definition);
  expect(after.revision).toBe(bumped.revision + 1);
  expect(await resetAudits()).toHaveLength(1);
});
