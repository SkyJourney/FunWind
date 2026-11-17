# M20 · 管理 Access Token 与管理 REST API v1

- 阶段：四·运营与演进 ｜ 依赖：无硬依赖（M19 已收口；**M21 强依赖本里程碑产物**）｜
  状态：✅ 已收口部署（2026-11-18 发版，镜像 `funwind-web:20261118-f42c1fe2`；执行记录见 §15）
- 立项动因：站长 2026-11-16——管理员拥有 **Access Token** 概念（自身有效期 + 被撤下管理员时同步吊销），
  支撑管理 REST API 与后续 MCP 化。

## 目标

1. 管理员可自签/自管 Access Token（命名、有效期、吊销、明文一次性展示），用于脚本 / AI 客户端等非浏览器场景。
2. 一套以 `Authorization: Bearer` 鉴权的管理 REST API（`/api/manage/**`），与页面会话体系并行、语义分离
   （JSON 401/403，绝不 redirect/notFound 页面语义）。
3. Token 生命周期与管理员身份强绑定：自身过期失效 + 手动吊销 + **撤权联动吊销**（事务内，仿封禁删会话先例），
   实时权限校验作为第二道防线。
4. 全部业务调用出审计（`writeAudit` via:"api"），响应信封与错误码有单一事实源。

## 1. 决策记录（站长拍板 2026-11-17）

| # | 决策 | 定案 |
|---|---|---|
| D1 | token 权限范围 | **继承持有人全量权限**（实时校验、撤权即失权），不做签发时子集裁剪 |
| D2 | 有效期策略 | 档位 **30/90/180/365 天**，默认 90；上限 365；**不允许永久** |
| D3 | v1 写端点 | **不含**；写端点按 M21 工具需求反推，逐个过站长确认 |
| D4 | 联动吊销口径 | 持有人**不再满足站点管理员不变量**即吊销全部 token（比只盯 admin 角色更严） |
| D5 | 数量上限 | 每管理员 **5 个**，超限提示先吊销旧的 |
| D6 | 兼容键清账 | **M20 清账**：bootstrap 幂等数据搬迁（旧键翻译成新键后删旧行）+ 同版本删读兼容层 |
| D7 | 配置键 UI | points.gate_fee_rate / punch.reward **M20 顺带补 UI**（/admin/points） |
| D8 | v1 端点范围 | **9 个全做**（含推送/邮件日志），对齐 M21 首批五件套工具 |

## 2. 设计原则：入口薄、Service 厚（贯穿 M20/M21 的分层纪律）

业务执行一律封装为 **Service 层方法**（事务、审计、不变量校验内聚在 Service 内）；
Server Action（session 鉴权）、REST route（Bearer 鉴权）、未来 MCP 工具都只是
「鉴权 + 参数解析 → 调 Service → 信封/回执」的**入口封装（Controller）**。
修业务只改 Service 一处，三类入口自动一致，操作原子性天然保证。

四条硬规则（Step 8 审查项）：

1. `app/api/manage/**` 的 route.ts **禁止出现业务查询/写逻辑**（不 import `@funwind/db`、不写 drizzle 调用），
   只做 guard + 参数解析 + 调 Service + 信封——**新增架构守卫测试静态固化**（静态 import 扫描，
   手法仿 `admin-nav-guard.test.ts` 的 TS AST 解析）。
2. 同一语义页面与 API 必须调同一 Service 函数；「权限→数据范围」映射逻辑下沉 Service：
   contents 的全站/版主 scope 判定抽成 `resolveContentScope(subject)`，
   contents 页现有三重判定（`app/admin/contents/page.tsx:68-87`）改为复用，消除两处重复。
3. 写操作 Service 化在本里程碑即实践：签发/吊销 token、联动吊销、兼容键搬迁、配置键保存全是 Service 函数，
   Server Action 只做薄壳。
4. 本节纪律写入 `docs/MANAGE-API.md`；M21 薄壳原则即本纪律的最外层推论（MCP 不 import db、不写业务逻辑）。

