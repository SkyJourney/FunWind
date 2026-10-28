import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

/**
 * 私信聊天页的上滑加载（M10.7 Step 3c）。用例临时造一个 75 条消息的会话（xiaoyi ↔ alice），用完清掉。
 * 每批 30 条：首屏最新 30（消息 46–75），上滑再取 30（16–45），最后 15（1–15）。
 */

const ME = USERS.xiaoyi;
const TOTAL = 75;
let convId = 0;
/** 与发送动作同一套会话键（小 uid:大 uid）：用例里发消息才会落进造好的这个会话 */
const PAIR_KEY = `${Math.min(ME, USERS.alice)}:${Math.max(ME, USERS.alice)}`;

const bubbles = (page: Page) => page.locator("main ul > li");
const atBottom = (page: Page) =>
  page.evaluate(
    () => window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4,
  );

test.beforeEach(async () => {
  convId = await withE2eDb(async (q) => {
    const c = await q.exec(
      "INSERT INTO conversations (kind, pair_key, last_message_at, created_at) VALUES ('direct', ?, NOW(), NOW())",
      [PAIR_KEY],
    );
    await q.exec(
      "INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)",
      [c.insertId, ME, c.insertId, USERS.alice],
    );
    for (let i = 1; i <= TOTAL; i++) {
      await q.exec(
        "INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, DATE_SUB(NOW(), INTERVAL ? MINUTE))",
        [c.insertId, i % 2 === 0 ? ME : USERS.alice, `消息 ${i}`, TOTAL - i],
      );
    }
    return c.insertId;
  });
});

test.afterEach(async () => {
  await withE2eDb(async (q) => {
    const sub = "(SELECT id FROM conversations WHERE pair_key = ?)";
    await q.exec(`DELETE FROM messages WHERE conversation_id IN ${sub}`, [PAIR_KEY]);
    await q.exec(`DELETE FROM conversation_members WHERE conversation_id IN ${sub}`, [PAIR_KEY]);
    await q.exec("DELETE FROM conversations WHERE pair_key = ?", [PAIR_KEY]);
  });
});

test.describe("聊天页上滑加载", () => {
  test("进入即最新一批：30 条、停在底部、最新消息可见（修复原先默认打开最旧一页）", async ({
    page,
    context,
  }) => {
    await loginAs(context, ME);
    await page.goto(`/messages/${convId}`);
    await expect(bubbles(page)).toHaveCount(30);
    await expect(page.getByText(`消息 ${TOTAL}`, { exact: true })).toBeInViewport();
    expect(await atBottom(page)).toBe(true);
    // 最旧的一批还没加载
    await expect(page.getByText("消息 1", { exact: true })).toHaveCount(0);
  });

  test("上滑自动加载更早一批：消息数 30 → 60，且视线中的消息位置不跳动", async ({
    page,
    context,
  }) => {
    await loginAs(context, ME);
    await page.goto(`/messages/${convId}`);
    await expect(bubbles(page)).toHaveCount(30);
    // 先等水合完成：进入时组件会滚到底部，此后再上滑才是用户真实的操作顺序
    await expect.poll(() => atBottom(page)).toBe(true);

    // 滚到顶，同步量出首屏最旧一条（消息 46）此刻在视口中的位置，再等更早一批插入
    const before = await page.evaluate(() => {
      window.scrollTo(0, 0);
      const first = [...document.querySelectorAll("main ul > li")].find((li) =>
        li.textContent?.includes("消息 46"),
      )!;
      return first.getBoundingClientRect().top;
    });
    await expect(bubbles(page)).toHaveCount(60);

    const after = await page.evaluate(() => {
      const first = [...document.querySelectorAll("main ul > li")].find((li) =>
        li.textContent?.includes("消息 46"),
      )!;
      return first.getBoundingClientRect().top;
    });
    // 补偿滚动：消息 46 仍停在原来的视口位置（允许 2px 取整误差）
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  });

  test("一路上滑到头：75 条无重复、按时间升序排列，出现「没有更早的消息了」", async ({
    page,
    context,
  }) => {
    await loginAs(context, ME);
    await page.goto(`/messages/${convId}`);
    await expect
      .poll(
        async () => {
          await page.evaluate(() => window.scrollTo(0, 0));
          return bubbles(page).count();
        },
        { timeout: 15_000 },
      )
      .toBe(TOTAL);
    await expect(page.getByText("没有更早的消息了")).toBeVisible();
    const bodies = await bubbles(page).evaluateAll((els) =>
      els.map((e) => e.querySelector("p")?.textContent ?? ""),
    );
    expect(bodies).toEqual(Array.from({ length: TOTAL }, (_, i) => `消息 ${i + 1}`));
  });

  test("发一条私信后回到聊天页，能在底部看到刚发的消息", async ({ page, context }) => {
    await loginAs(context, ME);
    await page.goto(`/messages/${convId}`);
    await page.locator('textarea[name="body"]').fill("E2E 新发的一条");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page).toHaveURL(new RegExp(`/messages/${convId}$`));
    await expect(page.getByText("E2E 新发的一条")).toBeInViewport();
    expect(await atBottom(page)).toBe(true);
  });
});

test.describe("聊天页 · 无 JS 兜底", () => {
  test.use({ javaScriptEnabled: false });

  test("顶部是「查看更早的消息」真链接，?before= 查看历史窗口并可回到最新", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      await loginAs(context, ME);
      const page = await context.newPage();
      await page.goto(`/messages/${convId}`);
      await expect(bubbles(page)).toHaveCount(30);
      const older = page.getByRole("link", { name: "查看更早的消息" });
      const href = await older.getAttribute("href");
      expect(href).toMatch(new RegExp(`/messages/${convId}\\?before=\\d+$`));

      await page.goto(href!);
      await expect(bubbles(page)).toHaveCount(30);
      await expect(page.getByText("消息 45", { exact: true })).toBeVisible(); // 历史窗口 16–45
      await expect(page.getByText(`消息 ${TOTAL}`, { exact: true })).toHaveCount(0);
      await page.getByRole("link", { name: "回到最新消息 →" }).click();
      await expect(page.getByText(`消息 ${TOTAL}`, { exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe("聊天取数端点", () => {
  test("游客 401；非成员 404；成员按游标取批，且不推进已读指针", async ({
    request,
    context,
    page,
    browser,
    baseURL,
  }) => {
    expect((await request.get(`/api/stream/messages/${convId}`)).status()).toBe(401);

    const outsider = await browser.newContext({ baseURL });
    try {
      await loginAs(outsider, USERS.member);
      expect((await outsider.request.get(`/api/stream/messages/${convId}`)).status()).toBe(404);
    } finally {
      await outsider.close();
    }

    await loginAs(context, ME);
    const first = (await (await page.request.get(`/api/stream/messages/${convId}`)).json()) as {
      items: { id: number; body: string }[];
      hasMore: boolean;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(30);
    expect(first.items.at(-1)!.body).toBe(`消息 ${TOTAL}`);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(String(first.items[0]!.id));

    const last = (await (
      await page.request.get(`/api/stream/messages/${convId}?before=${first.nextCursor}&x=1`)
    ).json()) as { items: unknown[] };
    expect(last.items).toHaveLength(30);

    // 取数端点只读：不推进已读指针（已读只在打开聊天页时推进）
    const [row] = await withE2eDb((q) =>
      q.query<{ last_read_message_id: number | null }>(
        "SELECT last_read_message_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
        [convId, ME],
      ),
    );
    expect(row!.last_read_message_id).toBeNull();
  });
});
