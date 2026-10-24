import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 集成测试要建库/删库，单文件内串行；文件之间使用各自的随机库名，互不干扰
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // 纯逻辑与数据库边界（bootstrap / seed）都纳入统计：
      // IO 层由 *.int.test.ts 的真实数据库集成测试覆盖，不再以「E2E 覆盖」为由排除（ROADMAP 测试基线）
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/env.ts", "src/client.ts"],
      thresholds: { lines: 90, branches: 80, functions: 90, statements: 90 },
    },
  },
});
