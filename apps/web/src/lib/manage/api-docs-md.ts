/**
 * 管理 REST API 在线文档的内容源（M20.1，站长拍板 markdown + 站内渲染器管线）：
 * 每节一段 markdown，页面用 `RichContent`（renderMarkdown：remark + GFM 表格 + 代码高亮 +
 * sanitize 白名单）统一渲染——排版/表格/代码块样式与全站管线一致，杜绝手写 JSX 散落样式。
 *
 * 同步责任：端点实现（app/api/manage/**）变更时同步本文件与 docs/MANAGE-API.md。
 * 参数表为 GFM 表格（五列：参数/类型/必填/缺省/说明）；代码围栏内不做 HTML 解析，`<站点>` 可直写。
 */

export interface DocsSection {
  /** 节锚点 id（页面 section id 与左树导航 href 共用） */
  slug: string;
  /** 左树导航条目名（语义功能名，不使用接口路径） */
  nav: string;
  /** 左树分组名（概览组 / 功能域组） */
  group: string;
  /** 是否携带 GET 方法徽标（概览组无） */
  withMethod?: boolean;
  /** 资格外权限徽标文本（与实现一致；缺省 = 仅站点管理员资格） */
  permission?: string;
  md: string;
}

export const DOCS_SECTIONS: DocsSection[] = [
  {
    slug: "docs-overview",
    nav: "总述",
    group: "概览",
    md: `管理后台的机器可读面向：9 个只读端点，供脚本、CI 与本地 MCP 客户端（M21）消费。与后台页面共享同一套 Service 层——权限、审计、数据语义完全一致，API 层不携带任何平行业务逻辑。

- 全部端点 \`GET\` 只读；写操作请继续使用后台页面（v1 无写端点，按 M21 工具需求反推）。
- 全部响应 \`cache-control: private, no-store\`；除 \`whoami\` 外每次调用写审计（\`via: "api"\`）。
- 人读契约（开发者面向）：仓库 \`docs/MANAGE-API.md\`；本页与该文档随端点实现同步维护。`,
  },
  {
    slug: "docs-auth",
    nav: "鉴权（如何传 AT）",
    group: "概览",
    md: `**第一步 · 签发 Access Token**：在 [管理后台 · API 令牌页](/admin/api-tokens)（新窗口）签发——名称 + 有效期档位（30/90/180/365 天，默认 90）；明文 \`fw_at_…\` 仅展示一次，请立即保存。每管理员最多 5 个有效 Token。

**第二步 · 传递凭证**：请求头携带 \`Authorization\`，方案为 \`Bearer <token>\`：

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/whoami"
\`\`\`

**资格与失效语义**

- Token 资格 = **站点管理员不变量**（\`site.admin\` + \`admin.roles\` 双持、可登录、未封禁）。
- 持有人被撤下管理员 / 全站封禁 / 申请注销时，**全部 Token 同事务即时吊销**（并出 \`api_token.cascade_revoke\` 审计）。
- \`401\` = 凭证缺失 / 无效 / 过期 / 已吊销 / 持有人注销（统一口径，存在性不泄露）；\`403\` = 凭证真实但权限不足。

**频控与审计**

- 频控：IP 桶 120 次/分钟 + 单 Token 60 次/分钟；超限 \`429\` 并携带 \`Retry-After\` 头。
- 除 \`whoami\` 外每次调用写审计（\`targetType: "manage_api"\`，含 query 摘要与 token 尾号），可在后台「审计日志」页按 action 过滤回看。
- 凭证安全：库内只存 SHA-256，列表仅见尾号；建议按用途拆分 Token 并定期轮换（重签 + 吊销旧）。`,
  },
  {
    slug: "docs-envelope",
    nav: "统一信封与错误码",
    group: "概览",
    md: `成功返回 \`{ "ok": true, "data": … }\`；失败返回 \`{ "error": { "code", "message" } }\` + 语义状态码。

| code | HTTP | 触发条件 |
|---|---|---|
| \`unauthorized\` | 401 | 凭证缺失、无效、过期、已吊销、持有人注销（统一口径，存在性不泄露） |
| \`forbidden\` | 403 | 凭证真实但权限不足 |
| \`not_found\` | 404 | 资源不存在；越权与不存在同型 |
| \`bad_request\` | 400 | query 参数不合法（v1 不静默回落——消费方是程序） |
| \`rate_limited\` | 429 | 超过频控，响应带 \`Retry-After\` 头 |
| \`internal\` | 500 | 服务内部错误（不透传内部细节） |

**分页约定**：列表端点 data 统一 \`{ items, total, page, totalPages }\`；\`size\` 白名单 **10/20/50/100**（缺省 20），非法值一律 \`bad_request\`。`,
  },
  {
    slug: "docs-site",
    nav: "站点与统计",
    group: "功能域",
    md: `凭证自省与站点级统计（看板同源数据）。`,
  },
  {
    slug: "ep-whoami",
    nav: "凭证自省",
    group: "站点与统计",
    withMethod: true,
    md: `握手端点：脚本 / MCP 客户端启动时调用，确认凭证有效并按权限清单决定可用能力。**不写审计、不更新最后使用时间**（高频无信息量）。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| （无 query 参数） | | | | |

\`\`\`json
{
  "ok": true,
  "data": {
    "token": {
      "name": "CI 脚本",
      "suffix": "X1G5CVXM",
      "createdAt": "2026-11-17 11:01:59",
      "expiresAt": "2027-02-15 11:01:59",
      "lastUsedAt": "2026-11-18 09:12:40"
    },
    "user": { "id": 90004, "username": "demo_admin" },
    "permissions": ["site.visit", "site.admin", "admin.roles", "admin.users", "admin.logs", "forum.read"]
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/whoami"
\`\`\`

> 权限清单为评估器实时判定结果——撤权后下一请求即收缩。`,
  },
  {
    slug: "ep-stats",
    nav: "看板统计",
    group: "站点与统计",
    withMethod: true,
    permission: "admin.logs",
    md: `与后台看板同源（\`dashboardData\`），共享 60 秒进程缓存。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| （无 query 参数） | | | | |

\`\`\`json
{
  "ok": true,
  "data": {
    "registered30": [{ "date": "2026-10-19", "n": 0 }],
    "threads30": [{ "date": "2026-10-19", "n": 3 }],
    "replies30": [{ "date": "2026-10-19", "n": 12 }],
    "todayLogins": 41,
    "totals": { "users": 128, "threads": 956, "posts": 7213 }
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/stats"
\`\`\``,
  },
  {
    slug: "docs-users",
    nav: "用户",
    group: "功能域",
    md: `用户治理列表与详情聚合（资料 / 角色 / 限制 / 会话 / 审计台账），与后台用户页同源筛选语义。`,
  },
  {
    slug: "ep-users-list",
    nav: "用户列表",
    group: "用户",
    withMethod: true,
    permission: "admin.users",
    md: `用户治理列表（与后台用户页同源筛选语义）。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| \`q\` | string ≤64 | 否 | — | 纯数字按 uid 等值匹配，否则用户名包含匹配 |
| \`status\` | enum | 否 | all | \`all\` \| \`restricted\`（存在未过期限制） |
| \`lifecycle\` | enum | 否 | active | \`active\` \| \`closure_pending\` \| \`deleted\` \| \`all\` |
| \`credential\` | enum | 否 | all | \`all\` \| \`email_unverified\` \| \`no_password\` \| \`legacy_password_pending\` |
| \`sort\` | enum | 否 | recent | \`recent\`（最新注册）\| \`id\` \| \`threads\`（发帖数降序） |
| \`page\` | int ≥1 | 否 | 1 | 页码 |
| \`size\` | int 档位 | 否 | 20 | 每页条数，白名单 10/20/50/100 |

\`\`\`json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 90002,
        "username": "e2e_legacy_user",
        "state": "active",
        "closurePending": false,
        "emailVerified": false,
        "hasPassword": false,
        "legacyPasswordPending": true,
        "createdAt": "2026-10-20 12:00:00",
        "threadCount": 2,
        "postCount": 0,
        "restricted": false
      }
    ],
    "total": 7,
    "page": 1,
    "totalPages": 1
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/users?lifecycle=active&size=10"
\`\`\``,
  },
  {
    slug: "ep-users-detail",
    nav: "用户详情",
    group: "用户",
    withMethod: true,
    permission: "admin.users",
    md: `用户详情三签聚合：资料 / 邮箱 / 积分 / 角色 / 限制 / 申诉 / 会话 / 审计台账。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| \`uid\` | int（路径段） | 是 | — | 用户 id；不存在或已注销 → 404 |

> 敏感字段（email、IP）仅当持有人另具 \`user.viewIp\` 权限时返回，否则置空（与后台用户页同语义）。

\`\`\`json
{
  "ok": true,
  "data": {
    "id": 90004,
    "username": "demo_admin",
    "state": "active",
    "email": "admin@demo.local",
    "hasPassword": true,
    "roles": [{ "roleKey": "admin", "scopeId": 0, "expiresAt": null }],
    "restrictions": [],
    "sessions": [{ "createdAt": "…", "lastSeenAt": "…" }],
    "audit": [{ "action": "…", "createdAt": "…" }],
    "points": { "balance": 120, "lifetimeEarned": 300, "lifetimeSpent": 180 }
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/users/90004"
\`\`\``,
  },
  {
    slug: "docs-contents",
    nav: "内容",
    group: "功能域",
    md: `内容管理列表与行级详情（主题 / 回帖统一形态，含待审队列先到先审正序）。`,
  },
  {
    slug: "ep-contents-list",
    nav: "内容列表",
    group: "内容",
    withMethod: true,
    md: `内容管理列表（与后台内容管理页同一 Service 与 scope 判定；v1 token 资格为站点管理员，scope 自然为全站视角）。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| \`kind\` | enum | 否 | thread | \`thread\` \| \`reply\` |
| \`q\` | string ≤128 | 否 | — | 关键词：主题搜标题，回帖搜正文 / 标题 |
| \`forumId\` | int ≥1 | 否 | — | 限定版块 |
| \`state\` | enum | 否 | all | \`all\` \| \`visible\` \| \`pending\` \| \`rejected\` \| \`hidden\` \| \`deleted\` \| \`disabled\` |
| \`order\` | enum | 否 | recent | \`recent\`（最新在前）\| \`queue\`（待审队列按提交时间正序，先到先审） |
| \`page\` | int ≥1 | 否 | 1 | 页码 |
| \`size\` | int 档位 | 否 | 20 | 每页条数，白名单 10/20/50/100 |

\`\`\`json
{
  "ok": true,
  "data": {
    "items": [
      {
        "postId": 900107,
        "threadId": 900007,
        "forumId": 906,
        "forumName": "『投稿审核区』",
        "title": "[待审核] 等待版主处理的投稿",
        "authorId": 90002,
        "authorName": "demo_小翼",
        "authorBanned": false,
        "state": "pending",
        "isThread": true,
        "createdAt": "2026-10-20 11:00:00",
        "replyCount": 0
      }
    ],
    "total": 1,
    "page": 1,
    "totalPages": 1
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/contents?kind=thread&state=pending&order=queue"
\`\`\``,
  },
  {
    slug: "ep-contents-detail",
    nav: "内容详情",
    group: "内容",
    withMethod: true,
    md: `内容行级详情：thread 含首帖正文，reply 含所属主题与正文。越权与不存在一律 404。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| \`id\` | int（路径段） | 是 | — | 主题 id 或回帖 id（由 kind 决定） |
| \`kind\` | enum | 否 | thread | \`thread\` \| \`reply\` |

\`\`\`json
{
  "ok": true,
  "data": {
    "kind": "thread",
    "threadId": 950001,
    "forumName": "『E2E 动画』",
    "title": "E2E 表情帖",
    "state": "visible",
    "authorName": "demo_alice",
    "createdAt": "2026-10-20 10:01:00",
    "replyCount": 0,
    "firstPost": {
      "postId": 950002,
      "floor": 1,
      "state": "visible",
      "bodyMd": "正文 Markdown…",
      "createdAt": "2026-10-20 10:01:00"
    }
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/contents/950001?kind=thread"
\`\`\``,
  },
  {
    slug: "docs-logs",
    nav: "日志与观测",
    group: "功能域",
    md: `审计日志 / 邮件 / 推送三渠道的检索与摘要（与后台观测页同源查询层）。`,
  },
  {
    slug: "ep-audit-logs",
    nav: "审计日志检索",
    group: "日志与观测",
    withMethod: true,
    permission: "admin.logs",
    md: `审计日志检索（与后台审计日志页同一查询层）。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| \`action\` | string ≤64 | 否 | — | 动作名过滤（如 \`api.stats\`、\`points.adjust\`） |
| \`actor\` | string ≤64 | 否 | — | 纯数字按 uid 等值，否则用户名精确反查；查无此人 → 空结果 |
| \`targetType\` | string ≤32 | 否 | — | 目标类型（如 \`user\`、\`manage_api\`） |
| \`from\` | date | 否 | — | 起始日 \`YYYY-MM-DD\`（含当日 00:00:00） |
| \`to\` | date | 否 | — | 截止日 \`YYYY-MM-DD\`（含当日 23:59:59） |
| \`page\` | int ≥1 | 否 | 1 | 页码 |
| \`size\` | int 档位 | 否 | 20 | 每页条数（白名单） |

\`\`\`json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 10,
        "actorId": 90004,
        "action": "api.audit-logs",
        "targetType": "manage_api",
        "targetId": "/api/manage/audit-logs",
        "afterJson": { "query": "{…}", "tokenSuffix": "X1G5CVXM", "via": "api" },
        "ip": "203.0.113.7",
        "createdAt": "2026-11-17 19:02:42"
      }
    ],
    "total": 1
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/audit-logs?targetType=manage_api"
\`\`\``,
  },
  {
    slug: "ep-emails",
    nav: "邮件日志",
    group: "日志与观测",
    withMethod: true,
    permission: "admin.logs",
    md: `邮件日志分页 + 近 24 小时成败摘要。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| \`status\` | enum | 否 | — | \`sent\` \| \`failed\` |
| \`kind\` | enum | 否 | — | \`verify\` \| \`security\` \| \`notice\` \| \`digest\` \| \`system\` |
| \`scene\` | string ≤48 | 否 | — | 场景键（小写字母 / 数字 / 连字符） |
| \`q\` | string ≤128 | 否 | — | 纯数字按 userId 等值，否则收件地址包含 |
| \`page\` | int ≥1 | 否 | 1 | 页码 |
| \`size\` | int 档位 | 否 | 20 | 每页条数（白名单） |

\`\`\`json
{
  "ok": true,
  "data": {
    "items": [
      { "id": 12, "kind": "verify", "scene": "register", "toEmail": "user@example.com", "status": "sent", "createdAt": "2026-11-17 08:00:00" }
    ],
    "total": 1,
    "summary": { "sent": 6, "failed": 0 }
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/emails?status=failed"
\`\`\``,
  },
  {
    slug: "ep-push-logs",
    nav: "推送日志",
    group: "日志与观测",
    withMethod: true,
    permission: "admin.logs",
    md: `推送日志分页 + 近 24 小时成败摘要（记录不含推送 payload 正文）。

| 参数 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| \`status\` | enum | 否 | — | \`sent\` \| \`failed\` |
| \`scene\` | enum | 否 | — | \`pm-received\` \| \`post-replied\` \| \`post-mentioned\` |
| \`q\` | string ≤128 | 否 | — | 纯数字按 userId 等值，否则订阅 endpoint 包含 |
| \`page\` | int ≥1 | 否 | 1 | 页码 |
| \`size\` | int 档位 | 否 | 20 | 每页条数（白名单） |

\`\`\`json
{
  "ok": true,
  "data": {
    "items": [
      { "id": 3, "scene": "post-replied", "status": "sent", "endpoint": "https://fcm.googleapis.com/…", "createdAt": "2026-11-17 09:30:00" }
    ],
    "total": 1,
    "summary": { "sent": 2, "failed": 1 }
  }
}
\`\`\`

\`\`\`bash
curl -H "Authorization: Bearer fw_at_…" \\
  "https://<站点>/api/manage/push-logs?status=sent"
\`\`\``,
  },
];

/** 左树分组结构（由 DOCS_SECTIONS 归组派生；「功能域」组内按 group 字段二次分组） */
export interface DocsNavGroup {
  group: string;
  items: { slug: string; nav: string; withMethod?: boolean; permission?: string }[];
}

export function docsNavGroups(): DocsNavGroup[] {
  const groups: DocsNavGroup[] = [];
  for (const section of DOCS_SECTIONS) {
    let g = groups.find((x) => x.group === section.group);
    if (!g) {
      g = { group: section.group, items: [] };
      groups.push(g);
    }
    g.items.push({
      slug: section.slug,
      nav: section.nav,
      withMethod: section.withMethod,
      permission: section.permission,
    });
  }
  return groups;
}
