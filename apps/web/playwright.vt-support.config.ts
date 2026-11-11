import { defineConfig, devices } from "@playwright/test";

/**
 * M15 Step 0-5 支持面探测专用配置（实验用，Step 4 清账时随 lab 移除）：
 * 只跑 vt-support.spec.ts（VT API / transitionTypes / view-transition-class 在 WebKit 与
 * Firefox 上的支持面）。复用 prod 配置已构建的 .next-e2e-prod 产物直接 start，不重复 build。
 */
process.env.NEW_DB_NAME = "qysub_next_e2e";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /vt-support\.spec\.ts/,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3201" },
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: {
    command: "pnpm exec next start --port 3201",
    url: "http://127.0.0.1:3201",
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      NEW_DB_NAME: "qysub_next_e2e",
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-e2e-prod",
      TRUSTED_PROXY_HOPS: "0",
      SMTP_URL: "smtp://127.0.0.1:1025",
      MAIL_FROM: "青翼字幕组 <noreply@qingyisub.top>",
    },
  },
});
