import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";

/**
 * 浏览量 E2E（M6.5b，桌面）：主题页挂载后发出信标，批量写入（约 10 秒一轮）后 view_count 增加。
 * 使用本文件专用的新主题（不与其它用例共享去重窗口）。
 */

const TID = 960601;
const PID = 960701;
const readCount = () =>
  withE2eDb(async (q) => {
    const rows = await q.query<{ n: number }>("SELECT view_count AS n FROM threads WHERE id = ?", [
      TID,
    ]);
    return Number(rows[0]?.n ?? -1);
  });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [TID]);
    await q.exec("DELETE FROM threads WHERE id = ?", [TID]);
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, view_count, created_at, last_posted_at)
       VALUES (?, ?, 90002, '[E2E] 浏览量', ?, 'visible', 0, '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [TID, FIX.compose.id, PID],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, 90002, '浏览量测试', 0, 'visible', '2026-10-21 10:00:00')`,
      [PID, TID],
    );
  });
});

test("游客阅读主题：信标计数，批量写入后 view_count 增加", async ({ page }) => {
  expect(await readCount()).toBe(0);
  await page.goto(`/t/${TID}`);
  await expect.poll(readCount, { timeout: 30_000, intervals: [1_000] }).toBe(1);
});
