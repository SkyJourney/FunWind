import { expect, test } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { fillBody } from "./support/editor";
import { txtAttachment } from "./support/images";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";

/**
 * 业务事件验收（M6.5c，桌面）：发主题（带附件）后，真实派发的 thread.created 与 attachment.uploaded
 * 到达演示消费方（首页页脚的进程内计数）。
 */
test("发主题带附件：演示消费方在首页收到 thread.created 与 attachment.uploaded", async ({
  page,
  context,
}) => {
  const restore = await relaxPostInterval();
  try {
    await loginAs(context, USERS.member);
    await page.goto(`/f/${FIX.compose.id}/new`);
    await page.locator("#thread-title").fill(`E2E 事件 ${Date.now()}`);
    await fillBody(page, "事件测试正文");
    await page
      .locator('input[type="file"][aria-label="选择附件"]')
      .setInputFiles(txtAttachment("事件附件.txt"));
    await expect(page.getByTestId("attachment-row")).toBeVisible();
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);

    await page.goto("/");
    await expect(page.getByText(/thread\.created × \d+/)).toBeVisible();
    await expect(page.getByText(/attachment\.uploaded × \d+/)).toBeVisible();
  } finally {
    await restore();
  }
});
