# M1 工程骨架与基础设施 · 推进计划（pnpm 版）

目标对照 `docs/milestones/M1-infra-scaffold.md`，交付可长期开发的工程基线 + 数据层双模式落地。包管理采用 **pnpm**（workspace 机制）。

## 0. 版本基线（2026-10-23 实查 npm registry）

Next **16.4.2** · React **19.3.1** · Tailwind **4.3.3**（v4 稳定线）· Drizzle orm **0.45.4** / kit **0.31.11**（generate/migrate/push 齐备）·
shadcn CLI **4.22.1**（原生支持 Tailwind v4 + React 19）· Vitest **5.0.5**（Node 24 ✓）· Playwright **1.64.1** · ESLint **10** · Prettier **3.9** ·
**TypeScript 锁 5.9.x**（7.0 是 Go 重写大版本，地基期求稳；M3 前做一次 TS7 兼容复评，记入遗留）。pnpm 取当前 latest（10.x），经 corepack 或全局安装，`packageManager` 字段锁版本。

## 1. 仓库结构（pnpm workspace，单仓多包）

```
FunWind/
├── pnpm-workspace.yaml     # packages: ["apps/*", "packages/*", "migration"]
├── package.json            # 根：packageManager 锁版本 + verify:all 等编排脚本
├── pnpm-lock.yaml          # 唯一 lockfile（删除 migration/package-lock.json）
├── apps/web/               # Next.js 16（App Router/RSC），TS strict，别名 @/*
│   ├── src/app/            # page.tsx = 令牌演示页
│   ├── src/styles/tokens/  # primitives.css / semantic.css / themes/default.css, dark.css
│   ├── src/components/ui/  # shadcn 模式组件（源码进仓库）
│   ├── src/lib/            # cn() 等工具（单测示范对象）
│   └── e2e/                # Playwright 用例
├── packages/db/            # @funwind/db —— schema 单一事实源（决策 #10）
│   ├── src/schema.ts       # 17 张表 Drizzle 定义（mysql-core，含 users.username 列级 as_cs）
│   ├── src/client.ts       # 连接工厂（web 与 migration 共用）
│   ├── drizzle/0000_init.sql + journal  # drizzle-kit generate 产物，提交入库（版本化迁移）
│   └── scripts/            # bootstrap / seed / verify
└── migration/              # 改造为 @funwind/migration workspace 包；schema-init 改走同一 Drizzle 管线
```

选型理由：pnpm workspace 的严格依赖隔离最干净，`@funwind/db` 被 web 与 migration 同时引用，真正实现"建表只有一份真相"。

## 2. 实施步骤（4 个提交点）

### Step 0 · pnpm 就绪
- 本机启用 pnpm（corepack enable / 全局安装），根 `package.json` 写 `packageManager`；`pnpm-workspace.yaml`；
  删除 `migration/package-lock.json`，根 `pnpm install` 一次装齐全部包，提交 `pnpm-lock.yaml`。

### Step 1 · packages/db 数据内核
- 17 张表翻译为 Drizzle 定义：groups/users/forums/threads/posts/attachments/emoticon_categories/emoticons/medals/user_medals/credit_logs/polls/poll_options/poll_voters/private_messages/message_dialogs/migration_state；逐列对照 `schema.sql`（int unsigned / varchar 长度 / json / datetime / mysqlEnum / 索引 / `username` 列级 COLLATE utf8mb4_0900_as_cs）。
- `drizzle-kit generate` 产出 `0000_init.sql` 提交入库；`db:bootstrap` = drizzle-kit migrate（空库建表）。
- `db:verify` 对账脚本：bootstrap 后比对 information_schema（表数/列数/关键列类型与排序规则）vs schema.ts 期望。
- `db:seed` 幂等演示种子：1 分类 + 3 版块 + 2 用户 + 5 主题 + 若干回帖/勋章/表情样例（UPSERT，可重跑）。

