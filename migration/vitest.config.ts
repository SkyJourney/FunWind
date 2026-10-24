import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // 纯逻辑层：转换（transform）与工具（lib）。抽取/加载/步骤编排是 IO 边界，
      // 由真实库的 verify 对账（pnpm verify:migration）与幂等重跑验证，不在单测覆盖统计内。
      include: ["src/transform/**", "src/lib/**"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
