import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS } from "./support/session";

/**
 * M16 Step 4 覆盖补齐 E2E（docs/milestones/M16-motion-coverage.md §9）：
 * - 楼层进场：首屏 10 层 MotionList 错落（animationDelay 递增），深层楼层滚入淡入（FloorReveal）；
 * - 锚点：点击「回复 #N」滚到目标楼层且 :target 高亮；深链直开同样高亮；
 * - 回到顶部：滚动超过一屏出现，点击回顶。
 * 自建 31 楼夹具线程（991201，论坛 901），测后删除——避免污染首页信息流 visual 基线。
 */

const TALL_THREAD = 991201;
const TALL_POST = TALL_THREAD + 100;

const lockStates = (page: Page) => page.locator("[data-gate-state]");
void lockStates;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [TALL_THREAD]);
    await q.exec("DELETE FROM threads WHERE id = ?", [TALL_THREAD]);
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, 901, ?, ?, ?, 'visible', '2026-11-12 11:00:00', '2026-11-12 11:00:00')`,
      [TALL_THREAD, USERS.alice, `[E2E] M16 楼层`, TALL_POST],
    );
    for (let floor = 1; floor <= 31; floor += 1) {
      await q.exec(
        `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, reply_to_post_id, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 'visible', ?, '2026-11-12 11:00:00')`,
        [
          TALL_POST + floor - 1,
          TALL_THREAD,
          floor,
          USERS.alice,
          `楼层 ${floor} 的正文内容。`,
          floor === 5 ? TALL_POST : null, // 楼层 5 回复首帖 → 渲染「↩ 回复 #1」锚点链接
        ],
      );
    }
  });
});

test.afterAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [TALL_THREAD]);
    await q.exec("DELETE FROM threads WHERE id = ?", [TALL_THREAD]);
  });
});

test("楼层进场：首屏 10 层错落（animationDelay 递增），深层楼层滚入时淡入", async ({ page }) => {
  await page.goto(`/t/${TALL_THREAD}`);
  await page.waitForTimeout(1500);
  const delays = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main .fw-enter")).map(
      (el) => getComputedStyle(el).animationDelay,
    ),
  );
  expect(delays.length, "首屏错落楼层数（MotionList 封顶 10）").toBe(10);
  expect(delays[0]!, "首层无延迟").toMatch(/0s|0ms/);
  expect(delays[9]!, "第 10 层延迟 450ms").toMatch(/0\.45s|450ms/);

  // 深层楼层（同页超出错落上限的第 11+ 层，滚入视口前无淡入类；FloorReveal 滚入后在包裹层挂上——楼层 Card 不持有）
  const deepFloor = page.locator("#p991315"); // 第 15 楼（错落上限外的深层楼层）
  expect(
    await deepFloor.evaluate((el) => el.parentElement?.classList.contains("fw-fade-in") ?? false),
  ).toBe(false);
  await deepFloor.scrollIntoViewIfNeeded();
  // FloorReveal 的 IO 底部收窄 80px：再滚 150px 让楼层进入触发区
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(600);
  const dump = await page.evaluate(() =>
    [...document.querySelectorAll("main [id^='p']")].map((e) => ({
      id: e.id,
      y: Math.round(e.getBoundingClientRect().top + window.scrollY),
      wrap:
        e.parentElement?.className
          .split(" ")
          .filter((c) => c.startsWith("fw-") || c === "opacity-0")
          .join(",") ?? "",
    })),
  );
  console.log("[m16dbg] 楼层状态:", JSON.stringify(dump));
  expect(
    await deepFloor.evaluate((el) => el.parentElement?.classList.contains("fw-fade-in") ?? false),
  ).toBe(true);
});

test("锚点跳转：点「回复 #N」平滑滚到目标楼层并挂 JS 高亮类", async ({ page }) => {
  await page.goto(`/t/${TALL_THREAD}`);
  await page.waitForTimeout(1500);
  const replyLink = page.locator("main a[href^='#p']").first();
  await replyLink.scrollIntoViewIfNeeded();
  const href = (await replyLink.getAttribute("href"))!;
  await replyLink.click();
  await page.waitForTimeout(900); // 平滑滚动 + 高亮动画中段（fw-floor-hl-on 挂 2.1s）

  expect(await page.locator(href).evaluate((el) => el.classList.contains("fw-floor-hl-on"))).toBe(
    true,
  );
  expect(new URL(page.url()).hash).toBe(href);
});

test("深链直开：#楼层 hash 加载后 :target 高亮生效", async ({ page }) => {
  await page.goto(`/t/${TALL_THREAD}#p${TALL_POST + 4}`);
  await page.waitForTimeout(900);
  expect(await page.locator(`#p${TALL_POST + 4}`).evaluate((el) => el.matches(":target"))).toBe(
    true,
  );
});

test("回到顶部：滚动超过一屏出现，点击回顶且按钮隐藏", async ({ page }) => {
  await page.goto(`/t/${TALL_THREAD}`);
  await page.waitForTimeout(1500);
  const top = page.getByRole("button", { name: "回到顶部" });
  await expect(top).toBeHidden(); // 页顶不出现

  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(400);
  await expect(top).toBeVisible();
  await top.click();
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(60);
  await expect(top).toBeHidden(); // 回顶后隐藏
});