### Step 2 · migration/ workspaces 化 + 双模式回归
- 并入 workspace（@funwind/migration），client 改用 @funwind/db 工厂（.env 路径固定，防 cwd 漂移）。
- `schema-init.ts` 切换为执行 `@funwind/db` 的同一批 drizzle SQL 迁移（弃用 schema.sql 直读；schema.sql 保留为 P0 历史底稿）。
- **门禁回归**：临时库（qysub-next-mysql 上建 `qysub_next_bootstrap_test`）跑 bootstrap→seed→verify；正式 `qysub_next` 重跑 `migrate`+`verify`（23 项必须全绿，幂等性本就要求可重跑）。

### Step 3 · apps/web 脚手架 + 三层令牌 + shadcn
- `create-next-app@16` 装配到 apps/web（TS strict / App Router / 无 Tailwind 模板残留），清理为最简骨架。
- 三层令牌（先定数值再写 CSS）：
  - primitives：青翼强调色 cyan-teal 色阶（50–950）、中性灰阶、success/warning/danger/info、字阶 12–36px 六档、4px 基数间距、圆角 4/8/12/16、阴影 3 档。
  - semantic：shadcn 兼容命名（background/foreground/card/muted/primary/accent/destructive/border/ring + --radius），组件只准用语义层。
  - themes：default（浅色）/ dark（`[data-theme=dark]`），Tailwind v4 `@theme inline` 映射进工具类（bg-background 等）。
- shadcn init（CSS 变量模式）+ 首批组件：button/input/card/dialog/dropdown-menu/tabs/badge/avatar/skeleton/sonner(toast)。
- ThemeProvider + ThemeSwitcher：data-theme 切换、跟随系统初始值、localStorage 持久化（服务端组件直出无闪烁方案）。
- 令牌演示页 `/`：色板/字阶/间距/圆角/阴影 + 全部首批组件样例 + 明暗切换，中英双标注。

### Step 4 · 质量工具链 + Docker dev + 门禁自测
- ESLint 10 flat config（eslint-config-next + typescript-eslint）+ Prettier（含 tailwindcss 插件）+ husky + lint-staged（pnpm 兼容）。
- Vitest 5（单测/组件，jsdom + Testing Library，v8 覆盖率，阈值 90/85）+ Playwright（chromium）。
- 根脚本（pnpm --filter 编排）：`lint / typecheck / test / test:e2e / build / db:bootstrap / db:seed / db:verify / verify:all`（verify:all = lint→typecheck→test→build 依序全绿）。
- Docker：`docker/dev/web.Dockerfile`（node:24-alpine + corepack pnpm）+ dev compose profile（可选路径，本地 pnpm dev 等价）。
- README「快速开始」补应用部分（pnpm 命令）；CHANGELOG 记 M1；M1 文档 checklist 勾选。

## 3. 测试计划（对照全局基线）

| 层 | 用例 |
|----|------|
| 单测（≥90%） | cn()、令牌解析/主题解析工具、seed 幂等函数、db:verify 对账逻辑 |
| 组件 | ThemeSwitcher（切换/持久化/系统偏好）、Button 全变体渲染 |
| E2E | 令牌演示页加载 + data-theme 切换断言 + 刷新后持久化 |
| 双模式回归 | bootstrap→seed（临时库）；青翼 migrate→verify 23 项（正式库，幂等重跑） |

## 4. 风险与对策

1. **TS 7 生态兼容未知** → 锁 5.9，遗留项记录复评点。
2. **drizzle generate 与手写 DDL 细节差异**（索引命名/列级 collation/unsigned）→ db:verify information_schema 对账兜底 + Step 2 全量导入回归；差异点记录进 BLUEPRINT。
3. **Next 16 Turbopack 默认构建变化** → 跟随默认，异常时记录并降级 webpack 配置。
4. **workspaces 化后 migration 的 .env/cwd 漂移** → dotenv 固定绝对路径加载，回归兜底验证。
5. **pnpm 严格 node_modules 与 shadcn/drizzle 兼容** → 两者均为 pnpm 主流适配对象，正常安装；异常用 `.npmrc` 按包豁免并记录。

## 5. 交付定义

M1 checklist 全勾 + `verify:all` 全绿 + README/CHANGELOG 更新 + 提交序列：Step 0/1（pnpm 就绪 + db 内核）→ Step 3（web 骨架与令牌）→ Step 4（工具链与测试）→ 收尾（门禁自测 + 文档），每步独立可回退。