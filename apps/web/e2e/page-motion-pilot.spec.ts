import { expect, test, type Page, type Request as PlaywrightRequest } from "@playwright/test";
import { FIX } from "./support/fixtures";
import { failOnPageErrors } from "./support/page-errors";
import { loginAs, USERS } from "./support/session";
import { installTransitionProbe, readTransitions, resetTransitions } from "./support/vt";

failOnPageErrors();
const A = `/t/${FIX.thread.emoji}`;
const B = `/t/${FIX.thread.image}`;
const panel = (page: Page) => page.getByRole("complementary", { name: "导航实验面板" });
async function idle(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          owner: document.documentElement.dataset.motionNav ?? null,
          direction: document.documentElement.dataset.motionDirection ?? null,
          active: document
            .getAnimations()
            .some(
              (animation) =>
                (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith(
                  "::view-transition",
                ) && animation.playState === "running",
            ),
        })),
      { timeout: 5000 },
    )
    .toEqual({ owner: null, direction: null, active: false });
}
async function events(page: Page): Promise<{ phase: string; id: number; reason?: string }[]> {
  return JSON.parse((await page.getByLabel("动效生命周期").getAttribute("data-events")) ?? "[]");
}
async function clear(page: Page) {
  await idle(page);
  await panel(page).getByRole("button", { name: "清空动效记录" }).click();
  await resetTransitions(page);
}
async function go(page: Page, href: string, method: "link" | "push" = "link") {
  await panel(page).getByLabel("站内目标地址").fill(href);
  if (method === "link") await panel(page).getByRole("link", { name: "链接前往" }).click();
  else await panel(page).getByRole("button", { name: "程序化前往" }).click();
  await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
}
async function open(page: Page, href: string) {
  await installTransitionProbe(page);
  // 测试专用 harness 经 addInitScript flag 激活（持久挂在根 layout，脱离 lab）；
  // __m15Document 只在首次加载后置一次，整页重载会清掉它，oneNavigation 据此证明软导航。
  await page.addInitScript(() => {
    (window as unknown as { __fwMotionTest: boolean }).__fwMotionTest = true;
  });
  await page.goto(href);
  await page.evaluate(() => {
    (window as unknown as { __m15Document: string }).__m15Document = "same-document";
  });
  await expect(page.getByRole("complementary", { name: "导航实验面板" })).toBeVisible();
  await clear(page);
}
async function oneNavigation(page: Page, oldAnimation: string, newAnimation: string) {
  await idle(page);
  const reading = await readTransitions(page);
  expect(reading.starts).toHaveLength(1);
  expect(reading.animations).toEqual(
    expect.arrayContaining([
      `::view-transition-old(page)|${oldAnimation}`,
      `::view-transition-new(page)|${newAnimation}`,
    ]),
  );
  // 不丢弃原始 group id：双根边界即使播放同名动画也不能被规范化 Set 掩盖。
  for (const phase of ["old", "new"]) {
    const groups = new Set(
      reading.rawAnimations
        .filter(
          (entry) => entry.startsWith(`::view-transition-${phase}(`) && entry.includes("|vt-page-"),
        )
        .map((entry) => entry.split("|")[0]),
    );
    expect(groups.size, `${phase} 页面快照组数`).toBe(1);
  }
  expect(
    await page.evaluate(() => (window as unknown as { __m15Document: string }).__m15Document),
  ).toBe("same-document");
  const lifecycle = await events(page);
  expect(lifecycle.map((event) => event.phase)).toEqual(["intent", "before", "ready", "finish"]);
  expect(new Set(lifecycle.map((event) => event.id)).size).toBe(1);
}

