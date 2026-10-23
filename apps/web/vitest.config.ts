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
      // 覆盖率范围：已交付的纯逻辑与内核（随里程碑扩展）；
      // state.ts / slot.tsx 组件渲染由 E2E 覆盖，不入单测阈值
      include: [
        "src/lib/utils.ts",
        "src/lib/theme.ts",
        "src/components/theme-switcher.tsx",
        "src/components/ui/button.tsx",
        "src/modules/kernel/types.ts",
        "src/modules/kernel/registry.ts",
        "src/modules/kernel/bus.ts",
      ],
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
