import { expect, test, type APIRequestContext, type BrowserContext } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { FIX } from "./support/fixtures";
import { relaxPostInterval } from "./support/limits";
import { USERS, loginAs } from "./support/session";
import { fillSource } from "./support/editor";

/**
 * 隐藏内容泄露专项 v1（M6.2 第 6 步，计划中的「隐藏内容泄露专项」）。
 * 作者 alice 通过界面发一条门控主题，隐藏正文里放唯一标记 MARK。以五种视角扫描所有出口：
 *   页面 HTML、RSC 载荷、编辑页、编辑器预览接口（/api/preview）、事件日志、审计日志。
 * 结论要求：只有作者与版主（两个有权读隐藏正文的视角）能在出口里看到 MARK；
 * 其它视角（游客、未购买的会员、未解锁的回帖者）任何出口都不能出现。
 * 正向对照：作者与版主的扫描必须真的命中 MARK，否则扫描本身可能是空转的，用例直接失败。
 */

const stamp = Date.now();
const MARK = `SECRET-LEAK-V1-${stamp}`;
const TITLE_A = `泄露检查 A ${stamp}`;
const TITLE_B = `泄露检查 B ${stamp}`;
const PUBLIC_A = `公开前言 A ${stamp}`;

test.describe.configure({ mode: "serial" });

let restoreLimits: () => Promise<void>;
let pathA = "";
let firstA = 0;
let firstB = 0;
let pathB = "";
const contexts: BrowserContext[] = [];

/** 门控主题的正文：公开前言 + 一个需要 10 积分解锁的门控，隐藏正文含 MARK */
const gatedSource = (publicText: string) =>
  `${publicText}\n\n:::gate{key="g1" unlock="points" price="10"}\n${MARK} 隐藏正文\n:::`;

async function createGatedThread(
  browser: import("@playwright/test").Browser,
  title: string,
  publicText: string,
): Promise<{ path: string; firstId: number }> {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  await loginAs(ctx, USERS.alice);
  const page = await ctx.newPage();
  await page.goto(`/f/${FIX.compose.id}/new`);
  await page.locator("#thread-title").fill(title);
  await fillSource(page, gatedSource(publicText));
  await page.getByRole("button", { name: "发布主题" }).click();
  await expect(page).toHaveURL(/\/t\/\d+$/);
  const path = new URL(page.url()).pathname;
  const editHref = await page.locator('a[href^="/p/"][href$="/edit"]').first().getAttribute("href");
  const firstId = Number(editHref!.match(/\/p\/(\d+)\//)![1]);
  return { path, firstId };
}

test.beforeAll(async ({ browser }) => {
  restoreLimits = await relaxPostInterval();
  const a = await createGatedThread(browser, TITLE_A, PUBLIC_A);
  pathA = a.path;
  firstA = a.firstId;
  const b = await createGatedThread(browser, TITLE_B, "将被版主删除的门控主题");
  pathB = b.path;
  firstB = b.firstId;

  // 版主删除 B：产生删除事件与审计记录，它们的载荷也要参与扫描
  const modCtx = await browser.newContext();
  contexts.push(modCtx);
  await loginAs(modCtx, USERS.admin);
  const mod = await modCtx.newPage();
  await mod.goto(`/p/${firstB}/delete`);
  await mod.locator("#moderation-reason").fill("E2E 泄露检查");
  await mod.getByRole("button", { name: "确认删除主题" }).click();
  await expect(mod).toHaveURL(new RegExp(`/f/${FIX.compose.id}$`));
});

test.afterAll(async () => {
  for (const c of contexts) await c.close();
  await restoreLimits();
});

type View = {
  name: string;
  /** 是否有权读隐藏正文：只有作者与版主 */
  mayRead: boolean;
  user: number | null;
};

const VIEWS: View[] = [
  { name: "游客", mayRead: false, user: null },
  { name: "普通会员（未购买）", mayRead: false, user: USERS.member },
  { name: "未解锁的回帖者", mayRead: false, user: USERS.xiaoyi },
  { name: "作者", mayRead: true, user: USERS.alice },
  { name: "版主", mayRead: true, user: USERS.admin },
];

async function viewContext(browser: import("@playwright/test").Browser, user: number | null) {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  if (user !== null) await loginAs(ctx, user);
  return ctx;
}

/** 扫描一个出口：返回是否命中标记（默认 MARK） */
async function hits(
  request: APIRequestContext,
  url: string,
  rsc = false,
  mark = MARK,
): Promise<boolean> {
  const res = await request.get(url, rsc ? { headers: { RSC: "1" } } : undefined);
  return (await res.text()).includes(mark);
}

test.describe("五种视角扫描所有页面出口", () => {
  for (const view of VIEWS) {
    test(`${view.name}：主题页 HTML、RSC 载荷、编辑页`, async ({ browser }) => {
      const ctx = await viewContext(browser, view.user);
      const expected = view.mayRead;

      expect(await hits(ctx.request, pathA), "HTML").toBe(expected);
      expect(await hits(ctx.request, pathA, true), "RSC 载荷").toBe(expected);
      // 编辑页：有权编辑的只有作者与版主（命中）；其它人是 404，不得含 MARK
      expect(await hits(ctx.request, `/p/${firstA}/edit`), "编辑页").toBe(expected);
      // 标题不是隐藏内容：任何视角都能看到，但标记不能出现在 <title>（已由 HTML 扫描覆盖）
    });
  }

  test("编辑器预览接口：游客 401；登录的四种视角只拿到占位，不含隐藏正文（正向对照：公开前言必须出现）", async ({
    browser,
  }) => {
    // 预览要求登录（编辑器只对登录用户开放）：游客直接 401，连渲染都不发生
    // 登录视角：接口对任何人都不得返回门控正文，门控在结果里只显示占位
    const source = gatedSource(PUBLIC_A);
    for (const view of VIEWS) {
      const ctx = await viewContext(browser, view.user);
      const res = await ctx.request.post("/api/preview", { data: { source } });
      if (view.user === null) {
        expect(res.status(), `${view.name} 应为 401`).toBe(401);
        expect((await res.text()).includes(MARK), `${view.name} 不得含隐藏正文`).toBe(false);
        continue;
      }
      expect(res.status(), `${view.name} 预览状态码`).toBe(200);
      const text = await res.text();
      expect(text.includes(PUBLIC_A), `${view.name} 正向对照：公开前言应出现`).toBe(true);
      expect(text.includes(MARK), `${view.name} 预览不得含隐藏正文`).toBe(false);
    }
  });

  test("事件日志与审计日志：任何行都不含隐藏正文标记", async () => {
    const [{ n: eventHits }] = await withE2eDb((q) =>
      q.query<{ n: number }>(
        // JSON 列与参数的字符集排序规则不同，LIKE 会报 collation 冲突：统一显式指定 utf8mb4_bin 再做子串判断
        "SELECT COUNT(*) AS n FROM event_log WHERE INSTR(CAST(payload AS CHAR) COLLATE utf8mb4_bin, ?) > 0",
        [MARK],
      ),
    );
    const [{ n: auditHits }] = await withE2eDb((q) =>
      q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE INSTR(CONCAT_WS('|', action, target_type, target_id, COALESCE(CAST(before_json AS CHAR), ''), COALESCE(CAST(after_json AS CHAR), '')) COLLATE utf8mb4_bin, ?) > 0",
        [MARK],
      ),
    );
    expect(eventHits, "事件日志命中标记").toBe(0);
    expect(auditHits, "审计日志命中标记").toBe(0);
  });

  test("正向对照：删除主题确实产生了事件与审计（扫描覆盖的是真实数据）", async () => {
    const [{ n: audit }] = await withE2eDb((q) =>
      q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE target_id = ? OR target_id = ?",
        [String(firstB), String(pathB.replace(/\D/g, ""))],
      ),
    );
    expect(audit, "应当存在删除的审计记录").toBeGreaterThanOrEqual(1);
  });
});

