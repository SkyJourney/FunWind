import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { failOnPageErrors } from "./support/page-errors";
import { USERS, loginAs } from "./support/session";

/**
 * M11.6 Step 3e（G-16 错误路径）：服务端拒绝定义时，编辑页列出具体问题，而不是只说「校验未通过」。
 * 编辑器本身拦住了非法输入，所以这里直接改写隐藏的 definition 再提交，模拟部署后 schema 收紧、存储损坏或被篡改。
 * 保存被拒，不动库；用内置的 default 包，不建新包，也不依赖别的用例。
 */
failOnPageErrors();

const PACK = "default";
const DRAFT_DESCRIPTION = "G-16 未保存说明";

type Definition = { surfaces: Record<string, unknown>; tokens?: unknown };

async function readStored() {
  const [row] = await withE2eDb((q) =>
    q.query<{ revision: number; name: string; description: string }>(
      "SELECT revision, name, description FROM theme_packages WHERE id = ?",
      [PACK],
    ),
  );
  return row!;
}

async function openEditor(page: Page) {
  await page.goto(`/admin/themes/${PACK}`);
  // 保存按钮在水合之后才可用：用它判断页面已经可以交互
  await expect(page.getByRole("button", { name: "保存主题包" })).toBeEnabled();
}

/** 先写一段未保存的说明，再改写隐藏的 definition，最后点保存。改写与点击之间不碰任何会让 React 重渲染的东西 */
async function saveTampered(page: Page, edit: (definition: Definition) => void) {
  await page.getByLabel("说明", { exact: true }).fill(DRAFT_DESCRIPTION);
  const input = page.locator('input[name="definition"]');
  const definition = JSON.parse(await input.inputValue()) as Definition;
  edit(definition);
  await input.evaluate((el, value) => {
    (el as HTMLInputElement).value = value;
  }, JSON.stringify(definition));
  await page.getByRole("button", { name: "保存主题包" }).click();
}

const rejectedWithOneIssue = (url: URL) =>
  url.pathname === `/admin/themes/${PACK}` &&
  url.searchParams.get("err") === "invalid-definition" &&
  url.searchParams.getAll("issue").length === 1;

test("区域设置被服务端拒绝：列出翻成编辑器名字的问题；说明草稿、原版本、已保存内容都不动", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await openEditor(page);
  const before = await readStored();
  const revision = page.locator('input[name="revision"]');
  await expect(revision).toHaveValue(String(before.revision));

  // 顶部导航的毛玻璃模糊上限是 24
  await saveTampered(page, (definition) => {
    definition.surfaces.header = { light: { blur: 99 } };
  });

  await expect(page).toHaveURL(rejectedWithOneIssue);
  const issues = page.getByRole("list", { name: "未通过校验的项" });
  await expect(issues.getByRole("listitem")).toHaveText([/^顶部导航 · 浅色档 · 毛玻璃模糊：.+/]);
  await expect(issues).not.toContainText("surfaces.header");
  await expect(page.getByText("包配置校验未通过，请检查分区定义。")).toBeVisible();

  // 草稿与原版本都在
  await expect(page.getByLabel("说明", { exact: true })).toHaveValue(DRAFT_DESCRIPTION);
  await expect(revision).toHaveValue(String(before.revision));
  await expect
    .poll(async () => {
      const raw = await page.locator('input[name="definition"]').inputValue();
      return (JSON.parse(raw) as { surfaces: { header: { light: { blur: number } } } }).surfaces
        .header.light.blur;
    })
    .toBe(99);
  expect(await readStored(), "被拒绝的保存没有写库").toEqual(before);
});

test("令牌被服务端拒绝：列出翻成编辑器名字的问题；草稿按损坏处理，回到服务端内容并说明", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.admin);
  await openEditor(page);
  const before = await readStored();

  await saveTampered(page, (definition) => {
    definition.tokens = { light: { colors: { primary: "红" } } };
  });

  await expect(page).toHaveURL(rejectedWithOneIssue);
  await expect(page.getByRole("list", { name: "未通过校验的项" }).getByRole("listitem")).toHaveText(
    ["全站令牌 · 浅色档 · 颜色 · 主色：非法颜色（须 #RRGGBB）"],
  );

  // 令牌不合 schema 时整份草稿按损坏处理（Step 3c）：页面回到服务端内容，并说明原因
  await expect(page.getByText(/未找到可恢复的完整草稿/)).toBeVisible();
  await expect(page.getByLabel("说明", { exact: true })).toHaveValue(before.description);
  await expect(page.locator('input[name="revision"]')).toHaveValue(String(before.revision));
  expect(await readStored(), "被拒绝的保存没有写库").toEqual(before);
});
