# FunWind · 项目指南

青翼字幕组（QYSUB）论坛重构：抛弃 phpwind 9，全新开发的现代化论坛。旧程序与旧库只作内容源与业务语义参考，**代码零复用**。
全局行为准则见 `~/.claude/CLAUDE.md`（简体中文交互、先列任务清单、改代码前确认、分步执行），本文件在其上叠加。

## 当前阶段

- 阶段一·骨架 M1–M5 已交付，但 2026-10-23 审查发现其数据模型与多项门禁勾选需重做/更正。
  **M5.5 重构（设计先行）已完成，已合并 `main`**。站长思路：**先定目标模型（`docs/DESIGN-MODEL.md`，schema v2.1 共 43 表，含通知中心），旧数据向它靠拢，迁移只是适配层**。
  进度：R1 文档 ✅ → R2 `packages/db` 与 `packages/content` 重做 ✅ → R3 迁移适配层重做并重建开发库 ✅ → S4 应用适配 ✅ → **S5 E2E 与全量门禁 ✅（2026-10-24）**；之后进入 M6 发帖。
  **M5.6 上线前加固与渲染修复（M6 的前置，见 `docs/milestones/M5.6-prelaunch-hardening.md`）**：S1 渲染补精简 GFM ✅ → E0 编辑器选型（Tiptap + CodeMirror + react-image-crop）✅ → S1b 转换器⇄渲染器语法契约与转换器修复、重导开发库 ✅ → S2 登录时序与频控 ✅ → S3 认证杂项 ✅ → S4 安全响应头与 `/files` 穿越矩阵 ✅ → S5 文档漂移清账 ✅。
  **M6 发帖与内容生产**：M6.1 写路径底座 ✅ → M6.2 薄切片（发主题 / 回帖 / 编辑 / 删除 / 恢复）✅ → M6.3 编辑器 ✅（真机清单已通过，见 `docs/milestones/M6.3-editor.md`）→ **M6.4 上传与图片** ✅（真机清单已通过，见 `docs/milestones/M6.4-uploads.md` §14）→ **M6.5 门控创作收尾** ✅（见 `docs/milestones/M6.5-gates-polish.md`）。**M6 ✅（2026-10-25）**：总验收与遗留清账见 `docs/milestones/M6-posting.md`，代码审查与整改见 `docs/reviews/2026-10-25-m6-code-review.md`；下一里程碑 M7（M6 未完成事项见 `docs/milestones/M6-carryover.md`，其中 §1 随 M7 一起处理）。
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
pnpm test:e2e                 # 重置并重建 qysub_next_e2e → 生产构建 3201 跑功能全量（desktop/mobile/安全用例）→ 重置并重建测试库 → dev 3200 仅跑 /api/dev/*、/design 冒烟；本地实测 341 + 8 全绿；需要 MailPit(8025)
pnpm db:bootstrap | db:seed | db:e2e-fixtures | db:verify   # 零数据路径：建表+系统种子 / 演示夹具 / E2E 专用夹具 / schema 对账（19 项：结构 + 孤儿引用 + 楼层唯一 + 首帖指针 + 主题与首帖状态 + 缓存计数）
pnpm db:recount                # 全量重算缓存计数（幂等，默认直接修正；--check 只读，有漂移非零退出）
pnpm db:gc-files --dry-run     # 孤儿文件巡检（只报告、不删除：库内无引用的文件 + 磁盘有、库里无的孤儿；超过 24 小时）
pnpm --filter @funwind/db test              # db 包单测 + 真实 MySQL 临时库集成测试（SKIP_DB_TESTS=1 可跳过）
pnpm --filter @funwind/web test             # web 单测 + 真实 MySQL 临时库集成测试（同样认 SKIP_DB_TESTS=1）；git push 前由 .husky/pre-push 自动跑类型检查 + 全部测试
pnpm --filter @funwind/content test         # 门控语法 + 正文切段 + 转换器⇄渲染器语法契约的完整性（UBB 转换器及其泄露不变量性质测试在 migration/，用 pnpm --filter @funwind/migration test）
pnpm migrate | verify:migration             # 青翼导入 v2（幂等）/ 对账 v2（110 项）+ 本地硬门禁 verify:render（渲染形状）与 verify:fidelity（旧库原文字符守恒，需旧库）；报告写入 docs/reports/（入库）
                                            # 先用临时库演练：NEW_DB_NAME=… 并用 packages/db/scripts/e2e-reset.ts 建空库
