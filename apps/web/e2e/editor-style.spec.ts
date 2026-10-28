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
