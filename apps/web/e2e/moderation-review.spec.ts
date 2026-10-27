import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { fillBody } from "./support/editor";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";

/**
 * M9 核心 E2E：审核流全链路（开审版块→pending→驳回带理由→作者重提→通过→公开+积分）+
 * 屏蔽→恢复 + 越权矩阵（版主仅所辖版块；会员 404；游客跳登录）。
 * 夹具：906 = review_policy=all 的审核版块（seed）；demo-team 仅版主 904。
 */

test.describe.configure({ mode: "serial" });

let reviewThreadUrl = "";

test.afterAll(async () => {
  // 本文件用例产生的内容（审核流/屏蔽恢复）在结束时清理——
  // 可见态主题会破坏 visibility.spec 的「共 0 个主题」断言（字母序 moderation-review 先跑）
  await withE2eDb(async (q) => {
    await q.exec(
      "DELETE FROM posts WHERE thread_id IN (SELECT id FROM threads WHERE forum_id = 906 AND id >= 990000)",
    );
    await q.exec("DELETE FROM threads WHERE forum_id = 906 AND id >= 990000");
  });
});

const authorPoints = async (page: Page, uid: number) => {
  await page.goto(`/u/${uid}`);
  const text = await page
    .getByText(/青翼币 \d+/)
    .first()
    .innerText();
  return Number(text.match(/青翼币 (\d+)/)![1]);
};

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM notifications WHERE user_id = ? AND category = 'moderation'", [
      USERS.xiaoyi,
    ]);
    await q.exec(
      "DELETE FROM content_reviews WHERE post_id IN (SELECT id FROM posts WHERE thread_id IN (SELECT id FROM threads WHERE forum_id = 906 AND id >= 990000))",
    );
    // 清掉本 spec 历史运行在 906 留下的 E2E 主题（可见态会破坏 visibility.spec 的「共 0 个主题」断言）。
    // 种子夹具在 906 的 id 是 900007/900008（9 万号段）——按「id ≥ 990000 的都是 E2E 运行产物」清理，
    // 避免 LIKE 对中文标题的编码歧义。
    await q.exec(
      "DELETE FROM posts WHERE thread_id IN (SELECT id FROM threads WHERE forum_id = 906 AND id >= 990000)",
    );
    await q.exec("DELETE FROM threads WHERE forum_id = 906 AND id >= 990000");
  });
});

test("审核流：xiaoyi 在 906 发帖 → pending 仅作者可见 → admin 驳回带理由 → 作者收通知 → 重提 → 通过 → 公开 + 积分入账", async ({
  page,
  context,
}) => {
  const restore = await relaxPostInterval();
  try {
    // 1. 作者（xiaoyi）发帖
    await loginAs(context, USERS.xiaoyi);
    const pointsBefore = await authorPoints(page, USERS.xiaoyi);
    await page.goto("/f/906/new");
    const title = `E2E 审核 ${Date.now()}`;
    await page.locator("#thread-title").fill(title);
    await fillBody(page, "待审核正文");
    await page.getByRole("button", { name: "发布主题" }).click();
    await expect(page).toHaveURL(/\/t\/\d+$/);
    reviewThreadUrl = page.url(); // 无 #p 锚（服务端 redirect）；首帖 id 用库查（见下方 edit 步骤）
    // 作者可见待审横幅
    await expect(page.getByText(/正在审核中/)).toBeVisible();
    // 发帖本身不给积分（pending 不发 thread.created）
    expect(await authorPoints(page, USERS.xiaoyi)).toBe(pointsBefore);

    // 2. 他人（member）不可见：404
    const memberCtx = await context.browser()!.newContext();
    const memberPage = await memberCtx.newPage();
    await loginAs(memberCtx, USERS.member);
    const res = await memberPage.goto(reviewThreadUrl);
    expect(res?.status()).toBe(404);
    await memberCtx.close();

    // 3. admin 驳回（带理由）
    const adminCtx = await context.browser()!.newContext();
    const adminPage = await adminCtx.newPage();
    await loginAs(adminCtx, USERS.admin);
    await adminPage.goto("/admin/review");
    await expect(adminPage.getByText(title)).toBeVisible();
    await adminPage
      .locator("li", { hasText: title })
      .locator('input[name="reason"]')
      .fill("E2E 驳回理由：内容不完整");
    await adminPage.locator("li", { hasText: title }).getByRole("button", { name: "驳回" }).click();
    await adminPage.getByRole("button", { name: "确认" }).click();
    await expect(adminPage).toHaveURL(/\/admin\/review\?rejected=1/);
    await adminCtx.close();

    // 4. 作者收到驳回通知与理由，可编辑重提
    await page.goto("/notifications?cat=moderation");
    await expect(page.getByText(/未通过审核.*E2E 驳回理由|E2E 驳回理由/).first()).toBeVisible();
    await page.goto(reviewThreadUrl);
    await expect(page.getByText(/E2E 驳回理由/).first()).toBeVisible();
    const tid = Number(reviewThreadUrl.match(/\/t\/(\d+)/)![1]);
    const postId = await withE2eDb(async (q) => {
      const rows = await q.query<{ id: number }>(
        "SELECT first_post_id AS id FROM threads WHERE id = ?",
        [tid],
      );
      return rows[0].id;
    });
    await page.goto(`/p/${postId}/edit`);
    await fillBody(page, "待审核正文（已补全）");
    await page.getByRole("button", { name: "保存修改" }).click();
    // 重提后回到 pending
    await expect(page.getByText(/正在审核中/)).toBeVisible();

    // 5. admin 通过 → 公开可见 + 作者积分入账（earn.post 补发）
    const adminCtx2 = await context.browser()!.newContext();
    const adminPage2 = await adminCtx2.newPage();
    await loginAs(adminCtx2, USERS.admin);
    await adminPage2.goto("/admin/review");
    await adminPage2
      .locator("li", { hasText: title })
      .getByRole("button", { name: "通过" })
      .click();
    await expect(adminPage2).toHaveURL(/\/admin\/review\?approved=1/);
    await adminCtx2.close();

    const guestPage = await (await context.browser()!.newContext()).newPage();
    await guestPage.goto(reviewThreadUrl);
    await expect(guestPage.getByText("待审核正文（已补全）")).toBeVisible();
    await guestPage.context().close();

    await expect
      .poll(async () => authorPoints(page, USERS.xiaoyi), { timeout: 10_000 })
      .toBeGreaterThan(pointsBefore);
  } finally {
    await restore();
  }
});