pnpm test:e2e:run              # 同上但不启动 MailPit 容器（CI 用：MailPit 由 GitHub Actions 服务容器提供）
pnpm --filter @funwind/web test:e2e:prod                  # 仅运行生产构建下的功能全量 E2E（真实 next build + next start）
pnpm --filter @funwind/web modules:toggle <id> <on|off>   # 模块启停（写 audit_log）
pnpm --filter @funwind/web perf:lcp                       # 生产构建 LCP 门禁
pnpm --filter @funwind/web perf:posting                   # 发帖性能基准（服务层 createReply×200，p95 < 300ms）；须显式 NEW_DB_NAME=qysub_next_e2e
```

改了 `packages/db` 后，web 依赖的是其 **构建产物**（`dist/`），先 `pnpm db:build`（`dev`/`build`/`migrate` 脚本已自带）。

## 硬约定（违反即回退）

1. **旧库只读**：只允许 SELECT/SHOW/DESC，迁移程序有代码级守卫。迁移是**一次性全量导入**：迁移独占的表整体替换式加载，检测到线上数据会拒绝重跑（`MIGRATION_FORCE=1` 强制）。
2. **只保留 URL 必须稳定的旧主键**（uid/fid/tid/pid）；其余 id 自增。业务表不带 `raw`/`content_raw`，正文只留 `body_md`；
   未被新模型使用的旧表一律丢弃、**不建归档库**；旧库保持只读且在 M13 签字前不得删除（即归档）。
2a. **运行时 schema 不认识旧站**：禁止 `legacy_*` 列、`migrated` 标记、迁移用 id 公式、`migration_*` 表；旧键映射/旧 gid/旧路径只放 `migration/`。
    被引用但已不存在的作者建「已注销用户」占位账号（`state=deleted`），不在内容表加冗余列。`schema-rules.ts` 将加断言（R2）。
3. **垃圾空壳、回收站与屏蔽内容、私信不迁**（旧库即归档）；内容状态机为 `visible|pending|rejected|hidden|deleted|disabled`（M9.5 增封禁终态：迁移白名单中央定义于 `lib/posting/transition.ts`，disabled 不可编辑不可重审、唯一出路 →deleted）；旧密码不迁移（`password_hash=NULL`，走邮件认领/重置）。
3a. **唯一键不得依赖 NULL 去重来表达作用域/层级**：全局作用域用 `scope_id = 0` 哨兵（MySQL 唯一索引不去重 NULL）。
    唯一例外：单列且「空值 = 没有」即期望语义（`users.email_key`）。由 `packages/db/src/schema-rules.ts` 断言，`db:verify` 与单测强制。
3b. **隐藏内容只能经 `getGateContent` 读取**；`body_md` 永远只含公开部分（门控规范见 `docs/GATES.md`）。
3c. **积分变动只能经 `applyPoints`**，渠道须先注册（`docs/POINTS.md`）。
3d. **附件表只能经 `lib/gates/attachments.ts` 读写**（M6.4 起，保存时的内联登记 `registerSourceFiles` 与编辑视图也在此；上传记录表 `file_uploads` 只能经 `lib/uploads/store.ts` 写入，守卫 `uploads-guard.test.ts`）：`attachments.gate_id` 非空的附件与门控隐藏正文同权，锁定项不得下发文件名 / 存储键 / 大小；`/files` 与帖子页共用同一出口（`docs/ATTACHMENT-GATES.md`，守卫测试 `attachments-guard.test.ts`）。
4. **时区**：库内 DATETIME 一律北京墙面时间；连接层 `+08:00` + `dateStrings`，**且每条新连接必须 `SET time_zone='+08:00'`**（mysql2 的 `timezone` 选项不改服务器会话时区，`NOW()` 会是容器的 UTC；`createPool` 已处理，任何绕过它的裸连接须自行设置；`db:verify` 与 `client.int.test.ts` 守护）；解析只走 `lib/datetime.ts`，禁止裸 `new Date(字符串)`。
5. **DB 连接**：web 运行时只用 `getWebDb()` 单例；`withDb` 仅限一次性脚本。
6. **渲染**：用户内容必须经 `lib/markdown.ts` + `lib/sanitize.ts` 管线，禁止 `dangerouslySetInnerHTML` 直出原文。管线启用的是**精简 GFM（只有表格与删除线，`singleTilde:false`，见 `lib/gfm-lite.ts`）**：不要换成完整 `remark-gfm`——它的自动链接会把紧跟 URL 的中文吞进链接，单波浪线删除线会误伤 1328 篇「语气词~」。
7. **权限**：一律走 `lib/authz` 的 `checkPermission`；越权对外表现为 **404**（不暴露存在性）；不允许硬编码身份判断。
8. **URL 已冻结**：`/f/{fid}`、`/t/{tid}`、`?page=`、`#p{pid}`（M13 的 301 依赖）。文件统一走 `/files/<storage_key>`（已取代 `/attachment/**`，S4-4 落地）；表情为 `/emoji/{id}.{ext}`（旧 50 枚是 public 静态 `{id}.gif`，新表情内容寻址由 `/emoji/[file]` 路由提供，id 冻结、已发布正文引用不能碎）。
9. **模块**：扩事件/槽位 = 改 `modules/kernel/types.ts` + 同步 `docs/MODULES.md`；使用内核的 route handler 必须自行 `import "@/modules"`，Server Action 一律用 `defineAction`（`lib/actions/define-action.ts` 顶部已导入，经它的入口天然满足；`use-server-exports-guard.test.ts` 保证 `"use server"` 文件只导出 `defineAction(...)`）——凡（传递）引用会触及内核的代码（派发事件 / 读写注册表）都算，`modules-import-guard.test.ts` 静态分析并守护（入口或其传递依赖里有 `import "@/modules"` 即合规，注释里写的不算），新增入口漏写会直接变红。`/admin/**` 的 Action 必须声明 `auth: { admin: "…" }`（`admin-entry-guard.test.ts`）。
10. **schema 变更**：改 `packages/db/src/schema.ts` → `drizzle-kit generate` → 提交迁移 SQL → `db:verify` 通过；迁移程序与应用共用同一管线。开发库用 `MIGRATION_FORCE=1` 重跑部分步骤时注意步骤联动：`files` 组会拉起 users/content/badges，且 content 重跑会重置 threads 缓存计数列——**必须连带重跑 `counters`**（run.ts 已内置该联动）。
11. **数据层双模式**：零数据部署是默认路径，青翼导入只是可选路径，应用代码不得依赖旧库。

