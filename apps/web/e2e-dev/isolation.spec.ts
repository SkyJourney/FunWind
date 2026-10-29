import { expect, test } from "@playwright/test";

/**
 * dev-only 冒烟（M9.5 CI 优化拆分）：依赖开发专属路由 /api/dev/*，生产模式 404（prod.spec 有断言），
 * 因此只能在 dev 服务器上跑。
 */
test("隔离校验：E2E server 连接的是隔离库", async ({ request }) => {
  const r = await request.get("/api/dev/whoami");
  const body = (await r.json()) as { database: string };
  expect(body.database).toBe("qysub_next_e2e");
});
