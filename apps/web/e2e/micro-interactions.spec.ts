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
