import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { fillBody } from "./support/editor";
import { txtAttachment } from "./support/images";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";
import { withE2eDb } from "./support/db";

/**
 * 业务事件验收（M7 起）：发主题带附件后，thread.created 与 attachment.uploaded 经 outbox
 * 到达**真实消费方**（积分模块 → earn.post 入账），event_log / event_outbox 各有留痕。
 */
test("发主题带附件：积分入账（真实消费方）且 outbox 全部标记已派发", async ({ page, context }) => {
  const restore = await relaxPostInterval();
  try {
    await loginAs(context, USERS.member);
    const title = `E2E 事件 ${Date.now()}`;
    await page.goto(`/f/${FIX.compose.id}/new`);
    await page.locator("#thread-title").fill(title);
    await fillBody(page, "事件测试正文");
    await page
      .locator('input[type="file"][aria-label="选择附件"]')
      .setInputFiles(txtAttachment("事件附件.txt"));
    await expect(page.getByTestId("attachment-row")).toBeVisible();
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);

    // 真实消费方（积分模块）收到 thread.created：/points 台账出现发帖奖励
    await page.goto("/points");
    await expect(page.getByText("发帖奖励").first()).toBeVisible();

    // outbox：thread.created 已标记派发（快路径）
    await withE2eDb(async (q) => {
      const created = await q.query<{ dispatched_at: string | null }>(
        `SELECT dispatched_at FROM event_outbox
         WHERE event_name = 'thread.created' AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.title')) = ?`,
        [title],
      );
      expect(created, "thread.created 的 outbox 行").toHaveLength(1);
      expect(created[0].dispatched_at).not.toBeNull();
    });

    // outbox：attachment.uploaded 经发帖人过滤（附件载荷无 title），同样已标记派发
    await withE2eDb(async (q) => {
      const rows = await q.query<{ dispatched_at: string | null }>(
        `SELECT dispatched_at FROM event_outbox
         WHERE event_name = 'attachment.uploaded' AND actor_id = ?
         ORDER BY id DESC LIMIT 1`,
        [USERS.member],
      );
      expect(rows, "本会员最近一条 attachment.uploaded 的 outbox 行").toHaveLength(1);
      expect(rows[0].dispatched_at).not.toBeNull();
    });
  } finally {
    await restore();
  }
});
