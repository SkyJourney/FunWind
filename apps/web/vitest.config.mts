import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    hookTimeout: 30_000, // 临时库 bootstrap+seed 在并发负载下允许更宽裕的准备时间
    // 用例超时对齐 hookTimeout：全库 IO 扫描型守卫（server-only/architecture/gate-wording 等
    // readFileSync 遍历全 src）本地毫秒级，CI 2 核 runner 实测可超 vitest 默认 5s（M16 Step 5
    // 连续两轮各随机红一个）——统一放宽，避免每轮随机红；真正挂死的用例仍会在 30s 后报红
    testTimeout: 30_000,
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
        // 纯 TypeScript 类型声明（interface/type，零运行时语句）：v8 把空模块计入分母拉低全局阈值（M9.5 收口时逐条核对）
        "src/components/editor/insert-api.ts",
        "src/lib/stream/types.ts",
        "src/lib/gates/types.ts",
        // IO 壳（原 mailer.ts 排除项随批次 0 拆分迁移）：SMTP 发送与发送记录、品牌解析（读 chrome/主题目录缓存）——集成与 E2E 覆盖
        "src/lib/mail/transport.ts",
        "src/lib/mail/brand.ts",
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
        "src/{components/editor,lib/editor/markdown}/**": {
          lines: 90,
          branches: 85,
          functions: 90,
          statements: 90,
        },
        "src/components/upload/**": { lines: 90, branches: 85, functions: 90, statements: 90 },
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      cn: path.resolve(import.meta.dirname, "src/lib/utils.ts"),
      // 测试进程不是 RSC 宿主；只替换标记，不切换 React 的解析条件。
      "server-only": path.resolve(
        import.meta.dirname,
        "node_modules/next/dist/compiled/server-only/empty.js",
      ),
    },
  },
});
