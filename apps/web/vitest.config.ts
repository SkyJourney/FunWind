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
      // 覆盖率范围：lib 全部 + 模块内核。服务层/查询层/会话/令牌等 IO 代码以真实 MySQL 临时库集成测试纳入统计（不再整块排除）。
      // 仍排除的只有两类“宿主壳”，原因逐条写明：
      //   · slot.tsx   —— RSC 宿主组件（异步服务端组件），无法在 jsdom 渲染，由 E2E 覆盖
      //   · mailer.ts  —— nodemailer SMTP 传输薄封装，真实投递由 E2E + MailPit 覆盖
      // 编辑器组件目录（M6.3）：与 lib 同口径统计。组件以 jsdom + 真实 Tiptap / CodeMirror 实例测试
      include: [
        "src/lib/**",
        "src/modules/kernel/**",
        "src/components/editor/**",
        "src/components/upload/**",
      ],
      exclude: [
        "src/modules/kernel/slot.tsx",
        "src/lib/auth/mailer.ts",
        // 裁剪工具（M6.4d2）：react-image-crop 的拖拽与手柄是第三方交互壳，换算逻辑在 crop-math.ts 中单测，交互由 E2E 覆盖
        "src/components/upload/crop-body.tsx",
        "src/components/upload/crop-dialog.tsx",
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
        // 编辑器组件目录单独设阈值（站长既定：编辑器组件 ≥ 90%，M6-posting 测试规则）
        "src/components/editor/**": { lines: 90, branches: 85, functions: 90, statements: 90 },
        "src/components/upload/**": { lines: 90, branches: 85, functions: 90, statements: 90 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      cn: path.resolve(__dirname, "src/lib/utils.ts"),
    },
  },
});
