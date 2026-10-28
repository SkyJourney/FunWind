import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { bodyEditor, fillSource } from "./support/editor";
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

test("表情面板：搜索并插入；再点按钮可关闭；图片表情与文字同一行", async ({ browser }) => {
  const ctx = await browser.newContext();
  await loginAs(ctx, USERS.member);
  const page = await ctx.newPage();
  await page.goto(`/f/${FIX.compose.id}`);
  await page.getByRole("link", { name: "发新主题" }).click();
  await page.locator(".fw-rich-editor").waitFor();
  const discard = page.getByRole("button", { name: "丢弃" });
  if (await discard.isVisible()) await discard.click();
  await bodyEditor(page).click();
  await page.keyboard.type("好");

  const trigger = page.getByRole("button", { name: "表情", exact: true });
  await trigger.click();
  const search = page.getByLabel("搜索表情");
  await expect(search).toBeFocused();
  await search.fill("点赞");
  await page.getByRole("gridcell", { name: "赞" }).click();
  await expect(bodyEditor(page)).toContainText("👍");
  await expect(search).toHaveCount(0);

  // 再次打开后，再点同一个按钮 = 关闭（回归：外部按下先关、点击又切回打开）
  await trigger.click();
  await expect(page.getByLabel("搜索表情")).toBeVisible();
  await trigger.click();
  await expect(page.getByLabel("搜索表情")).toHaveCount(0);

  // 图片表情（M10.9 的数据源）与文字同一行：一个段落、不换行、高度不超过一行半
  await page.getByRole("button", { name: "切换到源码" }).click();
  await fillSource(page, "你好 ![表情](/emoji/134.gif) 再见");
  await page.getByRole("button", { name: "切换到所见即所得" }).click();
  const p = bodyEditor(page).locator("p");
  await expect(p).toHaveCount(1);
  await expect(p.locator("img:not(.ProseMirror-separator)")).toBeVisible();
  const box = await p.boundingBox();
  const imgBox = await p.locator("img:not(.ProseMirror-separator)").boundingBox();
  expect(imgBox!.y).toBeGreaterThanOrEqual(box!.y - 1);
  expect(imgBox!.y + imgBox!.height).toBeLessThanOrEqual(box!.y + box!.height + 1);
  expect(box!.height).toBeLessThan(90);
  await ctx.close();
});

test("编辑器头部（M10.8 Step 9）：桌面按钮全部可见；右侧「源码 / 预览」固定；附件默认折叠、上传后自动展开", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await loginAs(ctx, USERS.member);
  const page = await ctx.newPage();
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator(".fw-rich-editor").waitFor();
  const discard = page.getByRole("button", { name: "丢弃" });
  if (await discard.isVisible()) await discard.click();

  // 桌面宽度：工具栏换行，所有按钮都在编辑器外框之内、无需横向滚动（回归：曾被做成单行横滚，表情 / 表格 / 撤销重做被挤出视野）
  const frame = await page.locator(".fw-editor").first().boundingBox();
  for (const name of ["标题", "加粗", "表情", "插入表格", "插入锁定内容", "撤销", "重做"]) {
    const b = await page.getByRole("button", { name, exact: true }).boundingBox();
    expect(b, name).not.toBeNull();
    expect(b!.x, name).toBeGreaterThanOrEqual(frame!.x);
    expect(b!.x + b!.width, name).toBeLessThanOrEqual(frame!.x + frame!.width);
  }
  // 右侧操作固定在头部：切换模式 + 预览
  await expect(page.getByRole("button", { name: "切换到源码" })).toBeVisible();
  await expect(page.getByRole("button", { name: "预览（近似，以发布后为准）" })).toBeVisible();
  // 编辑器下方不再有重复的「插入图片」按钮与勾选框（入口在工具栏）
  await expect(page.getByRole("button", { name: "插入图片" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "裁剪后插入" })).toHaveCount(0);

  // 附件默认折叠；上传后自动展开并出现这一行
  const toggle = page.getByRole("button", { name: /^附件（\d+）$/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("attachment-row")).toHaveCount(0);
  await page
    .locator('input[type="file"][aria-label="选择附件"]')
    .setInputFiles({ name: "折叠.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("attachment-row")).toHaveCount(1);

  // 源码模式：同样的外框与头部，保留编辑区下方的图片入口
  await page.getByRole("button", { name: "切换到源码" }).click();
  await expect(page.getByRole("button", { name: "切换到所见即所得" })).toBeVisible();
  await expect(page.getByRole("button", { name: "预览（近似，以发布后为准）" })).toBeVisible();
  await expect(page.getByRole("button", { name: "插入图片" })).toBeVisible();
  await ctx.close();
});
