/**
 * 管理 REST API 在线文档的数据模块（M20.1）：`/admin/api-docs` 页面渲染的唯一数据源。
 *
 * 同步责任：端点实现变更（app/api/manage/**）时必须同步本文件与 docs/MANAGE-API.md——
 * 参数清单以各 route 的 zod schema 为准，响应示例贴近服务层真实返回形态。
 * 错误码表不在此重复：页面直接 import `MANAGE_ERROR_CODES` 渲染，码↔文案永不失同步。
 */

export interface ManageApiParam {
  name: string;
  type: string;
  required?: boolean;
  /** 缺省时的取值语义 */
  default?: string;
  description: string;
}

export interface ManageApiEndpointDoc {
  /** 页内锚点 id */
  slug: string;
  /** 语义功能名（导航与小节标题用——路径只在方法行展示，参考 Twilio/GitHub 语义命名惯例） */
  title: string;
  method: "GET";
  path: string;
  /** 资格之外的端点权限；缺省 = 仅站点管理员资格 */
  permission?: string;
  summary: string;
  description?: string[];
  params: ManageApiParam[];
  /** 成功响应 data 字段的 JSON 示例（展示用，贴近服务层真实形态） */
  responseExample: string;
  /** curl 调用样例（不含真实凭证） */
  curlExample: string;
  /** 端点特有备注（如审计策略、缓存行为） */
  notes?: string[];
}

export interface ManageApiDomainDoc {
  /** 节锚点 id */
  slug: string;
  title: string;
  description: string;
  endpoints: ManageApiEndpointDoc[];
}

const CURL = (path: string, query = "") =>
  `curl -H "Authorization: Bearer fw_at_…" \\\n  "https://<站点>${path}${query}"`;

