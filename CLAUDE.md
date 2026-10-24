# FunWind · 项目指南

青翼字幕组（QYSUB）论坛重构：抛弃 phpwind 9，全新开发的现代化论坛。旧程序与旧库只作内容源与业务语义参考，**代码零复用**。
全局行为准则见 `~/.claude/CLAUDE.md`（简体中文交互、先列任务清单、改代码前确认、分步执行），本文件在其上叠加。

## 当前阶段

- 阶段一·骨架 M1–M5 已交付，但 2026-10-23 审查发现其数据模型与多项门禁勾选需重做/更正。
  **M5.5 重构（设计先行）已完成，已合并 `main`**。站长思路：**先定目标模型（`docs/DESIGN-MODEL.md`，schema v2.1 共 43 表，含通知中心），旧数据向它靠拢，迁移只是适配层**。
  进度：R1 文档 ✅ → R2 `packages/db` 与 `packages/content` 重做 ✅ → R3 迁移适配层重做并重建开发库 ✅ → S4 应用适配 ✅ → **S5 E2E 与全量门禁 ✅（2026-10-24）**；之后进入 M6 发帖。
- **分支**：M5.5 已合入 `main`（`feat/m5.5-schema-v2` 仅本地保留，不推送）。类型检查 / lint / 单测 / 构建 / E2E 全部真实通过（`pnpm verify:all` 与 `pnpm test:e2e` 均已连续多次实测）。
  2026-10-24 已重写 git 历史（清除口令、真实邮箱、第三方用户名与 `Claude-Session:` 行），随后已把 `main` 推送到 GitHub 公开仓库 `SkyJourney/FunWind`（CI：`.github/workflows/ci.yml`，`verify` + 自包含 `e2e` 两个作业，首轮修复构建产物步骤后全绿）；重写前的完整备份在站长本机 `~/FunWind-pre-rewrite.bundle`（含旧口令，**不得上传**）。
- 开发库：`qysub_next` = v2 **纯导入**（`verify:migration` 110 项对账只对它有意义）；`qysub_next_e2e` = 空库 + 演示种子（`db:seed`，id ≥ 90000）+ E2E 夹具（`db:e2e-fixtures`，id ≥ 950000），**不含迁移数据**（CI 同样如此），`pnpm test:e2e` 每次自动重建它。
- **M5.5 是破坏性重构**：站长已确认任何破坏性变更均可接受（重新迁移即可）。
- 开工前先读：`docs/ROADMAP.md`（里程碑与 DoD）→ 对应 `docs/milestones/Mx-*.md`（范围/边界/测试/门禁）；M5.5 另读 `docs/DESIGN-MODEL.md`（数据模型依据）、`docs/NOTIFICATIONS.md`、`docs/GATES.md`、`docs/POINTS.md`、`docs/AUTHZ.md` §4/§8。
- 新功能落地前查 `docs/LEGACY-FEATURE-MAP.md`（末尾有重构判定表）追溯旧实现语义；模块内核契约看 `docs/MODULES.md`。
- 里程碑文档的门禁勾选**以真实命令输出为准**；M0–M5 复验发现多处勾选与实测不符。

## 技术栈与目录

Next.js 16（App Router/RSC）+ React 19 + TypeScript strict · Tailwind v4 三层设计令牌 · shadcn/ui 模式 ·
Drizzle ORM + MySQL 8.4（utf8mb4）· Vitest + Playwright · pnpm 12 workspace（Node ≥ 24）。

```
apps/web/        Next 应用（src/app 路由、src/lib 纯逻辑与服务、src/modules 模块内核、e2e 用例）
packages/db/     @funwind/db：Drizzle schema 单一事实源 + 版本化迁移 + bootstrap/seed/verify + 权限词汇表
migration/       青翼 phpwind → 新库 的可选导入器（旧库只读）
docs/            蓝图/路线图/里程碑/权限/模块契约/前端设计
docker/          qysub-next（MySQL 8.4 @33621）、dev（web 容器 + MailPit）
```

## 常用命令

