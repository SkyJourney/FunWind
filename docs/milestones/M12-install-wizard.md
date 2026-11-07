# M12 · 安装向导与零数据部署

- 阶段：三·完善 ｜ 覆盖模块：数据层基建 ｜ 依赖：M4（管理员账号体系）+ M5.5（schema v2）+ M9（站点配置基础）；前置：M1 的 bootstrap/seed
- 状态：🚧 实施中（2026-11-07 开工。设计基准与本文件 §2 核实事实、§6 决策 D1–D4（站长 2026-11-07 确认）经规划审批）
- 设计基准：`packages/db` 的 bootstrap 管线（幂等，M5.5/M11.6 沉淀）；M11.3 的注册策略读取（`register.policy`）；
  守卫范式 `lib/dev-only.ts` + `dev-only-guard.test.ts`；EmptyState 全站约定（M9.5）；评审规范 G-15/G-16/G-19。

> **执行纪律**：分支 `feat/m12-install-wizard`，每个 Step 单独提交、单独过门禁，完成后回写 §9 并汇报，
> 站长确认后再进下一步；门禁以真实命令输出为准（不套管道），冲突先改文档再动代码。
> §2 记录的是**已在代码里核实过**的事实，§6 记录决策，二者不要混读。

## 1. 目标

让 FunWind 作为**可复用的论坛产品**独立部署：零数据从零安装即可运行；
「从青翼 phpwind 导入」只是可选路径（由 `migration/` 工具承担），不是项目运行的前提。

- **Web 安装向导 `/install`**（分步）：环境自检 → 数据库连接（表单预填 env，连接测试）→ 建库 + schema →
  站点基础设置（站名 / 描述 / 站点 URL / 默认主题 / 注册模式）→ 创建超级管理员 → 写入 `install.lock` → 跳转登录。
- **CLI 等价物**：`install:cli`（非交互，读 env / 参数），与向导**共用同一安装管线**（同一状态机、同一审计）。
- **零数据运行保障**：空库（bootstrap 后）全页面可访问、空态引导；**防重装**与中断恢复。

## 2. 已在代码里核实的事实（2026-11-07 探查，行号佐证）

