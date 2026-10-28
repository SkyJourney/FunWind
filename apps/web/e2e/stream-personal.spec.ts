import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

/**
 * 个人数据列表的流式加载（M10.7 Step 3b 第二批）：积分流水、私信会话列表、通知。
 * 数据由用例用 xiaoyi(90002) 的账号临时造出（每类都超过一页），用完清掉；该账号不被其他用例使用。
 */

const ME = USERS.xiaoyi;

async function scrollUntil(page: Page, count: () => Promise<number>, target: number) {
  await expect
    .poll(
      async () => {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        return count();
      },
      { timeout: 10_000 },
    )
    .toBe(target);
}

/* ---------------- 积分流水 ---------------- */

test.describe("积分流水", () => {
  const rows = (page: Page) => page.locator("main li", { hasText: "e2e-pts-" });

  test.beforeEach(async () => {
    await withE2eDb(async (q) => {
      for (let i = 0; i < 45; i++) {
        await q.exec(
          `INSERT INTO point_ledger (user_id, delta, balance_after, channel, idempotency_key, note, created_at)
           VALUES (?, 1, 100, 'adjust.admin', ?, ?, DATE_SUB(NOW(), INTERVAL ? MINUTE))`,
          [ME, `e2e-stream-pts-${i}`, `e2e-pts-${String(i).padStart(2, "0")}`, i],
        );
      }
    });
  });
  test.afterEach(async () => {
    await withE2eDb((q) =>
      q.exec("DELETE FROM point_ledger WHERE idempotency_key LIKE 'e2e-stream-pts-%'"),
    );
  });

  test("触底追加：每页 20 → 40 → 45，无重复；首屏错落、追加项淡入", async ({ page, context }) => {
    await loginAs(context, ME);
    await page.goto("/points");
    await expect(rows(page)).toHaveCount(20);
    expect(
      await page
        .locator("main li.fw-enter")
        .first()
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("fw-enter");

    await scrollUntil(page, () => rows(page).count(), 40);
    await scrollUntil(page, () => rows(page).count(), 45);
    const notes = await rows(page).evaluateAll((els) => els.map((e) => e.textContent));
    expect(new Set(notes).size).toBe(45);
    await expect(page.getByText("没有更多了")).toBeVisible();
    await expect(page.locator("main li.fw-fade-in").first()).toBeVisible();
  });

  test("无 JS：翻页链接与数字分页可用", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      await loginAs(context, ME);
      const page = await context.newPage();
      await page.goto("/points");
      await expect(page.locator("a[rel=next]")).toHaveAttribute("href", "/points?page=2");
      await expect(page.getByRole("navigation", { name: "分页" })).toBeVisible();
      await page.goto("/points?page=3");
      await expect(rows(page)).toHaveCount(5);
    } finally {
      await context.close();
    }
  });

  test("游客取数端点 401；越界页为空", async ({ request, context, page }) => {
    expect((await request.get("/api/stream/points?page=1")).status()).toBe(401);
    await loginAs(context, ME);
    const body = await (await page.request.get("/api/stream/points?page=999")).json();
    expect(body).toMatchObject({ items: [], hasMore: false });
  });
});

/* ---------------- 私信会话列表 ---------------- */

test.describe("私信会话列表", () => {
  const rows = (page: Page) => page.locator("main ul li a[href^='/messages/']");

  test.beforeEach(async () => {
    await withE2eDb(async (q) => {
      for (let i = 0; i < 25; i++) {
        const c = await q.exec(
          "INSERT INTO conversations (kind, pair_key, last_message_at, created_at) VALUES ('direct', ?, DATE_SUB(NOW(), INTERVAL ? MINUTE), NOW())",
          [`e2e-stream-${i}`, i],
        );
        await q.exec(
          "INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)",
          [c.insertId, ME, c.insertId, USERS.alice],
        );
      }
    });
  });
  test.afterEach(async () => {
    await withE2eDb(async (q) => {
      await q.exec(
        "DELETE FROM conversation_members WHERE conversation_id IN (SELECT id FROM conversations WHERE pair_key LIKE 'e2e-stream-%')",
      );
      await q.exec("DELETE FROM conversations WHERE pair_key LIKE 'e2e-stream-%'");
    });
  });

  test("触底追加：20 → 25，无重复，到底提示", async ({ page, context }) => {
    await loginAs(context, ME);
    await page.goto("/messages");
    await expect(rows(page)).toHaveCount(20);
    await scrollUntil(page, () => rows(page).count(), 25);
    const hrefs = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    expect(new Set(hrefs).size).toBe(25);
    await expect(page.getByText("没有更多了")).toBeVisible();
  });

  test("直达 ?page=2：从第 2 页起，提供「上一页」真链接", async ({ page, context }) => {
    await loginAs(context, ME);
    await page.goto("/messages?page=2");
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByRole("link", { name: "← 上一页" })).toHaveAttribute("href", "/messages");
  });

  test("无 JS：底部是指向下一页的真链接", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      await loginAs(context, ME);
      const page = await context.newPage();
      await page.goto("/messages");
      await expect(page.locator("a[rel=next]")).toHaveAttribute("href", "/messages?page=2");
    } finally {
      await context.close();
    }
  });

  test("游客取数端点 401", async ({ request }) => {
    expect((await request.get("/api/stream/conversations?page=1")).status()).toBe(401);
  });
});