```bash
pnpm dev                      # http://127.0.0.1:3100
pnpm verify:all               # lint + format:check + typecheck + test(覆盖率) + build
pnpm test:e2e                 # 重置并重建 qysub_next_e2e（bootstrap + 种子 + E2E 夹具，无迁移）→ dev 服务器 3200 的 E2E（61 项）→ 生产构建冒烟 3201（7 项）；需要 MailPit(8025)；约 40s
pnpm db:bootstrap | db:seed | db:e2e-fixtures | db:verify   # 零数据路径：建表+系统种子 / 演示夹具 / E2E 专用夹具 / schema 对账（12 项）
pnpm --filter @funwind/db test              # db 包单测 + 真实 MySQL 临时库集成测试（SKIP_DB_TESTS=1 可跳过）
pnpm --filter @funwind/web test             # web 单测 + 真实 MySQL 临时库集成测试（同样认 SKIP_DB_TESTS=1）；git push 前由 .husky/pre-push 自动跑类型检查 + 全部测试
pnpm --filter @funwind/content test         # 门控语法 + UBB 转换器 v2（含泄露不变量性质测试）
pnpm migrate | verify:migration             # 青翼导入 v2（幂等）/ 对账 v2；报告写入 docs/reports/（入库）
                                            # 先用临时库演练：NEW_DB_NAME=… 并用 packages/db/scripts/e2e-reset.ts 建空库
pnpm test:e2e:run              # 同上但不启动 MailPit 容器（CI 用：MailPit 由 GitHub Actions 服务容器提供）
pnpm --filter @funwind/web test:e2e:prod                  # 仅生产构建冒烟（真实 next build + next start）
pnpm --filter @funwind/web modules:toggle <id> <on|off>   # 模块启停（写 audit_log）
pnpm --filter @funwind/web perf:lcp                       # 生产构建 LCP 门禁
```

改了 `packages/db` 后，web 依赖的是其 **构建产物**（`dist/`），先 `pnpm db:build`（`dev`/`build`/`migrate` 脚本已自带）。

## 硬约定（违反即回退）

1. **旧库只读**：只允许 SELECT/SHOW/DESC，迁移程序有代码级守卫。迁移是**一次性全量导入**：迁移独占的表整体替换式加载，检测到线上数据会拒绝重跑（`MIGRATION_FORCE=1` 强制）。
2. **只保留 URL 必须稳定的旧主键**（uid/fid/tid/pid）；其余 id 自增。业务表不带 `raw`/`content_raw`，正文只留 `body_md`；
   未被新模型使用的旧表一律丢弃、**不建归档库**；旧库保持只读且在 M13 签字前不得删除（即归档）。
2a. **运行时 schema 不认识旧站**：禁止 `legacy_*` 列、`migrated` 标记、迁移用 id 公式、`migration_*` 表；旧键映射/旧 gid/旧路径只放 `migration/`。
    被引用但已不存在的作者建「已注销用户」占位账号（`state=deleted`），不在内容表加冗余列。`schema-rules.ts` 将加断言（R2）。
3. **垃圾空壳、回收站与屏蔽内容、私信不迁**（旧库即归档）；内容状态机为 `visible|pending|rejected|hidden|deleted`；旧密码不迁移（`password_hash=NULL`，走邮件认领/重置）。
3a. **唯一键不得依赖 NULL 去重来表达作用域/层级**：全局作用域用 `scope_id = 0` 哨兵（MySQL 唯一索引不去重 NULL）。
    唯一例外：单列且「空值 = 没有」即期望语义（`users.email_key`）。由 `packages/db/src/schema-rules.ts` 断言，`db:verify` 与单测强制。
3b. **隐藏内容只能经 `getGateContent` 读取**；`body_md` 永远只含公开部分（门控规范见 `docs/GATES.md`）。
3c. **积分变动只能经 `applyPoints`**，渠道须先注册（`docs/POINTS.md`）。
3d. **附件表只能经 `lib/gates/attachments.ts` 读写**：`attachments.gate_id` 非空的附件与门控隐藏正文同权，锁定项不得下发文件名 / 存储键 / 大小；`/files` 与帖子页共用同一出口（`docs/ATTACHMENT-GATES.md`，守卫测试 `attachments-guard.test.ts`）。
4. **时区**：库内 DATETIME 一律北京墙面时间；连接层 `+08:00` + `dateStrings`，**且每条新连接必须 `SET time_zone='+08:00'`**（mysql2 的 `timezone` 选项不改服务器会话时区，`NOW()` 会是容器的 UTC；`createPool` 已处理，任何绕过它的裸连接须自行设置；`db:verify` 与 `client.int.test.ts` 守护）；解析只走 `lib/datetime.ts`，禁止裸 `new Date(字符串)`。
5. **DB 连接**：web 运行时只用 `getWebDb()` 单例；`withDb` 仅限一次性脚本。
6. **渲染**：用户内容必须经 `lib/markdown.ts` + `lib/sanitize.ts` 管线，禁止 `dangerouslySetInnerHTML` 直出原文。
7. **权限**：一律走 `lib/authz` 的 `checkPermission`；越权对外表现为 **404**（不暴露存在性）；不允许硬编码身份判断。
8. **URL 已冻结**：`/f/{fid}`、`/t/{tid}`、`?page=`、`#p{pid}`（M13 的 301 依赖）。文件统一走 `/files/<storage_key>`（已取代 `/attachment/**`，S4-4 落地）；表情为 `/emoji/{id}.gif`。
9. **模块**：扩事件/槽位 = 改 `modules/kernel/types.ts` + 同步 `docs/MODULES.md`；使用内核的 route handler 必须自行 `import "@/modules"`。
10. **schema 变更**：改 `packages/db/src/schema.ts` → `drizzle-kit generate` → 提交迁移 SQL → `db:verify` 通过；迁移程序与应用共用同一管线。
11. **数据层双模式**：零数据部署是默认路径，青翼导入只是可选路径，应用代码不得依赖旧库。

