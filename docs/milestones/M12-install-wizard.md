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
- [x] Step 1 安装管线核心（2026-11-07）：
  - packages/db：`bootstrap.ts` 新增 `pingDatabase`（连接测试）与 `createDatabaseIfNotExists`
    （IF NOT EXISTS，绝不 DROP；库名由安装 schema 白名单校验后拼接），随 `export *` 自动公开。
  - `lib/audit.ts`：`via` 联合类型加 `"install"` + `INSTALL_ACTOR` 常量。
  - `apps/web/src/lib/install/`：`lock.ts`（isInstalled/writeInstallLock/removeInstallLock，异常 fail-closed 按
    已安装）、`schema.ts`（zod strict + 语义校验 checkUsername/isValidEmail/密码 ≥8 + db 与运行实例 env 一致性，
    问题按字段返回中文说明）、`run-install.ts`（六步幂等状态机：connection/create-db/bootstrap/
    site-settings/admin/lock；双重防呆 lock + users 空表；崩溃窗口自愈——唯一目标用户缺角色行时补齐；
    密码 argon2id 与注册同口径、首管理员免验证 D3、审计 install.admin/locked）、`guard.ts`
    （requireNotInstalled → 404）。
  - 测试：单测 lock（fail 方向含目录占位）+ schema（白名单/语义/env 默认/哨兵）+ guard（mock notFound）；
    真实 MySQL 集成 9 项——从「只建库不 bootstrap」的空库走全流程、重复幂等、三模式策略键值经
    `getRegisterPolicy` 读出生效、崩溃窗口自愈、防重装（users 非空双重拒绝 + 陌生用户不带角色）、
    lock 后全步骤拒绝。
  - 门禁实测：`pnpm verify:all` 退出码 0（web 3886 + db/content 278）；lib/install 覆盖率
    语句 94.16 / 行 97.16 / 函数 100 / 分支 85.93（≥90 承诺达成）；重复棘轮低于基线。
  - 过程更正：①集成用例首版把「站长」当用户名——它是保留字（防冒充），改 inst_admin；
    ②bootstrap 步骤在全量并发压库时超过 5 秒默认单测超时（temp-db 系用例靠 beforeAll 30 秒钩子躲过），
    重用例加显式 timeout；③覆盖率在「只跑子集」时会因其他目录 0% 报错，属运行方式假象，
    以 verify:all 全量聚合为准。
- [x] Step 2 CLI（2026-11-07）：
  - `scripts/install.mts`（.mts：顶层 await，CJS 包内 tsx 必需——首版 .ts 直接报错，改名解决）+
    apps/web 与根的 `install:cli` script（预加载 server-only-register）。env/参数驱动非交互
    （--site-name/--site-tagline/--site-url/--theme/--registration[--verify-email]/--admin-*）；
    失败按字段打印问题清单退出 1；`--unlock` TTY 交互确认（`--yes` 供自动化）；连接池显式 end + process.exit。
  - **语义更正**：site-settings 与 admin 共用 `installTargetGuard`——users 空放行；唯一用户恰为目标
    管理员 → 放行（--unlock 重装的收敛路径）；他人/多用户拒绝。更正前 --unlock 重装在「建用户后崩溃」
    窗口永远无法收敛（settings 先于 admin 被 users 非空挡下），与「--unlock 后可重装」矛盾；
    换管理员的重装被拒（替换管理员走后台），测试如实断言该语义。
  - 测试（cli.int.test.ts，真实 spawn 子进程 ×5）：配置缺失按字段报错；SIGKILL 中断恢复
    （等「开始 step=admin」杀进程 → 重跑收敛）；已安装直接运行提示 --unlock；同管理员重装收敛；
    换管理员重装被拒且旧管理员不动；lock 读写对 CLI 显式 env 生效。
  - 门禁实测：`pnpm verify:all` 退出码 0（web 3891 + db/content 278）；lib/install 覆盖率
    语句 94.53 / 行 97.29。
- [x] Step 3 向导 UI（2026-11-07）：
  - `app/install/page.tsx`（`?step=` 四步 + 进度推导自 DB 状态）、`actions.ts`（三个 Server Action，
    `auth:"guest"` + run 首行入口守卫；input 全字符串，语义校验在 run 里走切片 validator 并 failTo 回显）、
    `draft.ts`（G-19 失败草稿，decode 全程不可信：长度/类型/形状过滤）。
  - `lib/install/progress.ts`：进度从 DB 状态推导（表可查=建库完成 / register.policy 存在=设置完成 /
    users 非空=管理员完成），不另存状态机表——重启与换实例读到同一份事实；`nodeVersionOk`（≥24）、
    `storageWritable`（写删探针）、`stepOfProgress`。
  - `install-entry-guard.test.ts` 静态守卫：页面首个 await + 每个 Action 首行都必须调用入口守卫
    （数量精确对上；注释按 CLAUDE.md 已知坑改写措辞避免文本误计）；**变异自证**：删除一个 Action 的
    守卫调用 → 红，还原 → 绿。
  - 测试：page.test（G-15 六码专门文案 + 兜底对照、四步渲染、草稿回显含字段级问题、进度推导）； 
    schema.test 迁移到切片校验（validateInstallConfig 保留为切片组合，CLI 继续使用）。
  - 门禁实测：`pnpm verify:all` 退出码 0（web 3911 + db/content 278）；lib/install 覆盖率
    语句 93.14 / 行 95.36（首次跑出 78 后补 progress 单测与 int 断言拉回，lint 的未用导入清理）。