test("屏蔽→恢复：admin 屏蔽公开内容（理由）→ 作者收通知 → 恢复", async ({ browser }) => {
  // 作者独立上下文（上一用例的 context 会话仍在，但隔离更稳）
  const authorCtx = await browser.newContext();
  const authorPage = await authorCtx.newPage();
  await loginAs(authorCtx, USERS.xiaoyi);

  const adminCtx = await browser.newContext();
  const adminPage = await adminCtx.newPage();
  await loginAs(adminCtx, USERS.admin);

  await adminPage.goto(reviewThreadUrl);
  await adminPage.getByRole("link", { name: "屏蔽" }).first().click();
  await adminPage.getByLabel("理由（必填）").fill("E2E 屏蔽理由：临时屏蔽");
  const actionResponse = adminPage.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && Boolean(request.headers()["next-action"]);
  });
  await adminPage.getByRole("button", { name: "确认屏蔽" }).click();
  const response = await actionResponse;
  console.log("moderation-hide-action-response", response.status());
  // 当前路由本来就是 /t/{tid}，URL 断言不能作为 Action 完成信号；等待版主视图状态横幅。
  await expect(adminPage.getByText(/该主题已被隐藏/)).toBeVisible();
  // hidePostAction 成功后仍重定向到同一主题页；核对数据库真实迁移，避免旧 URL 造成假阳性。
  const hiddenState = await withE2eDb(async (q) =>
    q.query<{ post_state: string; thread_state: string }>(
      `SELECT p.state AS post_state, t.state AS thread_state
         FROM posts p JOIN threads t ON t.id = p.thread_id
        WHERE p.id = t.first_post_id AND t.id = ?`,
      [Number(reviewThreadUrl.match(/\/t\/(\d+)/)![1])],
    ),
  );
  expect(hiddenState[0]).toMatchObject({ post_state: "hidden", thread_state: "hidden" });

  // hidden 内容仅版主可见；作者与普通访客均按 404 隐藏存在性
  const authorRes = await authorPage.goto(reviewThreadUrl);
  expect(authorRes?.status()).toBe(404);
  await expect(authorPage.getByText("待审核正文（已补全）")).toHaveCount(0);
  const guestCtx = await browser.newContext();
  const guestPage = await guestCtx.newPage();
  const guestRes = await guestPage.goto(reviewThreadUrl);
  expect(guestRes?.status()).toBe(404);
  await expect(guestPage.getByText("待审核正文（已补全）")).toHaveCount(0);
  await guestCtx.close();
  // 作者收通知
  await authorPage.goto("/notifications?cat=moderation");
  await expect(authorPage.getByText(/E2E 屏蔽理由/).first()).toBeVisible();

  // admin 恢复（理由必填），内容重新公开
  await adminPage.goto(reviewThreadUrl);
  await adminPage.getByRole("link", { name: "恢复" }).first().click();
  await adminPage.getByLabel("理由（必填）").fill("E2E 恢复：整改完成");
  await adminPage.getByRole("button", { name: "确认恢复" }).click();
  // 同 URL 不代表 Action 完成；恢复后版主视角的隐藏横幅应消失，且状态回到 visible。
  await expect(adminPage.getByText(/该主题已被隐藏/)).toHaveCount(0);
  const restored = await withE2eDb(async (q) =>
    q.query<{ post_state: string; thread_state: string }>(
      `SELECT p.state AS post_state, t.state AS thread_state
         FROM posts p JOIN threads t ON t.id = p.thread_id
        WHERE p.id = t.first_post_id AND t.id = ?`,
      [Number(reviewThreadUrl.match(/\/t\/(\d+)/)![1])],
    ),
  );
  expect(restored[0]).toMatchObject({ post_state: "visible", thread_state: "visible" });
  await expect(authorPage.goto(reviewThreadUrl)).resolves.toBeTruthy();
  await authorCtx.close();
  await adminCtx.close();
});

test("越权矩阵：版主仅所辖版块（904）；会员访问后台 404；游客跳登录", async ({ page, context }) => {
  // team（仅 904 版主）：审核页可达但看不到 906 的内容；会员后台 404
  await loginAs(context, USERS.team);
  await page.goto("/admin/review");
  // 可达（版主门禁），但 906 的待审不在其队列
  await expect(page.getByText(/所辖版块没有待审核|待审核/).first()).toBeVisible();

  const memberCtx = await context.browser()!.newContext();
  const memberPage = await memberCtx.newPage();
  await loginAs(memberCtx, USERS.member);
  for (const path of ["/admin", "/admin/review", "/admin/users", "/admin/logs", "/admin/points"]) {
    const res = await memberPage.goto(path);
    expect(res?.status(), path).toBe(404);
  }
  await memberCtx.close();

  const guestPage = await (await context.browser()!.newContext()).newPage();
  await guestPage.goto("/admin/review");
  await expect(guestPage).toHaveURL(/\/login/);
  await guestPage.context().close();
});
