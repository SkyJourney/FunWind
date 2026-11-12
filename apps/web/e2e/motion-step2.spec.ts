import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

/**
 * M16 Step 2 高感知场景（docs/milestones/M16-motion-coverage.md §8）：
 * - 返回滚动恢复（Step 0 实证的全站级缺陷修复）+ 返回键状态级 VT + 前进键；
 * - 用户中途滚动让位（恢复循环尊重用户新意图）；
 * - 主题切换状态级 VT（交叉溶解 / reduce 降级）；
 * - 门控解锁 reveal（解锁后内容淡入一次；直接访问不播）。
 * 自建门控夹具（991101，价格 0），不依赖 gates.spec 的运行顺序。
 */

const GATE_THREAD = 991101;
const TALL_THREAD = 991102;
const FREE_TEXT = "隐藏内容-M16-reveal";

const probe = `
  window.__vt = [];
  const orig = document.startViewTransition?.bind(document);
  if (orig) document.startViewTransition = (arg) => {
    const e = { vt: document.documentElement.dataset.vt ?? null, anims: [] };
    window.__vt.push(e);
    const t = orig(arg);
    void t.ready.then(() => {
      for (const a of document.getAnimations()) {
        const p = a.effect?.pseudoElement ?? "";
        if (p.startsWith("::view-transition")) e.anims.push(p + "|" + (a.animationName ?? "?"));
      }
    }).catch(() => {});
    return t;
  };
`;

const lockStates = (page: Page) => page.locator("[data-gate-state]");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM gate_unlocks WHERE gate_id = ?", [GATE_THREAD]);
    await q.exec("DELETE FROM post_gates WHERE id = ?", [GATE_THREAD]);
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [GATE_THREAD]);
    await q.exec("DELETE FROM threads WHERE id = ?", [GATE_THREAD]);
    const post = GATE_THREAD + 100;
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, 901, ?, ?, ?, 'visible', '2026-11-12 10:00:00', '2026-11-12 10:00:00')`,
      [GATE_THREAD, USERS.alice, `[E2E] M16 reveal`, post],
    );
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, ?, 1, 'visible', '2026-11-12 10:00:00')`,
      [post, GATE_THREAD, USERS.alice, '这是 M16 reveal 测试\n\n:::gate{key="g1"}\n:::'],
    );
    await q.exec(
      `INSERT INTO post_gates (id, post_id, gate_key, conditions, match_mode, hidden_md, created_at, updated_at)
       VALUES (?, ?, 'g1', ?, 'all', ?, '2026-11-12 10:00:00', '2026-11-12 10:00:00')`,
      [GATE_THREAD, post, JSON.stringify([{ type: "points", price: 0 }]), FREE_TEXT],
    );
    // 高内容线程（滚动恢复测试用）：正文足够长 + 正文内 deterministic 站内链接
    await q.exec("DELETE FROM posts WHERE thread_id = ?", [TALL_THREAD]);
    await q.exec("DELETE FROM threads WHERE id = ?", [TALL_THREAD]);
    const tallPost = TALL_THREAD + 100;
    await q.exec(
      `INSERT INTO threads (id, forum_id, author_id, title, first_post_id, state, created_at, last_posted_at)
       VALUES (?, 901, ?, ?, ?, 'visible', '2026-11-12 10:01:00', '2026-11-12 10:01:00')`,
      [TALL_THREAD, USERS.alice, `[E2E] M16 滚动恢复`, tallPost],
    );
    const filler = Array.from({ length: 40 }, (_, i) => `滚动填充段落 ${i + 1}。`).join("\n\n");
    await q.exec(
      `INSERT INTO posts (id, thread_id, floor, author_id, body_md, has_gate, state, created_at)
       VALUES (?, ?, 1, ?, ?, 0, 'visible', '2026-11-12 10:01:00')`,
      [tallPost, TALL_THREAD, USERS.alice, `${filler}\n\n[去版块](/f/901)\n\n${filler}`],
    );
  });
});

// 自建线程（论坛 901）会出现在首页信息流——测完删除，避免污染后续 visual 基线对比
test.afterAll(async () => {
  await withE2eDb(async (q) => {
    for (const tid of [GATE_THREAD, TALL_THREAD]) {
      await q.exec("DELETE FROM gate_unlocks WHERE gate_id = ?", [tid]);
      await q.exec("DELETE FROM post_gates WHERE id = ?", [tid]);
      await q.exec("DELETE FROM posts WHERE thread_id = ?", [tid]);
      await q.exec("DELETE FROM threads WHERE id = ?", [tid]);
    }
  });
});

