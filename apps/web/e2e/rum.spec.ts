import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

/**
 * RUM E2E（M17 Step 4，G-16：新业务线必须有 E2E 且至少一条错误路径）。
 *
 * 生产构建下 RumBeacon 是激活的（与 SW 注册同口径），所以本文件覆盖三层：
 *  1. 端点：页面上下文 fetch 合法载荷 → 204 → 样本落库；
 *  2. **错误路径**：畸形 JSON 与非法指标名 → 仍 204 但零落库；
 *  3. 采集组件本身：浏览页面后导航离开（触发 pagehide）→ LCP 样本落库。
 *
 * 用专用 probe 路径计数，避免与 beacon 在其它页面自然产生的样本互相干扰。
 */

const PROBE_ROUTE = "/e2e-rum-probe";
const BAD_ROUTE = "/e2e-rum-bad";
const BEACON_ROUTE = "/register";

const countRoute = (route: string, name?: string) =>
  withE2eDb(async (q) => {
    const rows = await q.query<{ n: number }>(
      name
        ? "SELECT COUNT(*) AS n FROM rum_samples WHERE route = ? AND name = ?"
        : "SELECT COUNT(*) AS n FROM rum_samples WHERE route = ?",
      name ? [route, name] : [route],
    );
    return Number(rows[0]?.n ?? 0);
  });

const clearRoutes = (...routes: string[]) =>
  withE2eDb(async (q) => {
    for (const r of routes) await q.exec("DELETE FROM rum_samples WHERE route = ?", [r]);
  });

test.beforeAll(async () => {
  await clearRoutes(PROBE_ROUTE, BAD_ROUTE, BEACON_ROUTE);
});

test("端点：合法载荷落库；畸形与非法载荷仍 204 且零落库（错误路径）", async ({ page }) => {
  await page.goto("/login");

  const okStatus = await page.evaluate(async (route) => {
    const res = await fetch("/api/rum", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        v: 1,
        samples: [{ kind: "vital", name: "LCP", value: 1234, route }],
      }),
    });
    return res.status;
  }, PROBE_ROUTE);
  expect(okStatus).toBe(204);
  await expect.poll(() => countRoute(PROBE_ROUTE), { timeout: 15_000 }).toBe(1);

  // 错误路径：畸形 JSON、非法指标名、空样本——都必须 204 且不写库
  const badStatuses = await page.evaluate(async (route) => {
    const send = (body: string) =>
      fetch("/api/rum", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body,
      }).then((r) => r.status);
    return [
      await send("{不是 json"),
      await send(
        JSON.stringify({ v: 1, samples: [{ kind: "vital", name: "HACK", value: 1, route }] }),
      ),
      await send(JSON.stringify({ v: 1, samples: [] })),
    ];
  }, BAD_ROUTE);
  expect(badStatuses).toEqual([204, 204, 204]);
  expect(await countRoute(BAD_ROUTE)).toBe(0);
});

test("采集组件：浏览页面后导航离开（pagehide）→ LCP 样本落库", async ({ page }) => {
  // 清掉本路径既有样本：其它用例可能也访问过 /register
  await clearRoutes(BEACON_ROUTE);

  await page.goto(BEACON_ROUTE);
  await page.waitForLoadState("networkidle");
  // 观察者走 idle 注册；buffered:true 保证即使晚注册也能拿到 LCP entry
  await page.waitForTimeout(1500);

  // 导航离开触发 pagehide → flush（keepalive fetch 保证卸载时仍送达）
  await page.goto("/login");
  await expect
    .poll(() => countRoute(BEACON_ROUTE, "LCP"), { timeout: 20_000, intervals: [1_000] })
    .toBeGreaterThanOrEqual(1);
});

const ADMIN_ROUTE = "/e2e-rum-admin";

test("后台 /admin/rum：管理员可见样本与 p75；非管理员被拒（错误路径）", async ({
  page,
  context,
}) => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM rum_samples WHERE route = ?", [ADMIN_ROUTE]);
    for (const v of [100, 200, 300, 400]) {
      await q.exec(
        `INSERT INTO rum_samples (kind, name, value, route, detail, created_at)
         VALUES ('vital', 'LCP', ?, ?, NULL, NOW())`,
        [v, ADMIN_ROUTE],
      );
    }
  });

  // 非管理员：requireAdmin 拒绝（不渲染数据）
  await loginAs(context, USERS.member);
  await page.goto(`/admin/rum?route=${ADMIN_ROUTE}`);
  await expect(page.getByText(ADMIN_ROUTE)).toHaveCount(0);

  // 管理员：可见样本行与 p75 概览
  await loginAs(context, USERS.admin);
  await page.goto(`/admin/rum?route=${ADMIN_ROUTE}`);
  await expect(page.getByText(ADMIN_ROUTE).first()).toBeVisible();
  // p75 概览须反映分位数计算（算法精确值由 queries.test.ts 的 percentile 单测钉死）。
  // 锚定概览段落内的 LCP 正值——而非表格单元格（value=300 的行也渲染 "300ms"，旧断言打偏）；
  // percentile 若恒返回 0，概览会显示 "LCP 0ms" 而使本断言红。beacon 异步补样本不影响「正值」判定。
  const overview = page.locator("p").filter({ hasText: "p75：" });
  await expect(overview).toBeVisible();
  await expect(overview.getByText(/LCP [1-9]\d*ms/)).toBeVisible();
});
