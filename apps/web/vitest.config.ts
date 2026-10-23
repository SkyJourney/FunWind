import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      // 覆盖率范围：纯逻辑 + 内核（目录策略，新文件自动纳入）；
      // state.ts / slot.tsx 为 IO 边界，由 E2E 覆盖（显式排除）
      include: ["src/lib/**", "src/modules/kernel/**"],
      // IO 边界层（DB 查询/RSC 宿主）由 E2E 覆盖，不入单测阈值
      exclude: ["src/modules/kernel/state.ts", "src/modules/kernel/slot.tsx", "src/lib/queries/**"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      cn: path.resolve(__dirname, "src/lib/utils.ts"),
    },
  },
});
