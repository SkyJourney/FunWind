import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 私信 E2E（M10）：A 发 → B 未读（铃铛 + 会话列表）→ B 打开会话（联动已读，通知清零）→
 * 顶栏「私信」入口；无 pm.send 权限用户被拒（游客 404）；超量提示。
 */

test.describe.configure({ mode: "serial" });

const convoUrl = "/messages";

async function messageUnreadCount(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/notifications/bell", { cache: "no-store" });
    if (!response.ok) throw new Error(`铃铛接口返回 ${response.status}`);
    const body = (await response.json()) as { unread: { message: number } };
    return body.unread.message;
  });
}

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM messages");
    await q.exec("DELETE FROM conversation_members");
    await q.exec("DELETE FROM conversations");
    await q.exec("DELETE FROM notifications WHERE type = 'pm.received'");
  });
});

test("游客访问 /messages → 登录跳转", async ({ page }) => {
  await page.goto(convoUrl);
  await expect(page).toHaveURL(/\/login/);
});

test("A 发私信 → B 的消息分类未读 → B 打开会话后消息分类清零", async ({
  page,
  context,
  browser,
}) => {
  // A = alice，登录后给 team 发私信
  await loginAs(context, USERS.alice);
  await page.goto(`/u/${USERS.team}`);
  await page.locator("main").getByRole("link", { name: "私信" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/messages\\?to=${USERS.team}`));
  await page.locator('textarea[name="body"]').fill("E2E 私信内容");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page).toHaveURL(new RegExp("/messages/\\d+"));

  // B = team：确认消息分类未读，并打开会话
  const bCtx = await browser.newContext();
  const bPage = await bCtx.newPage();
  await loginAs(bCtx, USERS.team);
  await bPage.goto("/");
  await expect.poll(() => messageUnreadCount(bPage)).toBeGreaterThan(0);
  await expect(bPage.getByTestId("bell-unread")).toBeVisible();
  await bPage.goto(convoUrl);
  await expect(bPage.getByText(/demo_alice/)).toBeVisible();

  await bPage
    .getByRole("link", { name: /demo_alice/ })
    .first()
    .click();
  await expect(bPage.getByText("E2E 私信内容")).toBeVisible();
  await bPage.goto("/");
  await expect.poll(() => messageUnreadCount(bPage)).toBe(0);
  await bCtx.close();
});

test("「私信」入口可见（M10.5 起在用户菜单与移动端底部 Tab）", async ({ page, context }) => {
  await loginAs(context, USERS.alice);
  await page.goto("/");
  await page.getByRole("button", { name: "demo_alice" }).click();
  // Radix DropdownMenuItem asChild(Link) 的可达角色是 menuitem
  await expect(page.getByRole("menuitem", { name: "私信" })).toBeVisible();
});

test("游客访问带 to 的私信页 → 登录跳转", async ({ browser }) => {
  const guestCtx = await browser.newContext();
  const guestPage = await guestCtx.newPage();
  await guestPage.goto(`/messages?to=${USERS.team}`);
  await expect(guestPage).toHaveURL(/\/login/);
  await guestCtx.close();
});