## 架构要点

- **模块内核**（`src/modules/kernel`）：编译期注册（无热插拔）+ 同步事件总线（逐消费者隔离、落 `event_log`）+ UI 槽位；启停状态在 `module_state`。
- **认证**（`lib/auth`）：不透明令牌 cookie，库内只存 SHA-256；argon2id；登录轮换会话；邮件令牌 reset/verify/claim 单次原子消费；`register.mode = invite|open`。
- **权限**（`lib/authz` + `packages/db/src/authz-vocab.ts`）：`roles` / `permissions` / `role_grants` / `user_roles` 四表；
  `forum.read` **就近层显式优先**（不回退父级），`forum.write/manage` **沿父链级联合并**；版主由授权派生，不指派。
- **邮件**：nodemailer，开发期 MailPit（SMTP 1025 / UI 8025）。
- **权限/可见性**（`lib/authz` + `lib/queries/visibility.ts`）：评估器是纯函数（显式 `Subject`，零 SQL）；版块树与授权表常驻内存快照（管理动作后 `invalidateAuthzSnapshot()`）；
  查询层用 `readableForumIds`/`moderatedForumIds` 在**取数前**过滤，不取出来再逐行判断。
- **积分与门控的并发约定**（`lib/points`、`lib/gates`，教训来自真实复现的死锁/连接池饥饿）：① 事务内不得再借第二条连接（连接池仅 8 条）——渠道解析、权限检查等一律在开事务前完成；
  ② 加锁顺序固定「门控行 → 账户行（user_id 升序）」；③ 账户行用 `SELECT … FOR UPDATE` 加锁（不存在才 `INSERT IGNORE`），**禁止**用 `INSERT … ON DUPLICATE KEY UPDATE` 当加锁手段（共享锁升级死锁）；
  ④ 先拿账户锁再查幂等/已解锁。积分表只能经 `lib/points` 写，隐藏正文只能经 `lib/gates/service.ts` 读，附件表只能经 `lib/gates/attachments.ts` 读写，均有守卫测试。

## 已知坑

- **E2E 写法**：用例以 `e2e/support/session.ts` 的 `loginAs()` 直接往库里写会话并注入 cookie，**不要在多个用例里走界面登录**——登录有账号级频控（每账号 10 分钟 5 次），共用账号会互相挤爆；界面登录只在 `auth.spec` 与 `modules.spec` 各测一次。
  E2E 用例**不得引用真实迁移数据**（fid/tid 写死会让 CI 变红）：稳定场景用 `support/fixtures.ts`（镜像 `packages/db/src/e2e-fixtures.ts`，两处同步）；
  用例要的临时数据用 `support/db.ts` 的 `withE2eDb()` 直连 e2e 库自己造、自己收尾（Playwright 以 CJS 加载，不能直接 import 纯 ESM 的 `@funwind/db`）；写 SQL 时 **`?` 占位符不能放在引号里**（mysql2 不替换字符串字面量中的 `?`）。
- `pnpm test` 必须串行跑各包（`--workspace-concurrency=1`）：并行时 content 与 db 的 vitest 会同时清理共享的 `node_modules/.vitest-cache`，间歇性 `ENOTEMPTY`。