export const MANAGE_API_DOMAINS: ManageApiDomainDoc[] = [
  {
    slug: "domain-site",
    title: "站点与统计",
    description: "凭证自省与站点级统计（看板同源数据）。",
    endpoints: [
      {
        slug: "ep-whoami",
        title: "凭证自省",
        method: "GET",
        path: "/api/manage/whoami",
        summary: "凭证自省：token 元信息 + 持有人 + 有效权限点全清单",
        description: [
          "握手端点：MCP 客户端 / 脚本启动时调用，确认凭证有效并按权限清单决定可用能力。",
          "本端点不写审计、不更新最后使用时间（高频无信息量）。",
        ],
        params: [],
        responseExample: `{
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
    "permissions": [
      "site.visit", "site.admin", "admin.roles",
      "admin.users", "admin.logs", "forum.read", "…"
    ]
  }
}`,
        curlExample: CURL("/api/manage/whoami"),
        notes: ["权限清单为评估器实时判定结果——撤权后下一请求即收缩。"],
      },
      {
        slug: "ep-stats",
        title: "看板统计",
        method: "GET",
        path: "/api/manage/stats",
        permission: "admin.logs",
        summary: "看板统计：30 天注册/主题/回帖逐日、今日登录、总量",
        description: ["与后台看板同源（dashboardData），共享 60 秒进程缓存。"],
        params: [],
        responseExample: `{
  "ok": true,
  "data": {
    "registered30": [{ "date": "2026-10-19", "n": 0 }, …],
    "threads30": [{ "date": "2026-10-19", "n": 3 }, …],
    "replies30": [{ "date": "2026-10-19", "n": 12 }, …],
    "todayLogins": 41,
    "totals": { "users": 128, "threads": 956, "posts": 7213 }
  }
}`,
        curlExample: CURL("/api/manage/stats"),
      },
    ],
  },
  {
    slug: "domain-users",
    title: "用户",
    description: "用户治理列表与详情（资料/角色/限制/会话聚合）。",
    endpoints: [
      {
        slug: "ep-users-list",
        title: "用户列表",
        method: "GET",
        path: "/api/manage/users",
        permission: "admin.users",
        summary: "用户治理列表（与后台用户页同源筛选语义）",
        params: [
          {
            name: "q",
            type: "string ≤64",
            description: "纯数字按 uid 等值匹配，否则用户名包含匹配",
          },
          {
            name: "status",
            type: "enum",
            default: "all",
            description: "all | restricted（存在未过期限制）",
          },
          {
            name: "lifecycle",
            type: "enum",
            default: "active",
            description: "active | closure_pending | deleted | all",
          },
          {
            name: "credential",
            type: "enum",
            default: "all",
            description: "all | email_unverified | no_password | legacy_password_pending",
          },
          {
            name: "sort",
            type: "enum",
            default: "recent",
            description: "recent（最新注册）| id | threads（发帖数降序）",
          },
          { name: "page", type: "int ≥1", default: "1", description: "页码" },
          {
            name: "size",
            type: "int 档位",
            default: "20",
            description: "每页条数，白名单 10/20/50/100",
          },
        ],
        responseExample: `{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 90002,
        "username": "e2e_legacy_user",
        "state": "active",
        "closurePending": false,
        "closureScheduledAt": null,
        "emailVerified": false,
        "emailVerificationRequired": false,
        "hasPassword": false,
        "legacyPasswordPending": true,
        "createdAt": "2026-10-20 12:00:00",
        "threadCount": 2,
        "postCount": 0,
        "restricted": false
      }, …
    ],
    "total": 7,
    "page": 1,
    "totalPages": 1
  }
}`,
        curlExample: CURL("/api/manage/users", "?lifecycle=active&size=10"),
      },
      {
        slug: "ep-users-detail",
        title: "用户详情",
        method: "GET",
        path: "/api/manage/users/{uid}",
        permission: "admin.users",
        summary: "用户详情三签聚合：资料 / 邮箱 / 积分 / 角色 / 限制 / 申诉 / 会话 / 审计台账",
        description: [
          "email、IP 类敏感字段仅当持有人另具 user.viewIp 权限时返回（与后台用户页同语义），否则置空。",
          "uid 不存在或已注销 → 404（越权与不存在同型，不泄露存在性）。",
        ],
        params: [{ name: "uid", type: "int（路径段）", required: true, description: "用户 id" }],
        responseExample: `{
  "ok": true,
  "data": {
    "id": 90004,
    "username": "demo_admin",
    "state": "active",
    "email": "admin@demo.local",
    "emailVerifiedAt": null,
    "hasPassword": true,
    "legacyPasswordPending": false,
    "roles": [{ "roleKey": "admin", "scopeId": 0, "expiresAt": null }, …],
    "restrictions": [],
    "appeals": [],
    "sessions": [{ "createdAt": "…", "lastSeenAt": "…", "ip": "…" }, …],
    "audit": [{ "action": "…", "createdAt": "…" }, …],
    "points": { "balance": 120, "lifetimeEarned": 300, "lifetimeSpent": 180 }
  }
}`,
        curlExample: CURL("/api/manage/users/90004"),
        notes: ["detail 内键集合以实现为准（聚合视图，随功能演进增列）。"],
      },
    ],
  },
  {
    slug: "domain-contents",
    title: "内容",
    description: "内容管理列表与行级详情（主题 / 回帖统一形态，含待审队列）。",
    endpoints: [
      {
        slug: "ep-contents-list",
        title: "内容列表",
        method: "GET",
        path: "/api/manage/contents",
        summary: "内容管理列表（与后台内容管理页同一 Service 与 scope 判定）",
        description: [
          "v1 的 token 资格 = 站点管理员不变量，scope 自然为全站视角；版主作用域语义保留在 resolveContentScope 内（将来放宽 token 资格时端点自动正确）。",
        ],
        params: [
          { name: "kind", type: "enum", default: "thread", description: "thread | reply" },
          {
            name: "q",
            type: "string ≤128",
            description: "关键词：主题搜标题，回帖搜正文/标题",
          },
          { name: "forumId", type: "int ≥1", description: "限定版块" },
          {
            name: "state",
            type: "enum",
            default: "all",
            description: "all | visible | pending | rejected | hidden | deleted | disabled",
          },
          {
            name: "order",
            type: "enum",
            default: "recent",
            description: "recent（最新在前）| queue（待审队列按提交时间正序，先到先审）",
          },
          { name: "page", type: "int ≥1", default: "1", description: "页码" },
          {
            name: "size",
            type: "int 档位",
            default: "20",
            description: "每页条数，白名单 10/20/50/100",
          },
        ],
        responseExample: `{
  "ok": true,
  "data": {
    "items": [
      {
        "postId": 900107,
        "threadId": 900007,
        "forumId": 906,
        "forumName": "『投稿审核区』",
        "title": "[待审核] 等待版主处理的投稿",
        "excerpt": null,
        "authorId": 90002,
        "authorName": "demo_小翼",
        "authorBanned": false,
        "state": "pending",
        "isThread": true,
        "createdAt": "2026-10-20 11:00:00",
        "replyCount": 0,
        "isLocked": false,
        "isFeatured": false,
        "pinLevel": 0
      }, …
    ],
    "total": 1,
    "page": 1,
    "totalPages": 1
  }
}`,
        curlExample: CURL("/api/manage/contents", "?kind=thread&state=pending&order=queue"),
      },
      {
        slug: "ep-contents-detail",
        title: "内容详情",
        method: "GET",
        path: "/api/manage/contents/{id}",
        summary: "内容行级详情（thread 含首帖正文；reply 含所属主题与正文）",
        description: ["越权（版块 scope 外）与不存在一律 404，存在性不泄露。"],
        params: [
          {
            name: "id",
            type: "int（路径段）",
            required: true,
            description: "主题 id 或回帖 id（由 kind 决定）",
          },
          { name: "kind", type: "enum", default: "thread", description: "thread | reply" },
        ],
        responseExample: `{
  "ok": true,
  "data": {
    "kind": "thread",
    "threadId": 950001,
    "forumId": 951,
    "forumName": "『E2E 动画』",
    "title": "E2E 表情帖",
    "state": "visible",
    "authorId": 90001,
    "authorName": "demo_alice",
    "createdAt": "2026-10-20 10:01:00",
    "replyCount": 0,
    "isLocked": false,
    "isFeatured": false,
    "pinLevel": 0,
    "firstPost": {
      "postId": 950002,
      "floor": 1,
      "state": "visible",
      "bodyMd": "正文 Markdown…",
      "createdAt": "2026-10-20 10:01:00"
    }
  }
}`,
        curlExample: CURL("/api/manage/contents/950001", "?kind=thread"),
      },
    ],
  },
  {
    slug: "domain-logs",
    title: "日志与观测",
    description: "审计日志 / 邮件 / 推送三渠道的检索与摘要（与后台观测页同源）。",
    endpoints: [
      {
        slug: "ep-audit-logs",
        title: "审计日志检索",
        method: "GET",
        path: "/api/manage/audit-logs",
        permission: "admin.logs",
        summary: "审计日志检索（与后台审计日志页同一查询层）",
        params: [
          {
            name: "action",
            type: "string ≤64",
            description: "动作名过滤（如 api.stats、points.adjust）",
          },
          {
            name: "actor",
            type: "string ≤64",
            description: "纯数字按 uid 等值，否则用户名精确反查；查无此人 → 空结果",
          },
          {
            name: "targetType",
            type: "string ≤32",
            description: "目标类型（如 user、manage_api）",
          },
          { name: "from", type: "date YYYY-MM-DD", description: "起始日（含当日 00:00:00）" },
          { name: "to", type: "date YYYY-MM-DD", description: "截止日（含当日 23:59:59）" },
          { name: "page", type: "int ≥1", default: "1", description: "页码" },
          { name: "size", type: "int 档位", default: "20", description: "每页条数（白名单）" },
        ],
        responseExample: `{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 10,
        "actorId": 90004,
        "action": "api.audit-logs",
        "targetType": "manage_api",
        "targetId": "/api/manage/audit-logs",
        "beforeJson": null,
        "afterJson": { "query": "{…}", "tokenSuffix": "X1G5CVXM", "via": "api" },
        "ip": "203.0.113.7",
        "createdAt": "2026-11-17 19:02:42"
      }, …
    ],
    "total": 1
  }
}`,
        curlExample: CURL(
          "/api/manage/audit-logs",
          "?targetType=manage_api&from=2026-11-17&to=2026-11-17",
        ),
      },
      {
        slug: "ep-emails",
        title: "邮件日志",
        method: "GET",
        path: "/api/manage/emails",
        permission: "admin.logs",
        summary: "邮件日志分页 + 近 24 小时成败摘要",
        params: [
          { name: "status", type: "enum", description: "sent | failed" },
          {
            name: "kind",
            type: "enum",
            description: "verify | security | notice | digest | system",
          },
          {
            name: "scene",
            type: "string ≤48",
            description: "场景键（小写字母/数字/连字符）",
          },
          {
            name: "q",
            type: "string ≤128",
            description: "纯数字按 userId 等值，否则收件地址包含",
          },
          { name: "page", type: "int ≥1", default: "1", description: "页码" },
          { name: "size", type: "int 档位", default: "20", description: "每页条数（白名单）" },
        ],
        responseExample: `{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 12,
        "kind": "verify",
        "scene": "register",
        "toEmail": "user@example.com",
        "status": "sent",
        "createdAt": "2026-11-17 08:00:00"
      }, …
    ],
    "total": 1,
    "summary": { "sent": 6, "failed": 0 }
  }
}`,
        curlExample: CURL("/api/manage/emails", "?status=failed"),
      },
      {
        slug: "ep-push-logs",
        title: "推送日志",
        method: "GET",
        path: "/api/manage/push-logs",
        permission: "admin.logs",
        summary: "推送日志分页 + 近 24 小时成败摘要（记录不含推送 payload 正文）",
        params: [
          { name: "status", type: "enum", description: "sent | failed" },
          {
            name: "scene",
            type: "enum",
            description: "pm-received | post-replied | post-mentioned",
          },
          {
            name: "q",
            type: "string ≤128",
            description: "纯数字按 userId 等值，否则订阅 endpoint 包含",
          },
          { name: "page", type: "int ≥1", default: "1", description: "页码" },
          { name: "size", type: "int 档位", default: "20", description: "每页条数（白名单）" },
        ],
        responseExample: `{
  "ok": true,
  "data": {
    "items": [
      {
        "id": 3,
        "scene": "post-replied",
        "status": "sent",
        "endpoint": "https://fcm.googleapis.com/…",
        "createdAt": "2026-11-17 09:30:00"
      }, …
    ],
    "total": 1,
    "summary": { "sent": 2, "failed": 1 }
  }
}`,
        curlExample: CURL("/api/manage/push-logs", "?status=sent"),
      },
    ],
  },
];

/** 通用错误码表（渲染自 errors.ts 注册表的引用见页面；此处仅文档化触发条件） */
export const MANAGE_API_ERROR_DOCS: { code: string; when: string }[] = [
  {
    code: "unauthorized",
    when: "凭证缺失、格式错误、查无、已过期、已吊销、持有人注销——统一 401，存在性不泄露",
  },
  { code: "forbidden", when: "凭证真实但持有人不再是站点管理员，或端点业务权限点不足" },
  { code: "not_found", when: "资源不存在；越权与不存在同型" },
  { code: "bad_request", when: "query 参数不合法（v1 不静默回落——消费方是程序）" },
  { code: "rate_limited", when: "超过频控（IP 120/min、单 token 60/min），响应带 Retry-After 头" },
  { code: "internal", when: "服务内部错误（不透传内部细节）" },
];