## 3. 已探明事实（两轮调研 2026-11-16/17，file:line，各 Step 直接引用）

| # | 事实 | 影响 |
|---|---|---|
| A1 | 全仓库无 Authorization/Bearer 实现；唯一 token 鉴权是内网 x-ops-token（常量时间比较 + nginx 公网 404，`api/internal/campaigns/holiday/route.ts:19-25`） | Bearer 解析新写；内网先例可参考防御形态 |
| A2 | 权限每请求实时查库：requireAdmin→loadSubject 每次 SELECT user_roles（`authz/subject.ts:17-81`）；撤 admin 后下一请求即失权，登录态保留、无联动 | token 校验走同一实时链即得双保险 |
| A3 | 事务内联动先例：全站封禁删全部会话（`restrictions-admin.ts:106,129`）、强制下线单会话（`:236-261`）、注销三处删会话（`account-deletion.ts:137`、`:474`、`account-deletion-purge.ts:68`） | 撤权删 token 仿此模式 |
| A4 | token 原语现成：`generateToken`（32B→43 字符 base64url）/`hashToken`（SHA-256 hex 小写）（`lib/auth/token.ts:10-16`）；表模式参照 sessions（id=SHA-256，schema.ts:174-191）与 email_tokens/account_deletion_tokens（同款 varchar(64) 哈希主键 + expiresAt） | 存储与哈希方案直接沿用 |
| A5 | requireAdmin/requireModerator 是页面语义（redirect/notFound，`require-admin.ts:36-60`）；「版主」纯判定 = `checkPermission(subject,"site.admin")` 或 `getModeratedForumIds().length>0`（`authz/service.ts:24,49-51`） | 新写 `apiAdminGuard`：Bearer→查行→loadSubject→checkPermission→401/403 JSON |
| A6 | 响应信封与错误码无注册表：`{ok}`/`{error:"code"}` 逐路由自选，无公共 helper；CORS 全零实现 | 建统一信封 + 错误码注册表（G-15 纪律） |
| A7 | `writeAudit(tx, e)` 必须业务事务内（纯读无事务可直接传 `getWebDb()`）；`ConfigActor.via` 是 TS 字面量联合（`lib/audit.ts:18-22`，无 DB enum 约束，只进 after_json），加 `"api"` 零迁移成本；审计行只存 actorId 不存用户名 | API 审计沿用现成机制；日志页零改动（via 在 JSON 内可读） |
| A8 | **勘误（修正大纲）**：定时任务工厂在 `apps/web/src/lib/scheduler/tasks.ts`（`lib/ops/tasks.ts` 是 M14 运维配置写服务，互不相干）；push.cleanup 最简范例 = `scheduler/tasks.ts:204-215`，注册进 `jobs.ts:defaultJobs()`（:13-21）；接线四步见 `docs/SCHEDULED-JOBS.md:74-81` | cleanup 任务仿 push.cleanup，选每日 04:10 |
| A9 | 不变量判定权威：`isEffectiveSiteAdmin(tx,userId)`（`site-admin-invariant.ts:71-76`，事务内实时查、无缓存；条件=userRoles 未过期绑定 + 经 roleGrants 双持 site.admin/admin.roles 全局授权 + 可登录 + 无全站 ban）；调用方族谱见 `authz/admin.ts:88,170,239,285,354,406,463` 等 | 联动吊销触发条件以此为唯一权威 |
| A10 | nginx `location /api/internal/ {return 404;}`（`docker/production/nginx/funwind.conf:69-71`）不命中 `/api/manage/**`；后者命中 `location /` 公网直达 | 无 nginx 变更；暴露面=新端点+token，限流+审计兜底 |
| A11 | **联动吊销精确嵌入点（6 处）**：撤角色 `revokeUserRole`（`authz/admin.ts:461-520`，事务内当前不删 sessions）、撤授权 `revokeRolePermission`（`:274-316`）、删自定义角色 `deleteCustomRole`（`:349-376`）、全站封禁 `createRestriction`（`restrictions-admin.ts:74-160`，:106/:129 删会话同位）、注销申请 `createRequestInTx`（`account-deletion.ts:137`）、注销完成 purge（`account-deletion-purge.ts:68`）；撤销注销 `cancelAccountDeletion`（`:474`）重建会话但 closure_pending 期间不变量不满足 | 统一封装 Service 函数，6 处各加一行 |
| A12 | 服务层查询函数**全部零权限耦合**（纯函数，权限在页面/route 层）：`dashboardData()`（60s 进程缓存，`lib/admin/dashboard.ts:52-89`）、`listAdminUsersPage`/`adminUserDetail(uid,includeIp)`/`searchUsers`（`lib/authz/admin-user-views.ts:66/231/20`）、`listContentsPage`（`lib/moderation/contents.ts:54-167`）、`queryAuditLogs/queryEventLogs/resolveActorId`（`lib/admin/logs.ts:49/75/92`）、`queryEmailLogs/emailLogSummary/parseEmailLogFilter`（`lib/mail/log-query.ts:59/80/47`）、`queryPushLogs/pushLogSummary/parsePushLogFilter`（`lib/push/log-query.ts:52/72/46`） | API 层直接复用，route 只做参数映射 |
| A13 | 内容详情**无现成管理侧函数**（review.ts 私有 `loadPostContext` :35-51 未导出）；看板现版不含待审/举报计数聚合 | Service 新增 `loadContentDetail(kind,id)`；stats 端点对齐看板现有四块数据 |
| A14 | 频控抽象：`rateLimit(key,max,windowMs)` 滑动窗口内存桶 + `rateLimitRefund`（`lib/auth/ratelimit.ts:19-59`）；key 惯例「动作:主体类型:ID」；客户端 IP 用 `clientIpFrom(request.headers)`（`lib/net/client-ip.ts:27-39`，TRUSTED_PROXY_HOPS） | per-token 桶 + IP 桶直接组合 |
| A15 | route.ts 架构守卫：modules-import-guard 要求入口若触 kernel 必须静态 `import "@/modules"`（先例 `api/admin/users/search/route.ts:1`）；use-server-exports-guard 不覆盖 route.ts | manage route 统一带 `import "@/modules"` + `dynamic="force-dynamic"` |
| A16 | 权限点是**代码常量单一事实源**：`PERMISSION_DEFINITIONS` 28 个（`packages/db/src/authz-vocab.ts:26-67`）+ bootstrap 幂等 upsert（`bootstrap.ts:241-296`，**不删行**）；db:verify 的 authz 检查要求库内不越出词汇表（`packages/db/scripts/verify.ts:252-281`） | 删死权限点须同步 bootstrap 增加幂等清理，否则存量库 verify 红 |
| A17 | 死权限点残留面（M19 移交）：`authz-vocab.ts:54,56,63,64`（def）+ `:99,108,110,131-132`（grant）、`evaluator.ts:25,28-29,49`（分类表）、`evaluator.test.ts:64`、`authz-vocab.test.ts:27-28`（计数锚定）、`migration/src/mapping/legacy-permissions.ts:25,27,31-32`（旧键翻译）+ `mapping.test.ts:9`/`authz.test.ts:59`/`verify.ts:459-460`（连带）、`docs/AUTHZ.md:37,75` | Step 7 清单；删除后功能不受影响（vote 走 forum.write、结果可见性走 poll 字段、标签管理功能不存在） |
| A18 | register.mode 读兼容：读入口 `lib/auth/settings.ts:28-48`（双键查询）、回落规则 `lib/auth/register-policy.ts:49-64`、`lib/chrome/site-chrome.ts:111` 同规；**旧键仍是零数据部署种子值**（`authz-vocab.ts:183` DEFAULT_SITE_SETTINGS + E2E 夹具 `seed-data.ts:554`）；翻译函数 `policyFromLegacyMode`（:36-41） | 搬迁方案：bootstrap 翻译写入新键删旧键 + 种子改新键 + 删回落分支 |
| A19 | ops.backup.policy：已无任何代码写入；读兼容 `getBackupRetention`（`lib/ops/tasks.ts:502-516`，任务参数 keep→旧键→默认）+ bootstrap 首种推导（`bootstrap.ts:394`，保留=搬迁语义） | 只删运行时旧键回退分支 |
| A20 | sessions 过期行无 GC（`idx_sessions_expires` 建了无删除消费者）；email_tokens 仅签发事务惰性清理（`lib/auth/tokens.ts:66-77`，MAX_LIVE_TOKENS=6） | api-tokens.cleanup 顺带还两笔旧账 |
| A21 | M19 后台接线：菜单「系统与观测」组已预留（M19 文档:94）；新页四接线点 = NAV_GROUPS（`admin/layout.tsx:85-94`）/ `admin-nav-icons.ts` / metadata.title=label 逐字相等 / 页面守卫首位 requireAdmin（admin-entry-guard + G-07 断言）；表格样板 `/admin/csp`、卡片+确认样板 `/admin/announcements`（ConfirmSubmit 只拦本按钮，M19 修复） | Step 5 照样板接线 |
| A22 | 签发 action 骨架：defineAction（auth 声明+zod+频控+审计，先例 `admin/ops/actions.ts:80-84`）；明文回传**不可进 URL**（浏览器历史/日志）→ useActionState 客户端组件直接渲染 | Step 5 签发交互形态 |

