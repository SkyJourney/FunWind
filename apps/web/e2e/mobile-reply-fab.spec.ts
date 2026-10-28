import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";
import { bodyEditor } from "./support/editor";

/**
 * 移动端回复悬浮按钮（M10.8 Step 8，375px，只在 mobile 项目运行）：
 * 悬在底部 Tab 栏上方；点击滚到回复区并聚焦编辑器；与回复区互斥（进入即收起、上滑再出现）；
 * 减少动态效果下无过渡；访客与锁帖不出现。主题与帖子用 SQL 直接造（id 段 960811 起，与其它用例不重叠）。
 */
const T = 960811; // 可回复的长主题（12 条长回帖，保证回复区在首屏之外）
const T_LOCKED = 960812; // 锁帖
const FIRST = 961811;
const FIRST_LOCKED = 961812;

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE thread_id IN (?, ?)", [T, T_LOCKED]);
    await q.exec("DELETE FROM threads WHERE id IN (?, ?)", [T, T_LOCKED]);
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, is_locked, created_at, last_posted_at)
       VALUES (?, ?, ?, '[E2E] 回复悬浮按钮的主题', ?, 'visible', 0, '2026-10-21 10:00:00', '2026-10-21 10:00:00'),
              (?, ?, ?, '[E2E] 回复悬浮按钮的锁帖', ?, 'visible', 1, '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [
        T,
        FIX.compose.id,
        USERS.member,
        FIRST,
        T_LOCKED,
        FIX.compose.id,
        USERS.member,
        FIRST_LOCKED,
      ],
    );
    const long = "回帖正文很长很长。".repeat(40);
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, '首帖正文', 0, 'visible', '2026-10-21 10:00:00'),
              (?, ?, 1, ?, '锁帖首帖', 0, 'visible', '2026-10-21 10:00:00')`,
      [FIRST, T, USERS.member, FIRST_LOCKED, T_LOCKED, USERS.member],
    );
    for (let i = 0; i < 12; i++) {
      await q.exec(
        `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 'visible', '2026-10-21 10:01:00')`,
        [962811 + i, T, i + 2, USERS.xiaoyi, `${i + 2} 楼：${long}`],
      );
    }
  });
});
test.afterAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE thread_id IN (?, ?)", [T, T_LOCKED]);
    await q.exec("DELETE FROM threads WHERE id IN (?, ?)", [T, T_LOCKED]);
  });
});

const bar = (page: import("@playwright/test").Page) => page.getByTestId("reply-fab");

test("会员：按钮悬在底部 Tab 上方；点击滚到回复区并聚焦编辑器；与回复区互斥，上滑再出现", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.member);
  await page.goto(`/t/${T}`);
  await bodyEditor(page).waitFor(); // 编辑器已就绪
  await expect(bar(page)).not.toHaveAttribute("inert", "");

  // 位置与尺寸：圆形，在右下角、底部 Tab 栏之上不重叠，触控目标不小于 44px，离右缘有间距
  const tab = await page.getByRole("navigation", { name: "移动端主导航" }).boundingBox();
  const b = await bar(page).boundingBox();
  expect(b!.width).toBeGreaterThanOrEqual(44);
  expect(Math.abs(b!.width - b!.height)).toBeLessThanOrEqual(1);
  expect(b!.y + b!.height).toBeLessThanOrEqual(tab!.y + 1);
  expect(b!.x + b!.width).toBeLessThanOrEqual(375 - 8);
  expect(b!.x).toBeGreaterThan(375 / 2); // 靠右

  // 回归（站长实测）：没有整行背景层遮挡浏览——按钮左侧的区域不被任何固定元素盖住
  const covered = await page.evaluate(() => {
    const y = window.innerHeight - 56 - 16 - 24; // 按钮同一水平线
    const el = document.elementFromPoint(40, y);
    return !!el?.closest('[data-testid="reply-fab"], nav[aria-label="移动端主导航"]');
  });
  expect(covered, "按钮左侧不应被固定元素遮挡").toBe(false);

  // 点击：滚到回复区、聚焦编辑器、按钮收起
  // 点击：立即跳到回复区并聚焦编辑器（站长拍板：立即聚焦；平滑滚动与聚焦不可兼得，见 reply-fab.tsx）
  await page.getByRole("button", { name: "回复本帖" }).click();
  await expect(page.locator("#reply")).toBeInViewport();
  await expect(bodyEditor(page)).toBeFocused();
  await expect(bar(page)).toHaveAttribute("inert", "");

  // 上滑离开回复区：按钮回来
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar(page)).not.toHaveAttribute("inert", "");
});

test("减少动态效果：按钮显隐没有过渡", async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await loginAs(context, USERS.member);
  await page.goto(`/t/${T}`);
  await bodyEditor(page).waitFor();
  // motion-reduce:transition-none 把 transition-property 置为 none（时长保留），所以看属性
  const prop = await bar(page).evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(prop).toBe("none");
  // 对照：不减少动态效果时过渡的是 transform / opacity
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const normal = await bar(page).evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(normal).toContain("transform");
  expect(normal).toContain("opacity");
});

test("访客与锁帖：不出现按钮", async ({ page, context, browser }) => {
  // 访客
  await page.goto(`/t/${T}`);
  await expect(page.getByTestId("reply-fab")).toHaveCount(0);
  // 锁帖（会员）
  await loginAs(context, USERS.member);
  await page.goto(`/t/${T_LOCKED}`);
  await expect(page.getByTestId("reply-fab")).toHaveCount(0);
  void browser;
});
