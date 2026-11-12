import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { USERS } from "./support/session";

/**
 * M16 Step 4 覆盖补齐 E2E（docs/milestones/M16-motion-coverage.md §10）：
 * - 楼层进场：首屏 10 层 MotionList 错落（fw-enter，animationDelay 递增且不被覆盖），
 *   深层楼层滚入前挂起隐藏（opacity-0）、滚入淡入（FloorReveal 单向显影）；
 * - 锚点：点击「回复 #N」平滑滚到目标楼层并挂 JS 高亮类（pushState 不激活 :target）；
 *   深链直开走 :target CSS 高亮；
 * - 回到顶部：ReplyFab 同款常驻口径（只动 transform/opacity + inert），移动端 base hidden。
 * 自建 31 楼夹具线程（991201，论坛 901），测后删除——避免污染首页信息流 visual 基线。
 */

const TALL_THREAD = 991201;
const TALL_POST = TALL_THREAD + 100;

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
  const stagger = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main .fw-enter")).map((el) => {
      const style = getComputedStyle(el);
      return { delay: style.animationDelay, name: style.animationName };
    }),
  );
  expect(stagger.length, "首屏错落楼层数（MotionList 封顶 10）").toBe(10);
  expect(stagger[0]!.delay, "首层无延迟").toMatch(/0s|0ms/);
  expect(stagger[9]!.delay, "第 10 层延迟 450ms").toMatch(/0\.45s|450ms/);
  // 错落预设不被同元素其他动画覆盖（Step 4.5 P0-1：.fw-fade-in 声明序在后，同挂会吞掉位移预设）
  expect(new Set(stagger.map((s) => s.name)), "错落动画名统一为 fw-enter").toEqual(
    new Set(["fw-enter"]),
  );

  // 深层楼层（同页超出错落上限的第 11+ 层）：滚入视口前挂起隐藏（opacity-0）且未淡入；
  // FloorReveal 滚入后在包裹层挂 fw-fade-in——楼层 Card 不持有（断言目标为包裹层）
  const deepFloor = page.locator("#p991315"); // 第 15 楼（错落上限外的深层楼层）
  const wrapState = () =>
    deepFloor.evaluate((el) => {
      const cls = el.parentElement?.classList;
      return {
        fade: cls?.contains("fw-fade-in") ?? false,
        hidden: cls?.contains("opacity-0") ?? false,
      };
    });
  expect(await wrapState(), "滚入前：挂起隐藏、未淡入").toEqual({ fade: false, hidden: true });
  await deepFloor.scrollIntoViewIfNeeded();
  // FloorReveal 的 IO 底部收窄 80px：再滚 150px 让楼层进入触发区
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(600);
  expect(await wrapState(), "滚入后：单向淡入且不再隐藏").toEqual({ fade: true, hidden: false });
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

test("回到顶部：滚动超过一屏出现，点击回顶且按钮隐藏（ReplyFab 同款口径）", async ({ page }) => {
  await page.goto(`/t/${TALL_THREAD}`);
  await page.waitForTimeout(1500);
  // 常驻渲染 + 隐藏态挂 inert/aria-hidden：getByRole 会跳过 aria-hidden 元素，用属性定位器断言状态
  const top = page.locator('button[aria-label="回到顶部"]');
  const hiddenState = () =>
    top.evaluate((el) => ({
      hidden: el.classList.contains("opacity-0") && el.getAttribute("inert") !== null,
    }));
  expect(await hiddenState(), "页顶隐藏：opacity-0 + inert").toEqual({ hidden: true });

  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(400);
  expect(await hiddenState(), "深滚后显示").toEqual({ hidden: false });
  await top.click();
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(60);
  expect(await hiddenState(), "回顶后隐藏").toEqual({ hidden: true });

  // 移动端（<md）：base hidden——即使深滚也 display:none（与 ReplyFab 同位互斥，不参与布局）
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(300);
  expect(await top.evaluate((el) => getComputedStyle(el).display), "移动端恒不显示").toBe("none");
});

/**
 * reduce 降级（M16.1 Step 4 补齐 M16 残值）：BackToTop 与 SmoothAnchors 的 reduce 是
 * **点击时的 JS 参数分支**（behavior auto / 不挂高亮类），不是 CSS 动画名——
 * 不能套 reduce-overlays 的 animationName 断言，改用滚动探针记录真实入参。
 * 只记录对象形式的调用：NavKindCapture 的恢复循环用的是位置参数 scrollTo(0, y)，不干扰。
 */
const scrollProbe = `
  window.__scrollCalls = [];
  const origTo = window.scrollTo.bind(window);
  window.scrollTo = (...args) => {
    if (args[0] && typeof args[0] === "object")
      window.__scrollCalls.push({ kind: "scrollTo", behavior: args[0].behavior ?? null });
    return origTo(...args);
  };
  const origInto = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (arg) {
    if (arg && typeof arg === "object")
      window.__scrollCalls.push({ kind: "scrollIntoView", behavior: arg.behavior ?? null });
    return origInto.call(this, arg);
  };
`;

test("reduce 降级：回顶与锚点都瞬时跳转，锚点不挂高亮类；关掉 reduce 立即恢复平滑", async ({
  page,
}) => {
  await page.addInitScript(scrollProbe);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/t/${TALL_THREAD}`);
  await page.waitForTimeout(1500);

  // ① reduce 下的锚点点击：behavior auto + 不挂 fw-floor-hl-on
  const replyLink = page.locator("main a[href^='#p']").first();
  await replyLink.scrollIntoViewIfNeeded();
  const href = (await replyLink.getAttribute("href"))!;
  await page.evaluate(() => (window.__scrollCalls = []));
  await replyLink.click();
  await page.waitForTimeout(500);
  const anchorCalls = await page.evaluate(
    () => window.__scrollCalls as { kind: string; behavior: string | null }[],
  );
  expect(
    anchorCalls.filter((c) => c.kind === "scrollIntoView").every((c) => c.behavior === "auto"),
    "reduce 下锚点瞬时跳转",
  ).toBe(true);
  expect(anchorCalls.some((c) => c.kind === "scrollIntoView")).toBe(true);
  expect(await page.locator(href).evaluate((el) => el.classList.contains("fw-floor-hl-on"))).toBe(
    false,
  );
  // 导航语义不受 reduce 影响：hash 照常写
  expect(new URL(page.url()).hash).toBe(href);

  // ② reduce 下的回顶：behavior auto
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(400);
  await page.evaluate(() => (window.__scrollCalls = []));
  await page.locator('button[aria-label="回到顶部"]').click();
  await page.waitForTimeout(600);
  const topCalls = await page.evaluate(
    () => window.__scrollCalls as { kind: string; behavior: string | null }[],
  );
  expect(topCalls).toContainEqual({ kind: "scrollTo", behavior: "auto" });
  expect(await page.evaluate(() => window.scrollY)).toBeLessThan(60);

  // ③ 会话中途关掉 reduce：同一按钮立即恢复平滑（偏好实时读取，不是挂载时固化）
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(400);
  await page.evaluate(() => (window.__scrollCalls = []));
  await page.locator('button[aria-label="回到顶部"]').click();
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => window.__scrollCalls as { kind: string; behavior: string | null }[]),
  ).toContainEqual({ kind: "scrollTo", behavior: "smooth" });
});