## 架构要点

- **模块内核**（`src/modules/kernel`）：编译期注册（无热插拔）+ 同步事件总线（逐消费者隔离、落 `event_log`）+ UI 槽位；启停状态在 `module_state`。
- **认证**（`lib/auth`）：不透明令牌 cookie，库内只存 SHA-256；argon2id；登录签发新会话 cookie（**旧会话行不会被销毁**，到期前一直有效，见 M5.6 遗留事项）；邮件令牌 reset/verify/claim 单次原子消费；`register.mode = invite|open`。
- **权限**（`lib/authz` + `packages/db/src/authz-vocab.ts`）：`roles` / `permissions` / `role_grants` / `user_roles` 四表；
  `forum.read` **就近层显式优先**（不回退父级），`forum.write/manage` **沿父链级联合并**；版主由授权派生，不指派。
- **邮件**：nodemailer，开发期 MailPit（SMTP 1025 / UI 8025）。
- **写入的容器与限制**（M6.1）：评估器对 `forum.write` 先判分区 / 归档（含 admin 也拒），回帖带 `threadLocked` 时还需 `thread.replyLocked`；发帖限制在 `site_settings.limits`（`lib/limits/`，zod 校验，无效回落默认；**0 = 不限**，多角色每项取最宽松，缺字段整体无效而不是补 0）。门控条件固定为内置 `points` / `reply`，库里的未知类型一律 fail-closed（含购买侧不扣费）。
- **权限/可见性**（`lib/authz` + `lib/queries/visibility.ts`）：评估器是纯函数（显式 `Subject`，零 SQL）；版块树与授权表常驻内存快照（管理动作后 `invalidateAuthzSnapshot()`）；
  查询层用 `readableForumIds`/`moderatedForumIds` 在**取数前**过滤，不取出来再逐行判断。