/* ---------------- 通知（游标分页 + 就地已读） ---------------- */

test.describe("通知", () => {
  const rows = (page: Page) => page.locator("main ul > li.rounded-xl");
  const unreadCount = (): Promise<number> =>
    withE2eDb(async (q) => {
      const [r] = await q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
        [ME],
      );
      return Number(r!.n);
    });
  const totalInteraction = (): Promise<number> =>
    withE2eDb(async (q) => {
      const [r] = await q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND category = 'interaction'",
        [ME],
      );
      return Number(r!.n);
    });

  test.beforeEach(async () => {
    await withE2eDb(async (q) => {
      for (let i = 0; i < 45; i++) {
        await q.exec(
          `INSERT INTO notifications (user_id, category, type, actor_id, target_type, target_id, data, dedup_key, created_at)
           VALUES (?, 'interaction', 'post.liked', ?, 'post', 1, '{}', ?, DATE_SUB(NOW(), INTERVAL ? MINUTE))`,
          [ME, USERS.alice, `e2e-stream-nf-${i}`, i + 1],
        );
      }
    });
  });
  test.afterEach(async () => {
    await withE2eDb((q) =>
      q.exec("DELETE FROM notifications WHERE dedup_key LIKE 'e2e-stream-nf-%'"),
    );
  });

  test("游标分页触底追加：每段 20 条，追加到底，无重复", async ({ page, context }) => {
    await loginAs(context, ME);
    await page.goto("/notifications?cat=interaction");
    await expect(rows(page)).toHaveCount(20);
    const total = await totalInteraction();
    await scrollUntil(page, () => rows(page).count(), total);
    await expect(page.getByText("没有更多了")).toBeVisible();
    // 游标请求带 before 与分类
    const res = await page.request.get("/api/stream/notifications?cat=interaction");
    const first = (await res.json()) as { items: { key: string }[]; nextCursor: string | null };
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const keys = first.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("追加出来的通知点「已读」就地生效：不跳转、已追加的列表不丢、未读数下降", async ({
    page,
    context,
  }) => {
    await loginAs(context, ME);
    await page.goto("/notifications?cat=interaction");
    await scrollUntil(page, () => rows(page).count(), await totalInteraction());
    const before = await rows(page).count();
    const unreadBefore = await unreadCount();
    // 页头「未读 N」是通知 + 公告的合计，与库里纯通知未读数不同；按页头自己的前后差值断言
    const headerBefore = Number(
      (await page.getByText(/^未读 \d+$/).innerText()).replace("未读 ", ""),
    );

    // 取最后一条（一定是追加出来的）并点它的「已读」
    const last = rows(page).last();
    await last.getByRole("button", { name: "已读" }).click();
    await expect(last.getByRole("button", { name: "已读" })).toHaveCount(0);

    await expect.poll(unreadCount).toBe(unreadBefore - 1);
    await expect(page).toHaveURL(/\/notifications\?cat=interaction$/);
    expect(await rows(page).count()).toBe(before); // 列表没有被重置回首屏
    // router.refresh() 之后页头合计恰好少 1
    await expect(page.getByText(`未读 ${headerBefore - 1}`, { exact: true })).toBeVisible();
  });

  test("无 JS：「已读」仍是表单提交 + 重定向，状态落库", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      await loginAs(context, ME);
      const page = await context.newPage();
      await page.goto("/notifications?cat=interaction");
      const unreadBefore = await unreadCount();
      await rows(page).first().getByRole("button", { name: "已读" }).click();
      await expect(page).toHaveURL(/\/notifications\?cat=interaction$/);
      await expect.poll(unreadCount).toBe(unreadBefore - 1);
      await expect(page.locator("a[rel=next]")).toHaveAttribute(
        "href",
        /\/notifications\?cat=interaction&before=/,
      );
    } finally {
      await context.close();
    }
  });

  test("游客取数端点 401；非法分类被忽略", async ({ request, context, page }) => {
    expect((await request.get("/api/stream/notifications")).status()).toBe(401);
    await loginAs(context, ME);
    const res = await page.request.get("/api/stream/notifications?cat=hack");
    expect(res.status()).toBe(200);
  });
});
