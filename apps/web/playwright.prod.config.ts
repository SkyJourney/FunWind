import { defineConfig, devices } from "@playwright/test";

/**
 * 生产模式冒烟（端口 3201）：真实 `next build` + `next start`，验证只有生产构建才有的行为——
 * 开发入口（/api/dev/*、/design）不可达、/files 安全响应头、TRUSTED_PROXY_HOPS 已声明下业务页面正常。
 * 与主 E2E（playwright.config.ts，dev 服务器 3200）分开运行，且产物目录各自独立（.next-e2e-prod），不会覆盖 dev 的 .next。
 */
process.env.NEW_DB_NAME = "qysub_next_e2e";

export default defineConfig({
  testDir: "./e2e-prod",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3201" },
  projects: [{ name: "production", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm exec next build && pnpm exec next start --port 3201",
    url: "http://127.0.0.1:3201",
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEW_DB_NAME: "qysub_next_e2e",
      // 独立产物目录：生产构建不再覆盖 dev 的 .next
      NEXT_DIST_DIR: ".next-e2e-prod",
      // 生产环境必须显式声明可信代理层数（0 = 直连无代理），漏配会在取 IP 时报错
      TRUSTED_PROXY_HOPS: "0",
    },
  },
});