- **上传**（M6.4，`lib/uploads`、`app/api/upload`、`components/upload`）：嗅探不信扩展名；图片经 sharp 定向、去元数据、重编码（GIF 不重编码，只去除注释与非动画扩展块）；内容寻址落盘（临时文件再 rename）；配额在事务内持 `user_stats` 行锁检查（去重命中也计数）。版块参数走查询参数 `forumId`，权限在读取请求体之前判定；同一账号同时进行中的上传不超过 3 个。图片可见性按引用它的帖子鉴权（游客视角单独计算，见 `resolveFileGrant`）。保存帖子时在同一事务内登记正文引用（`inline`）与附件（`download`）。
- **积分与门控的并发约定**（`lib/points`、`lib/gates`，教训来自真实复现的死锁/连接池饥饿）：① 事务内不得再借第二条连接（连接池仅 8 条）——渠道解析、权限检查等一律在开事务前完成；
  ② 加锁顺序固定「门控行 → 账户行（user_id 升序）」；③ 账户行用 `SELECT … FOR UPDATE` 加锁（不存在才 `INSERT IGNORE`），**禁止**用 `INSERT … ON DUPLICATE KEY UPDATE` 当加锁手段（共享锁升级死锁）；
  ④ 先拿账户锁再查幂等/已解锁。⑤ **积分与解锁事务一律 READ COMMITTED**（`POINTS_TX_OPTIONS`）：默认 REPEATABLE READ 下对「不存在的键」`FOR UPDATE` 会加间隙锁，不同新用户并发首次建账户互相死锁（实测 640 次并发 139 次失败）；任何包含 `lockAccount` / `applyPointsInTx` 的新事务都必须以它开启。积分表只能经 `lib/points` 写，隐藏正文只能经 `lib/gates/service.ts` 读，附件表只能经 `lib/gates/attachments.ts` 读写，均有守卫测试。

- **编辑器**（M6.3，`components/editor`）：所见即所得（Tiptap 3）默认，可切 CodeMirror 源码；操作**完整源码**（含门控隐藏正文）。**未编辑的旧帖保留原文，绝不重新序列化**；往返不等价的帖强制源码模式（`lib/posting/roundtrip-check.ts`，判定为渲染等价）。预览走 `POST /api/preview`（Route Handler，门控只显示占位）。
- **草稿**（`components/editor/draft.ts`）：`localStorage`，键 `funwind:draft:<userId>:<kind>:<id>`，每次变化即写。**提交即暂存**：submit 时主键移到 `…:sent`，失败跳回从暂存键恢复，成功后主键为空；登出（`LogoutForm`）清除全部草稿键。草稿只是个人便利，读写都包在 try/catch 里。暂存键只在失败或冲突跳回时读取，进入页面时过期即清理；编辑冲突时正文与附件的暂存版本以提示交给作者选择。

## 已知坑

- **同源判定不能比较 `request.url`**：Next 按服务绑定的主机名构造它（本地为 localhost），浏览器的 Origin 是 127.0.0.1 或真实域名，会误拒所有同源请求。用 `lib/net/same-origin.ts`（Host 头 + X-Forwarded-Proto，与 Server Action 一致）。
- **E2E 存储隔离**：`test:e2e` 设置 `STORAGE_DIR=<仓库根>/storage-e2e`（每次运行前清空）；E2E 用例读写文件请用同一变量，不要硬编码 `storage/`。
- **jsdom 缺几何接口**：Tiptap / ProseMirror 滚动到选区时需要 `scrollIntoView`、`getClientRects`、`Range.getBoundingClientRect`，缺失会以未捕获异常让整次运行失败（垫片在 `vitest.setup.ts`）。
- **裁剪的最小边长是 32 像素**：1×1 的测试图无法框出合法裁剪区域（会显示「裁剪区域太小」，这是正确行为）。E2E 裁剪用例用 96×96 的图。
- **浏览量身份不读 User-Agent**：UA 由攻击者任意构造，换一个就是新访客。拿不到可信 IP 时统一为 `g:unknown` 并共用限额桶（代价是直连部署下计数偏少）。
- **解锁事务的复核顺序**：定位在事务外完成，持锁前必须对主题加共享锁并复核帖子状态（否则可能为已隐藏的内容扣费）；锁序「主题 → 门控 → 账户」不得颠倒。
- **上传的版块参数在查询字符串里**：不要改回表单字段，否则权限判定会排在读取请求体之后（整改记录 U-1）。
- **守卫按文本匹配，注释也会命中**：`hidden-md-guard.test.ts` 扫描的是源码文本，注释里写 `hidden_md` 同样会红。注释里用中文描述。