| # | 事实 | 位置 | 对设计的影响 |
|---|---|---|---|
| F1 | `bootstrapDb()` 幂等且对已有库安全：drizzle 版本化迁移（原子）、collation 补丁先查后改、基线授权仅角色无授权行时写入（不覆盖管理员调整）、默认设置只补缺、内置主题包只补缺 + 条件升级；**但它假定库已存在，不 CREATE DATABASE** | `packages/db/src/bootstrap.ts:53-85,107-239`；幂等性测试 `bootstrap.int.test.ts:171,428` | 安装管线 = 建库（CREATE DATABASE IF NOT EXISTS，**绝不 DROP**）→ 复用 bootstrapDb → 设置 → 管理员 → 锁；每步可重入，中断后重跑收敛 |
| F2 | **零数据死路**：默认 `register.mode={invite}` → 注册必填邀请码 → 邀请码只能 admin 在 `/admin/invites` 生成 → 无用户无 admin 死路。`registerUser` 不写 `user_roles`；`assignUserRole` 需要已存在的 admin actor（写审计 + 事件 + 锁不变量） | `packages/db/src/seed-data.ts:552-555`；`apps/web/src/lib/auth/register.ts:58-98`；`lib/authz/admin.ts:380-444` | 首管理员必须由安装管线直接创建：`registerUser`（复用：users/profiles/stats + argon2id）+ 同事务插 `user_roles {roleKey:"admin", scopeId:0}` + 审计；评估器 `held.has("admin")` 即放行（`lib/authz/evaluator.ts:121`） |
| F3 | `install.lock` 全仓无先例；无文件锁先例（调度器互斥用 MySQL 命名锁）；STORAGE_DIR 是应用唯一磁盘根，fs 侧有 `mkdir recursive` 先例；E2E 每轮清空专用 STORAGE_DIR（清理脚本只允许专用目录） | `lib/chrome/site-chrome.ts` 之外无 lock；`lib/uploads/store.ts:84-86`；`lib/brand/brand-pool-fs.ts:72`；`scripts/e2e-storage-utils.mjs` | 锁放 `STORAGE_DIR/install.lock`（D1）：部署平移锁随数据走，E2E 天然「未安装」起点；读取异常按「已安装」（fail-closed，保护已装站点） |
| F4 | 「空库可访问」的可行基线 = **bootstrap 之后**：零表时 `bannerAnnouncement` 无 try/catch 会 500；首页/搜索已有 EmptyState，**/boards 空库无空态引导**；`EmptyState` 是全站约定（组件注释明令禁止手写灰字） | `lib/chrome/site-chrome.ts:133-152`；`app/page.tsx:179-191`；`app/search/page.tsx:79-95`；`components/empty-state.tsx:5-8` | 向导/CLI 先建表再谈站点可达；Step 4 补 /boards 空态；文档写明不承诺「零表」状态 |
| F5 | bootstrap 默认设置只有旧键 `register.mode={invite}`（共 6 键），无 `register.policy` / `site.identity` / `site.theme`；`resolveRegisterPolicy` 新键优先、旧键映射（已验证）；站点身份常量回退 `SITE_NAME/SITE_TAGLINE/APP_URL` | `packages/db/src/authz-vocab.ts:182-189`；`lib/auth/register-policy.ts:49-64`；`lib/site.ts:1-8` | 向导直接写新键 `register.policy`（取代旧键语义）；`site.identity` / `site.theme` 经 `setSettings` 同事务审计写入（现成函数 `lib/auth/settings.ts:93-133`） |
| F6 | 守卫先例：`dev-only-guard.test.ts` 静态扫描 `/api/dev/**` 与 `/design/**` 全部入口必须调用守卫，数量对不上即红；`defineAction` 的 `ActionAuth = "guest" \| "user" \| "password" \| { admin }`，无自定义守卫槽位 | `src/lib/dev-only-guard.test.ts`；`lib/actions/define-action.ts:31` | /install 复刻为 `install-entry-guard.test.ts`（页面首个 await + 每个 Action/Route 必须先查 lock，含变异自证）；Action 用 `auth:"guest"` + run 首行 `requireNotInstalled()` |
| F7 | `proxy.ts` 作用于 /install：畸形 URL 门正常；强制换密门只豁免 `/login` 与 `/settings/password`（向导是 guest 场景无该 cookie，不豁免）；安全响应头（含 CSP form-action 'self'）已覆盖 /install | `src/proxy.ts:34-49`；`lib/security-headers.ts:56-80` | 无需改 proxy；拒绝形式 404（D2）与 dev-only 的 `notFound()` 写法一致 |
| F8 | 审计写 `audit_log` 的 `writeAudit` / `CLI_ACTOR` 在 web 侧；server-only 脚本须经 package script 预加载 `server-only-register.mjs`（现成清单 7 个脚本）；`db:bootstrap` 幂等可复用 | `lib/audit.ts`；`apps/web/package.json:18-25`；`scripts/server-only-register.mjs:1-13` | 安装管线放 `apps/web/src/lib/install/`；CLI = `apps/web/scripts/install.ts` + script `install:cli`（预加载钩子），与向导共用同一状态机 |
| F9 | E2E 管线总是 seed+fixtures，无从空库起步的先例；`e2e-safety.ts` 只允许重置 `qysub_next_e2e` 且仅 loopback；STORAGE_DIR 清理脚本只允许专用目录；CI 的 mysql+mailpit 服务容器齐备 | `packages/db/src/e2e-safety.ts:1-17`；`scripts/e2e-storage-utils.mjs`；`.github/workflows/ci.yml:77-127` | 向导 E2E：专用配置（端口 3203、`NEXT_DIST_DIR=.next-e2e-install-prod`、专用 STORAGE_DIR ×2）；库复用 `qysub_next_e2e` 重置为空后**不 bootstrap 不 seed**；CLI 路径用第二库 `qysub_next_install_cli`（建库走管线的 IF NOT EXISTS，不经 e2e-reset）；CI e2e 作业追加步骤 |
| F10 | 文档现状：README 无部署章节、无 env 必填表；`npm run db:bootstrap`（README L88）、M12 旧文档门禁行 `npm run verify:all`、M13 文档 L31 `npm run verify`（无此脚本）三处 npm 勘误；compose 带 `${NEW_DB_PASSWORD:?}` 但 README 命令未带 `--env-file`（照做报错）；「从 phpwind 导入」无面向站长的独立文档 | `README.md:88`；`M13-launch.md:31`；`docker/qysub-next/compose.yaml:16`；migration/ 无 README | Step 6 收口：README「零数据部署」章节（env 必填表 + `--env-file` 勘误）、三处 npm→pnpm、新建 `migration/README.md`（完成页链接落点） |
| F11 | 生产 DB 用户可能无建库权限（CREATE 需要 CREATE 权限）；`MIGRATION_FORCE` 只属于 migration 包（旧库导入），与 bootstrap 无关 | `migration/src/db.ts:184-201` | create-db 步失败时提示「请手动建库后重试」；IF NOT EXISTS 语义下重跑收敛 |
| F12 | `db:verify` 现为 21 项对账，零数据安装后可直接跑（无任何依赖演示数据的检查）；`db:seed` 生产守卫拒绝在含非演示用户的库上跑 | `packages/db/scripts/verify.ts:313`；`packages/db/src/seed-guard.ts:27-35` | 安装完成的核对清单 = `db:verify`（必）+ `db:recount`（建议）；seed 明确标注「仅开发」 |
| F13 | 登录页 `?message=` 绿条参数现成（注册待验证等已在用）；`AuthShell` 渲染 error/message；`registerUser` 的密码哈希与校验规则现成 | `app/(auth)/login/page.tsx:9-14`；`app/actions/auth.ts:296-299` | 安装完成跳 `/login?message=<文案>`；管理员密码强度复用注册口径 |