## 4. 数据层终稿

新表 `admin_api_tokens`（`packages/db/src/schema.ts` 追加；模板 = sessions/emailTokens）：

```
id          varchar(64)  PK，存 SHA-256(明文 token)
user_id     int unsigned NOT NULL
name        varchar(64)  NOT NULL，展示名（站长自取）
suffix      varchar(8)   NOT NULL，明文尾 8 字符（列表展示辨识用）
created_at  datetime     NOT NULL（应用层写 NOW()）
expires_at  datetime     NOT NULL
last_used_at datetime    NULL（节流 60s 写）
last_used_ip varchar(64) NULL（clientIpFrom）
revoked_at  datetime     NULL（手动/联动吊销时刻）
created_via varchar(16)  NOT NULL DEFAULT 'admin'（预留）
索引：PRIMARY(id) + idx_aat_user(user_id) + idx_aat_expires(expires_at)
```

- 不建外键、`dt()` 无 defaultNow、命名 `uq_/idx_` 前缀（schema.ts:22-36 惯例）。
- 明文形如 `fw_at_<43 字符 base64url>`，仅签发响应中展示一次；库内只存哈希。
- 迁移 `0031_m20_admin_api_tokens.sql`（`pnpm --filter @funwind/db generate`）。

## 5. Bearer 门禁 `apiAdminGuard(request, permission?)` 设计

