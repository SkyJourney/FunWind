import { defineConfig, devices } from "@playwright/test";

process.env.NEW_DB_NAME = "qysub_next_e2e";

/** 管理界面六档宽度专项；复用冻结构建可保留修复前后的同场景证据。 */
export default defineConfig({
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3202", serviceWorkers: "block" },
  projects: [
    {
      name: "production",
      testDir: "./e2e",
      testMatch: "responsive-management.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command:
      process.env.LAYOUT_PREBUILT === "1"
        ? "pnpm exec next start --port 3202"
        : "pnpm exec next build && pnpm exec next start --port 3202",
    url: "http://127.0.0.1:3202",
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEW_DB_NAME: "qysub_next_e2e",
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-review-layout",
      TRUSTED_PROXY_HOPS: "0",
      APP_URL: "http://127.0.0.1:3202",
      STORAGE_DIR: process.env.STORAGE_DIR ?? "../../storage-e2e-step7",
      SMTP_URL: "smtp://127.0.0.1:1025",
      MAIL_FROM: "青翼字幕组 <noreply@qingyisub.top>",
    },
  },
});
