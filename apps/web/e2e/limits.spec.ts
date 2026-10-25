import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { fillBody } from "./support/editor";
import { FIX } from "./support/fixtures";
import { txtAttachment } from "./support/images";
import {
  patchMemberLimits,
  relaxPostInterval,
  todayThreadCount,
  todayUploadCount,
} from "./support/limits";
import { USERS, loginAs } from "./support/session";

/**
 * 频控提示 E2E（M6.5d，桌面）：间隔、每日主题、每日上传三条都由服务端真实判定，并回显到界面。
 * 限额通过 site_settings.limits 临时覆盖会员角色，每个用例在 finally 中还原。
 * 用例串行执行（playwright workers: 1），临时收紧限额不会影响并行用例。
 * 主题与帖子用 SQL 造在 954（公开、不审核）；ID 段 961301 起，与其它用例不重叠。
 */

const TID = 961301;
const PID = 961401;
const NOTICE = 'p[role="alert"]';

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [TID]);
    await q.exec("DELETE FROM threads WHERE id = ?", [TID]);
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, ?, ?, '[E2E] 频控的主题', ?, 'visible', '2026-10-21 10:00:00', '2026-10-21 10:00:00')`,
      [TID, FIX.compose.id, USERS.xiaoyi, PID],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, '频控测试首帖', 0, 'visible', '2026-10-21 10:00:00')`,
      [PID, TID, USERS.xiaoyi],
    );
  });
});

test.describe("频控提示", () => {
  test("发帖间隔：会员连续回帖，第二次被间隔拦下并回显提示", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    const restoreRelaxed = await relaxPostInterval();
    let restoreTight: (() => Promise<void>) | undefined;
    try {
      await page.goto(`/t/${TID}`);
      await fillBody(page, `E2E 间隔首条 ${Date.now()}`);
      await page.getByRole("button", { name: "发表回复" }).click();
      await expect(page).toHaveURL(new RegExp(`/t/${TID}(\\?page=\\d+)?#p\\d+$`));

      // 首条已入库：把间隔收紧到一小时，下一条必然落在间隔之内
      restoreTight = await patchMemberLimits({ postIntervalSec: 3600 });
      await page.goto(`/t/${TID}`);
      await fillBody(page, `E2E 间隔第二条 ${Date.now()}`);
      await page.getByRole("button", { name: "发表回复" }).click();

      await expect(page).toHaveURL(/reply=too_frequent#reply$/);
      await expect(page.locator(NOTICE)).toHaveText("发帖太频繁，请稍后再试。");
    } finally {
      await restoreTight?.();
      await restoreRelaxed();
    }
  });

  test("每日主题：超过当日额度后再发主题被拦下，并回显提示", async ({ page, context }) => {
    await loginAs(context, USERS.alice);
    // 额度 = 今日已发数 + 1：第一条恰好用掉额度，第二条必然超限
    const used = await todayThreadCount(USERS.alice);
    const restore = await patchMemberLimits({ postIntervalSec: 0, threadsPerDay: used + 1 });
    try {
      await page.goto(`/f/${FIX.compose.id}/new`);
      await page.locator("#thread-title").fill(`E2E 配额首条 ${Date.now()}`);
      await fillBody(page, "每日额度首条正文");
      await page.getByRole("button", { name: "发布主题" }).click();
      await expect(page).toHaveURL(/\/t\/\d+$/);

      await page.goto(`/f/${FIX.compose.id}/new`);
      await page.locator("#thread-title").fill(`E2E 配额第二条 ${Date.now()}`);
      await fillBody(page, "每日额度第二条正文");
      await page.getByRole("button", { name: "发布主题" }).click();

      await expect(page).toHaveURL(/\/new\?error=quota_exceeded$/);
      await expect(page.locator(NOTICE)).toHaveText("今日发主题次数已达上限，明天再来吧。");
    } finally {
      await restore();
    }
  });

  test("每日上传：超过当日额度后再上传被拦下，并回显提示", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    const used = await todayUploadCount(USERS.member);
    const restore = await patchMemberLimits({ postIntervalSec: 0, uploadsPerDay: used + 1 });
    try {
      await page.goto(`/f/${FIX.compose.id}/new`);
      const picker = page.locator('input[type="file"][aria-label="选择附件"]');
      await picker.setInputFiles(txtAttachment(`额度附件一 ${Date.now()}.txt`));
      await expect(page.getByTestId("attachment-row")).toBeVisible();

      await picker.setInputFiles(txtAttachment(`额度附件二 ${Date.now()}.txt`));
      await expect(page.locator(NOTICE)).toHaveText("今天的上传次数已用完。");
      await expect(page.getByTestId("attachment-row")).toHaveCount(1);
    } finally {
      await restore();
    }
  });
});
