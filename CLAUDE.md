# FunWind · 项目指南

青翼字幕组（QYSUB）论坛重构：抛弃 phpwind 9，全新开发的现代化论坛。旧程序与旧库只作内容源与业务语义参考，**代码零复用**。
全局行为准则见 `~/.claude/CLAUDE.md`（简体中文交互、先列任务清单、改代码前确认、分步执行），本文件在其上叠加。

## 当前阶段

- 阶段一·骨架 M1–M5 已交付，但 2026-10-23 审查发现其数据模型与多项门禁勾选需重做/更正。
  **当前里程碑：M5.5 重构（数据模型 v2 + 迁移 v2 + 缺陷清账）**，S1 设计 ✅、S2 schema v2 ✅（packages/db）、**S3-A `packages/content` ✅**，**S3-B：B0+B1 ✅（身份/版块/限制/权限已迁，对账 40/40）**，B2（内容/积分/社交）/B3（对账与全量导入）/S4 应用适配/S5 回归待开工；之后才是 M6 发帖。
- **工作分支 `feat/m5.5-schema-v2`**：`apps/web` 与 `migration` 仍依赖 v1 schema，类型检查/构建为红直到 S3/S4；S5 全绿后合回 main。
  开发库 `qysub_next` 仍是 v1 结构，S3 会重建；schema 相关验证请用临时库（`NEW_DB_NAME=…`）。
- **M5.5 是破坏性重构**：站长已确认任何破坏性变更均可接受（重新迁移即可）；M3–M5 的查询层/权限层/E2E 夹具将随 schema v2 重写。
- 开工前先读：`docs/ROADMAP.md`（里程碑与 DoD）→ 对应 `docs/milestones/Mx-*.md`（范围/边界/测试/门禁）；M5.5 另读 `docs/GATES.md`、`docs/POINTS.md`、`docs/AUTHZ.md` §8。
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
pnpm test:e2e                 # 独立库 qysub_next_e2e + 端口 3200 + MailPit(8025)，会重建 e2e 库
pnpm db:bootstrap | db:seed | db:verify     # 零数据路径：建表+系统种子 / 演示夹具 / schema 对账（10 项）
pnpm --filter @funwind/db test              # db 包单测 + 真实 MySQL 临时库集成测试（SKIP_DB_TESTS=1 可跳过）
pnpm --filter @funwind/content test         # 门控语法 + UBB 转换器 v2（含泄露不变量性质测试）
pnpm migrate | verify:migration             # 青翼导入 v2（幂等）/ 对账 v2；报告写入 docs/reports/（入库）
                                            # 先用临时库演练：NEW_DB_NAME=… 并用 packages/db/scripts/e2e-reset.ts 建空库
pnpm --filter @funwind/web modules:toggle <id> <on|off>   # 模块启停
pnpm --filter @funwind/web perf:lcp                       # 生产构建 LCP 门禁
```

改了 `packages/db` 后，web 依赖的是其 **构建产物**（`dist/`），先 `pnpm db:build`（`dev`/`build`/`migrate` 脚本已自带）。

## 硬约定（违反即回退）

1. **旧库只读**：只允许 SELECT/SHOW/DESC，迁移程序有代码级守卫。
2. **保留旧主键**（uid/tid/pid/fid/aid）；新记录自增。**v2 起业务表不带 `raw`/`content_raw`**，正文只留 `body_md`；
   未被新模型使用的旧表一律丢弃、**不建归档库**；旧库保持只读且在 M13 签字前不得删除。
3. **垃圾只标记不删除**（v2 为 `state=spam`）；旧密码不迁移（`password_hash=NULL`，走邮件认领/重置）。
3a. **唯一键不得依赖 NULL 去重来表达作用域/层级**：全局作用域用 `scope_id = 0` 哨兵（MySQL 唯一索引不去重 NULL）。
    唯一例外：单列且「空值 = 没有」即期望语义（`users.email_key`）。由 `packages/db/src/schema-rules.ts` 断言，`db:verify` 与单测强制。
3b. **隐藏内容只能经 `getGateContent` 读取**；`body_md` 永远只含公开部分（门控规范见 `docs/GATES.md`）。
3c. **积分变动只能经 `applyPoints`**，渠道须先注册（`docs/POINTS.md`）。
4. **时区**：库内 DATETIME 一律北京墙面时间；连接层 `+08:00` + `dateStrings`；解析只走 `lib/datetime.ts`，禁止裸 `new Date(字符串)`。
5. **DB 连接**：web 运行时只用 `getWebDb()` 单例；`withDb` 仅限一次性脚本。
6. **渲染**：用户内容必须经 `lib/markdown.ts` + `lib/sanitize.ts` 管线，禁止 `dangerouslySetInnerHTML` 直出原文。
7. **权限**：一律走 `lib/authz` 的 `checkPermission`；越权对外表现为 **404**（不暴露存在性）；不允许硬编码身份判断。
8. **URL 已冻结**：`/f/{fid}`、`/t/{tid}`、`?page=`、`#p{pid}`、`/attachment/**`、`/emotion/**`（M13 的 301 依赖）。
9. **模块**：扩事件/槽位 = 改 `modules/kernel/types.ts` + 同步 `docs/MODULES.md`；使用内核的 route handler 必须自行 `import "@/modules"`。
10. **schema 变更**：改 `packages/db/src/schema.ts` → `drizzle-kit generate` → 提交迁移 SQL → `db:verify` 通过；迁移程序与应用共用同一管线。
11. **数据层双模式**：零数据部署是默认路径，青翼导入只是可选路径，应用代码不得依赖旧库。

