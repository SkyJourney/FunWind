import { expect, test, type Page } from "@playwright/test";
import { installTransitionProbe, readTransitions, resetTransitions } from "./support/vt";

/**
 * M15 Step 0 技术验证（实验路由 /design/motion/lab，结论回写 M15 文档 §10）：
 *   1. 共享段兄弟切换（one→two）：根 template 不重挂，只应触发段级一次过渡（F2 官方路径）；
 *   2. 方向延迟解析：目标页 useLayoutEffect（2a，commit 同步）vs useEffect（2b，paint 后）
 *      写 data-nav，谁来得及影响新层动画选择；
 *   3. 返回键（popstate）：是否产生过渡、动画是否被跳过（F11）；
 *   4. 流式加载与滚动恢复互扰。
 * 实验页与 CSS 组（.fw-lab-*）为 Step 0 专用，Step 4 清账时随 lab 移除。
 */

const LAB = "/motion-lab";

/** 每次「开始一次新的观察」：装好探针后从入口页出发 */
async function openLab(page: Page) {
  await installTransitionProbe(page);
  await page.goto(LAB);
  await expect(page.getByRole("heading", { name: "M15 Step 0 · VT 实验室" })).toBeVisible();
}

/** 等上一段过渡真正播完（页面过渡 slow 400ms + 余量）再 reset——URL 变更早于动画结束，
    否则上一段的采样会混进新观察（2a/2b 首轮结论被该污染反噬的教训） */
async function settleTransitions(page: Page) {
  await page.waitForTimeout(650);
  await resetTransitions(page);
}

