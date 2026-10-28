import { expect, test, type Page } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

/**
 * L1 微交互（M10.7 Step 5）：点赞 / 关注的乐观更新与动效。
 * 关键证明：把 Server Action 的 POST 人为延迟 1.5s，界面在服务端返回之前就已经切换——
 * 以前是整页表单提交，点完要等服务端刷新。
 */

const POST_ID = 900101; // 种子里欢迎主题 900001 的首帖
/** 清掉 member 对该帖的点赞，并按明细重算缓存计数（posts.like_count，口径同 db:recount） */
const resetLike = () =>
  withE2eDb(async (q) => {
    await q.exec("DELETE FROM reactions WHERE user_id = ? AND post_id = ? AND kind = 'like'", [
      USERS.member,
      POST_ID,
    ]);
    await q.exec(
      "UPDATE posts SET like_count = (SELECT COUNT(*) FROM reactions WHERE post_id = ? AND kind = 'like') WHERE id = ?",
      [POST_ID, POST_ID],
    );
  });

const likeForm = (page: Page) => page.locator(`form[data-testid="like-${POST_ID}"]`);
const likeBtn = (page: Page) => likeForm(page).locator("button");

/** 延迟（或中止）Server Action 的 POST：Next 的 Server Action 请求带 next-action 头，目标是页面自身 URL */
async function slowActions(page: Page, ms: number, mode: "delay" | "abort" = "delay") {
  const handler = async (route: import("@playwright/test").Route) => {
    if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
      if (mode === "abort") return route.abort("failed");
      await new Promise((r) => setTimeout(r, ms));
    }
    await route.continue().catch(() => {});
  };
  await page.route("**/*", handler);
  return handler;
}

/** 正在运行的动画名（页面内容，不含 view-transition 伪元素） */
const runningAnimations = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .map((a) => (a as CSSAnimation).animationName)
      .filter((n) => n && n.startsWith("fw-")),
  );

test.describe("点赞", () => {
  test.beforeEach(async () => {
    await resetLike();
  });
  test.afterEach(async () => {
    await resetLike();
  });

  test("点击立即切换（服务端还在 1.5s 的延迟里）：数字 +1、已点赞、飘出 +1、图标弹跳与数字滚动动画在播", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.member);
    await page.goto("/t/900001");
    await expect(likeBtn(page)).toBeVisible();
    const before = Number((await likeBtn(page).innerText()).replace(/\D/g, "") || 0);
    await slowActions(page, 1500);

    const t0 = Date.now();
    await likeBtn(page).click();
    // 乐观：远早于服务端返回就已切换
    await expect(likeBtn(page)).toHaveAttribute("aria-pressed", "true", { timeout: 800 });
    expect(Date.now() - t0).toBeLessThan(1200);
    await expect(likeBtn(page)).toContainText(String(before + 1));
    await expect(page.locator(".fw-float-up")).toHaveText("+1");
    const names = await runningAnimations(page);
    expect(names).toEqual(expect.arrayContaining(["fw-pop", "fw-roll-in-up", "fw-float-up"]));

    // 服务端返回后状态一致、仍在原页（没有整页刷新）
    await expect(likeBtn(page)).toHaveAttribute("aria-busy", "false", { timeout: 8000 });
    await expect(likeBtn(page)).toContainText(String(before + 1));
    const rows = await withE2eDb((q) =>
      q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM reactions WHERE user_id = ? AND post_id = ? AND kind = 'like'",
        [USERS.member, POST_ID],
      ),
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  test("再点一次取消：立即回到原数字，数字下滚、不飘 +1", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await page.goto("/t/900001");
    const before = Number((await likeBtn(page).innerText()).replace(/\D/g, "") || 0);
    await likeBtn(page).click();
    await expect(likeBtn(page)).toHaveAttribute("aria-busy", "false", { timeout: 8000 });
    await slowActions(page, 1200);
    await likeBtn(page).click();
    await expect(likeBtn(page)).toHaveAttribute("aria-pressed", "false", { timeout: 800 });
    if (before === 0) await expect(likeBtn(page)).toContainText("赞");
    else await expect(likeBtn(page)).toContainText(String(before));
    await expect(page.locator(".fw-float-up")).toHaveCount(0);
    expect(await runningAnimations(page)).toEqual(expect.arrayContaining(["fw-roll-in-down"]));
  });

  test("服务端失败（请求被中止）：乐观值回滚并 toast 提示", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await page.goto("/t/900001");
    const before = (await likeBtn(page).innerText()).replace(/\s+/g, "");
    await slowActions(page, 0, "abort");
    await likeBtn(page).click();
    await expect(page.locator("[data-sonner-toast]", { hasText: "操作失败，请重试" })).toBeVisible({
      timeout: 8000,
    });
    await expect(likeBtn(page)).toHaveAttribute("aria-pressed", "false");
    // 回滚后数字回到点击前（滚出的旧值节点可能还在，只看当前显示的值）
    await expect(likeBtn(page)).toContainText(before.replace(/\D/g, "") || "赞");
  });

  test("减少动态效果：状态照常立即切换，但没有任何微交互动画", async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await loginAs(context, USERS.member);
    await page.goto("/t/900001");
    await slowActions(page, 1200);
    await likeBtn(page).click();
    await expect(likeBtn(page)).toHaveAttribute("aria-pressed", "true", { timeout: 800 });
    expect(await runningAnimations(page)).toEqual([]);
    await expect(page.locator(".fw-float-up")).toBeHidden(); // reduce 下 +1 不显示
  });

  test("游客：按钮禁用，不发请求", async ({ page }) => {
    await page.goto("/t/900001");
    await expect(likeBtn(page)).toBeDisabled();
  });
});

