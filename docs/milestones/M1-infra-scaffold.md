# M1 · 工程骨架与基础设施

- 阶段：一·骨架 ｜ 覆盖模块：—（基建）｜ 依赖：无
- 状态：⬜ 未开始

## 目标

立起可长期开发的工程基线：Next.js 最新版 + TypeScript 严格模式 + Tailwind v4 + 三层设计令牌 +
shadcn/ui 模式组件地基 + 质量工具链 + 测试框架 + Drizzle 接入新库。完成后一切后续开发都在这条流水线上跑。

## 范围（做什么）

1. `apps/web`：Next.js（App Router, RSC）脚手架，TS `strict`，路径别名 `@/`。
2. Tailwind v4 + 设计令牌三层结构（`tokens/primitives.css` / `semantic.css` / `themes/default.css`、`dark.css`），
   `/` 提供令牌演示页（色板/字号/间距/组件样例 + 明暗切换）。
3. shadcn/ui 模式初始化，落地首批组件：Button/Input/Card/Dialog/Dropdown/Tabs/Badge/Avatar/Skeleton/Toast。
4. 质量工具链：ESLint（flat config）+ Prettier + husky + lint-staged；`npm run lint / typecheck / test / build` 一键化。
5. 测试框架：Vitest（单测/组件）+ Playwright（E2E）+ 覆盖率报告（v8）。
6. Drizzle ORM 接 `qysub_next`（连接层复用迁移程序的环境变量约定）；`drizzle-kit` 可生成/执行迁移。
7. **数据层双模式落地（决策 #10）**：Drizzle schema 定义成为**单一事实源**（重现 `migration/schema/schema.sql`
   的全部语义）；`npm run db:bootstrap` 空库一键建表；`npm run db:seed` 演示数据种子（开发/测试用，
   与安装器 M12 分离）；迁移程序 `schema-init` 改为引用同一 Drizzle 管线。
8. Docker：web 开发容器编排并入 `docker/`（dev 用 compose profile）。

## 边界（明确不做什么）

- 不做任何业务页面/数据渲染（`/` 仅令牌演示页）；不做安装向导（M12）。
- 不做「复刻·青翼2010」主题包（M11）；不做登录/权限（M4/M5）。
- 不引入状态管理库与 UI 黑盒组件库。

## 测试规则

- 令牌演示页：Playwright 冒烟 1 例（加载 + 切换 `data-theme` 断言根变量变化）。
- 一个工具函数样例（如 cn/日期格式化）单测，作为覆盖率基线示范。
- CI 就位：本地 husky pre-commit 跑 lint-staged；`npm run verify:all`（lint+tsc+test+build）脚本化。

## 验收门禁

- [ ] `npm run build` 成功；`npm run verify:all` 全绿
- [ ] 令牌演示页明暗切换 E2E 通过
- [ ] **双模式数据层回归**：空库 `db:bootstrap`→`db:seed`→演示查询跑通；
  且青翼导入程序在新 Drizzle schema 上完整回归（`npm run migrate` + `npm run verify` 23 项全过）
- [ ] 覆盖率报告可生成并达标（示范模块 ≥90%）
- [ ] README「快速开始」可被新人照做跑通（应用启动部分补全）
- [ ] CHANGELOG 记录 M1 交付

## 遗留事项

（无）