## 3. 与「读侧覆盖」的本质差异（为什么安装是状态机而不是普通页面）

安装是**有状态、有副作用、一次性**的写流程：建库 / 建表 / 写设置 / 建管理员都会落库落盘，且发生在「站点尚无任何
防护身份」的窗口期。因此：① 每步必须幂等可重入（中断后重跑收敛，不留半成品——F1 的 bootstrap 语义直接复用）；
② 双重防呆——lock 404 之外，**设置与管理员步骤仅当 `users` 表为空**才执行（lock 意外丢失的活跃站点也无法被改写）；
③ 全部动作写审计（`install.*`，via="install"），可回答「这套站点是谁在何时装的」。

## 4. 范围与 Step 分解

> 分支 `feat/m12-install-wizard`；Step 编号沿用规划；每步门禁→提交→汇报→站长确认后推进。

**Step A · 文档先行**：重写本文件（§2 核实事实、§6 决策、§4 分解、§7/§8 测试与门禁、§9 执行记录）；ROADMAP 同步。只改文档。

**Step 1 · 安装管线核心**：`apps/web/src/lib/install/`——
- `lock.ts`：`isInstalled()`（读 `STORAGE_DIR/install.lock`，异常=已安装）、`writeInstallLock()`、CLI 专用 `removeInstallLock()`。
- `schema.ts`：安装配置 zod strict（DB 五项默认读 `NEW_DB_*` env；站名/描述/站点 URL；默认主题 default|qy2010；
  注册模式 open(+verifyEmail) | invite | closed；管理员 用户名/邮箱/密码，强度同注册）。
- `run-install.ts`：幂等状态机 `runInstallStep(step, config)`——`connection` → `create-db`（IF NOT EXISTS，权限不足报
  「手动建库后重试」）→ `bootstrap`（bootstrapDb）→ `site-settings`（`setSettings`：register.policy / site.identity /
  site.theme；**仅当 users 表为空**）→ `admin`（`registerUser` + 同事务插 admin 角色行 + 审计；**仅当 users 表为空**；
  不要求邮箱验证 D3）→ `lock`（写文件 + 审计）。审计动作 `install.*`（via="install"）。
- `requireNotInstalled()`（404 语义）供页面与 Action 共用；packages/db 公开导出按需补齐。
- 单测（lock fail 方向、状态机幂等重入、schema 校验、错误码）≥90%；真实 MySQL 集成（全流程、重复幂等、
  users 非空拒绝、向导写设置后 `getRegisterPolicy` 生效、lock 后拒绝）。

**Step 2 · CLI**：`apps/web/scripts/install.ts` + script `install:cli`（预加载 server-only-register）；env/参数驱动非交互；
`--unlock` 交互确认；SIGKILL 中断恢复集成测试（子进程中途杀 → 重跑收敛）。

