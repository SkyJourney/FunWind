import { defineConfig, devices } from "@playwright/test";

/**
 * 安装向导 E2E（M12，端口 3203）：真实 `next build` + `next start`，专用产物目录
 * `.next-e2e-install-prod` 与专用存储 `storage-e2e-install`（由根 test:e2e:install 编排导出）。
 * 起点必须是「只建库、不 bootstrap 不 seed」的空库——建表是安装管线自己的第 3 步
 * （编排里 e2e-reset + install-cli-reset 只负责建空库）。与 3200/3201/3202 互不抢锁。
 */
process.env.NEW_DB_NAME = "qysub_next_e2e";

export default defineConfig({
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3203", serviceWorkers: "block" },
  projects: [
    { name: "production", testDir: "./e2e-install", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "pnpm exec next build && pnpm exec next start --port 3203",
    // 就绪探针指向 /install?step=1：零表库上首页会 500（feed 查询），而向导页自带零表韧性
    url: "http://127.0.0.1:3203/install?step=1",
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEW_DB_NAME: "qysub_next_e2e",
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-e2e-install-prod",
      TRUSTED_PROXY_HOPS: "0",
      APP_URL: "http://127.0.0.1:3203",
      SMTP_URL: "smtp://127.0.0.1:1025",
      MAIL_FROM: "青翼字幕组 <noreply@qingyisub.top>",
    },
  },
});