test.describe("点赞 · 无 JS 回退", () => {
  test.use({ javaScriptEnabled: false });

  test("表单仍可提交：服务端落库并刷新，计数更新", async ({ browser, baseURL }) => {
    await resetLike();
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    try {
      await loginAs(context, USERS.member);
      const page = await context.newPage();
      await page.goto("/t/900001");
      const before = Number((await likeBtn(page).innerText()).replace(/\D/g, "") || 0);
      await likeBtn(page).click();
      await expect
        .poll(async () => Number((await likeBtn(page).innerText()).replace(/\D/g, "") || 0))
        .toBe(before + 1);
    } finally {
      await context.close();
      await resetLike();
    }
  });
});

test.describe("关注", () => {
  const FORUM = FIX.compose.id;
  const followBtn = (page: Page) =>
    page
      .locator("main form")
      .filter({ has: page.locator('input[name="targetType"][value="forum"]') })
      .locator("button");
  const cleanup = () =>
    withE2eDb((q) =>
      q.exec("DELETE FROM follows WHERE user_id = ? AND target_type = 'forum' AND target_id = ?", [
        USERS.member,
        FORUM,
      ]),
    );
  test.beforeEach(cleanup);
  test.afterEach(cleanup);

  test("点击立即在「加入关注 / 已关注」之间切换（服务端延迟 1.5s 时界面已变），按钮弹跳、文案淡入，随后落库", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.member);
    await page.goto(`/f/${FORUM}`);
    await expect(followBtn(page)).toContainText("加入关注");
    await slowActions(page, 1500);

    await followBtn(page).click();
    await expect(followBtn(page)).toContainText("已关注", { timeout: 800 });
    await expect(followBtn(page)).toHaveAttribute("aria-pressed", "true");
    expect(await runningAnimations(page)).toEqual(expect.arrayContaining(["fw-pop"]));
    await expect(followBtn(page)).toHaveAttribute("aria-busy", "false", { timeout: 8000 });
    await expect(page).toHaveURL(new RegExp(`/f/${FORUM}$`));
    const rows = await withE2eDb((q) =>
      q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM follows WHERE user_id = ? AND target_type = 'forum' AND target_id = ?",
        [USERS.member, FORUM],
      ),
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // 再点一次：立即回到「加入关注」并取消落库
    await followBtn(page).click();
    await expect(followBtn(page)).toContainText("加入关注", { timeout: 800 });
    await expect(followBtn(page)).toHaveAttribute("aria-busy", "false", { timeout: 8000 });
    const after = await withE2eDb((q) =>
      q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM follows WHERE user_id = ? AND target_type = 'forum' AND target_id = ?",
        [USERS.member, FORUM],
      ),
    );
    expect(Number(after[0]!.n)).toBe(0);
  });

  test("服务端失败：回滚到「加入关注」并 toast", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await page.goto(`/f/${FORUM}`);
    await slowActions(page, 0, "abort");
    await followBtn(page).click();
    await expect(page.locator("[data-sonner-toast]", { hasText: "操作失败，请重试" })).toBeVisible({
      timeout: 8000,
    });
    await expect(followBtn(page)).toContainText("加入关注");
  });
});