**Step 3 · 向导 UI**：`app/install/` 四步（`?step=`）：1 环境自检（Node ≥24、STORAGE_DIR 可写探针、DB 表单预填 env）→
2 站点设置 → 3 管理员 → 4 完成（跳登录按钮、导入指引链接、部署检查清单链接）。每步 Server Action
（`auth:"guest"` + run 首行 `requireNotInstalled`）；页面首个 await 即 lock 检查；失败草稿保留（G-19）；
`install-entry-guard.test.ts` 静态扫描全部入口（含变异自证）；新错误码与文案成对（G-15 类型表）。

**Step 4 · 空态与指引**：/boards 空库 `EmptyState`（按登录态给主行动）；完成页链接落点 `migration/README.md`
（面向站长：前置、命令、对账、红线）；empty-pages 单测补用例。

**Step 5 · E2E 与 CI**：`playwright.install.config.ts`（3203 / `.next-e2e-install-prod` / STORAGE_DIR=`storage-e2e-install`）；
`e2e-install/install-wizard.spec.ts`（串行）：向导全流程 → 空态首页 /boards → admin 登录 → 建首个版块 + 发帖 →
`/install` 404 + lock 存在 → CLI 路径（第二库 `qysub_next_install_cli` + 第二 STORAGE_DIR，`install:cli` 非交互 +
起服务断言 + `--unlock` 重装语义）→ 中断恢复（CLI 子进程 SIGKILL 后重跑收敛）。
根编排 `pnpm test:e2e:install`；prepare-e2e-storage 允许清单扩两个专用目录；ci.yml e2e 作业追加；
布局矩阵加 /install 表单场景（六档，M9.5 契约）。

**Step 6 · 文档收口**：README「零数据部署」章节（env 必填/可选表、`--env-file` 勘误、步骤、SCHEDULED-JOBS 与
导入指引链接）+ 三处 npm→pnpm 勘误 + CHANGELOG + 本文件收口 + ROADMAP；里程碑门禁（§8）→ AI 读图目视 →
站长验收 → PR 合并 main。

## 5. 边界（明确不做什么）

- 不做 Docker 官方镜像发布 / 应用市场分发（M13 只做自部署 compose）。
- 不做多站点 / SaaS 化。
- 不做「导入预演 / 差异预览」等迁移增强（migration/ 已有能力为准）；**向导内不实现导入本体**，完成页只给指引。
- 不做 nginx / 301 / 备份 / 可观测（M13）；安装自检只提示 `TRUSTED_PROXY_HOPS` 必填语义，不验证反代。
- 不承诺「零表」状态可访问（基线 = bootstrap 之后，§2 F4）；`db:seed` 演示数据明确标注仅开发。

## 6. 决策记录

### 6.1 已拍板（站长 2026-11-07，随规划审批确认）

- **D1 安装锁** ✅ 文件 `STORAGE_DIR/install.lock`；读取异常按「已安装」（fail-closed，保护已装站点）。
- **D2 拒绝形式** ✅ lock 存在后 `/install` 全路由 **404**（与「越权一律 404」哲学一致）；重装须 CLI `--unlock` 交互确认。
- **D3 首管理员** ✅ 向导创建即立即可登录（不要求邮箱验证——安装时 SMTP 可能未配；事后可用 M11.3 免登录重发补验证）。
- **D4 既有约定沿用** ✅（探查确认，直接作为设计约束）：EmptyState 全站约定、G-15/G-16/G-19、M9.5 后台表单契约、
  server-only 脚本预加载纪律、install-entry-guard 静态守卫（仿 dev-only-guard）。
- **管线放 web 侧** ✅（规划确认）：审计 `writeAudit` 与 `CLI_ACTOR` 在 web 侧（F8），管线与 CLI 同源；
  packages/db 只补公开导出，不反向依赖 web。

### 6.2 待确认

无。

## 7. 测试规则（2026-11-07 版）

- **单测（lib/install，覆盖率 ≥90%）**：lock 读写与 fail 方向（异常=已安装）、状态机每步幂等重入、配置 schema
  （strict / 非法值 / env 默认）、管理员创建（角色行 / 审计 / users 空表前置）、错误码清单、install-entry-guard
  （含变异自证：去掉页面 lock 检查 → 红）、G-15 文案成对表。
