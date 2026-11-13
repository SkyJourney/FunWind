import { expect, test } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { loginAs, USERS } from "./support/session";

/**
 * Web Push 订阅 API E2E（M18 Step 3，G-16：新业务线必须有 E2E 且至少一条错误路径）。
 * 订阅→落库→退订→删除；未登录 401、坏 body 400；VAPID 公钥下发。
 * 真实推送送达由 SW push 事件用例（Step 5）与站长真机覆盖，这里只验订阅凭据 CRUD。
 */

const ENDPOINT = "https://push.example.invalid/e2e-sub";

const countSub = (userId: number) =>
  withE2eDb(async (q) => {
    const rows = await q.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?",
      [userId],
    );
    return Number(rows[0]?.n ?? 0);
  });

test.beforeAll(async () => {
  await withE2eDb(async (q) => {
    await q.exec("DELETE FROM push_subscriptions WHERE endpoint = ?", [ENDPOINT]);
  });
});

test("订阅→落库→退订→删除；未登录 401、坏 body 400（错误路径）", async ({ page, context }) => {
  // 错误路径①：未登录 POST → 401
  await page.goto("/login");
  const unauth = await page.evaluate(async (endpoint) => {
    const res = await fetch("/api/push/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, p256dh: "k", auth: "a" }),
    });
    return res.status;
  }, ENDPOINT);
  expect(unauth).toBe(401);

  // 登录会员后订阅
  await loginAs(context, USERS.member);
  await page.goto("/");
  const okStatus = await page.evaluate(async (endpoint) => {
    const res = await fetch("/api/push/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint, p256dh: "p256dh-key", auth: "auth-key" }),
    });
    return res.status;
  }, ENDPOINT);
  expect(okStatus).toBe(200);
  await expect.poll(() => countSub(USERS.member), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  // 错误路径②：坏 body（缺 auth）→ 400
  const badStatus = await page.evaluate(async () => {
    const res = await fetch("/api/push/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.invalid/x", p256dh: "k" }),
    });
    return res.status;
  });
  expect(badStatus).toBe(400);

  // 退订 → 删除
  const delStatus = await page.evaluate(async (endpoint) => {
    const res = await fetch("/api/push/subscription", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return res.status;
  }, ENDPOINT);
  expect(delStatus).toBe(200);
  await expect.poll(() => countSub(USERS.member), { timeout: 15_000 }).toBe(0);
});

test("VAPID 公钥下发：返回非空公钥（E2E 配置已注入测试密钥）", async ({ page }) => {
  await page.goto("/login");
  const key = await page.evaluate(async () => {
    const res = await fetch("/api/push/vapid-public-key");
    const data = (await res.json()) as { publicKey?: string };
    return data.publicKey ?? "";
  });
  expect(key.length).toBeGreaterThan(0);
});
