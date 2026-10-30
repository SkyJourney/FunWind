import { defineConfig, devices } from "@playwright/test";

/**
 * 生产模式冒烟（端口 3201）：真实 `next build` + `next start`，验证只有生产构建才有的行为——
 * 开发入口（/api/dev/*、/design）不可达、/files 安全响应头、TRUSTED_PROXY_HOPS 已声明下业务页面正常。
 * 与主 E2E（playwright.config.ts，dev 服务器 3200）分开运行，且产物目录各自独立（.next-e2e-prod），不会覆盖 dev 的 .next。
 */
process.env.NEW_DB_NAME = "qysub_next_e2e";

export default defineConfig({
  // 功能用例全量（M9.5 CI 优化）：生产构建预编译全部 chunk，无 dev 按需编译的冷启动 flake；
  // dev-only 用例（e2e-dev/）不在本目录。e2e-prod/ 的生产专属断言由下面额外的 projects 补跑
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3201" },
  projects: [
    // 桌面：除 mobile-*.spec.ts 之外的全部功能用例（与 dev 配置同口径）
    {
      name: "production",
      testDir: "./e2e",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile-.*\.spec\.ts$/,
    },
    // 移动：375px 视口（与 dev 配置同口径）
    {
      name: "mobile",
      testDir: "./e2e",
      testMatch: /mobile-.*\.spec\.ts$/,
      use: {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
    // 生产构建专属行为（开发入口 404、安全响应头等），只有 prod 服务器能验证
    { name: "production-only", testDir: "./e2e-prod", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm exec next build && pnpm exec next start --port 3201",
    url: "http://127.0.0.1:3201",
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEW_DB_NAME: "qysub_next_e2e",
      // 独立产物目录：生产构建不再覆盖 dev 的 .next
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-e2e-prod",
      // 生产环境必须显式声明可信代理层数（0 = 直连无代理），漏配会在取 IP 时报错
      TRUSTED_PROXY_HOPS: "0",
    },
  },
});