test("共享段公告真实 Link 双向过渡，旧新层各一个快照且 transitionTypes 透传", async ({ page }) => {
  await open(page, "/a");
  await page.locator('main a[href="/a/901"]').click();
  await expect(page).toHaveURL(/\/a\/901$/);
  await oneNavigation(page, "vt-page-out-left", "vt-page-in-right");
  expect((await readTransitions(page)).transitionTypes.flat()).toContain("fw-push");
  await clear(page);
  await page.locator('main a[href="/a"]').click();
  await expect(page).toHaveURL(/\/a$/);
  await oneNavigation(page, "vt-page-out-right", "vt-page-in-left");
  expect((await readTransitions(page)).transitionTypes.flat()).toContain("fw-pop");
});

test("共享段主题兄弟页通过真实 Next Link 导航，非整页重载且默认 fade", async ({ page }) => {
  await open(page, A);
  await go(page, B);
  await oneNavigation(page, "vt-page-fade-out", "vt-page-fade-in");
});

test("程序化 push 使用同一守卫和生命周期，类型在 Next transition 内透传", async ({ page }) => {
  await open(page, A);
  await go(page, B, "push");
  await oneNavigation(page, "vt-page-fade-out", "vt-page-fade-in");
  expect((await readTransitions(page)).transitionTypes.flat()).toContain("fw-fade");
});

test("同 pathname 的 query/hash 不重挂页面，不创建导航生命周期", async ({ page }) => {
  await open(page, A);
  await go(page, `${A}?motion=1`);
  await idle(page);
  expect(
    (await readTransitions(page)).rawAnimations.filter((entry) => entry.includes("|vt-page-")),
  ).toEqual([]);
  expect(await events(page)).toEqual([]);
  await clear(page);
  await go(page, `${A}?motion=1#top`);
  await idle(page);
  expect(
    (await readTransitions(page)).rawAnimations.filter((entry) => entry.includes("|vt-page-")),
  ).toEqual([]);
  expect(await events(page)).toEqual([]);
});

