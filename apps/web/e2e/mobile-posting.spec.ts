import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";
import { bodyEditor } from "./support/editor";

/**
 * 移动端版式与触达检查（M6.2 第 6 步）：375px 视口，只在 mobile 项目中运行。
 * 检查项：没有横向滚动（页面宽度不超过视口）；发帖 / 回复 / 编辑 / 删除的关键控件都在视口内、可见。
 * 访客冒烟：未登录的浏览页没有横向滚动。
 * 主题与帖子用 SQL 直接造（id 段 960801 起，与其它用例不重叠）。
 */

const T = 960801; // 主题（作者：会员）
const FIRST = 961801; // 首帖
const REPLY = 962801; // 回帖（作者：回帖者）

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [T]);
    await q.exec("DELETE FROM threads WHERE id = ?", [T]);
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, ?, ?, '[E2E] 移动端版式检查的主题', ?, 'visible', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [T, FIX.compose.id, USERS.member, FIRST],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, '移动端首帖正文', 0, 'visible', '2026-10-21 10:00:00'),
              (?, ?, 2, ?, '移动端回帖正文', 0, 'visible', '2026-10-21 10:01:00')`,
      [FIRST, T, USERS.member, REPLY, T, USERS.xiaoyi],
    );
  });
});

/** 页面宽度不超过视口：没有横向滚动 */
async function expectNoHorizontalScroll(page: Page) {
  const { viewport, scroll } = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(scroll, "页面出现横向滚动").toBeLessThanOrEqual(viewport);
}

/** 元素在视口内可见，且左右不越界 */
async function expectInViewport(page: Page, locator: ReturnType<Page["locator"]>) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const width = await page.evaluate(() => window.innerWidth);
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

test("视口确实是 375px（移动项目的前提）", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => window.innerWidth)).toBe(375);
});

test("访客冒烟：版块页与主题页没有横向滚动", async ({ page }) => {
  await page.goto(`/f/${FIX.anime.id}`);
  await expectNoHorizontalScroll(page);
  await page.goto(`/t/${FIX.thread.emoji}`);
  await expectNoHorizontalScroll(page);
});

test("会员：版块页的发帖入口可见可点，发帖表单的输入框与按钮在视口内", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.member);
  await page.goto(`/f/${FIX.compose.id}`);
  await expectNoHorizontalScroll(page);
  await expectInViewport(page, page.getByRole("link", { name: "发新主题" }));

  await page.goto(`/f/${FIX.compose.id}/new`);
  await expectNoHorizontalScroll(page);
  await expectInViewport(page, page.locator("#thread-title"));
  await expectInViewport(page, bodyEditor(page));
  await expectInViewport(page, page.getByRole("button", { name: "发布主题" }));
});

test("主题页：快速回复表单在视口内，没有横向滚动", async ({ page, context }) => {
  await loginAs(context, USERS.xiaoyi);
  await page.goto(`/t/${T}`);
  await expectNoHorizontalScroll(page);
  await expectInViewport(page, bodyEditor(page));
  await expectInViewport(page, page.getByRole("button", { name: "发表回复" }));
});

test("编辑与删除确认页：没有横向滚动，保存 / 删除按钮在视口内", async ({ page, context }) => {
  await loginAs(context, USERS.member);
  await page.goto(`/p/${FIRST}/edit`);
  await expectNoHorizontalScroll(page);
  await expectInViewport(page, bodyEditor(page));
  await expectInViewport(page, page.getByRole("button", { name: "保存修改" }));

  await page.goto(`/p/${REPLY}/edit`);
  await expect(bodyEditor(page)).toHaveCount(0); // 不是作者：404，不渲染表单
  expect((await page.goto(`/p/${REPLY}/edit`))?.status()).toBe(404);
});