`lib/manage/guard.ts`，JSON 语义，**绝不复用 requireAdmin/requireModerator**（页面语义）。链条：

1. IP 桶 `manage:ip:<ip>`（120/min，`clientIpFrom`；取不到 IP 跳过 IP 桶）；
2. `Authorization: Bearer fw_at_<43chars>` 严格前缀解析，缺头/格式错 → **401 unauthorized**；
3. per-token 桶 `manage:token:<hash 前 12>`（60/min）→ 429 + Retry-After；
4. `hashToken` 查行：无行 / `expires_at <= NOW()` / `revoked_at IS NOT NULL` → **一律 401**（存在性不泄露）；
5. `loadSubject(row.userId)` → GUEST_SUBJECT（注销中/非 active）→ **401**；
6. 管理员资格 = `checkPermission(subject,"site.admin") && checkPermission(subject,"admin.roles")`
   （A9 不变量的权限核心；封禁经 evaluator 拒绝 → 403）→ 不满足 **403 forbidden**；
7. `permission` 参数（端点业务权限）不满足 → **403**；
8. 通过：last_used 节流更新（距上次 >60s 才写，写时带 last_used_ip），返回
   `{ userId, tokenId, suffix, subject }`。

封禁持有人：users.state 仍 active，loadSubject 正常返回，evaluator 对全站 ban 拒绝写权限——
资格判定随之失败 → 403（int 测试穷举此路径）。

