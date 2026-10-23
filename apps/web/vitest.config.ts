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
      // M1 覆盖率范围：地基期已交付的纯逻辑与组件（随里程碑扩展 include）
      include: [
        "src/lib/utils.ts",
        "src/lib/theme.ts",
        "src/components/theme-switcher.tsx",
        "src/components/ui/button.tsx",
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
