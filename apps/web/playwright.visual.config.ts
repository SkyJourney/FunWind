import { defineConfig } from "@playwright/test";

/**
 * 视觉回归基线（M11 Step 6，docs/milestones/M11-themes-pwa.md）：三主题 × 关键页面的
 * Playwright `toHaveScreenshot` 截图对比。**仅本机 macOS 运行**（字体渲染平台差异，CI 不跑；
 * 仓库 CI 只有 verify 与 e2e 两个 job）。基线快照入库在 e2e-visual/__screenshots__/。
 * 更新基线：`pnpm test:visual:update`（先人工核对截图差异，再入库）。
 *
 * 稳定性措施：单 worker、独立端口 3202 与产物目录 .next-e2e-visual（不与 3200/3201 抢锁）；
 * 帖子浏览量计数每次访问自增，页面已打 data-testid="thread-view-count" 供 mask；
 * 截图前滚动一屏预热懒加载，animations/caret 由 toHaveScreenshot 默认禁用。
 */
process.env.NEW_DB_NAME = "qysub_next_e2e";

export default defineConfig({
  testDir: "./e2e-visual",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:3202" },
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      // macOS Chromium 逐进程字形抗锯齿抖动实测 0.4–1.6%（全页文本亚像素微移，非布局差异），
      // 容差取实测 3 倍；真实的主题/布局回归是整片色块（30%+），3% 不会漏报
      maxDiffPixelRatio: 0.03,
    },
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile",
      use: { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: "pnpm exec next build && pnpm exec next start --port 3202",
    url: "http://127.0.0.1:3202",
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      NEW_DB_NAME: "qysub_next_e2e",
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-e2e-visual",
      TRUSTED_PROXY_HOPS: "0",
      // 与 prod E2E 同口径：邮件一律落本地 Mailpit，防止根 .env 漂移影响站点行为
      SMTP_URL: "smtp://127.0.0.1:1025",
      MAIL_FROM: "青翼字幕组 <noreply@qingyisub.top>",
    },
  },
});
