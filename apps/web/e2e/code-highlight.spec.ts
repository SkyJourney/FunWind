import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { bodyEditor, fillSource } from "./support/editor";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";

/**
 * 代码块语法高亮（M10.8 Step 5）：编辑区语言下拉 + 高亮，发布后正文高亮；没写语言的保持纯文本。
 * 颜色在真实浏览器里读 computed style：关键字必须与普通代码文字颜色不同；暗色主题下关键字颜色随令牌变化。
 */
test.describe.configure({ mode: "serial" });

let restoreLimits: () => Promise<void>;
test.beforeAll(async () => {
  restoreLimits = await relaxPostInterval();
});
test.afterAll(async () => {
  await restoreLimits();
});

test("编辑区高亮 + 语言下拉；发布后正文高亮；无语言围栏纯文本；暗色令牌生效", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.member);
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator("#thread-title").fill(`E2E 高亮 ${Date.now()}`);
  await fillSource(page, "```js\nconst a = 1;\n```\n\n```\nconst b = 2;\n```");
  await page.getByRole("button", { name: "切换到所见即所得" }).click();

  // 编辑区：带语言的块高亮，下拉显示 js；无语言的块没有 hljs
  const blocks = bodyEditor(page).locator(".fw-codeblock");
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(0).locator(".hljs-keyword")).toBeVisible();
  await expect(blocks.nth(0).getByLabel("代码语言")).toHaveValue("js");
  await expect(blocks.nth(1).locator('[class*="hljs-"]')).toHaveCount(0);

  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);

  const kw = page.locator(".content-md pre code .hljs-keyword").first();
  await expect(kw).toHaveText("const");
  const colors = async () =>
    page.evaluate(() => {
      const k = document.querySelector(".content-md pre code .hljs-keyword")!;
      const code = k.closest("code")!;
      return { kw: getComputedStyle(k).color, base: getComputedStyle(code).color };
    });
  const light = await colors();
  expect(light.kw).not.toBe(light.base);
  // 第二个围栏没写语言：纯文本
  await expect(page.locator(".content-md pre").nth(1).locator('[class*="hljs-"]')).toHaveCount(0);

  // 暗色：关键字颜色随令牌换成另一套
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const dark = await colors();
  expect(dark.kw).not.toBe(light.kw);
});