## 6. v1 端点契约（9 个，全 GET 读）

统一模式：`import "@/modules"` + `export const dynamic = "force-dynamic"` +
`apiAdminGuard` + 复用各 `parse*Filter` 纯函数 + 调 Service + 信封 +
`cache-control: private, no-store`。成功 `{ok:true, data}`；分页 data 含
`{items, total, page, totalPages}`。

| 端点 | 资格外权限 | 参数 → Service |
|---|---|---|
| `GET /api/manage/whoami` | 无额外 | 无 → token 元信息 + 持有人 + 有效权限点全清单（评估器逐点评估）。**不审计** |
| `GET /api/manage/stats` | admin.logs | 无 → `dashboardData()`（30 天注册/主题/回帖逐日、今日登录、总量） |
| `GET /api/manage/users` | admin.users | `q,status,lifecycle,credential,sort,page,size` → `listAdminUsersPage` |
| `GET /api/manage/users/[uid]` | admin.users | 无 → `adminUserDetail(uid, can("user.viewIp"))`（三签聚合：资料/角色/限制/会话/审计） |
| `GET /api/manage/contents` | 版主语义 | `kind,q,forumId,state,order,page,size` → `resolveContentScope(subject)` 收窄后 `listContentsPage` |
| `GET /api/manage/contents/[id]` | 版主语义 | `?kind=thread\|reply` → `loadContentDetail(kind,id)`（新增 Service；版主须所辖版块内否则 404） |
| `GET /api/manage/audit-logs` | admin.logs | `action,actor,targetType,from,to,page,size` → `queryAuditLogs`（actor 经 `resolveActorId`） |
| `GET /api/manage/emails` | admin.logs | `status,kind,scene,q,page,size` → `queryEmailLogs` + `emailLogSummary` |
| `GET /api/manage/push-logs` | admin.logs | `status,scene,q,page,size` → `queryPushLogs` + `pushLogSummary` |

审计：业务端点（除 whoami）门禁通过后各写一条——`targetType:"manage_api"`、
`action:"api.<endpoint>"`、targetId=路径、after=`{query 摘要, tokenSuffix}`、
`via:"api"`、actorId=持有人；`getWebDb()` 直写（纯读无业务事务）。

参数纪律：`size` 白名单 10/20/50/100 默认 20（对齐 M19 `ADMIN_PAGE_SIZES`）；
非法参数一律 `bad_request`（v1 语义明确，不静默回落——与页面 GET 表单宽容策略有意区分）。

## 7. 错误码注册表（`lib/manage/errors.ts`，G-15：码↔文案成对 + 单测锚定）

| code | HTTP | 文案 |
|---|---|---|
| unauthorized | 401 | 凭证缺失、无效或已失效 |
| forbidden | 403 | 凭证有效但权限不足 |
| not_found | 404 | 资源不存在（越权同型） |
| bad_request | 400 | 请求参数不合法 |
| rate_limited | 429 | 请求过于频繁，请稍后再试 |
| internal | 500 | 服务内部错误 |

失败信封 `{error:{code,message}}`；`internal` 不泄露内部细节（兜底 catch）。

## 8. 后台页 /admin/api-tokens（菜单入「系统与观测」组）

- 页面：`requireAdmin("site.admin")` 首位 + 追加不变量校验（不满足 notFound，与 API 资格口径一致）；
  metadata.title =「API 令牌」（=菜单 label，逐字相等）；`admin-nav-icons.ts` 登记图标。
