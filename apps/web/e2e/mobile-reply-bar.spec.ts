import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { USERS, loginAs } from "./support/session";
import { bodyEditor } from "./support/editor";

/**
 * 移动端回复固定条（M10.8 Step 8，375px，只在 mobile 项目运行）：
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
       VALUES (?, ?, ?, '[E2E] 回复固定条的主题', ?, 'visible', 0, '2026-10-21 10:00:00', '2026-10-21 10:00:00'),
              (?, ?, ?, '[E2E] 回复固定条的锁帖', ?, 'visible', 1, '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
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

const bar = (page: import("@playwright/test").Page) => page.getByTestId("reply-bar");

test("会员：固定条悬在底部 Tab 上方；点击滚到回复区并聚焦编辑器；与回复区互斥，上滑再出现", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.member);
  await page.goto(`/t/${T}`);
  await bodyEditor(page).waitFor(); // 编辑器已就绪
  await expect(bar(page)).not.toHaveAttribute("inert", "");

  // 位置：在底部 Tab 栏之上，不重叠
  const tab = await page.getByRole("navigation", { name: "移动端主导航" }).boundingBox();
  const b = await bar(page).boundingBox();
  expect(b!.y + b!.height).toBeLessThanOrEqual(tab!.y + 1);
  expect(b!.x).toBeGreaterThanOrEqual(0);
  expect(b!.x + b!.width).toBeLessThanOrEqual(375);
  // 触控目标不小于 44px
  const btn = await page.getByRole("button", { name: "写回复" }).boundingBox();
  expect(btn!.height).toBeGreaterThanOrEqual(44);

  // 点击：滚到回复区、聚焦编辑器、固定条收起
  await page.getByRole("button", { name: "写回复" }).click();
  await expect(page.locator("#reply")).toBeInViewport();
  await expect(bodyEditor(page)).toBeFocused();
  await expect(bar(page)).toHaveAttribute("inert", "");

  // 上滑离开回复区：固定条回来
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(bar(page)).not.toHaveAttribute("inert", "");
});

test("减少动态效果：固定条显隐没有过渡", async ({ page, context }) => {
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

test("访客与锁帖：不出现固定条", async ({ page, context, browser }) => {
  // 访客
  await page.goto(`/t/${T}`);
  await expect(page.getByTestId("reply-bar")).toHaveCount(0);
  // 锁帖（会员）
  await loginAs(context, USERS.member);
  await page.goto(`/t/${T_LOCKED}`);
  await expect(page.getByTestId("reply-bar")).toHaveCount(0);
  void browser;
});
