# FunWind 管理 REST API v1（`/api/manage/**`）

> M20 交付 · 本文档是**契约单一事实源**：M21 管理 MCP 的工具面收敛于此，改端点必须同步本文档与
> `apps/web/src/app/api/manage/manage-api-guard.test.ts`。
>
> 分层纪律（M20 §2）：**入口薄、Service 厚**——Server Action（页面）、REST route（本文档）、
> 未来的 MCP 工具都只是「鉴权 + 参数解析 → 调 Service → 信封」的入口封装；
> 业务语义（事务、审计、权限范围）只在 `apps/web/src/lib/**` 的 Service 层，三类入口自动一致。

## 1. 鉴权：Access Token

1. 后台 `/admin/api-tokens`（「系统与观测 → API 令牌」）签发：名称 + 有效期档位 30/90/180/365 天
   （默认 90，上限 365，不允永久），每管理员最多 **5 个有效** token。
2. 明文形如 `fw_at_<43 字符>`，**仅签发响应中展示一次**，请立即妥善保存；遗失只能吊销重签。
3. 库内只存 SHA-256；列表只见名称与尾号（尾 8 字符），无法找回明文。
4. 三重失效：自身过期、后台一键吊销、**持有人不再满足站点管理员不变量时事务内联动吊销**
   （撤角色/撤授权/删角色/全站封禁/注销申请即刻生效）。
5. 建议：按用途拆分 token（一个脚本一个）、定期轮换（重签 + 吊销旧）、异常使用看 `last_used_at/ip`。

```bash
curl -H "Authorization: Bearer fw_at_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
     https://<站点>/api/manage/whoami
```

- 鉴权失败语义：**401** = 凭证缺失/格式错/查无/过期/已吊销/持有人注销（存在性不泄露，统一口径）；
  **403** = 凭证真实但持有人不再是站点管理员或权限点不足。
- v1 的 token 资格 = **站点管理员不变量**（`site.admin` + `admin.roles` 双持、可登录、未封禁）；
  版主作用域语义对 API 不生效（版主无 token）。
- 频控：IP 桶 120 次/分钟 + per-token 60 次/分钟；429 附 `Retry-After` 头。
- 除 whoami 外的每次调用节流更新 `last_used_at/ip`（60 秒内多次调用只落一次；whoami 为高频握手，不更新）。

## 2. 统一信封与错误码

成功：`{ "ok": true, "data": … }`（HTTP 200）
失败：`{ "error": { "code": "…", "message": "中文文案" } }` + 语义状态码：

| code | HTTP | 语义 |
|---|---|---|
| `unauthorized` | 401 | 凭证缺失、无效或已失效（含过期/吊销/持有人注销） |
| `forbidden` | 403 | 凭证有效但权限不足 |
| `not_found` | 404 | 资源不存在（越权同型，存在性不泄露） |
| `bad_request` | 400 | 请求参数不合法（v1 不静默回落——消费方是程序） |
| `rate_limited` | 429 | 请求过于频繁（带 `Retry-After`） |
| `internal` | 500 | 服务内部错误（不透传细节） |

所有响应带 `cache-control: private, no-store`。分页 data 统一 `{items, total, page, totalPages}`，
`size` 档位白名单 **10/20/50/100**（缺省 20）。

## 3. 端点（v1 全部只读；写端点按 M21 工具需求反推，逐个过站长确认）

| # | 端点 | 权限 | 说明 |
|---|---|---|---|
| 1 | `GET /api/manage/whoami` | 资格 | token 元信息 + 持有人 + 有效权限点全清单；**不写审计**（握手高频） |
| 2 | `GET /api/manage/stats` | `admin.logs` | 看板统计：`registered30/threads30/replies30`（逐日）、`todayLogins`、`totals{users,threads,posts}` |
| 3 | `GET /api/manage/users` | `admin.users` | 用户治理列表。query：`q`（纯数字=uid，否则用户名包含）、`status=all|restricted`、`lifecycle=active|closure_pending|deleted|all`、`credential=all|email_unverified|no_password|legacy_password_pending`、`sort=recent|id|threads`、`page`、`size` |
| 4 | `GET /api/manage/users/{uid}` | `admin.users` | 用户详情三签聚合（资料/邮箱/积分/角色/限制/申诉/会话/审计台账）；`email/ip` 类字段仅当持有人另具 `user.viewIp` 权限 |
| 5 | `GET /api/manage/contents` | 资格 | 内容列表。query：`kind=thread|reply`、`q`（标题/正文）、`forumId`、`state=all|visible|pending|rejected|hidden|deleted|disabled`、`order=recent|queue`（queue=待审先到先审正序）、`page`、`size` |
| 6 | `GET /api/manage/contents/{id}?kind=` | 资格 | 内容行级详情（thread 含首帖正文 bodyMd；reply 含所属主题与正文）；越权与不存在一律 404 |
| 7 | `GET /api/manage/audit-logs` | `admin.logs` | 审计日志检索。query：`action`、`actor`（纯数字=uid，否则用户名精确）、`targetType`、`from`/`to`（YYYY-MM-DD，含当日） |
| 8 | `GET /api/manage/emails` | `admin.logs` | 邮件日志 + 近 24h 成败摘要（`summary{sent,failed}`）。query：`status`、`kind=verify|security|notice|digest|system`、`scene`、`q`（纯数字=userId，否则收件地址包含） |
| 9 | `GET /api/manage/push-logs` | `admin.logs` | 推送日志 + 近 24h 摘要。query：`status`、`scene=pm-received|post-replied|post-mentioned`、`q` |

共同 query：`page`（≥1）、`size`（档位白名单）。除 whoami 外，**每次调用写一条审计**
（`targetType="manage_api"`、`action="api.<endpoint>"`、after 含 query 摘要与 token 尾号，
`via="api"`，可在后台「审计日志」页按 action 过滤回看）。

## 4. 端点实现索引（web 侧 Service，供维护）

| 端点 | Service | route |
|---|---|---|
| whoami | `lib/manage/whoami.ts loadWhoami` | `app/api/manage/whoami/route.ts` |
| stats | `lib/admin/dashboard.ts dashboardData`（60s 进程缓存） | `app/api/manage/stats/route.ts` |
| users / users/{uid} | `lib/authz/admin-user-views.ts` | `app/api/manage/users/**` |
| contents / contents/{id} | `lib/moderation/contents.ts listContentsPage / loadContentDetail / resolveContentScope` | `app/api/manage/contents/**` |
| audit-logs | `lib/admin/logs.ts queryAuditLogs / resolveActorId` | `app/api/manage/audit-logs/route.ts` |
| emails | `lib/mail/log-query.ts` | `app/api/manage/emails/route.ts` |
| push-logs | `lib/push/log-query.ts` | `app/api/manage/push-logs/route.ts` |
| 门禁/信封/入口封装 | `lib/manage/guard.ts / errors.ts / route.ts` | — |

- 架构守卫：`app/api/manage/manage-api-guard.test.ts`（route 禁业务 import、必须走 manageEndpoint）。
- Token 生命周期 Service：`lib/manage/tokens.ts`（签发/吊销/联动/节流）——**任何新入口都不得绕过它**。
- 明文 token 永不进 URL / 日志 / 数据库（仅签发响应一次）。