- 签发表单：客户端组件 `useActionState`（**明文不经 URL**）——名称（≤64 字符）+
  有效期档位 30/90/180/365（默认 90）；成功响应直接渲染明文一次 + 「仅此一次」警示 + 复制提示。
- 列表：AdminDataTable（M19 基建：`parseAdminListParams`/`AdminListPager`/density）——
  名称/尾号/创建/过期/最后使用/状态；吊销按钮 ConfirmSubmit 确认。
- actions 薄壳：`defineAction({auth:{admin:"site.admin"}})` + zod + 频控 → 调 Step 2 Service
  （`createAdminApiToken` / `revokeAdminApiToken`，事务+审计+上限 5 校验在 Service 内）。
- E2E 新 spec：签发→拿明文→curl whoami 200→撤角色→401 全链。

## 9. 清理调度 `api-tokens.cleanup`（每日 04:10，仿 push.cleanup）

- `scheduler/tasks.ts` 新工厂 + `jobs.ts:defaultJobs()` 注册 + `SCHEDULED-JOBS.md` 加行；
- token：`expires_at < NOW()-30d` 或 `revoked_at < NOW()-30d` 物理删（保留期供审计排查）；
- **顺还两笔 GC 旧账**：sessions 过期行 `expires_at < NOW()-7d` 删；email_tokens
  `used_at < NOW()-30d OR expires_at < NOW()-30d` 删；
- int 测试：三类行各构造过期/存活样本断言只删应删行。

## 10. 清账三项（M19 移交，Step 7）

1. **死权限点 4 个**（vote.create/vote.view/tag.edit/tag.manage）：按 A17 清单删词汇表 def+grant、
   evaluator 分类、测试锚定（28→24）、migration 映射行（旧键不再翻译）+连带测试、docs/AUTHZ.md；
   **bootstrap seedSystemData 增加幂等清理**（删词汇表外 permissions/role_grants 行，
   存量库随部署自动收敛，db:verify 验收）。
2. **兼容键搬迁**：register.mode → bootstrap 幂等搬迁（无 register.policy 则 `policyFromLegacyMode`
   翻译写入 + 删旧键行）后删读兼容层（A18 三处）+ DEFAULT_SITE_SETTINGS 种子改新键 +
   E2E 夹具同步；ops.backup.policy → 删 `getBackupRetention` 旧键回退分支
   （bootstrap 首种推导保留 = 搬迁语义，A19）。
3. **配置键补 UI**：/admin/points「奖励规则」卡补 punch.reward(min/max) + 新「过闸费率」小卡
   （gate_fee_rate ∈ [0,1)）；action 薄壳调 Service + zod + 审计 + Flash + 测试。

## 11. 边界（明确不做）

- 不做 OAuth / 第三方应用体系 / 刷新令牌 / CORS（消费方是服务端）。
- 不迁移存量 `/api/**` 会话端点；不动 requireAdmin 页面语义。
- v1 无写端点（M21 按工具需求反推）；API 不提供 token 自管理（凭证管理不经凭证自身）。
- 不做 OpenAPI 生成（手写 docs/MANAGE-API.md）；不做 Redis 分布式限流（注释保留升级位）。
- 不做 token 权限子集裁剪（D1）。

## 12. 测试与门禁清单

- 单测：信封/错误码表、guard 纯逻辑分支、签发/吊销/上限/节流、resolveContentScope。
- int（setupTempDb 真实临时库）：guard 全错误路径（无头/格式/401 三态/403 两态/限流/节流写）；
  联动吊销 6 处事务原子性穷举（token 删 + 审计同事务）；cleanup 三表；bootstrap 搬迁与权限点清理；
  死权限点删除后评估器回归；配置键 action。
- 架构守卫：manage-api 守卫（route 禁业务 import）+ admin-entry/nav-guard + modules-import-guard 全绿。
- E2E：全链（登录→签发→API 200→撤角色→401）+ /admin/api-tokens 页面场景（admin 视角）。
- 收口：verify:all 全绿 + E2E 全量 + 六档矩阵 + CHANGELOG + 文档回写；**Step 8 审查闸门先行**。