- Next 16 开发服务器需 `allowedDevOrigins: ["127.0.0.1"]`，否则页面可渲染但整页无交互（水合静默失败）。
- Next 16.4.2 的 `title.template` 对子页字符串标题疑似未生效（M1 遗留，升级后复验）。
- E2E 必须用独立库与 3200 端口，别和 dev 服务抢端口。
- zsh 下 `grep --include=*.ts` 要加引号，否则报 `no matches found`。
- 频控与权限快照都是进程内存实现（单实例语义），多实例前须换 Redis / 共享失效通道（M13）。
- `TRUSTED_PROXY_HOPS`：生产环境必须显式设置（直连填 0，nginx 之后填层数），漏配会在首次取 IP 时报错；取不到可信 IP 时跳过 IP 级限额，只留账号/邮箱级。
- `next dev` 每次启动会生成 `apps/web/AGENTS.md`（已 `.gitignore`）；`.next/` 里过期的生成类型会让 `tsc` 报已删除路由，用 `pnpm --filter @funwind/web exec next typegen` 刷新。
- 迁移与对账的临时库演练：`NEW_DB_NAME=… pnpm --filter @funwind/db exec tsx scripts/e2e-reset.ts` 建空库再 `pnpm migrate`；`STORAGE_DIR` 可指向临时目录避免污染 `storage/`。

## M0–M5 审查缺口的处置状态（2026-10-23 审查 → M5.5 修复）

全部在 `feat/m5.5-schema-v2` 上修复并带回归用例；括号内为提交。**安全事项已处置，见最后一条。**

- ✅ **P0** 首页目录/最新动态泄露受限版块、`is_listed=0` 进聚合 —— 可见性在取数前翻译成 SQL 谓词（S4-3 `eb32c3f`），游客在真实数据上 4 个受限版块全 404、标题/计数/置顶均无泄露。
- ✅ **P0（数据）** 权限翻译不幂等、脏键 —— R3 迁移重写（`user_roles`/`role_grants` 由旧数据整体推导，`verify:migration` 零容忍断言）。
- ✅ **P0（数据）** 门控内容变公开 —— R2/R3 转换器重写 + 门控读取唯一出口（S4-4 `bba315b`，守卫测试禁止别处引用 `hidden_md`）。
- ✅ **P1** 覆盖率门槛为红 —— S4-6：去掉对 queries/session/tokens/settings/state 的整块排除，仅余 `slot.tsx`、`mailer.ts` 两个有明文原因的宿主壳，门槛未降（实测 96.9/91.5/96.5/98.2 vs 90/85/90/90）。
- ✅ **P1** `/admin` 动作未写审计 —— 授权管理（S4-2 `f69427a`）、模块启停与站点设置（S4-6）均同事务写 `audit_log`。
- ✅ **P1** 开放注册邮箱未验证限制、派生版主误用 `forum.write` —— S4-2（评估器写类权限拦截；版主=持有 `forum.moderate`）。
- ✅ **P1** 频控信任 `x-forwarded-for`、`checkPermission(userId)` 忽略入参、注册 `MAX(id)+1` 竞态与邀请码先核销 —— S4-2（`TRUSTED_PROXY_HOPS`、显式 `Subject`、自增 id + 同事务核销）及两次安全补丁（`6741138`、`8cc53ae`）。
- ✅ **P2** `createCustomRole` 可改写内置角色、grant/revoke 不校验 —— S4-2。`/api/dev/*` 与 `/design` 生产可达 —— S4-6：统一守卫 `lib/dev-only.ts` + 守卫测试，生产构建实测 404。`tsconfig.tsbuildinfo` 误入库 —— S4-6 出库并加入 `.gitignore`。
- ✅ **安全事项**：2026-10-24 已重写历史，口令 / 真实邮箱 / 第三方用户名在全部提交（808 个 blob）中命中为 0；口令只放根 `.env`，`pnpm check:secrets` 在 pre-push 与 CI 拦截回流。站长决定**不轮换**旧库口令（旧库仅本机只读使用）。

## 工作流

1. 领取里程碑 → 严守其「范围/边界」；完成定义（DoD）= 门禁 checklist 全勾 + CHANGELOG + 相关文档同步 + 遗留事项记录。
2. 门禁以真实命令输出为准，不凭文档勾选；测试规则见 `docs/ROADMAP.md`「全局测试基线」。
3. 代码注释一律简体中文（类/方法/复杂逻辑），标识符保持英文。
4. 本地开发凭据只放根 `.env`（已 gitignore；模板见 `.env.example`），README 里只有变量名；**不要把口令写进文档或提交**，`pnpm check:secrets`（pre-push / CI 自动跑）会拦截。