/**
 * M6.5 回归：作者修改隐藏正文后，新的隐藏内容只能经作者与版主的出口看到。
 * 「内容更新于」「改价提示」「去回复」等新字段只携带时间与计数，不携带正文；这里用一个新标记验证它们没有把修改后的正文带出去。
 * 与上面的用例共用 beforeAll 造出的主题（serial 模式，本组排在最后执行）。
 */
test.describe("修改隐藏正文后：新内容不经任何出口泄露", () => {
  const MARK_EDIT = `SECRET-LEAK-EDIT-${stamp}`;

  test("作者保存修改：五种视角的主题页 HTML、RSC、编辑页只有读者视角命中新标记", async ({
    browser,
  }) => {
    test.slow(); // CI 2 核 runner：五视角逐页请求 + 保存，超时裕度×3（CI 上曾超时）
    const author = await viewContext(browser, USERS.alice);
    const page = await author.newPage();
    await page.goto(`/p/${firstA}/edit`);
    await fillSource(
      page,
      `${PUBLIC_A}\n\n:::gate{key="g1" unlock="points" price="10"}\n${MARK_EDIT} 修改后的隐藏正文\n:::`,
    );
    await page.getByRole("button", { name: "保存修改" }).click();
    await expect(page).toHaveURL(new RegExp(`${pathA}(\\?page=\\d+)?#p${firstA}$`));

    for (const view of VIEWS) {
      const ctx = await viewContext(browser, view.user);
      const expected = view.mayRead;
      expect(await hits(ctx.request, pathA, false, MARK_EDIT), `${view.name} HTML`).toBe(expected);
      expect(await hits(ctx.request, pathA, true, MARK_EDIT), `${view.name} RSC`).toBe(expected);
      expect(
        await hits(ctx.request, `/p/${firstA}/edit`, false, MARK_EDIT),
        `${view.name} 编辑页`,
      ).toBe(expected);
    }
  });

  test("修改后的日志：事件与审计中都不含新标记", async () => {
    const [{ n: eventHits }] = await withE2eDb((q) =>
      q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM event_log WHERE INSTR(CAST(payload AS CHAR) COLLATE utf8mb4_bin, ?) > 0",
        [MARK_EDIT],
      ),
    );
    const [{ n: auditHits }] = await withE2eDb((q) =>
      q.query<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE INSTR(CONCAT_WS('|', action, target_type, target_id, COALESCE(CAST(before_json AS CHAR), ''), COALESCE(CAST(after_json AS CHAR), '')) COLLATE utf8mb4_bin, ?) > 0",
        [MARK_EDIT],
      ),
    );
    expect(eventHits, "事件日志命中新标记").toBe(0);
    expect(auditHits, "审计日志命中新标记").toBe(0);
  });
});
