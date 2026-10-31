import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

test("举报用户桶第 11 次请求被拒", async ({ browser }) => {
  const [target] = await withE2eDb((q) =>
    q.query<{ id: number }>(
      "SELECT p.id FROM posts p JOIN threads t ON t.id = p.thread_id WHERE t.id = ? AND p.floor = 1 AND p.state = 'visible' AND t.state = 'visible' AND p.author_id <> ? LIMIT 1",
      [950001, USERS.member],
    ),
  );
  if (!target) throw new Error("E2E 可见举报帖子夹具缺失");

  const context = await browser.newContext();
  const reportUrl = `/p/${target.id}/report`;
  try {
    await loginAs(context, USERS.member);
    const page = await context.newPage();
    for (let i = 0; i < 10; i++) {
      await page.goto(reportUrl);
      await page.getByLabel("举报理由（必填）").fill(`E2E 举报频控 ${i}`);
      await page.getByRole("button", { name: "提交举报" }).click();
      await expect(page).toHaveURL(new RegExp(`/p/${target.id}/report\\?(done=1|error=)`));
    }

    await page.goto(reportUrl);
    await page.getByLabel("举报理由（必填）").fill("E2E 举报频控超限");
    await page.getByRole("button", { name: "提交举报" }).click();
    await expect(page.getByText("举报过于频繁，请稍后再试", { exact: true })).toBeVisible();
  } finally {
    await withE2eDb((q) =>
      q.exec("DELETE FROM reports WHERE post_id = ? AND reporter_id = ?", [
        target.id,
        USERS.member,
      ]),
    );
    await context.close();
  }
});