## 架构要点

- **模块内核**（`src/modules/kernel`）：编译期注册（无热插拔）+ 同步事件总线（逐消费者隔离、落 `event_log`）+ UI 槽位；启停状态在 `module_state`。
- **认证**（`lib/auth`）：不透明令牌 cookie，库内只存 SHA-256；argon2id；登录轮换会话；邮件令牌 reset/verify/claim 单次原子消费；`register.mode = invite|open`。
- **权限**（`lib/authz` + `packages/db/src/authz-vocab.ts`）：`roles` / `permissions` / `role_grants` / `user_roles` 四表；
  `forum.read` **就近层显式优先**（不回退父级），`forum.write/manage` **沿父链级联合并**；版主由授权派生，不指派。
- **邮件**：nodemailer，开发期 MailPit（SMTP 1025 / UI 8025）。

## 已知坑

- Next 16 开发服务器需 `allowedDevOrigins: ["127.0.0.1"]`，否则页面可渲染但整页无交互（水合静默失败）。
- Next 16.4.2 的 `title.template` 对子页字符串标题疑似未生效（M1 遗留，升级后复验）。
- E2E 必须用独立库与 3200 端口，别和 dev 服务抢端口。
- zsh 下 `grep --include=*.ts` 要加引号，否则报 `no matches found`。
- 频控是进程内存实现（单实例语义），多实例前须换 Redis（M13）。

## 已知缺口（2026-10-23 M0–M5 审查；**代码修复归 M5.5 S4**，当前代码仍带这些缺陷）

- **P0** 首页 `getLatestThreads` 与版块目录未按权限过滤，会泄露受限版块的标题/计数；`isShow=0` 版块主题也未从最新动态排除。
- **P0（数据）** 权限翻译迁移不幂等：当前开发库 `user_roles` 1255 行仅 251 组不同、`role_grants` 含脏键（`p1`/`p2`/`y`）；迁移 v2 前不要依赖这两张表的内容。
- **P0（数据）** 门控内容变公开：`[post]` 306 帖未处理、`[sell]` 全文公开；当前开发库的 `content_md` 不可视为已隔离。
- **P1** `pnpm test` 覆盖率门槛当前为红（`lib/authz/service.ts` 0%），`verify:all` 并非全绿。
- **P1** `/admin` 权限动作未写审计；开放注册的邮箱未验证限制未落地；派生版主把 `forum.write` 当版主授权。
- **P1** 频控信任 `x-forwarded-for`；注册 `MAX(id)+1` 有竞态且邀请码先核销后建用户；`checkPermission(userId)` 忽略传入 userId。
- **P2** `createCustomRole` upsert 可改写内置角色；`/api/dev/*` 与 `/design` 在生产构建中可达（仅靠 `NODE_ENV` 守卫）；
  `tsconfig.tsbuildinfo` 被误提交。
- **安全提醒**：BLUEPRINT 的旧库口令已清除，但 **git 历史里仍有**；仓库当前无 remote，推送前必须审计/重写历史并轮换口令。

## 工作流

1. 领取里程碑 → 严守其「范围/边界」；完成定义（DoD）= 门禁 checklist 全勾 + CHANGELOG + 相关文档同步 + 遗留事项记录。
2. 门禁以真实命令输出为准，不凭文档勾选；测试规则见 `docs/ROADMAP.md`「全局测试基线」。
3. 代码注释一律简体中文（类/方法/复杂逻辑），标识符保持英文。
4. 本地开发凭据见 `README.md`「环境速查」与根 `.env`（已 gitignore）；**不要把口令写进文档或提交**。
