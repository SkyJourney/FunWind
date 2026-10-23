# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式；
版本号采用语义化版本（SemVer）。里程碑交付在条目中标注（M1–M13，见 docs/ROADMAP.md）。

## [Unreleased]

### Added（M3 · 内容只读渲染）

- **topic_type 补迁**（M0 漏迁，150 行）：版块页主题分类筛选的前提；迁移实体 11→12，verify 23→24 项。
- **安全渲染管线**：unified/remark/rehype（allowDangerousHtml→raw→sanitize→harden→stringify）+ LRU 缓存；
  白名单 schema + style 声明级过滤（保住 UBB 彩色/字号情怀排版，封死 url()/expression()）；
  XSS 用例集 16 + 白名单保留 6（sanitize.test 29 例）。
- **静态资源路由** `/attachment/**`、`/emotion/**`：逐段穿越守卫 + resolve 前缀双保险 + Content-Type 映射 +
  非图片下载头 + immutable 缓存；探针实证含 `.env` 穿越拦截。
- **三个页面**：首页（分类版块目录 + 真实计数 + 最新动态）、版块页（置顶前置/主题分类筛选/分页 25）、
  帖子页（首帖正文 + 楼层 20/页 + 嵌套回复 + #p 锚点 + 首帖附件芯片）；
  组件 RichContent/UserBadge（已注销）/ThreadRow（置顶三级/精华/投票/附件徽标）/Pagination。
- **数据状态呈现**：spam→404、屏蔽→blocked 视图、孤儿作者→已注销（81 个真实作者）、售帖→付费提示块。
- **E2E 15 例**（真实数据夹具）+ **perf:lcp**（生产构建 LCP 断言 <2500ms：首页 128ms/版块 68ms/帖子 68ms）。
- **URL 格式冻结**（BLUEPRINT §4.5）：`/f/{fid}`、`/t/{tid}`、`?page=`、`#p{pid}` + 旧站 301 源映射表。


### Added（基线审查修复轮 · P1–P3 全项）

- **连接层重构（P1）**：web 运行时单例池 `getWebDb()`（globalThis 守卫，消除每请求建池）；
  连接统一 `timezone: "+08:00"` + `dateStrings` —— 库内 DATETIME 锁定为北京墙面时间，
  UTC 容器化不再漂移；`apps/web/src/lib/datetime.ts` 为唯一解析入口（parseDbDateTime/nowBeijingWallTime）。
- **actor 语义（P2）**：`event_log.actor_id` 按事件映射 payload 字段
  （thread.created→authorId 等 10 项），显式 actorId 可覆盖；语义表入 MODULES.md。
- **外部入口校验（P2）**：REQUIRED_PAYLOAD_KEYS + validateEventPayload，dev emit API 强制校验。
- **E2E 独立数据库（P2）**：`qysub_next_e2e`（e2e-reset 脚本 drop→create→bootstrap→seed，
  根 `test:e2e` 编排），测试不再污染开发库。
- **迁移 UPSERT 语法升级（P2）**：upsertBatch 迁至 `AS new` 别名（VALUES() 于 8.0.20 弃用）；
  迁移回归 23 项全绿。
- **并发锁（P3）**：迁移进程 GET_LOCK 互斥，双开即拒。
- **测试补强（P2）**：覆盖率改目录策略（kernel/lib 新文件自动纳入，当前 96/94/97）；
  event-names / datetime 单测补齐（48 用例）；e2e 纳入 typecheck。

### Fixed

- drizzle datetime 列统一 `mode: "string"`（与连接层 dateStrings 对齐，消除 Date/字符串双形态）。
- .dockerignore 补齐（构建上下文不再吞 node_modules/.next/dist）。
- next-env.d.ts 出库；state.ts 重复导入合并；db verify.ts `void key` 清理。
- BLUEPRINT §6/§9 文档漂移同步（pnpm 命令 + 根 .env 路径 + §2.3 新增时区/连接两条红线）。


### Added（M2 · 模块注册表内核）

- **内核五件**（`apps/web/src/modules/kernel/`）：types（10 事件 + home.* 槽位 + 六类注册边界，编译期防呆）、
  registry（唯一性/kebab-case/封板）、bus（顺序派发、逐消费者隔离、event_log 审计、落库失败降级、依赖注入）、
  state（module_state + React cache 请求级缓存、库故障降级）、slot（selectSlotRenderers 纯函数 + RSC 槽位宿主）。
- **平台表**：event_log + module_state（0001/0002 迁移；正式库补 drizzle journal 基线，与 P0 手写 DDL
  的 mediumint/bigint 类型漂移经 db:verify 暴露并以 0002 对齐）。
- **装卸机制**：`modules:toggle` CLI + dev-only API（/api/dev/emit 假会话事件、/api/dev/modules/toggle），
  双重生产守卫。
- **demo-checkin 演示模块**：user.logged_in 消费 + home.footer-notice 最近登录横幅（M7 由真实签到替换）。
- **契约文档** `docs/MODULES.md`：事件/槽位清单、六类边界、语义与边界（扩清单=改内核+说明）。
- **测试**：内核单测 18 例（注册唯一性/派发顺序/异常隔离/槽位合并/装卸过滤），E2E 2 例装卸闭环
  （串行——装卸共享 dev 服务器状态），全站 36 单测 + 6 E2E 全绿，内核覆盖率 95/97/95。

### Fixed

- API 路由与页面是两棵模块图：使用内核的 route handler 必须自行 `import "@/modules"`
  （已写入 MODULES.md 边界第 6 条，dev API 首版即踩）。

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

