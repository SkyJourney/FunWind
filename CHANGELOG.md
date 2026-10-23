# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式；
版本号采用语义化版本（SemVer）。里程碑交付在条目中标注（M1–M13，见 docs/ROADMAP.md）。

## [Unreleased]

### Added（M1 · 工程骨架与基础设施）

- **pnpm workspace**（pnpm 12.15 自管版本）：`apps/web` + `packages/db` + `migration` 三包结构。
- **@funwind/db 数据内核（决策 #10 单一事实源）**：17 张表 Drizzle 定义、版本化迁移
  （`drizzle/0000_init.sql` 入库）、`db:bootstrap`（空库建表 + username 列级 as_cs 幂等 patch）、
  `db:seed`（90000+ 号段幂等演示种子）、`db:verify`（information_schema 逐表对账，期望自 schema.ts）。
- **双模式数据回归**：临时库空库→建表→全量导入 23 项对账全绿；正式库幂等重跑 23 项全绿。
- **apps/web**：Next.js 16.4.2 + React 19.3.1 + TS strict；三层设计令牌
  （primitives/semantic/themes：default + dark）；Tailwind v4 `@theme inline` 映射；
  shadcn CLI 4.22 首批 10 组件（统一 radix-ui 包 + cn 别名）；next-themes 三态切换（无闪烁）；
  令牌演示页（色板/字阶/圆角阴影/组件样例）。
- **质量工具链**：ESLint 10（flat config，eslint-config-next 原生 flat 数组）+ Prettier 3.9
  （tailwindcss 插件）+ husky/lint-staged；Vitest 5 + Testing Library（覆盖率门槛 90/85，当前 100%）；
  Playwright（E2E：主题切换/持久化/语义配色）；`verify:all` 一键门禁。
- **Docker dev**：`docker/dev/`（node:24-alpine + corepack pnpm，compose profile 可选路径）。

### Fixed

- Next 16 安全默认拦截 `127.0.0.1` 开发资源（HMR/运行时块）导致**开发模式整页无交互**（水合静默失败）——
  `next.config.ts` 配置 `allowedDevOrigins: ["127.0.0.1"]` 修复。

### Changed

- 里程碑重排：新增 M12「安装向导与零数据部署」，原 M12「部署与社区重启」改为 M13；
  ROADMAP/依赖图/相关里程碑引用已同步。

### 计划中

- M2 模块注册表内核（下一里程碑）
- M3–M13 里程碑（见 docs/ROADMAP.md）

## [0.1.0] - 2026-10-23 · 项目设计与数据迁移（P0）

### Added

- **技术蓝图与决策**：`docs/BLUEPRINT.md`——Next.js + MySQL 8.4 LTS + Drizzle + 模块注册表；两轮 8 项站长确认决策全部记录。
- **数据迁移程序** `migration/`：phpwind 9（GBK）→ qysub_next（utf8mb4）幂等迁移，
  11 实体 ≈16.7 万行（用户 10,701 / 主题 4,505 / 回帖 35,248 / 积分流水 93,765 / 私信 3,760 等）；
  旧库只读守卫、UBB→Markdown 转换器（36,771 行正文标签清单驱动）、content_raw/content_md 双写。
- **新库 schema**：保留旧主键（uid/tid/pid/fid/aid）+ 每表 raw JSON 归档；username 列
  `utf8mb4_0900_as_cs`（さくら/サクラ EUC-JP 历史字节实测修正）。
- **验证程序**：23 项对账（行数/600 行抽样 MD5/转换完整性/垃圾标记/附件磁盘/楼层连续性）全部通过。
- **新库容器**：`docker/qysub-next/` MySQL 8.4 LTS @ 127.0.0.1:33621。
- **源码对齐报告**：`docs/LEGACY-FEATURE-MAP.md`——旧 37 应用/40 服务归并为 M01–M15 模块清单，
  57 权限点词汇表提取，签到=每日红包任务等业务语义考古，骨架插入点清单。
- **前端方案**：`docs/FRONTEND-DESIGN.md`——三层设计令牌 + 主题包（现代浅色/暗色/复刻·青翼2010）+ shadcn/ui 模式。
- **权限方案**：`docs/AUTHZ.md`——自研 RBAC/ABAC（5 表 + 评估器），继承旧 57 权限点，旧数据翻译映射。
- **路线图与里程碑体系**：`docs/ROADMAP.md` + `docs/milestones/M1–M12`（范围/边界/测试规则/验收门禁）。

### Data quality（迁移期发现并处置）

- 3,033 条 2018-11 广告空壳主题标记 `is_spam` 隐藏（真实内容主题 ≈1,472）；3 个广告账号标记。
- 孤儿 uid（用户已删、帖仍在）确认为历史现象，方案：UI 渲染「已注销」。
- 附件路径勘误：实际位于 `wwwroot/.../attachment/`（527MB，两代目录并存）；415 个中仅 1 个源盘即缺失。
- pw8 遗留表情码 152 行（映射外）确认旧站亦无法渲染，保留原文；源帖截断/笔误标签原样保留，raw 可证。