## 13. 风险

- **token 泄漏**：明文一次性展示、库内只存哈希、last_used 可观测、吊销一步可达、文档建议轮换；
  明文绝不进 URL/日志。
- **暴露面扩大**：`/api/manage/**` 公网直达（A10）——双桶限流 + 审计 + 错误码不泄露内部细节；
  文档可建议 nginx 层再加一道限速（非必须）。
- **撤权联动遗漏路径**：触发条件以 site-admin-invariant 为唯一权威（A9），6 处嵌入 + 实时校验双保险，
  int 穷举全部降权路径。
- **权限语义漂移**：API 与页面共用同一 checkPermission/evaluator；manage-api 守卫禁止 API 层平行判定。

## 14. Step 划分

| Step | 内容 | 门禁 |
|---|---|---|
| 0 | 本文档细化落稿 + ROADMAP 🚧 + M21/M22 大纲入库 | — |
| 1 | 数据层：schema 表 + 迁移 0031 | db:verify + schema-rules |
| 2 | `lib/manage/`：errors/tokens/guard Service + 单测 | lint/tsc/单测 |
| 3 | 联动吊销封装 + 6 处事务嵌入 | int 穷举 |
| 4 | v1 端点 9 个 + resolveContentScope/loadContentDetail + manage-api 守卫 + MANAGE-API.md | 单测/int + curl 拨测 |
| 5 | /admin/api-tokens 页面 + 菜单四接线 + E2E spec | 架构守卫 + E2E |
| 6 | api-tokens.cleanup（+sessions/email_tokens GC） | int + SCHEDULED-JOBS.md |
| 7 | 清账三项（死权限点/兼容键搬迁/配置键 UI） | 全量相关测试 |
| 8 | **全面审查闸门**：清单自查→修复→复审清零 | 审查清单全项 |
| 9 | 收口：verify:all + E2E 全量 + 文档回写 + PR | CI 双作业绿 |

## 15. 执行记录（随 Step 回写）

- 2026-11-17：Step 0 完成——本文档细化定稿（决策 D1–D8、分层纪律、A1–A22 事实修正与补充），
  ROADMAP M20 → 🚧，M21/M22 大纲文档入库。分支 `feat/m20-admin-api-tokens` 建立。
- 2026-11-17：Step 1 完成（`66088248`）——`admin_api_tokens` 表（varchar(64) 哈希主键/尾号/有效期/
  吊销/最后使用审计列）+ 迁移 `0031_m20_admin_api_tokens.sql`；表数锚定 60→61；本地库应用迁移 +
  db:verify 21 项全绿。
- 2026-11-17：Step 2 完成（`5cb18511`）——`lib/manage/` 四件套（errors 信封+六码注册表 / tokens
  签发·吊销·联动·节流 Service / guard Bearer 鉴权链+资格判定 / route 入口封装）；
  `ConfigActor.via` 新增 `"api"`；纯逻辑单测 12 项。
- 2026-11-17：Step 3 完成（`02e0a077`）——撤权联动吊销落地，6 处既有事务嵌入
  `revokeAdminApiTokensIfNotSiteAdmin`。两处对计划的调整：**收回团队角色**（revokeTeamMembership）
  为计划外新增嵌入点（团队角色可持 admin 授权）；**purge 兜底撤销嵌入**（「不扩大删表」守卫纪律 +
  guard 双保险覆盖残留，代码留注释）。AdminError 挪出 admin-error.ts 断循环依赖。
  int 穷举 8 场景（含非降权不误伤反例）。
- 2026-11-17：Step 4 完成（`8686c78`）——v1 端点 9 个（统一 manageEndpoint 入口封装）；
  `resolveContentScope`（权限→范围唯一实现，contents 页改复用消除两处重复）+ `loadContentDetail`；
  **manage-api 架构守卫**（route 禁业务 import、必须走 manageEndpoint）；两个后台守卫扩展识别
  scope 下沉形态；docs/MANAGE-API.md 契约；本地 curl 拨测 16 项全过。