test("返回滚动恢复：软导航返回后回到离开时的滚动位置，返回播状态级溶解，前进键正常", async ({
  page,
}) => {
  await page.addInitScript(probe);
  await page.goto(`/t/${TALL_THREAD}`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(400);
  const s0 = await page.evaluate(() => window.scrollY);
  expect(s0).toBeGreaterThan(300); // 确认确实滚动了

  // 作者徽章链接（同站软导航；正文 markdown 链接渲染为 target=_blank 新标签，不走软导航）
  await page.locator("main a[href^='/u/']").first().click();
  await page.waitForTimeout(1200);
  await page.goBack();
  await page.waitForTimeout(4500); // 恢复窗口 4s（对抗流式 commit 的滚顶）
  const s1 = await page.evaluate(() => window.scrollY);
  expect(Math.abs(s1 - s0), "返回后滚动恢复").toBeLessThan(60);

  const vt = await page.evaluate(() => window.__vt as { vt: string | null; anims: string[] }[]);
  const backVt = vt[vt.length - 1]!;
  expect(backVt.vt).toBe("fade"); // 状态级 fade（intercept 路线）
  expect(backVt.anims).toContain("::view-transition-new(root)|vt-fade-in");
  expect(backVt.anims).toContain("::view-transition-old(root)|vt-fade-out");

  await page.goForward();
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toMatch(/^\/u\//);
});

test("用户中途滚动让位：恢复循环立即取消，尊重用户新意图", async ({ page }) => {
  await page.goto(`/t/${TALL_THREAD}`);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(400);
  await page.locator("main a[href^='/u/']").first().click();
  await page.waitForTimeout(1200);
  await page.goBack();
  await page.waitForTimeout(500); // 恢复循环运行中
  await page.mouse.wheel(0, -150); // 用户向上滚：恢复循环立即让位
  await page.waitForTimeout(4000); // 若未让位，恢复循环会把位置顶回 800
  const y = await page.evaluate(() => window.scrollY);
  expect(y, "停在用户滚动后的位置（不得恢复到 800）").toBeLessThan(780);
});

test("主题切换：状态级 VT 交叉溶解（data-vt=fade + root 动画），reduce 下无 VT 直改", async ({
  page,
}) => {
  await page.addInitScript(probe);
  await page.goto("/");
  await page.waitForTimeout(1200);

  async function pick(name: string) {
    await page.getByRole("button", { name: "主题切换" }).click();
    await page.getByRole("menuitem", { name }).click();
  }

  await pick("暗色");
  await page.waitForTimeout(600);
  let vt = (await page.evaluate(() => window.__vt as { vt: string | null; anims: string[] }[])) as {
    vt: string | null;
    anims: string[];
  }[];
  const themeVt = vt[vt.length - 1]!;
  expect(themeVt.vt).toBe("fade");
  expect(themeVt.anims).toContain("::view-transition-new(root)|vt-fade-in");
  expect(await page.evaluate(() => document.documentElement.dataset.mode)).toBe("dark");

  const before = vt.length;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pick("浅色");
  await page.waitForTimeout(500);
  vt = await page.evaluate(() => window.__vt as { vt: string | null }[]);
  expect(vt.length, "reduce 下不启动 VT").toBe(before);
  expect(await page.evaluate(() => document.documentElement.dataset.mode)).toBe("light");
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("门控 reveal：解锁后内容淡入一次（fw-fade-in），直接访问已解锁内容不播", async ({
  page,
  context,
}) => {
  await loginAs(context, USERS.team);
  await page.goto(`/t/${GATE_THREAD}`);
  await expect(lockStates(page).filter({ hasText: "免费解锁" })).toBeVisible();

  await lockStates(page).getByRole("button", { name: "免费解锁" }).click();
  await expect(page.locator('[data-gate-state="open"]').getByText(FREE_TEXT)).toBeVisible();
  // reveal 包装层挂了淡入类（一次性）
  await expect(page.locator("div.fw-fade-in:has([data-gate-state='open'])")).toHaveCount(1);

  // 直接访问（标记已消费）：不播 reveal
  await page.reload();
  await expect(page.locator('[data-gate-state="open"]').getByText(FREE_TEXT)).toBeVisible();
  expect(await page.locator("div.fw-fade-in:has([data-gate-state='open'])").count()).toBe(0);
});
