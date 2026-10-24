import { defineConfig, devices } from "@playwright/test";

// 测试进程（含工作进程）与被测服务器指向同一个隔离库；support/db.ts 的直连夹具助手依赖它
process.env.NEW_DB_NAME = "qysub_next_e2e";

/**
 * E2E 独占 3200 端口 + 隔离库（qysub_next_e2e）：
 * - 与用户 dev 服务（3100）完全隔离，杜绝 env 错配（基线审查教训）
 * - webServer env 由配置固定注入，不依赖 shell 环境
 * - 库内容由根 test:e2e 编排先行重置（重置→迁移导入→种子）
 */
export default defineConfig({
  testDir: "./e2e",
  // 单个用例 30s 上限；整套串行（共享一个库与一个 dev 服务器）
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3200",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev --port 3200",
    url: "http://127.0.0.1:3200",
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      NEW_DB_NAME: "qysub_next_e2e",
      FUNWIND_DEBUG_DB: "1",
    },
  },
});