- 2026-11-17：Step 5 完成（`10ec5b15`）——后台页 /admin/api-tokens（菜单四接线、页面追加不变量
  校验、明文一次性展示 = Service 暂存命中即删+TTL，零新交互形态）；E2E 全链 3 用例。
  E2E 钓出 actions.ts 漏写文件级 `"use server"` 的 RSC 序列化 500 并修复。
- 2026-11-17：Step 6 完成（`855b4af6`）——`api-tokens.cleanup`（每日 04:10）三表 GC
  （token 30 天 / sessions 7 天——顺还 idx_sessions_expires 空挂旧账 / email_tokens 30 天）；
  CLI `api-tokens:cleanup` 共锁；SCHEDULED-JOBS.md 任务数 5→6；int 三表「超期删/窗口内留」穷举。
- 2026-11-17：Step 7 完成（`a60dd5ff`）——清账三项：死权限点 4 个移除（词表 28→24 + bootstrap
  按词表全集反选幂等清理含孤儿授权）+ migration 映射移除 + AUTHZ.md 同步；register.mode 兼容键
  bootstrap 搬迁（先于补缺翻译写入删旧键）+ 读兼容层全删 + 种子/夹具改 register.policy；
  points.gate_fee_rate / punch.reward 补 UI（/admin/points 新卡 + saveGatePunchAction）。
  **本地存量库实演**：14 死授权同步删、invite→新键翻译正确、db:verify 21 项绿。
- 2026-11-17：Step 8 完成（`3c6620ac`）——两路独立审查（安全面+一致性 / 分层+测试+文档+死码）
  **无 P0/P1**，16 条 P2/P3 清零：审计补 via:"api" 落地 + manage_api 审计 int 断言；明文暂存绑定
  签发人 + TTL 清扫；限流桶全哈希；ID 严格十进制判定；资格校验下沉 Service（入口零 db 直连）；
  **抓出并修复安装管线真回归**（siteConfigured 判定键 register.policy→site.identity，否则 M20 后
  全新安装会跳过站点配置步）；死码清理（policyFromLegacyMode/userIdOf）；补测 5 项。
  web 全量 4858 测试绿。
- 2026-11-17：Step 9 收口——verify:all 全绿（EXIT=0：lint/format/三包单测/重复棘轮 1425≤1425/构建）；emails/push-logs 收敛 manageLogEndpoint 工厂 + 分页片段提取 params.ts（重复度回锚 1425/160，提交 0eeceaf6）；E2E 全量 **prod 536 passed（13.7m，含 api-tokens 全链 3 用例）+ dev 冒烟 8 passed，EXIT=0**。
- 2026-11-18：**发版完成**——站长验收通过（两条意见落地：CopyCode 快速复制、后台表格样式组件收敛
  §2 纪律延伸至视觉层：users/authz-forum/ops 台账迁移唯一 AdminDataTable、emojis token 对齐；
  e2e-visual 钓出并修复 3 处 M19 回执键漏网）。PR #19 CI 双作业绿两轮（verify 10m30s / e2e 17m30s），
  合并 main `f42c1fe2`；镜像 `funwind-web:20261118-f42c1fe2` save/load 至 QY_HK 部署（回滚点
  `20261117-d67cd470`）；容器内 db:bootstrap 应用迁移 0031 并完成清账实演（越界授权 15 行删、
  词表 24、61 表全集一致），db:verify 21 项全绿；公网核对：/admin/api-tokens 307、
  /api/manage/whoami 401 JSON 信封语义正确、调度器 6 任务含 api-tokens.cleanup。观察期事项：
  站长真机签发首枚 Token 并跑通真实调用、api-tokens.cleanup 首次执行结果、M21 接入准备。