test("浏览器返回诚实跳过，刷新不残留会话，刷新后 Link 仍可过渡", async ({ page }) => {
  await open(page, "/a");
  await page.locator('main a[href="/a/901"]').click();
  await idle(page);
  await clear(page);
  await page.goBack();
  await expect(page).toHaveURL(/\/a$/);
  await expect
    .poll(async () =>
      (await events(page)).filter((event) => event.phase === "skip").map((event) => event.reason),
    )
    .toEqual(["history"]);
  await idle(page);
  expect(
    (await readTransitions(page)).rawAnimations.filter((entry) => entry.includes("|vt-page-")),
  ).toEqual([]);
  await page.reload();
  await expect(page.locator('main a[href="/a/901"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.motionNav ?? null)).toBeNull();
  await resetTransitions(page);
  await page.locator('main a[href="/a/901"]').click();
  await idle(page);
  expect((await readTransitions(page)).animations).toContain(
    "::view-transition-new(page)|vt-page-in-right",
  );
});

for (const mode of ["reduced-motion", "no-api"] as const) {
  test(`${mode} 下共享段内容同步可用，动效 skip 且无整页动画`, async ({ page }) => {
    if (mode === "reduced-motion") await page.emulateMedia({ reducedMotion: "reduce" });
    else
      await page.addInitScript(() => {
        Object.defineProperty(document, "startViewTransition", {
          configurable: true,
          value: undefined,
        });
      });
    await open(page, "/a");
    await page.locator('main a[href="/a/901"]').click();
    await expect(page).toHaveURL(/\/a\/901$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await idle(page);
    expect(
      (await readTransitions(page)).rawAnimations.filter((entry) => entry.includes("|vt-page-")),
    ).toEqual([]);
    expect(
      (await events(page)).filter((event) => event.phase === "skip").map((event) => event.reason),
    ).toEqual([mode]);
  });
}

test("慢网期间重复点击去重，提交后只发一次 ready/finish", async ({ page }) => {
  await open(page, "/a");
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/a/901*`, async (route) => {
    const headers = route.request().headers();
    if (headers["rsc"] && !headers["next-router-prefetch"]) {
      requests += 1;
      await gate;
    }
    await route.continue();
  });
  const link = page.locator('main a[href="/a/901"]');
  await link.click();
  await expect.poll(() => requests).toBe(1);
  await link.click({ force: true });
  await link.click({ force: true });
  expect(requests).toBe(1);
  expect(await page.evaluate(() => document.documentElement.dataset.motionNav)).toBeTruthy();
  release();
  await expect(page).toHaveURL(/\/a\/901$/);
  await oneNavigation(page, "vt-page-out-left", "vt-page-in-right");
});

test("不同目标快速切换只提交最新页面，旧RSC晚到不覆盖内容或清掉新状态", async ({ page }) => {
  await open(page, "/a");
  let release!: () => void;
  let observed = 0;
  const settled = new Promise<void>((resolve) => {
    const complete = (request: PlaywrightRequest) => {
      const headers = request.headers();
      if (
        new URL(request.url()).pathname !== A ||
        !headers["rsc"] ||
        headers["next-router-prefetch"]
      )
        return;
      page.off("requestfinished", complete);
      page.off("requestfailed", complete);
      resolve();
    };
    page.on("requestfinished", complete);
    page.on("requestfailed", complete);
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${A}*`, async (route) => {
    const headers = route.request().headers();
    if (headers["rsc"] && !headers["next-router-prefetch"]) {
      observed += 1;
      await gate;
    }
    await route.continue().catch(() => {}); // 新导航可中止旧请求，晚到的旧拦截允许结束。
  });
  await panel(page).getByLabel("站内目标地址").fill(A);
  await panel(page).getByRole("link", { name: "链接前往" }).click();
  await expect.poll(() => observed).toBe(1);
  await panel(page).getByLabel("站内目标地址").fill(B);
  await panel(page).getByRole("link", { name: "链接前往" }).click();
  await expect
    .poll(async () => (await events(page)).filter((event) => event.phase === "intent").length)
    .toBe(2);
  // Next顺序队列可能等待较早的RSC；要求全部响应完成后保持最新目标，不要求B抢在A响应前提交。
  release();
  await settled;
  await expect(page).toHaveURL(new RegExp(`${B}$`));
  await idle(page);
  const lifecycle = await events(page);
  expect(lifecycle.filter((event) => event.phase === "skip").map((event) => event.reason)).toEqual([
    "interrupted",
  ]);
  expect(lifecycle.filter((event) => event.phase === "ready")).toHaveLength(1);
  expect(lifecycle.filter((event) => event.phase === "finish")).toHaveLength(1);
  expect(lifecycle.find((event) => event.phase === "finish")!.id).not.toBe(lifecycle[0]!.id);
  expect(await page.evaluate(() => document.documentElement.dataset.motionNav ?? null)).toBeNull();
});

test("真实异步页流式就绪不播放额外整页动画，也不伪造第二个导航会话", async ({ page }) => {
  await open(page, "/boards");
  await go(page, A);
  await idle(page);
  const lifecycle = await events(page);
  // 导航恰一个会话；RSC 流式就绪是更新而非新导航，不伪造第二个会话（M15 Step 4 用真实业务页替代 lab 流式页）
  expect(new Set(lifecycle.map((event) => event.id)).size).toBe(1);
  expect(lifecycle.map((event) => event.phase)).toEqual(["intent", "before", "ready", "finish"]);
  const reading = await readTransitions(page);
  for (const phase of ["old", "new"]) {
    const groups = new Set(
      reading.rawAnimations
        .filter(
          (entry) => entry.startsWith(`::view-transition-${phase}(`) && entry.includes("|vt-page-"),
        )
        .map((entry) => entry.split("|")[0]),
    );
    expect(groups.size, `${phase} 页面快照组数`).toBe(1);
  }
});

test("试点跨根段进入与退出都只有一对页面动画，没有内外重复边界", async ({ page }) => {
  await open(page, "/boards");
  await go(page, A);
  await oneNavigation(page, "vt-page-out-left", "vt-page-in-right");
  await clear(page);
  await go(page, "/boards");
  await oneNavigation(page, "vt-page-out-right", "vt-page-in-left");
});

/** 单会话 + 旧新页面快照组各一个（共享组下沉边界不得产生内外重复边界）。 */
async function expectSinglePageTransition(page: Page) {
  await idle(page);
  const lifecycle = await events(page);
  expect(new Set(lifecycle.map((event) => event.id)).size).toBe(1);
  expect(lifecycle.map((event) => event.phase)).toEqual(["intent", "before", "ready", "finish"]);
  const reading = await readTransitions(page);
  for (const phase of ["old", "new"]) {
    const entries = reading.rawAnimations.filter(
      (entry) => entry.startsWith(`::view-transition-${phase}(`) && entry.includes("|vt-page-"),
    );
    const groups = new Set(entries.map((entry) => entry.split("|")[0]));
    expect(
      groups.size,
      `${phase} 页面快照组数（实际：${entries.join(" ; ") || "无 vt-page 动画"}）`,
    ).toBe(1);
  }
}

test.describe("共享 layout 组边界下沉（M15 Step 4 核心契约回归）", () => {
  test("admin 组内导航：单会话单快照组、fade 微动，AdminShell 不重挂", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.admin);
    await open(page, "/admin");
    // 标记侧栏导航节点：AdminShell 若重挂则该节点重建、标记消失（实证 Next 根模板组内不重挂）
    await page.evaluate(() => {
      document.querySelector('nav[aria-label="后台导航"]')?.setAttribute("data-shell-mark", "1");
    });
    await go(page, "/admin/users");
    await oneNavigation(page, "vt-page-fade-out", "vt-page-fade-in");
    expect(await page.evaluate(() => !!document.querySelector('[data-shell-mark="1"]'))).toBe(true);
  });

  test("settings 组内导航：单会话单快照组，设置壳不重挂", async ({ page, context }) => {
    await loginAs(context, USERS.member);
    await open(page, "/settings/profile");
    await page.evaluate(() => {
      document.querySelector('nav[aria-label="设置导航"]')?.setAttribute("data-shell-mark", "1");
    });
    await go(page, "/settings/email");
    await expectSinglePageTransition(page);
    expect(await page.evaluate(() => !!document.querySelector('[data-shell-mark="1"]'))).toBe(true);
  });

  test("跨组进入 admin：单会话、单一进场边界；旧页淡出（旧内容被出/进两侧各捕获一次，同位置同动画，视觉为单次淡出）", async ({
    page,
    context,
  }) => {
    await loginAs(context, USERS.admin);
    await open(page, "/boards");
    await go(page, "/admin");
    await idle(page);
    const lifecycle = await events(page);
    expect(new Set(lifecycle.map((event) => event.id)).size).toBe(1);
    expect(lifecycle.map((event) => event.phase)).toEqual(["intent", "before", "ready", "finish"]);
    const reading = await readTransitions(page);
    const newGroups = new Set(
      reading.rawAnimations
        .filter(
          (entry) => entry.startsWith("::view-transition-new(") && entry.includes("|vt-page-"),
        )
        .map((entry) => entry.split("|")[0]),
    );
    expect(newGroups.size, "new 页面快照组数").toBe(1);
    const oldEntries = reading.rawAnimations.filter(
      (entry) => entry.startsWith("::view-transition-old(") && entry.includes("|vt-page-"),
    );
    expect(oldEntries.length, "旧页淡出至少播一次").toBeGreaterThan(0);
    // 进入共享组时，旧页内容被「出边界退场」与「进边界组的旧快照（继承出边界 fw-page-out 类）」
    // 各捕获一次；两者同位置、同动画、同计时，像素级重叠，视觉等价于单次淡出（React VT 模板重挂特性）。
    expect(new Set(oldEntries.map((entry) => entry.split("|")[1])).size, "旧侧动画名唯一").toBe(1);
  });

  test("跨组退出 admin 回社区：单会话单快照组，旧页淡出", async ({ page, context }) => {
    await loginAs(context, USERS.admin);
    await open(page, "/admin");
    await go(page, "/boards");
    await expectSinglePageTransition(page);
  });
});