/* ---------------- 5c Tab 滑动指示器 ---------------- */

test.describe("分段控件的滑动指示器（个人主页「主题 / 回复」）", () => {
  const PROFILE = `/u/${USERS.alice}`;
  const indicator = (page: Page) => page.getByTestId("segmented-indicator");
  /** 指示器当前的横向位移（px，取自 computed transform 矩阵） */
  const indicatorX = (page: Page) =>
    indicator(page).evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m41);

  test("点击「回复」：指示器立即开始滑动（服务端还在 1.5s 延迟里），并走 spring 过渡；提交后停在第二格", async ({
    page,
  }) => {
    await page.goto(PROFILE);
    await expect(indicator(page)).toBeVisible();
    expect(await indicatorX(page)).toBe(0);
    await page.request.get(`${PROFILE}?tab=replies`); // 热身
    await page.route(/\/u\/\d+/, async (route) => {
      const h = route.request().headers();
      if (h["rsc"] && !h["next-router-prefetch"]) await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
    });

    await page.getByRole("link", { name: /^回复/ }).click();
    await page.waitForTimeout(350);
    // 乐观：URL 还没变，指示器已经离开第一格
    expect(page.url()).not.toContain("tab=replies");
    expect(await indicatorX(page)).toBeGreaterThan(0);
    const transitions = await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a instanceof CSSTransition)
        .map((a) => ({
          prop: (a as CSSTransition).transitionProperty,
          fn: getComputedStyle(document.querySelector('[data-testid="segmented-indicator"]')!)
            .transitionTimingFunction,
        })),
    );
    expect(transitions.some((t) => t.prop === "transform")).toBe(true);
    expect(transitions[0]!.fn).toContain("cubic-bezier(0.34, 1.56"); // spring 过冲曲线

    await expect(page).toHaveURL(/tab=replies/, { timeout: 8000 });
    await expect(page.getByRole("link", { name: /^回复/ })).toHaveAttribute("aria-current", "page");
    await expect.poll(() => indicatorX(page)).toBeGreaterThan(100); // 停在第二格（容器约半宽）
  });

  test("切回「主题」后指示器回到第一格（不被陈旧的点击记录劫持）", async ({ page }) => {
    await page.goto(`${PROFILE}?tab=replies`);
    await page.getByRole("link", { name: /^主题/ }).click();
    await expect(page).not.toHaveURL(/tab=replies/);
    await expect.poll(() => indicatorX(page)).toBe(0);
  });

  test("减少动态效果：指示器位置照常切换，但没有过渡动画", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(PROFILE);
    await page.getByRole("link", { name: /^回复/ }).click();
    await expect(page).toHaveURL(/tab=replies/);
    // 只数指示器自己的过渡（页面上别的元素如链接颜色本来就有 150ms 的过渡，与本功能无关）
    const own = await indicator(page).evaluate(
      (el) => el.getAnimations().filter((a) => a instanceof CSSTransition).length,
    );
    expect(own).toBe(0);
    expect(await indicatorX(page)).toBeGreaterThan(100);
  });
});

