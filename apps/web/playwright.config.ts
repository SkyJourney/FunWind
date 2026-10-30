import { defineConfig, devices } from "@playwright/test";

// 测试进程（含工作进程）与被测服务器指向同一个隔离库；support/db.ts 的直连夹具助手依赖它
process.env.NEW_DB_NAME = "qysub_next_e2e";

/**
 * E2E 独占 3200 端口 + 隔离库（qysub_next_e2e）：
 * - 与用户 dev 服务（3100）完全隔离，杜绝 env 错配（基线审查教训）；产物目录也独立（.next-e2e），两者可同时运行
 * - webServer env 由配置固定注入，不依赖 shell 环境
 * - 库内容由根 test:e2e 编排先行重置（重置→迁移导入→种子）
 */
export default defineConfig({
  // dev-only 冒烟（M9.5 CI 优化）：依赖 /api/dev/* 与 /design 的用例；功能用例全部在 prod 配置跑
  testDir: "./e2e-dev",
  // 单个用例 30s 上限；整套串行（共享一个库与一个 dev 服务器）
  fullyParallel: false,
  workers: 1,
  // CI 上重试一次：dev server 冷启动的按需编译（next/dynamic chunk、编辑页首访）在 2 核 runner
  // 上偶发超过用例内断言的超时，重试时 chunk 已缓存即绿——本地无法复现的环境型 flake。
  // trace on-first-retry 会在重试时留现场，正好把「偶发」变成可检视的证据。
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3200",
    trace: "on-first-retry",
  },
  projects: [
    // 桌面：除 mobile-*.spec.ts 之外的全部用例
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile-.*\.spec\.ts$/,
    },
    // 移动：375px 视口的版式与触达检查（M6.2 决策 4：只跑 M6.2 的用例与访客冒烟，全量移动回归留到 M6.5）
    {
      name: "mobile",
      testMatch: /mobile-.*\.spec\.ts$/,
      use: {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "pnpm dev --port 3200",
    url: "http://127.0.0.1:3200",
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      NEW_DB_NAME: "qysub_next_e2e",
      FUNWIND_DEBUG_DB: "1",
      // 独立产物目录：不与 dev（.next）抢 Next 16 的目录锁，E2E 与用户 dev 服务可同时运行
      NEXT_DIST_DIR: process.env.NEXT_DIST_DIR ?? ".next-e2e",
    },
  },
});
