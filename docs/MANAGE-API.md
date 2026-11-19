# FunWind 管理 REST API v1（`/api/manage/**`）

> 本文是管理 REST 的仓库契约：M20 的九个 GET 原样保留，M20.2 增加细粒度令牌和两个内容写端点。本文描述仓库实现，不代表 M20.2 已部署或通过外网验收。M21 管理 MCP 仅封装已发布并验收的 REST 能力，写工具另行确认。
>
> **入口薄、服务层负责业务**：REST 路由经统一门禁、解析请求并调用服务；后台 Server Action 与 REST 共用内容治理事务核心。改端点须同步 `lib/manage/permissions.ts` 目录、本文及相关守卫；令牌资格及授权边界见 [AUTHZ.md](AUTHZ.md#9-管理-rest-令牌授权)。

## 鉴权与签发

- 只接受 `Authorization: Bearer <令牌>`。后台「系统与观测 → API 令牌」自签自管（`/admin/api-tokens`）：名称去首尾空白后 1–64 字符，有效期 30/90/180/365 天（默认 90），每管理员最多 5 个未过期且未吊销的令牌。明文只显示一次，凭证仅存 SHA-256，列表可见尾 8 字符；不要在 URL、请求体或日志中传递令牌。
- 新版签发 `fw_at2_` + 43 个 URL 安全字符，按 8 个域选择「禁止／只读／读写」，默认全部禁止、至少选择一个可用域；除令牌身份、站点统计与四类日志域外，其余十一域均支持读写。「读写」包含签发时该域的读端点与写端点。各日志域和统计域即使共用 `admin.logs`，也分别授权。
- 权限标签 `domain:read` / `domain:write` 用于分类；运行时检查的是**具体端点 ID**。签发时生成不可编辑的端点快照，且复核持有人资格、全局业务权限和配额；同域以后新增端点也不会自动扩权，需签发新令牌并吊销旧令牌。
- 历史 `fw_at_`（同样后接 43 个字符）固定为 M20 九读，不授权写入。新版凭证与库内模型必须双向匹配；未知模型、空/重复/未知 ID 的新版快照、历史模型携带快照或前缀错配均不回落而拒绝。同库退版时旧镜像不认 `fw_at2_`；迁移及复升见[上线手册](ops/LAUNCH-RUNBOOK.md#7-m202-管理-rest-升级停写与退版)。
- 凭证有效还须持有人当前满足站点管理员资格（`site.admin` + `admin.roles`、可登录、未封禁），并具有下表所列全局权限；对象范围和敏感字段继续由业务判定。只有版主权限不能签发或使用令牌。过期、手动吊销及失去站点管理员资格的联动吊销照旧；请求入口另做实时资格校验，不保证能中断已通过门禁的在途写。
- 频控为进程内单实例语义：可信 IP 120 次/分钟（取不到可信 IP 跳过此桶），每令牌 60 次/分钟（按格式合法的凭证计，包括后续鉴权失败者）。写入再受下文独立频控；429 返回 `Retry-After`（秒）。

```bash
curl -H "Authorization: Bearer ${FUNWIND_MANAGE_TOKEN}" \
  "${FUNWIND_BASE_URL}/api/manage/whoami?include=token_permissions"
```

## 统一信封与错误码

成功 HTTP 200：`{ "ok": true, "data": … }`。失败：`{ "error": { "code": "…", "message": "中文文案" } }`。管理入口封装产生的响应均带 `Cache-Control: private, no-store`。

| 错误码 | HTTP | 语义 |
|---|---|---|
| `unauthorized` | 401 | 无凭证、格式错误、查无、过期、已吊销、持有人注销或凭证的授权模型无效 |
| `forbidden` | 403 | 凭证有效，但持有人资格、端点授权或所需的全局业务权限不足 |
| `not_found` | 404 | 对象不存在或对象越权，两者同型；被转发到入口的非登记方法也不运行处理器 |
| `bad_request` | 400 | 路径参数、查询参数、幂等键或 JSON 无效 |
| `state_conflict` | 409 | 审核对象状态或版本不符合前置条件；重新读取后再决定是否操作 |
| `idempotency_conflict` | 409 | 同一令牌、端点下，未过期的同一键已用于不同目标或参数 |
| `payload_too_large` | 413 | 请求体超过 16 KiB |
| `unsupported_media_type` | 415 | 请求体媒体类型不是 `application/json` |
| `rate_limited` | 429 | 超出频控，按 `Retry-After` 等待 |
| `internal` | 500 | 服务内部错误，不透传细节 |
| `writes_disabled` | 503 | 管理 REST 写入口未开启 |

## 端点清单

路径使用权限目录中的模板，不含查询串。以下权限还须满足上文的通用门禁。框架派生的 `HEAD`、`OPTIONS` 不授予数据权限，不调用管理业务。

| 方法 | 路径 | 权限 | 稳定端点 ID | 附加业务判定 |
|---|---|---|---|---|
| `GET` | `/api/manage/whoami` | `identity:read` | `whoami` | 无附加全局权限 |
| `GET` | `/api/manage/stats` | `stats:read` | `stats` | `admin.logs` |
| `GET` | `/api/manage/users` | `users:read` | `users` | `admin.users` |
| `GET` | `/api/manage/users/{uid}` | `users:read` | `users.detail` | `admin.users`；敏感字段另需 `user.viewIp` |
| `POST` | `/api/manage/users/{uid}/restrictions` | `users:write` | `users.restrict` | `admin.users`；五类限制的 kind×scope 配对、`endsAt` 未来性在服务层复核 |
| `DELETE` | `/api/manage/users/{uid}/restrictions/{restrictionId}` | `users:write` | `users.lift` | `admin.users`；uid 与限制行归属不一致按不存在处理 |
| `DELETE` | `/api/manage/users/{uid}/sessions/{sessionId}` | `users:write` | `users.revoke-session` | `admin.users`；uid 与会话归属不一致按不存在处理 |
| `POST` | `/api/manage/users/{uid}/appeals/{appealId}/resolve` | `users:write` | `users.resolve-appeal` | `admin.users`；approved 仅是复核结论，不自动解除限制 |
| `GET` | `/api/manage/contents` | `contents:read` | `contents` | `resolveContentScope` |
| `GET` | `/api/manage/contents/{id}` | `contents:read` | `contents.detail` | `resolveContentScope`；范围外同不存在 |
| `GET` | `/api/manage/audit-logs` | `audit-logs:read` | `audit-logs` | `admin.logs` |
| `GET` | `/api/manage/emails` | `emails:read` | `emails` | `admin.logs` |
| `GET` | `/api/manage/push-logs` | `push-logs:read` | `push-logs` | `admin.logs` |
| `POST` | `/api/manage/posts/{postId}/review` | `contents:write` | `posts.review` | 帖子所在版块的 `forum.moderate` |
| `POST` | `/api/manage/posts/{postId}/hide` | `contents:write` | `posts.hide` | 帖子所在版块的 `forum.moderate` |
| `POST` | `/api/manage/posts/{postId}/disable` | `contents:write` | `posts.disable` | 帖子所在版块的 `forum.moderate` |
| `POST` | `/api/manage/posts/{postId}/restore` | `contents:write` | `posts.restore` | 帖子所在版块的 `forum.moderate` |
| `PUT` | `/api/manage/threads/{threadId}/lock` | `contents:write` | `threads.lock` | 既有 `site.admin` 或目标版块 `forum.moderate` 判定 |
| `PATCH` | `/api/manage/threads/{threadId}/flags` | `contents:write` | `threads.flags` | 既有 `site.admin` 或目标版块 `forum.moderate` 判定；置顶级别版主 ≤1、站点管理员 ≤3 |
| `GET` | `/api/manage/reports` | `reports:read` | `reports` | `admin.reports` |
| `GET` | `/api/manage/reports/{reportId}` | `reports:read` | `reports.detail` | `admin.reports` |
| `POST` | `/api/manage/reports/{reportId}/resolve` | `reports:write` | `reports.resolve` | `admin.reports` |
| `POST` | `/api/manage/reports/{reportId}/dismiss` | `reports:write` | `reports.dismiss` | `admin.reports` |
| `GET` | `/api/manage/announcements` | `announcements:read` | `announcements` | 无附加全局权限；状态由时间窗派生 |
| `GET` | `/api/manage/announcements/{announcementId}` | `announcements:read` | `announcements.detail` | 无附加全局权限 |
| `POST` | `/api/manage/announcements` | `announcements:write` | `announcements.create` | `startsAt` null=立即开始；`endsAt` null=长期 |
| `PATCH` | `/api/manage/announcements/{announcementId}` | `announcements:write` | `announcements.edit` | 无 revision：行锁串行；`startsAt` null=保留原值；值未变不写审计 |
| `POST` | `/api/manage/announcements/{announcementId}/end` | `announcements:write` | `announcements.end` | `ends_at` 置当前时刻 |
| `GET` | `/api/manage/campaigns` | `campaigns:read` | `campaigns` | 无附加全局权限；列表不分页（上限 500） |
| `GET` | `/api/manage/campaigns/{campaignId}` | `campaigns:read` | `campaigns.detail` | 无附加全局权限 |
| `POST` | `/api/manage/campaigns` | `campaigns:write` | `campaigns.create` | enabled 恒 true、revision=1；行为类窗口重叠 409 |
| `PATCH` | `/api/manage/campaigns/{campaignId}` | `campaigns:write` | `campaigns.edit` | `expectedRevision` 不一致 409（乐观锁） |
| `POST` | `/api/manage/campaigns/{campaignId}/enabled` | `campaigns:write` | `campaigns.enabled` | 同值 `changed:false`；实际启停 revision+1（G-20） |
| `GET` | `/api/manage/invites` | `invites:read` | `invites` | 无附加全局权限；状态由使用/过期时间派生 |
| `POST` | `/api/manage/invites` | `invites:write` | `invites.generate` | 单次 ≤20 张、有效期 ≤3650 天；同键回放返回同一批码 |
| `DELETE` | `/api/manage/invites/{code}` | `invites:write` | `invites.revoke` | 吊销=物理删除未用码；已用 409 |
| `POST` | `/api/manage/invites/batches/{batch}/revoke` | `invites:write` | `invites.revoke-batch` | 吊销批次全部可用码（已用码不受影响）；无可用码 404 |
| `GET` | `/api/manage/forums` | `forums:read` | `forums` | 无附加全局权限；含归档全量 |
| `GET` | `/api/manage/forums/{fid}` | `forums:read` | `forums.detail` | 无附加全局权限 |
| `POST` | `/api/manage/forums` | `forums:write` | `forums.create` | 父级深度自动计算；创建后权限快照失效重建 |
| `PATCH` | `/api/manage/forums/{fid}` | `forums:write` | `forums.edit` | 子树迁移 + 环检测；板块图不经此端点 |
| `DELETE` | `/api/manage/forums/{fid}` | `forums:write` | `forums.delete` | 硬删双守卫：有子版块或有主题 409 |
| `POST` | `/api/manage/forums/{fid}/prefixes` | `forums:write` | `forums.prefix-add` | 前缀名 ≤64 字 |
| `DELETE` | `/api/manage/forums/{fid}/prefixes/{prefixId}` | `forums:write` | `forums.prefix-remove` | 物理删除前缀行 |
| `GET` | `/api/manage/polls` | `polls:read` | `polls` | 状态由 endsAt 派生（open/closed） |
| `POST` | `/api/manage/polls/{threadId}/close` | `polls:write` | `polls.close` | 按主题 ID 定位；已截止 409 |
| `POST` | `/api/manage/polls/{threadId}/reopen` | `polls:write` | `polls.reopen` | 清除截止时间 |
| `DELETE` | `/api/manage/polls/{threadId}` | `polls:write` | `polls.delete` | 硬删投票/选项/选票，主题回普通帖 |
| `DELETE` | `/api/manage/pm/messages/{messageId}` | `pm:write` | `pm.message-delete` | 软删：正文覆写 + 理由必填入审计 |
| `GET` | `/api/manage/badges` | `badges:read` | `badges` | `admin.badges`；可授予荣誉字典口径 |
| `POST` | `/api/manage/users/{uid}/badges/{badgeId}` | `badges:write` | `badges.grant` | `admin.badges`；team 徽章拒、已持有 409；授予通知当事人 |
| `DELETE` | `/api/manage/users/{uid}/badges/{badgeId}` | `badges:write` | `badges.revoke` | `admin.badges`；撤销通知当事人 |
| `GET` | `/api/manage/points/ledger` | `points:read` | `points.ledger` | `admin.points`；`userId` 必填 |
| `GET` | `/api/manage/points/rules` | `points:read` | `points.rules` | `admin.points`；奖励与门闸费率只读聚合 |
| `POST` | `/api/manage/points/adjustments` | `points:write` | `points.adjust` | `admin.points`；走 `adjust.admin` 渠道，台账同事务，delta 非零+备注必填 |
| `GET` | `/api/manage/emojis` | `emojis:read` | `emojis` | `emoji.manage`；含停用全量 |
| `POST` | `/api/manage/emoji-groups` | `emojis:write` | `emojis.group-create` | `emoji.manage`；组名唯一（重名 409） |
| `PATCH` | `/api/manage/emoji-groups/{groupId}` | `emojis:write` | `emojis.group-rename` | `emoji.manage`；同值 `changed:false` |
| `POST` | `/api/manage/emoji-groups/{groupId}/enabled` | `emojis:write` | `emojis.group-enabled` | `emoji.manage`；停用不影响已发布正文 |
| `DELETE` | `/api/manage/emoji-groups/{groupId}` | `emojis:write` | `emojis.group-delete` | `emoji.manage`；组内非空 409 |
| `POST` | `/api/manage/emoji-groups/{groupId}/sort` | `emojis:write` | `emojis.group-reorder` | `emoji.manage`；sort 0–9999 |
| `PATCH` | `/api/manage/emojis/{emojiId}` | `emojis:write` | `emojis.update` | `emoji.manage`；改名+关键词+排序；上传新图不经此端点 |
| `POST` | `/api/manage/emojis/{emojiId}/enabled` | `emojis:write` | `emojis.enabled` | `emoji.manage`；同值 `changed:false` |

## 读取端点说明

列表分页参数为 `page`（整数 ≥1，默认 1）、`size`（只接受 10/20/50/100；用户与内容列表默认 20，审计、邮件、推送日志默认 50）。下面列出成功信封的 `data`；各端点保留原有分页返回结构。

- **令牌身份（`whoami`）**：默认仍为 `{token, user, permissions}`；`token` 含 `name`、`suffix`、`createdAt`、`expiresAt`、`lastUsedAt`，`user` 含 `id`、`username`，`permissions` 是持有人通过评估的权限点，不是令牌授权。仅在 `include=token_permissions` 时增返 `tokenPermissions: {granted, effective}`，两组元素均为 `{id, method, path, scope}`。`granted` 是精确快照，`effective` 再按实时全局业务权限裁剪；后者不反映停写开关、不保证具体对象可操作。此端点也必须在令牌授权内。
- **统计（`stats`）**：`registered30`、`threads30`、`replies30`（近 30 日逐日值），`todayLogins`，`totals: {users, threads, posts}`。
- **用户列表（`users`）**：`q` 纯数字按 UID，否则用户名包含；`status` 为 `all` 或 `restricted`；`lifecycle` 为 `active`（默认）、`closure_pending`、`deleted` 或 `all`；`credential` 为 `all`、`email_unverified`、`no_password` 或 `legacy_password_pending`；`sort` 为 `recent`（默认）、`id` 或 `threads`。返回 `{items, total, page, totalPages}`。
- **用户详情（`users.detail`）**：按 `uid` 返回资料、积分、角色、限制、申诉、会话、审计台账等聚合；邮箱/IP 等敏感字段受 `user.viewIp` 控制。
- **内容列表（`contents`）**：`kind` 为 `thread`（默认）或 `reply`；`q` 在主题时搜标题，回帖时搜正文或主题标题；`forumId` 限定版块；`state` 为 `all`（默认）、`visible`、`pending`、`rejected`、`hidden`、`deleted` 或 `disabled`；`order` 为 `recent`（默认，最新在前）或 `queue`（最早在前；待审队列另传 `state=pending`）。返回 `{items, total, page, totalPages}`。
- **内容详情（`contents.detail`）**：`kind=thread`（默认）时 `id` 是 TID，首帖在 `firstPost`；`kind=reply` 时 `id` 是 PID，详情含所属主题和正文。审核需要 PID 与编辑版本：分别取 `firstPost.postId` / `firstPost.editedAt`，或回复详情的 `postId` / `editedAt`。`editedAt` 可为 `null`。
- **审计日志（`audit-logs`）**：`action`、`actor`（纯数字按 UID，否则按用户名精确查找；无法解析出 UID 时不添加操作者过滤条件）、`targetType`、`from` / `to`（`YYYY-MM-DD`，含起止当日）。返回 `{items, total}`。
- **邮件日志（`emails`）**：`status` 为 `sent` 或 `failed`；`kind`、`scene` 各接受 `verify`、`security`、`notice`、`digest`、`system`；`q` 纯数字按用户 ID，否则按收件地址包含。返回 `{items, total, summary: {sent, failed}}`，摘要为近 24 小时成败计数。
- **推送日志（`push-logs`）**：`status` 为 `sent` 或 `failed`；`scene` 为 `pm-received`、`post-replied` 或 `post-mentioned`；`q` 纯数字按用户 ID，否则按订阅地址包含。返回 `{items, total, summary: {sent, failed}}`，摘要为近 24 小时成败计数，不返回推送正文。

## 写入端点与无损重试

**默认停写。** 仅应用进程中 `MANAGE_API_WRITES=on`（精确小写）启用写入，留空或其它值均关闭。先检查凭证、快照和附加全局权限，再检查开关和写入桶（10 次/分钟/令牌、30 次/分钟/持有人），通过后才读取正文。停写不影响九个 GET，也不撤销已提交的数据。

写端点都要求路径目标为十进制正安全整数、`Content-Type: application/json`，正文为严格 JSON 对象（UTF-8，实际读取至多 16 KiB；不收未知字段或批量），以及 `Idempotency-Key`（16–128 个字符，只允许 `A–Z`、`a–z`、`0–9`、`.`、`_`、`:`、`-`）。

- **单帖审核（`posts.review`）**：正文为 `{"decision":"approve","expectedEditedAt":null}` 或 `{"decision":"reject","expectedEditedAt":"2026-11-18 12:00:00","reason":"…"}`。`expectedEditedAt` 必传，原样使用刚读取的北京时间秒级 `YYYY-MM-DD HH:mm:ss` 或 `null`，不要换算为 UTC。驳回理由去首尾空白后须为 1–255 字，通过不接受 `reason`。首次实际执行只允许待审帖子，事务锁内核对帖子、主题、版块归属及编辑版本；错版或不再待审为 `state_conflict`。返回 `{postId, threadId, state}`，其中 `state` 为 `visible` 或 `rejected`。沿用既有审核历史、计数及事务性事件链路（通知、通过时的首次积分）。
- **主题锁定／解锁（`threads.lock`）**：正文为 `{"locked":true}` 或 `{"locked":false}`，只设置目标值，不翻转，不收置顶或精华字段。锁内复核主题归属并比较原值，返回 `{threadId, locked, changed}`；同值时 `changed: false`，不改主题、不记变更审计。相反目标值按事务串行顺序生效；没有版本前置条件。

**重试协议：** 每次新的业务意图使用新键；客户端先保存原令牌、方法、目标、参数和键。如果超时、断线或无法判断响应是否到达，24 小时窗口内用**同一令牌、端点、目标、规范化参数和键**重试（遇 429 先等待），不要为重试换新键，也不要悄悄换审核版本。键按「令牌 + 端点 ID + 键」隔离，只保存键的摘要；指纹由目标和校验后的参数生成，字段顺序不影响判断。

- 每次重试仍须经过当前鉴权、权限、开关、频控及目标范围检查；落库前的同键并发由数据库唯一键串行。24 小时内同键同请求返回原成功 `data`（包括原 `changed`），不会再次检查业务状态前置条件、变更、写变更审计或发业务事件。不能把回放当作当前状态。同键改目标或参数、且目标可访问时返回 `idempotency_conflict`。
- 幂等结果与业务数据、变更审计、需要入队的 outbox 事件在同一事务提交；事务失败不会留下成功记录。同键可在失败原因排除后重试；如果响应丢失但事务已提交，回放取原结果。HTTP 同键回放不会重复作出变更或入队；提交后快派失败不改变已保存的成功结果，持久化 outbox 仍按既有至少一次语义补派，不承诺 SMTP 邮件或 Web Push 端到端仅投递一次。
- 超过 24 小时不保证回放，即使记录尚未清扫也可能重新执行。此时或无法再使用原凭证时应先读回最新状态（必要时结合审计），再决定要不要发起新操作；不要盲目改键或换令牌重试。

## 审计与维护入口

- **调用审计**：除 `whoami`（既不记调用记录也不更新使用时间）外，通过入口门禁的请求在业务处理前写 `action=api.<端点 ID>`、`targetType=manage_api`。读请求记路径和截断的查询摘要；写请求记目录路径模板、令牌尾号、`via: "api"`、`requestId`，不记录原始 query、请求体、幂等键、Bearer 或完整哈希。使用时间/IP 在这里以 60 秒节流更新。参数失败、对象拒绝及成功回放也可能有调用记录；它不是写成功证明。未通过门禁（例如停写或缺授权）不记该调用记录。
- **变更审计**：真正的审核和锁位变化随业务事务写 `post.state.visible` / `post.state.rejected` 或 `admin.thread.flags`，含操作者、业务目标、前后状态、`via: "api"`、令牌尾号和关联 `requestId`；审核另含业务理由（如有），不写帖子正文或原始请求体。锁位同值、失败事务和成功回放没有新的变更记录。
- **源码入口**：`apps/web/src/app/api/manage/` 的路由由 `manage-api-guard.test.ts` 核对方法、路径和端点 ID。`lib/manage/route.ts` / `guard.ts` / `errors.ts` 统一门禁、信封和错误；`tokens.ts` / `permissions.ts` 负责令牌与授权目录；`content-writes.ts` / `idempotency.ts` 连接写入事务及业务服务 `lib/moderation/review.ts`、`lib/moderation/contents.ts`。过期幂等记录由[定时任务](SCHEDULED-JOBS.md#管理-rest-幂等记录清扫)有界清扫。