- **部署在反向代理后**：Server Action 比对 Origin 与 Host / X-Forwarded-Host，代理必须正确透传，否则同源提交也会被误拒（M13 上线核对项；复查 A3 已验证跨站被拒、同源放行）。

- **E2E 写法**：用例以 `e2e/support/session.ts` 的 `loginAs()` 直接往库里写会话并注入 cookie，**不要在多个用例里走界面登录**——登录有账号级频控（每账号 10 分钟 5 次），共用账号会互相挤爆；界面登录只在 `auth.spec` 与 `modules.spec` 各测一次。
  E2E 用例**不得引用真实迁移数据**（fid/tid 写死会让 CI 变红）：稳定场景用 `support/fixtures.ts`（镜像 `packages/db/src/e2e-fixtures.ts`，两处同步）；
  用例要的临时数据用 `support/db.ts` 的 `withE2eDb()` 直连 e2e 库自己造、自己收尾（Playwright 以 CJS 加载，不能直接 import 纯 ESM 的 `@funwind/db`）；写 SQL 时 **`?` 占位符不能放在引号里**（mysql2 不替换字符串字面量中的 `?`）。
- `pnpm test` 必须串行跑各包（`--workspace-concurrency=1`）：并行时 content 与 db 的 vitest 会同时清理共享的 `node_modules/.vitest-cache`，间歇性 `ENOTEMPTY`。

- Next 16 开发服务器需 `allowedDevOrigins: ["127.0.0.1"]`，否则页面可渲染但整页无交互（水合静默失败）。
- Next 16.4.2 的 `title.template` 对子页字符串标题疑似未生效（M1 遗留，升级后复验）。
- E2E 必须用独立库；生产全量运行在 3201（`NEXT_DIST_DIR=.next-e2e-prod`），dev-only `/api/dev/*`、`/design` 冒烟运行在 3200（`NEXT_DIST_DIR=.next-e2e`）。两阶段之间重置并重建测试库以隔离状态，因此 `pnpm test:e2e` 不会与 3100 开发服务争用端口或 Next distDir。新增 distDir 时 Next 会自动往 `tsconfig.json` 的 `include` 补 types 路径，条目已入库，不要删。
- zsh 下 `grep --include=*.ts` 要加引号，否则报 `no matches found`。
- 频控与权限快照都是进程内存实现（单实例语义），多实例前须换 Redis / 共享失效通道（M13）。浏览量计数（`lib/views`，每 10 秒批量刷入）同样是进程内，数字只是估计值。
- `perf:posting` 拒绝任何非 `qysub_next_e2e` 的库名：根 `.env` 里的 `NEW_DB_NAME` 指向开发库，必须在命令行显式指定。
- `TRUSTED_PROXY_HOPS`：生产环境必须显式设置（直连填 0，nginx 之后填层数），漏配会在首次取 IP 时报错；取不到可信 IP 时跳过 IP 级限额，只留账号/邮箱级。
- **跑 E2E 会重建包的 `dist`，与正在运行的 3100 开发服务器冲突**：`test:e2e:run` 开头会执行 `db:build`（重新 `tsc` 编译 `packages/db`、`packages/content` 的 `dist/`）。此时若 3100 正在编译，会读到写了一半或旧的 `dist`，报 `Export xxx doesn't exist in target module`（例如给 `@funwind/content` 新增导出后），页面一直 500 / 「阻断性错误」遮罩，**这是缓存了过期状态而不是代码有问题**。处理：E2E 跑完后重启 3100（`pnpm dev` 会先重建 `dist` 再启动）。改了 `packages/*` 的导出后同理——先重建再重启，别指望热更新。
- **编辑器的 `focus()` 会让页面一步跳过去，`preventScroll: true` 拦不住**：「平滑滚到某处再聚焦编辑器」做不出来——滚动开始前 / 进行中聚焦都会取消平滑滚动（第二次点击看起来平滑只是因为编辑器已有焦点）。要平滑只能等 `scrollend` 之后再聚焦，但那样聚焦不在用户手势内，iOS 唤不起软键盘。回复悬浮按钮（`components/posting/reply-fab.tsx`）取舍为「瞬时跳转 + 立即聚焦」（站长拍板）。
- **编辑器 E2E 写法的几个坑**（`e2e/editor-crud*.spec.ts` 踩过）：① ProseMirror 的选区同步是异步的，点击 / `End` 后紧跟按键会在旧选区上生效，定位后等 ~120ms；② 点编辑区空白处会落进 `TrailingNode` 在末尾自动补的空段落（光标跑到引用 / 列表外面），全选还会把它也包含进去——要点到内容元素本身；③ Radix 弹层 / 下拉在关闭时用 `setTimeout(0)` 延后把焦点还给触发按钮，脚本紧接着重开会被关掉，关闭后等一个 tick；④ ProseMirror 历史把 500ms 内相邻的编辑合并成一个撤销组，脚本跑太快一次 Ctrl+Z 会连前面的插入一起撤；⑤ 会员每天 20 次上传额度，反复重跑会耗尽，上传用例用管理员；⑥ 切换源码 / 所见即所得后编辑器重建，光标回到文档开头。
- **编辑器相关的用例必须同时检查「文档合法」与「页面无异常」**：往返测试只比较 Markdown 文本，文档结构不合法时文本照样逐字相同；只检查「元素在不在」的 E2E 在编辑器已损坏时也是绿的。用 `doc.check()`（单测 `doc-validity.test.ts`）与 `failOnPageErrors()`（`e2e/support/page-errors.ts`）兜底。
- `next dev` 每次启动会生成 `apps/web/AGENTS.md`（已 `.gitignore`）；`.next/` 里过期的生成类型会让 `tsc` 报已删除路由，用 `pnpm --filter @funwind/web exec next typegen` 刷新。
- **安全响应头**（`lib/security-headers.ts`）：CSP 目前只是 **Report-Only**，违规会 POST 到 `/api/csp-report` 并记成一行 `[csp-report]` 日志；`script-src` 仍含 `'unsafe-inline'`（Next 的 RSC 载荷是内联脚本，nonce 需要中间件）。`/files/**` 被全站头排除（自带 `default-src 'none'; sandbox`）。HSTS 只在生产且 `APP_URL` 是 https 时下发。新增页面类型后，`e2e/security-headers.spec.ts` 的「零违规」页面清单要同步。
- 迁移与对账的临时库演练：`NEW_DB_NAME=… pnpm --filter @funwind/db exec tsx scripts/e2e-reset.ts` 建空库再 `pnpm migrate`；`STORAGE_DIR` 可指向临时目录避免污染 `storage/`。