- **集成（真实临时 MySQL）**：runInstallStep 全流程（空库 → 可登录管理员 → lock）；重复全流程幂等（断言
  users/audit/设置不重复）；users 非空时设置与管理员步骤拒绝；向导写的 `register.policy` 经 `getRegisterPolicy`
  读出生效；lock 后 `requireNotInstalled` 404；bootstrap 产物 `db:verify` 直接可跑（F12）。
- **E2E（新 spec，G-16 每条业务线含错误路径）**：向导全流程（错误路径：错误 DB 口令连接被拒且表单保留）；
  空态首页 /boards 引导；admin 登录建版块发帖；防重装（404 + lock 文件存在）；CLI 双路径同一管线断言；
  `--unlock` 重装语义；SIGKILL 中断恢复。
- **回归**：既有 E2E / 单测断言不改且全过（安装是纯新增；settings/site-chrome/auth 不改行为）。

## 8. 门禁标准（2026-11-07 版）

| 层级 | 标准 |
|---|---|
| Step 门禁（1–5） | `pnpm verify:all` 退出码 0；本步新增用例全过；回归断言零改动 |
| Step 5 起 | `pnpm test:e2e:install` 全绿 |
| 里程碑收口 | `pnpm verify:all`；`pnpm test:e2e` 全量；`pnpm test:e2e:install`；`pnpm test:visual` 全过且基线零更新；`pnpm test:layout` + `pnpm layout:summary` 退出码 0（含 /install 场景）；生产站点 `pnpm pwa:lighthouse` 100/100；`pnpm perf:posting` p95 < 300ms；PR 的 CI `verify` 与 `e2e` 均 success；目视验收（AI 代做六档切块 + 对比度计算，站长复核） |
| 分支纪律 | `feat/m12-install-wizard` → PR → CI 双作业通过后合并 main；不 force push；不触碰开发库 `qysub_next` |
| 执行规则 | 以真实命令输出为准，验证命令不套管道；失败先定位，疑似偶发单独复跑并如实报告两次结果；守卫测试（architecture / server-only / no-direct-points-write / admin-entry / install-entry / use-server-exports）保持全绿；每步把命令、通过数、退出码、提交号记入 §9 |

## 9. 执行记录

- [x] Step A 文档先行（2026-11-07）：§2 核实事实 F1–F13、§6 决策 D1–D4、§4 分解、§7/§8 门禁、验收门禁重写；
      ROADMAP 同步；`pnpm format:check`、`pnpm check:secrets` 通过（退出码均 0）。
- [ ] Step 1 安装管线核心：
- [ ] Step 2 CLI：
- [ ] Step 3 向导 UI：
- [ ] Step 4 空态与指引：
- [ ] Step 5 E2E 与 CI：
- [ ] Step 6 文档收口：

## 验收门禁

- [ ] 空库 → 向导 → 可用站点 E2E 全绿（向导与 CLI 双路径，同一管线断言）
- [ ] install.lock 防重装（404）+ `--unlock` 显式重装语义验证通过
- [ ] 中断恢复用例通过（SIGKILL 后重跑收敛，无半成品）
- [ ] 零数据空态走查：首页、/boards、搜索、管理后台全页面无异常（E2E + 布局矩阵六档含 /install 场景）
- [ ] README「零数据部署」章节可照做（env 必填表 + `--env-file` 勘误）；migration/README.md 入口可达
- [ ] `lib/install` 单测覆盖率 ≥90%；每个错误码有页面专门提示（G-15 类型守卫）
- [ ] `pnpm verify:all` 全绿；CHANGELOG 记录；§8 里程碑收口门禁全部通过并回写 §9
- [ ] 文档：本文件状态改 ✅；ROADMAP / CHANGELOG / README / migration/README 同步
- [ ] 目视验收（AI 代做六档切块 + 对比度计算，站长复核）
- [ ] 经 PR 合并 main，CI 双绿，未强推，开发库 `qysub_next` 未触碰

## 遗留事项

（收口时回写。已知候选：`ACCOUNT_DELETION_BATCH_SIZE` / `NEXT_PUBLIC_LOGO` 两个运行时变量不在 `.env.example`
（Step 6 顺带补）；`perf:lcp` 与 dev E2E 共用 3200 端口（历史现状，不属本里程碑）。）
