# FunWind 管理 REST API v1（`/api/manage/**`）

> 本文是管理 REST 的仓库契约。当前目录保留 M20 的九个 GET，并覆盖 M20.2 与 M20.3 新增能力。端点清单以仓库实现为准。M21 管理 MCP 仅封装已发布并验收的 REST 能力，写工具另行确认。
>
> **入口薄、服务层负责业务**。REST 路由经统一门禁解析请求，再调用业务服务。改端点须同步 `lib/manage/catalog.ts` 目录、本文及相关守卫。令牌资格及授权边界见 [AUTHZ.md](AUTHZ.md#9-管理-rest-令牌授权)。

## 鉴权与签发

- 只接受 `Authorization: Bearer <令牌>`。后台「系统与观测 → API 令牌」自签自管（`/admin/api-tokens`）：名称去首尾空白后 1–64 字符，有效期 30/90/180/365 天（默认 90），每管理员最多 5 个未过期且未吊销的令牌。明文只显示一次，凭证仅存 SHA-256，列表可见尾 8 字符；不要在 URL、请求体或日志中传递令牌。
- 新版签发 `fw_at2_` 加 43 个 URL 安全字符。按 21 个域选择「禁止／只读／读写」，默认全部禁止，至少选择一个可用档位。20 个域有读端点，16 个域有写端点，其中 15 个域同时有读写端点。令牌身份、站点统计、审计日志、邮件日志、推送日志仅读，私信域仅写。读写档包含该域可签发的读、写端点，在私信域只授予写端点。统计、审计、邮件、推送四域虽共用 `admin.logs`，仍分别授权。
- 权限标签 `domain:read` / `domain:write` 用于分类；运行时检查的是**具体端点 ID**。签发按整档校验：缺少任一所选档位内端点的全局权限时，拒绝该次签发，不会跳过端点部分签发。`roles:write` 包含用户角色绑定与解绑，因而还要求持有人具备 `admin.users`；无此权限可选择 `roles:read`。签发时生成不可编辑的端点快照，同域以后新增端点也不会自动扩权，需签发新令牌并吊销旧令牌。
- 历史 `fw_at_`（同样后接 43 个字符）固定为 M20 九读，不授权写入。新版凭证与库内模型必须双向匹配；未知模型、空/重复/未知 ID 的新版快照、历史模型携带快照或前缀错配均不回落而拒绝。同库退版时旧镜像不认 `fw_at2_`；迁移及复升见[上线手册](ops/LAUNCH-RUNBOOK.md#7-m202-管理-rest-升级停写与退版)。
- 凭证有效还须持有人当前满足站点管理员资格（`site.admin` + `admin.roles`、可登录、未封禁），并具有下表所列全局权限；对象范围和敏感字段继续由业务判定。只有版主权限不能签发或使用令牌。过期、手动吊销及失去站点管理员资格的联动吊销照旧；请求入口另做实时资格校验。六个角色写端点在事务内、幂等裁决前还会复核凭证及当前授权，先提交的撤权或吊销会阻止业务写和回放；其他端点不保证中断已通过门禁的在途写。
- 频控为进程内单实例语义：可信 IP 120 次/分钟（取不到可信 IP 跳过此桶），每令牌 60 次/分钟（按格式合法的凭证计，包括后续鉴权失败者）。写入再受下文独立频控；429 返回 `Retry-After`（秒）。

```bash
curl -H "Authorization: Bearer ${FUNWIND_MANAGE_TOKEN}" \
  "${FUNWIND_BASE_URL}/api/manage/whoami?include=token_permissions"
```

## 统一信封与错误码

成功响应通常为 HTTP 200 和 `{ "ok": true, "data": … }`。运维任务触发使用同一信封，管线受理后返回 HTTP 202。失败响应使用对应的 HTTP 状态和 `{ "error": { "code": "…", "message": "中文文案" } }`。管理入口封装产生的响应均带 `Cache-Control: private, no-store`。

| 错误码 | HTTP | 语义 |
|---|---|---|
| `unauthorized` | 401 | 无凭证、格式错误、查无、过期、已吊销、持有人注销或凭证的授权模型无效 |
| `forbidden` | 403 | 凭证有效，但持有人资格、端点授权或所需的全局业务权限不足 |
| `not_found` | 404 | 对象不存在或对象越权，两者同型；被转发到入口的非登记方法也不运行处理器 |
| `bad_request` | 400 | 路径参数、查询参数、幂等键或 JSON 无效 |
| `state_conflict` | 409 | 资源状态或版本不符合前置条件，应先读取最新状态 |
| `idempotency_conflict` | 409 | 同一令牌、端点下，未过期的同一键已用于不同目标或参数 |
| `payload_too_large` | 413 | 请求体超过 16 KiB |
| `unsupported_media_type` | 415 | 请求体媒体类型不是 `application/json` |
| `rate_limited` | 429 | 超出频控，按 `Retry-After` 等待 |
| `internal` | 500 | 服务内部错误，不透传细节 |
| `ops_unavailable` | 503 | 运维任务管线暂不可用。不透传管线响应或内部错误细节 |
| `writes_disabled` | 503 | 管理 REST 写入口未开启 |

## 端点清单

当前目录共有 **82 个端点（30 读、52 写），覆盖 21 个域**。与 Step 4 相比，M20.3 Step 5 新增 **19 个端点（7 读、12 写）**，分布在角色、设置、运维与主题四域。

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
| `POST` | `/api/manage/announcements` | `announcements:write` | `announcements.create` | 两个日期字段均必传；`startsAt:null` 表示立即开始，`endsAt:null` 表示长期 |
| `PATCH` | `/api/manage/announcements/{announcementId}` | `announcements:write` | `announcements.edit` | 行锁串行，无 revision；`startsAt:null` 保留原值，`endsAt:null` 清除截止时间 |
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
| `GET` | `/api/manage/roles` | `roles:read` | `roles` | `admin.roles` |
| `GET` | `/api/manage/roles/{roleKey}` | `roles:read` | `roles.detail` | `admin.roles`。路径键允许以数字开头 |
| `POST` | `/api/manage/roles` | `roles:write` | `roles.create` | `admin.roles`。内置键或重复键返回 409 |
| `DELETE` | `/api/manage/roles/{roleKey}` | `roles:write` | `roles.delete` | `admin.roles`。内置角色和固定团队角色不可删，`roleKey` 参与幂等指纹 |
| `PUT` | `/api/manage/roles/{roleKey}/grants/{permission}` | `roles:write` | `roles.grant` | `admin.roles`。隐式角色不得全局授予管理权限 |
| `DELETE` | `/api/manage/roles/{roleKey}/grants/{permission}` | `roles:write` | `roles.revoke` | `admin.roles`。保护 `admin` 的全局 `site.admin` 和 `admin.roles` 授权，撤权联动吊销 API 令牌 |
| `PUT` | `/api/manage/users/{uid}/roles/{roleKey}` | `roles:write` | `users.role-assign` | `admin.users`。`expiresAt` 缺省为 `null`，`uid` 和 `roleKey` 参与幂等指纹 |
| `DELETE` | `/api/manage/users/{uid}/roles/{roleKey}` | `roles:write` | `users.role-revoke` | `admin.users`。不接受 `expiresAt`，`uid` 和 `roleKey` 参与幂等指纹 |
| `GET` | `/api/manage/settings` | `settings:read` | `settings` | `?group=` 按白名单查询并投影允许字段，缺省返回分组索引 |
| `PATCH` | `/api/manage/settings/{group}` | `settings:write` | `settings.update` | 请求体为组内结构，逐组严格校验，`limits` 锁内合并 |
| `GET` | `/api/manage/ops/tasks` | `ops:read` | `ops` | 返回任务及触发器，配置表未建时返回空列表 |
| `GET` | `/api/manage/ops/runs` | `ops:read` | `ops.runs` | 分页读取运行台账 |
| `POST` | `/api/manage/ops/tasks/{taskKey}/trigger` | `ops:write` | `ops.trigger` | 管线受理后返回 202 与 `{taskKey, runId, accepted: true}`，无需幂等键 |
| `PATCH` | `/api/manage/ops/tasks/{taskKey}/enabled` | `ops:write` | `ops.enabled` | 字符串 `taskKey` 定位任务。同值 `changed: false`，实际启停递增 `revision` |
| `PATCH` | `/api/manage/ops/tasks/{taskKey}/params` | `ops:write` | `ops.params` | 字符串 `taskKey` 定位任务，`expectedRevision` 不一致返回 409 |
| `GET` | `/api/manage/themes` | `themes:read` | `themes` | 包含已停用主题包 |
| `GET` | `/api/manage/themes/{packId}` | `themes:read` | `themes.detail` | 包含 `definition` 与 `revision` |
| `PATCH` | `/api/manage/themes/{packId}` | `themes:write` | `themes.edit` | 只改名称与描述，`packId` 和 `expectedRevision` 参与幂等指纹 |
| `POST` | `/api/manage/themes/{packId}/enabled` | `themes:write` | `themes.enabled` | `default` 不可停用，同时启用最多 5 个包，同值 `changed: false` |

## 读取端点说明

只有分页端点接受 `page`（整数 ≥1，默认 1）与 `size`（10/20/50/100）；非法值返回 `bad_request`（400）。默认每页 20 条：用户、内容、举报、公告、邀请码、投票、积分台账、运维运行历史。默认每页 50 条：审计日志、邮件日志、推送日志、表情列表（只分页表情条目，不分页表情组）。下面列出部分成功信封的 `data`；各端点的分页响应结构不统一。

- **令牌身份（`whoami`）**：默认仍为 `{token, user, permissions}`；`token` 含 `name`、`suffix`、`createdAt`、`expiresAt`、`lastUsedAt`，`user` 含 `id`、`username`，`permissions` 是持有人通过评估的权限点，不是令牌授权。仅在 `include=token_permissions` 时增返 `tokenPermissions: {granted, effective}`，两组元素均为 `{id, method, path, scope}`。`granted` 是精确快照，`effective` 再按实时全局业务权限裁剪；后者不反映停写开关、不保证具体对象可操作。此端点也必须在令牌授权内。
- **统计（`stats`）**：`registered30`、`threads30`、`replies30`（近 30 日逐日值），`todayLogins`，`totals: {users, threads, posts}`。
- **用户列表（`users`）**：`q` 纯数字按 UID，否则用户名包含；`status` 为 `all` 或 `restricted`；`lifecycle` 为 `active`（默认）、`closure_pending`、`deleted` 或 `all`；`credential` 为 `all`、`email_unverified`、`no_password` 或 `legacy_password_pending`；`sort` 为 `recent`（默认）、`id` 或 `threads`。返回 `{items, total, page, totalPages}`。
- **用户详情（`users.detail`）**：按 `uid` 返回资料、积分、角色、限制、申诉、会话、审计台账等聚合；邮箱/IP 等敏感字段受 `user.viewIp` 控制。
- **内容列表（`contents`）**：`kind` 为 `thread`（默认）或 `reply`；`q` 在主题时搜标题，回帖时搜正文或主题标题；`forumId` 限定版块；`state` 为 `all`（默认）、`visible`、`pending`、`rejected`、`hidden`、`deleted` 或 `disabled`；`order` 为 `recent`（默认，最新在前）或 `queue`（最早在前；待审队列另传 `state=pending`）。返回 `{items, total, page, totalPages}`。
- **内容详情（`contents.detail`）**：`kind=thread`（默认）时 `id` 是 TID，首帖在 `firstPost`；`kind=reply` 时 `id` 是 PID，详情含所属主题和正文。审核需要 PID 与编辑版本：分别取 `firstPost.postId` / `firstPost.editedAt`，或回复详情的 `postId` / `editedAt`。`editedAt` 可为 `null`。
- **审计日志（`audit-logs`）**：`action`、`actor`（纯数字按 UID，否则按用户名精确查找；无法解析出 UID 时不添加操作者过滤条件）、`targetType`、`from` / `to`（`YYYY-MM-DD`，含起止当日）。返回 `{items, total}`。
- **邮件日志（`emails`）**：`status` 为 `sent` 或 `failed`；`kind`、`scene` 各接受 `verify`、`security`、`notice`、`digest`、`system`；`q` 纯数字按用户 ID，否则按收件地址包含。返回 `{items, total, summary: {sent, failed}}`，摘要为近 24 小时成败计数。
- **推送日志（`push-logs`）**：`status` 为 `sent` 或 `failed`；`scene` 为 `pm-received`、`post-replied` 或 `post-mentioned`；`q` 纯数字按用户 ID，否则按订阅地址包含。返回 `{items, total, summary: {sent, failed}}`，摘要为近 24 小时成败计数，不返回推送正文。
- **公告（`announcements`、`announcements.detail`）**：列表默认 `status=all`，覆盖全部状态、受众；`q`（最多 128 字符）按标题做 SQL `LIKE` 包含匹配（`%`、`_` 为通配符）。`scheduled` 筛选尚未开始，`active` 筛选已开始且未到结束时间（含长期），`ended` 筛选已到结束时间。提前下线但尚未到原定开始时间的公告可命中 `ended` 筛选，列表与详情的 `status` 仍优先显示 `scheduled`。列表返回 `{items, total, page, totalPages}`，按 `createdAt` 降序、同一时间按 `id` 升序，越界页码归到最后一页；只有详情含正文，不存在返回 404。
- **积分台账（`points.ledger`）**：必传正整数 `userId`；缺失或查询参数无效返回 `bad_request`（400）。返回 `{items, total, page, totalPages, balance, lifetimeEarned, lifetimeSpent}`，流水按 `id` 降序，越界页码归到最后一页。合法 ID 无账户或流水时相应数值为 0、流水为空，不因用户不存在返回 404。

## 写入端点与无损重试

**默认停写。** 仅应用进程中 `MANAGE_API_WRITES=on`（精确小写）启用写入，留空或其它值均关闭。先检查凭证、快照和附加全局权限，再检查开关和写入桶（10 次/分钟/令牌、30 次/分钟/持有人），通过后才读取正文。读取和已提交的变更不受停写影响。

写端点均使用 `Content-Type: application/json` 和 UTF-8 JSON，正文最多 16 KiB，即使没有 `Content-Length` 也会检查。正文按端点严格校验，通常是对象。设置 `nav`、`links` 直接使用数组，每个数组写入一个配置值。数字路径 ID 须为十进制正安全整数，字符串键按各端点的规则校验。

除 `ops.trigger` 外，所有写端点都要求 `Idempotency-Key`（16–128 字符，只允许 `A–Z`、`a–z`、`0–9`、`.`、`_`、`:`、`-`）。`ops.trigger` 仍受通用写门禁与频控约束，传入的幂等键会被忽略。

- **单帖审核（`posts.review`）**：正文为 `{"decision":"approve","expectedEditedAt":null}` 或 `{"decision":"reject","expectedEditedAt":"2026-11-18 12:00:00","reason":"…"}`。`expectedEditedAt` 必传，原样使用刚读取的北京时间秒级 `YYYY-MM-DD HH:mm:ss` 或 `null`，不要换算为 UTC。驳回理由去首尾空白后须为 1–255 字，通过不接受 `reason`。首次实际执行只允许待审帖子，事务锁内核对帖子、主题、版块归属及编辑版本；错版或不再待审为 `state_conflict`。返回 `{postId, threadId, state}`，其中 `state` 为 `visible` 或 `rejected`。沿用既有审核历史、计数及事务性事件链路（通知、通过时的首次积分）。
- **主题锁定／解锁（`threads.lock`）**：正文为 `{"locked":true}` 或 `{"locked":false}`，只设置目标值，不翻转，不收置顶或精华字段。锁内复核主题归属并比较原值，返回 `{threadId, locked, changed}`；同值时 `changed: false`，不改主题、不记变更审计。相反目标值按事务串行顺序生效；没有版本前置条件。
- **公告创建与编辑**：`title`、`startsAt`、`endsAt` 必填，缺省返回 400。`bodyMd`、`level`、`audience`、`showBanner` 省略时分别取空字符串、`info`、`all`、`false`，编辑同样恢复这些默认值。显式 `startsAt:null` 表示创建取当前时间、编辑保留原值；显式 `endsAt:null` 表示不设截止时间（编辑时清除已有截止时间）。非空日期须为北京时间 `YYYY-MM-DD HH:mm:ss`，校验格式及日历有效性，不强制窗口先后。编辑未改变字段值时不记变更审计，不重发发布事件。

以下重试协议适用于要求幂等键的端点。每次新的业务意图使用新键。如果超时、断线或无法判断响应是否到达，在 24 小时窗口内用**同一令牌、端点、目标、参数和键**重试。遇 429 先等待。键按「令牌 + 端点 ID + 键」隔离，只保存键的摘要。指纹包含目标（含路径中的字符串键）和请求参数（含适用的版本条件）。新指纹不区分 JSON 对象键顺序，但保留数组顺序；重试升级前的回执时请保留原字段顺序。

- 每次重试仍须经过当前鉴权、权限、开关、频控及适用的事务外校验。同键并发由数据库唯一键串行。24 小时内同键同指纹返回原成功 `data`，跳过事务内的目标加锁与业务执行。回放不会再次变更数据、写变更审计或发业务事件。同键换目标或参数会返回 `idempotency_conflict`。
- 幂等结果与业务数据、变更审计、需要入队的 outbox 事件在同一事务提交；事务失败不会留下成功记录。同键可在失败原因排除后重试；如果响应丢失但事务已提交，回放取原结果。HTTP 同键回放不会重复作出变更或入队；提交后快派失败不改变已保存的成功结果，持久化 outbox 仍按既有至少一次语义补派，不承诺 SMTP 邮件或 Web Push 端到端仅投递一次。
- 超过 24 小时不保证回放，即使记录尚未清扫也可能重新执行。此时或无法再使用原凭证时应先读回最新状态（必要时结合审计），再决定要不要发起新操作；不要盲目改键或换令牌重试。

## 角色与用户绑定

所有 `{roleKey}` 路径参数均接受 kebab-case。每段由小写字母和数字组成，段间以单个连字符分隔，允许以数字开头，例如 `2nd-reviewer`。路径键格式不符返回 404。创建 `roles.create` 的正文使用 `key`、`name` 和可选的 `description`。角色列表返回 `items`，详情在列表字段上增加 `grants`（`permissionKey`、`scopeId`）和权限词汇表 `permissions`。

- 角色权限的授予和撤销在路径中指定 `{roleKey}` 和 `{permission}`。正文可传 `scopeId`，缺省为 `0`（全局）。两个路径参数均参与各自的幂等指纹。
- `roles.delete` 的正文为 `{}`，路径中的 `roleKey` 参与幂等指纹。删除角色会清理关联授权和用户绑定。同键同参且复核仍有权时，可回放原删除结果。
- 用户绑定与解绑均属于角色域，需要令牌的 `roles:write` 和持有人的 `admin.users`；`users:write` 不包含这两项。正文须传 `reason`（去首尾空白后 1–255 字符），可传 `scopeId`（缺省 `0`）。绑定可传未来北京时间 `YYYY-MM-DD HH:mm:ss` 格式的 `expiresAt`，省略或传 `null` 均表示永久。解绑不接收 `expiresAt`，传入则返回 400。两者均把 `uid` 和 `roleKey` 纳入幂等指纹。
- 删角色、撤权、解绑或将永久绑定改为限时，如果会移除最后一位永久管理员，返回 `state_conflict`（409）。永久管理员须可登录、未封禁，并通过不设到期的全局绑定持有 `site.admin` 和 `admin.roles`，两项权限可以来自不同角色。临时管理员有效期内仍可使用令牌，但不计入永久保底；受影响用户一旦失去实际管理员资格，其管理 API 令牌会被同事务吊销。

## 站点设置分组

`GET /api/manage/settings` 不带 `group` 或传空值时返回 `data: { groups }`。用 `?group=register` 等白名单分组名查询时，返回 `data: { group, key, value, updatedAt }`，`value` 仅投影允许的字段。未配置时 `value` 和 `updatedAt` 为 `null`。未知非空组返回 404，超过 64 字符的查询组名返回 400。SMTP 配置与凭据只从环境变量读取，测试发信也不在这组端点内。

`PATCH /api/manage/settings/{group}` 请求体直接使用该组的 JSON 结构，返回 `data: { group, key }`。以下是完整白名单。未知组返回 404，组内字段和结构严格校验，未知字段与非法值返回 400。

| 分组 | PATCH 请求体 |
|---|---|
| `identity` | 对象，必填 `name`，可选 `tagline`、`url`（空字符串或 HTTP(S) 地址） |
| `register` | 对象，`open`、`invite`、`verifyEmail` 三个布尔值均须显式提供 |
| `limits` | 扁平对象，必填 `titleMax`、`bodyMax`，以及分别以 `member`、`admin` 为前缀的 `PostIntervalSec`、`ThreadsPerDay`、`UploadsPerDay`、`PmPerDay`、`EditWindowSec` 五项整数额度，如 `memberPostIntervalSec` |
| `email.security`、`email.ops`、`push.enabled` | 对象，必填布尔 `enabled` |
| `email.digest` | 对象，必填北京时间小时 `hour`（0–23） |
| `nav`、`links` | 裸数组，最多 20 项，每项仅含 `label`（1–32 字符）、`href`（`nav` 最多 200，`links` 最多 300）。`nav` 仅接受站内路径，`links` 还接受 HTTP(S) 链接 |
| `footer` | 对象，可选 `text`，默认空字符串（最多 300 字符） |

`limits` 的 GET `value` 使用嵌套的 `{ titleMax, bodyMax, roles }` 结构。PATCH 在事务行锁内读取现值，合并时仅替换站点级两项和 `member`、`admin` 的额度，保留其他角色并校验合并结果。设置写入无版本前置条件，值变化时记录前后值审计。

设置读取反映管理侧保存的值，不等于前台展示：导航最多存 20 项，站点框架只取前 10 个合格项；友链可存站内路径，但前台只展示 HTTP(S) 链接。后台逐行表单规则不变。`identity`、`register`、`nav`、`links`、`footer` 写入真实提交后使当前进程的站点框架缓存失效；失败和幂等回放不触发，不保证其他进程即时刷新。

```bash
curl -X PATCH -H "Authorization: Bearer ${FUNWIND_MANAGE_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${FUNWIND_IDEMPOTENCY_KEY}" \
  --data '{"open":true,"invite":false,"verifyEmail":true}' \
  "${FUNWIND_BASE_URL}/api/manage/settings/register"
```

## 运维任务与主题包

- **运维配置**：启停、修改参数、手动触发均使用任务列表中的字符串 `taskKey`（如 `backup.db`）。启停正文为 `{"enabled":false}` 等显式布尔设置。修改参数须传 `expectedRevision` 和 `name`、`params` 中至少一项，`params` 按对应执行器校验。配置实际更新后递增 `revision`，提交后尽力通知管线热加载。`taskKey` 参与两项配置写入的幂等指纹。
- **运维触发**：正文为 `{}`。HTTP 202 仅代表管线受理，不表示已执行或成功。任务键无效或任务缺失返回 `not_found`（404），任务停用或管线报告同组忙碌返回 `state_conflict`（409），没有启用的手动触发器或管线拒绝返回 `bad_request`（400）。管线未配置、不可达、降级、内部鉴权失败或异常响应均返回 `ops_unavailable`（503），不透传细节。该端点不使用幂等缓存；断连、超时或 `ops_unavailable` 不能证明未受理，不要盲目重试。先按 `runId`（如已知）或 `taskKey` 与请求时间核对台账，必要时向运维确认；台账当前未见记录也不保证没有受理。恢复与备份同步的独立执行入口不属于管理 REST。
- **运维台账**：`GET /api/manage/ops/runs` 默认 `page=1`、`size=20`，返回 `{ rows, total, totalPages, anyRunning, ledgerMissing }`。管线台账表未建时 `rows` 为空，`ledgerMissing` 为 `true`；越界页码也返回空 `rows`，但不会据此标记台账缺失。
- **主题包**：编辑仅允许修改名称 `name` 和描述 `description`，未提供的字段保留原值。去首尾空白后，名称须为 1–60 字符，描述最多 200 字符（空字符串清空）；超限返回 `bad_request`（400），不截断。必须传 `expectedRevision`，版本不一致返回 409。`packId` 和 `expectedRevision` 均参与编辑的幂等指纹。`definition` 与素材留在后台编辑器，导入导出不在管理 REST 内。实际启停递增 `revision`，提交后清除当前进程的主题目录与站点框架缓存；失败、同值及幂等回放不触发，不保证其他进程即时刷新。

```bash
curl -X POST -H "Authorization: Bearer ${FUNWIND_MANAGE_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{}' \
  "${FUNWIND_BASE_URL}/api/manage/ops/tasks/backup.db/trigger"
```

管线受理后返回 HTTP 202，运行结果以台账为准。

```json
{ "ok": true, "data": { "taskKey": "backup.db", "runId": 42, "accepted": true } }
```

## 审计与维护入口

- **调用审计**：除 `whoami`（既不记调用记录也不更新使用时间）外，通过入口门禁的请求在业务处理前写 `action=api.<端点 ID>`、`targetType=manage_api`。读请求记路径和截断的查询摘要；写请求记目录路径模板、令牌尾号、`via: "api"`、`requestId`，不记录原始 query、请求体、幂等键、Bearer 或完整哈希。使用时间/IP 在这里以 60 秒节流更新。参数失败、对象拒绝及成功回放也可能有调用记录；它不是写成功证明。未通过门禁（例如停写或缺授权）不记该调用记录。
- **变更审计**：真正的审核和锁位变化随业务事务写 `post.state.visible` / `post.state.rejected` 或 `admin.thread.flags`，含操作者、业务目标、前后状态、`via: "api"`、令牌尾号和关联 `requestId`；审核另含业务理由（如有），不写帖子正文或原始请求体。锁位同值、失败事务和成功回放没有新的变更记录。运维触发在管线受理后另记 `ops.task.run` 并关联 `runId`，该审计与跨服务受理分开执行。
- **源码入口**：`apps/web/src/app/api/manage/` 的路由由 `manage-api-guard.test.ts` 核对方法、路径和端点 ID。`lib/manage/route.ts` / `guard.ts` / `errors.ts` 统一门禁、信封和错误；`tokens.ts` / `permissions.ts` / `catalog.ts` 负责令牌与授权目录；`content-writes.ts` / `idempotency.ts` 连接写入事务及业务服务 `lib/moderation/review.ts`、`lib/moderation/contents.ts`。过期幂等记录由[定时任务](SCHEDULED-JOBS.md#管理-rest-幂等记录清扫)有界清扫。
