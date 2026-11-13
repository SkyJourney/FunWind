import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

/**
 * CSP 报告面 E2E（M17 Step 6，G-16）：上报→落库→后台可查询，非管理员被拒。
 * 用专用文档路径计数，避免与其它用例的自然违规互相干扰。
 * 注意 document-uri 必须传完整 URL（裸路径会被 redactUri 判为 [other]）。
 */

const DOC_PATH = "/e2e-csp-probe";

const countDoc = () =>
  withE2eDb(async (q) => {
    const rows = await q.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM csp_reports WHERE document_uri LIKE ?",
      [`%${DOC_PATH}%`],
    );
    return Number(rows[0]?.n ?? 0);
  });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM csp_reports WHERE document_uri LIKE ?", [`%${DOC_PATH}%`]);
  });
});

test("上报违规→落库→管理员后台可查；非管理员被拒（错误路径）", async ({ page, context }) => {
  await page.goto("/login");
  const status = await page.evaluate(async (path) => {
    const res = await fetch("/api/csp-report", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: JSON.stringify({
        "csp-report": {
          "violated-directive": "script-src",
          "blocked-uri": "https://cdn.example.invalid/x.js",
          "document-uri": `${location.origin}${path}`,
          disposition: "report",
        },
      }),
    });
    return res.status;
  }, DOC_PATH);
  expect(status).toBe(204);
  await expect.poll(countDoc, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  // 非管理员：不渲染数据
  await loginAs(context, USERS.member);
  await page.goto(`/admin/csp?document=${DOC_PATH}`);
  await expect(page.getByText(DOC_PATH)).toHaveCount(0);

  // 管理员：可见该违规行
  await loginAs(context, USERS.admin);
  await page.goto(`/admin/csp?document=${DOC_PATH}`);
  await expect(page.getByText(DOC_PATH).first()).toBeVisible();
  await expect(page.getByText("script-src").first()).toBeVisible();
});
