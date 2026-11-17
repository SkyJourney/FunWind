import { expect, test } from "@playwright/test";
import { USERS, loginAs } from "./support/session";
import { withE2eDb } from "./support/db";

/**
 * API 令牌全链 E2E（M20）：签发 → 明文一次性展示 → Bearer 调用 /api/manage/whoami 200 →
 * 刷新不重放 → 吊销（确认保护）→ 调用即 401。联动吊销（撤权/封禁/注销）由
 * lib/manage/tokens.int.test.ts 穷举，此处不重复。
 */

test.describe.configure({ mode: "serial" });

const FRESH = "[data-testid=fresh-token]";

async function clearTokens(): Promise<void> {
  await withE2eDb((q) => q.exec("DELETE FROM admin_api_tokens WHERE user_id = ?", [USERS.admin]));
}

test("会员访问 API 令牌页 → 404（越权不暴露后台存在）", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(ctx, USERS.member);
  expect((await page.goto("/admin/api-tokens"))?.status()).toBe(404);
  await ctx.close();
});

test("无凭证调用 /api/manage/whoami → 401（JSON 信封，不暴露页面语义）", async ({ request }) => {
  const resp = await request.get("/api/manage/whoami");
  expect(resp.status()).toBe(401);
  expect(await resp.json()).toEqual({
    error: { code: "unauthorized", message: "凭证缺失、无效或已失效。" },
  });
});

test("签发 → 明文一次性展示 → Bearer 调用 200 → 吊销 → 401", async ({ browser }) => {
  await clearTokens();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await loginAs(ctx, USERS.admin);

  // 菜单出现且页面可达（label 与 title 逐字一致，由 admin-nav-guard 静态断言；此处走查真实渲染）
  await page.goto("/admin/api-tokens");
  await expect(page.getByText("签发新 Token")).toBeVisible();

  // 签发（默认 90 天档位）
  await page.getByPlaceholder("如：CI 脚本 / 本地 MCP").fill("E2E 全链用例");
  const issued = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined,
  );
  await page.getByRole("button", { name: "签发" }).click();
  await issued;

  // 明文一次性展示：fw_at_ 前缀，格式完整
  await expect(page.locator(FRESH)).toBeVisible();
  const plain = (await page.locator(FRESH).locator("code").textContent())?.trim() ?? "";
  expect(plain).toMatch(/^fw_at_[A-Za-z0-9_-]{43}$/);

  // Bearer 调用：200 + 持有人身份正确
  const okResp = await page.request.get("/api/manage/whoami", {
    headers: { authorization: `Bearer ${plain}` },
  });
  expect(okResp.status()).toBe(200);
  const body = (await okResp.json()) as {
    ok: boolean;
    data: { user: { id: number }; token: { name: string } };
  };
  expect(body.ok).toBe(true);
  expect(body.data.user.id).toBe(USERS.admin);
  expect(body.data.token.name).toBe("E2E 全链用例");

  // 刷新（?created= 仍在 URL）：暂存已取走即删，明文不重放
  await page.reload();
  await expect(page.locator(FRESH)).toHaveCount(0);
  const okResp2 = await page.request.get("/api/manage/whoami", {
    headers: { authorization: `Bearer ${plain}` },
  });
  expect(okResp2.status()).toBe(200); // 明文本身仍有效（只是不再展示）

  // 列表行出现（名称 + 尾号）
  await expect(page.locator("table").first()).toContainText("E2E 全链用例");
  await expect(page.locator("table").first()).toContainText(plain.slice(-8));

  // 吊销：确认保护 → Flash → Bearer 调用即刻 401
  await page.getByRole("button", { name: "吊销" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("Token 已吊销，使用它的调用即刻失效（401）。")).toBeVisible();
  const revokedResp = await page.request.get("/api/manage/whoami", {
    headers: { authorization: `Bearer ${plain}` },
  });
  expect(revokedResp.status()).toBe(401);
  // 状态徽标翻转为已吊销；操作列不再提供吊销
  await expect(page.locator("table").first()).toContainText("已吊销");

  await ctx.close();
  await clearTokens();
});
