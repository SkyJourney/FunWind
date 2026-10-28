import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * 所见即所得编辑区的外观（M10.8 Step 2）：jsdom 没有样式，只能在真实浏览器里断言。
 * 回归点：编辑区曾没有边框，列表 / 引用 / 代码块 / 表格被 Tailwind preflight 重置得与普通段落无异，
 * 站长感觉「工具点了没反应」。
 */
test("编辑区有外框，列表 / 引用 / 代码 / 表格 / 标题与正文排版可见", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginAs(ctx, USERS.member);
  const page = await ctx.newPage();
  await page.goto(`/f/${FIX.compose.id}`);
  await page.getByRole("link", { name: "发新主题" }).click();
  await page.locator(".fw-rich-editor").waitFor();
  const discard = page.getByRole("button", { name: "丢弃" });
  if (await discard.isVisible()) await discard.click();
  await page.getByRole("button", { name: "切换到源码" }).click();
  const cm = page.locator(".cm-content");
  await cm.click();
  await cm.fill(
    "# 标题\n\n正文\n\n- 列表\n\n> 引用\n\n```\ncode\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
  );
  await page.getByRole("button", { name: "切换到所见即所得" }).click();
  const ed = page.locator(".fw-rich-editor");
  await expect(ed.locator("table")).toBeVisible();

  const s = await page.evaluate(() => {
    const css = (sel: string) => getComputedStyle(document.querySelector(sel)!);
    return {
      frame: css(".fw-editor").borderTopWidth,
      list: css(".fw-rich-editor ul").listStyleType,
      quote: css(".fw-rich-editor blockquote").borderLeftWidth,
      pre: css(".fw-rich-editor pre").backgroundColor,
      td: css(".fw-rich-editor td").borderTopWidth,
      h1: parseFloat(css(".fw-rich-editor h1").fontSize),
      p: parseFloat(css(".fw-rich-editor p").fontSize),
    };
  });
  expect(s.frame).toBe("1px");
  expect(s.list).toBe("disc");
  expect(s.quote).toBe("4px");
  expect(s.pre).not.toBe("rgba(0, 0, 0, 0)");
  expect(s.td).toBe("1px");
  expect(s.h1).toBeGreaterThan(s.p);

  // 工具栏按钮悬浮即出提示（名称 + 快捷键）
  await page.getByRole("button", { name: "加粗" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("加粗");
  await ctx.close();
});

test("表格：插入后出现表格工具条；Tab 走格并在表尾自动加行；删除整个表格后工具条消失", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  await loginAs(ctx, USERS.member);
  const page = await ctx.newPage();
  await page.goto(`/f/${FIX.compose.id}`);
  await page.getByRole("link", { name: "发新主题" }).click();
  await page.locator(".fw-rich-editor").waitFor();
  const discard = page.getByRole("button", { name: "丢弃" });
  if (await discard.isVisible()) await discard.click();

  await expect(page.getByRole("toolbar", { name: "表格工具" })).toHaveCount(0);
  await page.getByRole("button", { name: "插入表格" }).click();
  const bar = page.getByRole("toolbar", { name: "表格工具" });
  await expect(bar).toBeVisible();
  const rows = page.locator(".fw-rich-editor tr");
  await expect(rows).toHaveCount(3);

  // 插入后光标在第一格：连按 Tab 走完 3×3 的 9 格，再按一次在表尾自动新增一行
  for (let i = 0; i < 9; i++) await page.keyboard.press("Tab");
  await expect(rows).toHaveCount(4);

  // 工具条：右侧插列后每行多一格
  await bar.getByRole("button", { name: "在右侧插入列" }).click();
  await expect(page.locator(".fw-rich-editor tr:first-child > *")).toHaveCount(4);

  await bar.getByRole("button", { name: "删除整个表格" }).click();
  await expect(page.locator(".fw-rich-editor table")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "表格工具" })).toHaveCount(0);
  await ctx.close();
});

test("锁定内容块：标题与解锁方式由条件目录渲染；换成回复解锁后不再有价格输入；保存语法不变", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  await loginAs(ctx, USERS.member);
  const page = await ctx.newPage();
  await page.goto(`/f/${FIX.compose.id}`);
  await page.getByRole("link", { name: "发新主题" }).click();
  await page.locator(".fw-rich-editor").waitFor();
  const discard = page.getByRole("button", { name: "丢弃" });
  if (await discard.isVisible()) await discard.click();

  await page.getByRole("button", { name: "插入锁定内容" }).click();
  const head = page.locator(".fw-gate-head");
  await expect(head).toContainText("🔒 锁定内容");
  const how = head.getByLabel("解锁方式");
  await expect(how.locator("option")).toHaveText(["积分解锁", "回复解锁"]);
  await expect(head.getByLabel("价格（积分）")).toHaveValue("10");

  await how.selectOption("reply");
  await expect(head.getByLabel("价格（积分）")).toHaveCount(0);
  // 存储语法不变：仍是 :::gate{… unlock="reply"}
  await page.getByRole("button", { name: "切换到源码" }).click();
  await expect(page.locator(".cm-content")).toContainText(':::gate{key="g1" unlock="reply"}');
  await ctx.close();
});