- **浏览器专属状态不能在 `useState` 初始化里读**（如 `localStorage`）：服务端渲染与客户端首次渲染不一致会水合失败，且 jsdom 单测看不出来（不走 SSR）。应改用 `useSyncExternalStore`（服务端快照返回空值）；`react-hooks/set-state-in-effect` 也禁止在 effect 里同步 setState。E2E 的草稿用例显式收集 `pageerror` 并断言无 `Hydration` 错误，因为 React 会静默重渲染成功。
- **隐藏字段与 React 重渲染**：非受控 `<input type=hidden defaultValue>` 会在父组件每次重渲染时被写回 `defaultValue`，覆盖 ref 写入的值。用 `memo` 组件隔离（见 `editor-shell.tsx` 的 `HiddenSource`）。
- **macOS 没有 `timeout` 命令**：本机跑长命令直接用工具的超时参数，不要套 `timeout`。

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
5. **CI（GitHub Actions，`.github/workflows/ci.yml`）**：push main / PR / 手动触发。两个作业——`verify`（秘密扫描 / 脚本 / lint / 格式 / 类型 / 单测含真实 MySQL 集成与覆盖率门槛 / 构建）与 `e2e`（MySQL + MailPit 服务容器：生产构建跑 Playwright 功能全量，随后重置测试库，再由 dev 服务器仅跑 `/api/dev/*`、`/design` 冒烟；失败自动传现场 artifact）。main 分支保护：required checks = verify + e2e（PR 合并强制过 CI）；`enforce_admins` 关闭（保留直接 push 的工作流，push 后 CI 独立跑一轮留档）。**迁移对账（verify:migration）只在本地跑**——需要只读旧库，CI 无法覆盖。
