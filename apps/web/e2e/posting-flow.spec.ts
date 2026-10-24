import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";

/**
 * 全流程 E2E（M6.2 第 6 步）：发主题 → 回帖 → 编辑 → 删除 → 恢复。
 * 每一步都切换到对应角色的独立会话（会员 / 回帖者 / 版主），并检查「对方视角」确实看到了变化，
 * 而不是只看操作者自己的页面。用例串行执行，共享一个主题与一条回帖的编号。
 */

const stamp = Date.now();
const TITLE = `流程主题 ${stamp}`;
const FIRST_BODY = `流程首帖原文 ${stamp}`;
const FIRST_EDITED = `流程首帖改后 ${stamp}`;
const REPLY_BODY = `流程回帖正文 ${stamp}`;
const REASON_DELETE = "E2E 流程删除";
const REASON_RESTORE = "E2E 流程恢复";

test.describe.configure({ mode: "serial" });

let restoreLimits: () => Promise<void>;
let threadPath = "";
let replyId = 0;
const contexts: BrowserContext[] = [];

async function session(browser: Browser, userId: number): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  await loginAs(ctx, userId);
  return ctx;
}

test.beforeAll(async () => {
  restoreLimits = await relaxPostInterval();
});

test.afterAll(async () => {
  for (const c of contexts) await c.close();
  await restoreLimits();
});

test("1 会员在 E2E 发帖区发主题，跳到主题页", async ({ browser }) => {
  const ctx = await session(browser, USERS.member);
  const page = await ctx.newPage();
  await page.goto(`/f/${FIX.compose.id}`);
  await page.getByRole("link", { name: "发新主题" }).click();
  await page.locator("#thread-title").fill(TITLE);
  await page.locator("#thread-source").fill(FIRST_BODY);
  await page.getByRole("button", { name: "发布主题" }).click();

  await expect(page).toHaveURL(/\/t\/\d+$/);
  threadPath = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
});

test("2 回帖者在主题下回帖，作者视角能看到", async ({ browser }) => {
  const ctx = await session(browser, USERS.xiaoyi);
  const page = await ctx.newPage();
  await page.goto(threadPath);
  await page.locator("#reply-source").fill(REPLY_BODY);
  await page.getByRole("button", { name: "发表回复" }).click();

  await expect(page).toHaveURL(new RegExp(`${threadPath}#p(\\d+)$`));
  replyId = Number(new URL(page.url()).hash.replace("#p", ""));
  expect(replyId).toBeGreaterThan(0);
  await expect(page.getByText(REPLY_BODY)).toBeVisible();

  // 作者（会员）的视角
  const author = await session(browser, USERS.member);
  const authorPage = await author.newPage();
  await authorPage.goto(threadPath);
  await expect(authorPage.getByText(REPLY_BODY)).toBeVisible();
});

test("3 作者编辑首帖，其他人看到新版本", async ({ browser }) => {
  const ctx = await session(browser, USERS.member);
  const page = await ctx.newPage();
  await page.goto(threadPath);
  const editHref = await page.locator('a[href^="/p/"][href$="/edit"]').first().getAttribute("href");
  expect(editHref).toBeTruthy();
  await page.goto(editHref!);
  await page.locator("#edit-source").fill(FIRST_EDITED);
  await page.getByRole("button", { name: "保存修改" }).click();

  await expect(page).toHaveURL(new RegExp(`${threadPath}(#p\\d+)?$`));
  await expect(page.getByText(FIRST_EDITED)).toBeVisible();

  const reader = await session(browser, USERS.xiaoyi);
  const readerPage = await reader.newPage();
  await readerPage.goto(threadPath);
  await expect(readerPage.getByText(FIRST_EDITED)).toBeVisible();
  await expect(readerPage.getByText(FIRST_BODY)).toHaveCount(0);
});

test("4 版主删除回帖（写理由），普通用户看不到它", async ({ browser }) => {
  const mod = await session(browser, USERS.admin);
  const modPage = await mod.newPage();
  await modPage.goto(`/p/${replyId}/delete`);
  await modPage.locator("#moderation-reason").fill(REASON_DELETE);
  await modPage.getByRole("button", { name: "确认删除回帖" }).click();
  await expect(modPage).toHaveURL(new RegExp(`${threadPath}$`));

  const reader = await session(browser, USERS.xiaoyi);
  const readerPage = await reader.newPage();
  await readerPage.goto(threadPath);
  await expect(readerPage.getByText(REPLY_BODY)).toHaveCount(0);
});

test("5 版主恢复回帖（写理由），普通用户重新看到它", async ({ browser }) => {
  const mod = await session(browser, USERS.admin);
  const modPage = await mod.newPage();
  await modPage.goto(`/p/${replyId}/restore`);
  await modPage.locator("#moderation-reason").fill(REASON_RESTORE);
  await modPage.getByRole("button", { name: "确认恢复回帖" }).click();
  await expect(modPage).toHaveURL(new RegExp(`${threadPath}(#p\\d+)?$`));

  const reader = await session(browser, USERS.xiaoyi);
  const readerPage = await reader.newPage();
  await readerPage.goto(threadPath);
  await expect(readerPage.getByText(REPLY_BODY)).toBeVisible();
});
