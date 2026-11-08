import { defineConfig } from "@playwright/test";

/**
 * 301 用例集专用 config（M13 Step 2）：仅 API 请求，不起 webServer——
 * nginx 验证容器由用例自身 beforeAll/afterAll 管理（docker）。
 * 运行：cd apps/web && pnpm exec playwright test -c playwright.legacy-redirect.config.ts
 */
export default defineConfig({
  testDir: "./e2e-prod",
  testMatch: /legacy-redirect\.spec\.ts/,
  // nginx 验证容器是单例（beforeAll 起、afterAll 清）：多 worker 会并发抢同名容器
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