- [x] Step 4 空态与指引（2026-11-07）：
  - /boards 空库（forumCount=0）改走 `EmptyState` 三要素（替换 M9.5 清账记录里的手写灰字违例）：
    管理员主行动「进后台创建第一个版块」；访客按注册策略给「注册账号」（开放/邀请均可注册）或退化为「登录」；
    计数行保持「0 个板块 · 0 个主题」。非空路径渲染不变。
  - 完成页链接落点：新建 `migration/README.md`（面向站长的导入指南：前置、演练/正式/对账步骤、
    管理员由旧 gid 3/4/5 推导的说明、红线与回滚；完成页与 README 将链接此文档）。
  - 测试：`boards-empty.test.tsx` 4 项（管理员/注册开放/注册关闭/非空对照）。
  - 门禁实测：`pnpm verify:all` 退出码 0（web 3915 + db/content 278）。
- [x] Step 5 E2E 与 CI（2026-11-07）：
  - 配置：`playwright.install.config.ts`（端口 3203、`.next-e2e-install-prod`、`STORAGE_DIR=storage-e2e-install`、
    就绪探针指向 `/install?step=1`——零表库上首页 feed 会 500，向导页自带韧性）；`e2e-install/install-wizard.spec.ts`
    4 用例（串行）；根编排 `pnpm test:e2e:install`；`scripts/prepare-install-storage.mjs`（只允许清两个专用目录）；
    `packages/db` 新增 `assertInstallCliResetTarget` + `scripts/install-cli-reset.ts`（第二库 `qysub_next_install_cli`，
    同款写死库名 + loopback 护栏）；ci.yml e2e 作业追加安装向导步骤；布局矩阵加 /install 场景
    （**仅布局矩阵运行**——`LAYOUT_SPEC`/`RUN_LAYOUT_SCREENSHOTS` 开关限定，主 E2E 的 seed 库 + 无 lock 存储
    不满足其期望）。
  - E2E 用例：①错误路径（口令与 env 不一致 → invalid-config 字段级提示 + 草稿保留 + 不落库）②向导全流程
    （空库 → 建库建表 → 站点设置 → 管理员 → 完成跳登录 → lock 404 → DB 断言 admin 角色/免验证/策略三布尔）→
    零数据空态（首页无主题、/boards 访客「注册账号」引导）③管理员登录建首个版块发第一帖 → 目录脱离空态
    ④CLI 路径（SIGKILL 中断恢复 → 收敛 → 防重装 → unlock 同管理员收敛 → 换管理员拒绝 → 恢复锁）。
  - 实施中修掉的三个真问题（E2E 的价值所在）：
    ① **`bannerAnnouncement` 零表无兜底** → webServer 就绪探针永远超时（根布局 500）；加固为 try/catch 回无横幅。
    ② **`getRegisterPolicy` 零表无兜底** → Server Action 里 `getSubject` 直接抛错进错误边界；加固为
    fail-closed 回邀请制并告警（读不到 = 不放开注册）。
    ③ **动作输入 schema 两处坑**：嵌套结构不被 `formDataToObject` 支持（扁平键）→ 改扁平；
    `.strict()` 把 Next 注入的 `$ACTION_ID_*` 判成未知键 → 404 → 去 strict（语义校验本就在 run 里）。
    另：完成跳转从「回向导第 4 步」改为「跳登录页带完成提示」——lock 落盘后向导对自身也 404；
    Server Action 的 redirect 走响应头，中文 message 必须 encodeURIComponent（同 auth.ts 先例）；
    /install 页面补 `<main>` 根（布局审计找不到可见 main 而误报 missing-root，无障碍上也应如此）。
  - 工具链收口：`.next-e2e-install-prod/` 与 `.next-review-layout/` 补进 eslint ignore 与 .prettierignore
    （新 distDir 的两处既有清单都要同步，与 CLAUDE.md tsconfig 行为并列）。
  - 门禁实测：`pnpm test:e2e:install` 退出码 0（4/4）；`pnpm test:layout` + `pnpm layout:summary` 退出码 0
    （6 份审计 0 问题，六档含 /install）；`pnpm test:e2e` 全量退出码 0（440 + 8，回归断言零改动）；
    `pnpm verify:all` 退出码 0（web 3915 + db/content 278）。
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