test.describe("M15 Step 0 · 共享段与双层 ViewTransition", () => {
  test("验证1a：同段兄弟切换（one→two）只触发段级一次过渡，根组不动", async ({ page }) => {
    await openLab(page);
    await page.getByRole("link", { name: "共享段兄弟切换（one）" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/one/);
    await resetTransitions(page);
    await page.getByRole("link", { name: "去-two" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/two/);
    const reading = await readTransitions(page);
    // 段级一次：startViewTransition 只发生一次；根组动画（vt-page-*）不出现——F2 成立。
    // 新层动画 = in-right（two 的 useEffect 写 push 生效，fade-in 首帧前被覆盖——见验证 2b）
    expect(reading.starts).toHaveLength(1);
    expect(reading.animations).toEqual(
      expect.arrayContaining([
        "::view-transition-new(page)|vt-lab-in-right",
        "::view-transition-old(page)|vt-lab-fade-out",
      ]),
    );
    expect(reading.animations.every((a) => !a.includes("vt-page-"))).toBe(true);
  });

  test("验证1b：跨段首次进入 lab（根 template 重挂 + 段级首挂）只有一次 startViewTransition", async ({
    page,
  }) => {
    await openLab(page);
    await resetTransitions(page);
    await page.getByRole("link", { name: "共享段兄弟切换（one）" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/one/);
    await expect
      .poll(async () => (await readTransitions(page)).starts.length, { timeout: 15000 })
      .toBe(1);
    // Step 0-1 实测：跨段进入仍只有一次 startViewTransition（无双重过渡）；且目标页 one 的
    // useLayoutEffect 在 commit 阶段写 push 生效（lab 组 in-right + 旧内容 fade-out）。
    // 设计推定（Step 2 以 MotionPage 实证）：目标页不声明方向时，段内 children 替换走
    // default="none" 静切——这正是 <MotionPage motionKey> 强制 remount 的必要性所在。
    const animations = (await readTransitions(page)).animations;
    expect(animations).toEqual(
      expect.arrayContaining([
        "::view-transition-new(page)|vt-lab-in-right",
        "::view-transition-old(page)|vt-lab-fade-out",
      ]),
    );
    expect(animations.every((a) => !a.includes("vt-page-"))).toBe(true);
  });

  test("验证2a：目标页 useLayoutEffect 声明的方向来得及选择新层动画（延迟解析可行）", async ({
    page,
  }) => {
    await openLab(page);
    await page.getByRole("link", { name: "共享段兄弟切换（one）" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/one/);
    await settleTransitions(page);
    // NavigationGuard 在点击时按 rank 表兜底写 fade（starts[0] 可见）；one 的 useLayoutEffect
    // 在提交阶段覆写为 push——若来得及，新层动画选 vt-lab-in-right 而非默认 fade-in
    await page.getByRole("link", { name: "去-two" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/two/);
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 15000 })
      .toContain("::view-transition-new(page)|vt-lab-in-right");
    const reading = await readTransitions(page);
    expect(reading.starts[0]).toBe("fade"); // Guard 兜底先写 fade
    // 干净采样（settle 后）下 in-right 出现 = commit 阶段声明的 push 生效；且不得混入上一段的采样
    expect(reading.animations).toContain("::view-transition-new(page)|vt-lab-in-right");
    expect(reading.animations.filter((a) => a.includes("vt-lab-in-right"))).toHaveLength(1);
  });

  test("验证2b：useEffect（paint 后）声明的方向同样生效——fade-in 首帧前被覆盖", async ({
    page,
  }) => {
    await openLab(page);
    await page.getByRole("link", { name: "共享段兄弟切换（one）" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/one/);
    await settleTransitions(page);
    await page.getByRole("link", { name: "去-two（段级过渡 + 延迟方向验证 2b）" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/two/);
    // two（目标页）的 useEffect 在 paint 后写 push——实测同样生效（fade-in 首帧前被覆盖，
    // 采样中不出现）。结论：新层进场方向的覆写窗口覆盖 commit 与 paint 两个阶段；
    // 红线是覆写次数（每次覆写重启动画，多次写会产生跳变）。
    await expect
      .poll(async () => (await readTransitions(page)).animations, { timeout: 15000 })
      .toContain("::view-transition-new(page)|vt-lab-in-right");
    const animations = (await readTransitions(page)).animations;
    expect(animations).not.toContain("::view-transition-new(page)|vt-lab-fade-in");
  });
});

test.describe("M15 Step 0 · 返回键与流式", () => {
  test("验证3：浏览器返回（popstate）是否产生过渡", async ({ page }) => {
    await openLab(page);
    await page.getByRole("link", { name: "共享段兄弟切换（two）" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/two/);
    await page.getByRole("link", { name: /去返回键实验页/ }).click();
    await expect(page).toHaveURL(/\/motion-lab\/back/);
    await settleTransitions(page);
    await page.goBack();
    await expect(page).toHaveURL(/\/motion-lab\/two/);
    // 观察记录（Step 0-3 结论数据）：starts 是否新增、动画是否被跳过。
    // React 文档预期：popstate 同步急切提交 → 缓存命中无 VT（M10.7 §5.7 现状）。
    // 无过渡 = 诚实降级成立（返回键无动画维持现状）；有过渡 = F11 打开优化空间。
    const reading = await readTransitions(page);
    expect(reading.starts).toEqual([]);
  });

  test("验证4：流式加载（Suspense 400ms）不产生二次过渡，滚动恢复无互扰", async ({ page }) => {
    await openLab(page);
    await page.getByRole("link", { name: "流式加载 + 滚动恢复" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/stream/);
    await expect
      .poll(async () => (await readTransitions(page)).starts.length, { timeout: 15000 })
      .toBe(1);
    await expect(page.getByText("流式内容已就绪")).toBeVisible();
    // Step 0-4 实测结论：流式内容 resolve（约 400ms，晚于导航过渡结束与 data-nav 清理）
    // 会触发第二次 startViewTransition（starts[1] = null，lab 组按默认 fade 再动一次）——
    // Suspense fallback→content 切换会激活祖先 ViewTransition，属互扰实锤。
    // 处置候选（Step 1/2 引擎设计吸收）：Suspense resolve 包 startTransition 抑制 / 引擎钩子抑制。
    const reading = await readTransitions(page);
    expect(reading.starts).toEqual(["fade", null]);
    expect(page.getByText("流式内容已就绪")).toBeVisible();
    // 滚到底 → 去 two → 返回：滚动位置恢复、返回行为正常
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const scrolledY = await page.evaluate(() => window.scrollY);
    expect(scrolledY).toBeGreaterThan(0);
    await page.getByRole("link", { name: "去-two（滚到底后点走" }).click();
    await expect(page).toHaveURL(/\/motion-lab\/two/);
    await page.goBack();
    await expect(page).toHaveURL(/\/motion-lab\/stream/);
    const restoredY = await page.evaluate(() => window.scrollY);
    expect(restoredY).toBeGreaterThan(0);
  });
});