/* ---------------- 5d 开关 ---------------- */

test.describe("通知偏好的开关（Switch）", () => {
  test("点击立即切换（服务端 PATCH 延迟 1.2s），滑块用 spring 曲线滑动；再点恢复原状", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.member);
    await page.goto("/settings/notifications");
    const sw = page.getByRole("switch", { name: /站内通知/ }).first();
    await expect(sw).toBeVisible();
    const initial = await sw.getAttribute("aria-checked");
    await page.route("**/api/settings/preferences", async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue().catch(() => {});
    });

    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", initial === "true" ? "false" : "true", {
      timeout: 600,
    });
    const thumb = sw.locator('[data-slot="switch-thumb"]');
    const style = await thumb.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        fn: cs.transitionTimingFunction,
        dur: cs.transitionDuration,
        prop: cs.transitionProperty,
      };
    });
    expect(style.prop).toContain("transform");
    expect(style.fn).toContain("cubic-bezier(0.34, 1.56"); // 过冲回弹
    expect(style.dur).toBe("0.5s");
    await expect(page.locator("[data-sonner-toast]").first()).toBeVisible({ timeout: 6000 });

    await page.unroute("**/api/settings/preferences");
    await sw.click(); // 复位
    await expect(sw).toHaveAttribute("aria-checked", initial!);
    await expect(sw).toBeEnabled({ timeout: 6000 });
  });

  test("保存失败：回滚并 toast", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await page.goto("/settings/notifications");
    const sw = page.getByRole("switch", { name: /站内通知/ }).first();
    const initial = await sw.getAttribute("aria-checked");
    await page.route("**/api/settings/preferences", (route) => route.abort("failed"));
    await sw.click();
    await expect(page.locator("[data-sonner-toast]", { hasText: "保存失败，请重试" })).toBeVisible({
      timeout: 6000,
    });
    await expect(sw).toHaveAttribute("aria-checked", initial!);
  });
});

/* ---------------- 5e 卡片 hover 抬升 ---------------- */

test.describe("卡片 hover 抬升与按压", () => {
  test("首页内容卡片：悬停时上浮 1px、边框加深、阴影加重；移开复位", async ({ page }) => {
    await page.goto("/");
    const card = page.locator("main article").first();
    await expect(card).toBeVisible();
    const read = () =>
      card.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          // Tailwind v4 的 -translate-y-px 用的是独立的 `translate` 属性（不是 transform）："0px -1px"
          ty: parseFloat(cs.translate.split(" ")[1] ?? "0") || 0,
          shadow: cs.boxShadow,
          border: cs.borderTopColor,
        };
      });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const rest = await read();
    await card.hover({ position: { x: 20, y: 20 } });
    await page.waitForTimeout(400); // 过渡 150ms，留足余量
    const hover = await read();
    expect(hover.ty).toBeCloseTo(-1, 0);
    expect(hover.shadow).not.toBe(rest.shadow);
    expect(hover.border).not.toBe(rest.border);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    expect((await read()).ty).toBeCloseTo(0, 0);
  });

  test("板块页主题行：悬停时背景高亮（行不位移，避免分隔线错位）", async ({ page }) => {
    await page.goto(`/f/${FIX.water.id}`);
    const row = page.locator("main section:not([aria-label]) [data-vt-expand]").first();
    await expect(row).toBeVisible();
    const bg = () => row.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    const rest = await bg();
    await row.hover({ position: { x: 30, y: 10 } });
    await page.waitForTimeout(400);
    expect(await bg()).not.toBe(rest);
    // 行不位移（位移会让相邻行的分隔线错位）：translate 保持 none
    expect(await row.evaluate((el) => getComputedStyle(el).translate)).toBe("none");
  });
});
