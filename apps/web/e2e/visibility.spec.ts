import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS, loginAs } from "./support/session";

/**
 * 内容状态可见性矩阵 E2E（docs/DESIGN-MODEL.md §4）。
 * 夹具：审核版块 906 里 900007（待审核）/ 900008（已驳回，驳回理由见 content_reviews），作者都是 xiaoyi。
 * 隐藏帖/隐藏回帖由用例自己写库、自己收尾，不污染共享种子。
 */

const PENDING = 900007;
const REJECTED = 900008;
const HIDDEN_THREAD = 990001;
const HIDDEN_REPLY_MARK = "被隐藏的回帖内容-ZZ9";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, 901, ?, '被隐藏的主题', 990101, 'hidden', '2026-10-20 10:00:00', '2026-10-20 10:00:00')`,
      [HIDDEN_THREAD, USERS.xiaoyi],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, state, created_at)
       VALUES (990101, ?, 1, ?, '隐藏主题的正文', 'hidden', '2026-10-20 10:00:00')`,
      [HIDDEN_THREAD, USERS.xiaoyi],
    );
    // 在一个公开主题（900003，无回帖）下加一条被版主隐藏的回帖
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, state, created_at)
       VALUES (990102, 900003, 2, ?, ?, 'hidden', '2026-10-20 11:00:00')`,
      [USERS.alice, HIDDEN_REPLY_MARK],
    );
  });
});

test.afterAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE id IN (990101, 990102)");
    await q.exec("DELETE FROM threads WHERE id = ?", [HIDDEN_THREAD]);
  });
});

test.describe("待审核 / 已驳回", () => {
  test("游客：两个主题都是 404；审核版块本身可读，但普通列表里什么都看不到", async ({ page }) => {
    expect((await page.goto(`/t/${PENDING}`))?.status()).toBe(404);
    expect((await page.goto(`/t/${REJECTED}`))?.status()).toBe(404);
    await page.goto("/f/906");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("投稿审核区");
    // 全站置顶会出现在每个版块的置顶块里，所以空状态文案不会出现；断言普通列表的计数为 0
    await expect(page.getByText(/共 0 个主题/)).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain("等待版主处理的投稿");
    expect(html).not.toContain("内容不符合版规的投稿");
  });

  test("无关会员（既不是作者也不是版主）：同样 404、列表为空", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    expect((await page.goto(`/t/${PENDING}`))?.status()).toBe(404);
    expect((await page.goto(`/t/${REJECTED}`))?.status()).toBe(404);
    await page.goto("/f/906");
    // 全站置顶会出现在每个版块的置顶块里，所以空状态文案不会出现；断言普通列表的计数为 0
    await expect(page.getByText(/共 0 个主题/)).toBeVisible();
  });

  test("作者本人：能看到自己的待审核 / 已驳回主题；已驳回带驳回理由；列表带状态徽标", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.xiaoyi);

    await page.goto(`/t/${PENDING}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("待审核");
    await expect(page.getByText("该主题正在审核中")).toBeVisible();

    await page.goto(`/t/${REJECTED}`);
    await expect(page.getByText("该主题未通过审核")).toBeVisible();
    await expect(page.getByText("驳回理由：内容与版块主题无关，请修改后重新提交")).toBeVisible();

    await page.goto("/f/906");
    await expect(page.getByRole("link", { name: /待审核/ }).first()).toBeVisible();
    await expect(page.getByText("审核中", { exact: true })).toBeVisible();
    await expect(page.getByText("已驳回", { exact: true })).toBeVisible();
  });

  test("版主（admin）：两个主题都可见", async ({ page, context }) => {
    await loginAs(context, USERS.admin);
    await page.goto(`/t/${PENDING}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("待审核");
    await page.goto(`/t/${REJECTED}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("已驳回");
  });

  test("待审核主题不进入首页「最新动态」聚合——即使作者本人登录", async ({ page, context }) => {
    await loginAs(context, USERS.xiaoyi);
    await page.goto("/");
    expect(await page.content()).not.toContain("等待版主处理的投稿");
  });
});

test.describe("隐藏 / 删除", () => {
  test("被隐藏的主题：游客、无关会员、作者本人都是 404（对他们等同于不存在）", async ({
    page,
    context,
  }) => {
    expect((await page.goto(`/t/${HIDDEN_THREAD}`))?.status()).toBe(404);
    await loginAs(context, USERS.member);
    expect((await page.goto(`/t/${HIDDEN_THREAD}`))?.status()).toBe(404);
    await context.clearCookies();
    await loginAs(context, USERS.xiaoyi);
    expect((await page.goto(`/t/${HIDDEN_THREAD}`))?.status()).toBe(404);
    // 版块列表里同样没有
    await page.goto("/f/901");
    expect(await page.content()).not.toContain("被隐藏的主题");
  });

  test("版主（admin）：看得到被隐藏的主题，并有版主视图提示", async ({ page, context }) => {
    await loginAs(context, USERS.admin);
    await page.goto(`/t/${HIDDEN_THREAD}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("被隐藏的主题");
    await expect(page.getByText("【版主视图】该主题已被隐藏")).toBeVisible();
  });

  test("被隐藏的回帖：普通访客看不到内容也不计入回帖数；版主看得到并带「已隐藏」徽标", async ({
    page,
    context,
  }) => {
    await page.goto("/t/900003");
    expect(await page.content()).not.toContain(HIDDEN_REPLY_MARK);
    await expect(page.getByText("回帖 0 条")).toBeVisible();

    await loginAs(context, USERS.admin);
    await page.goto("/t/900003");
    await expect(page.getByText(HIDDEN_REPLY_MARK)).toBeVisible();
    await expect(page.getByText("已隐藏", { exact: true })).toBeVisible();
    await expect(page.getByText("回帖 1 条")).toBeVisible();
  });
});
