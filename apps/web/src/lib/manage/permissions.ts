/** 管理 REST 的域名称供签发矩阵和在线文档共用。域不是运行时授权单位。 */
export const MANAGE_PERMISSION_DOMAINS = {
  identity: "令牌身份",
  contents: "内容治理",
  users: "用户管理",
  stats: "站点统计",
  "audit-logs": "审计日志",
  emails: "邮件日志",
  "push-logs": "推送日志",
} as const;

export type ManagePermissionDomain = keyof typeof MANAGE_PERMISSION_DOMAINS;
export type ManagePermissionLevel = "none" | "read" | "write";

/**
 * 端点可挂接的持有人权限点（authz 词汇表的管理类子集）。
 * `site.admin` 是全部端点的基线资格门（guard 内置），不在此重复；
 * 新增权限点先入 authz 词汇表与 require-admin 的 AdminPermission，再扩此清单。
 */
export const MANAGE_ENDPOINT_PERMISSIONS = [
  "admin.users",
  "admin.logs",
  "admin.roles",
  "admin.points",
  "admin.badges",
  "admin.reports",
  "admin.recycle",
  "emoji.manage",
] as const;

export type ManageEndpointPermission = (typeof MANAGE_ENDPOINT_PERMISSIONS)[number];

export type ManageEndpointDefinition = {
  domain: ManagePermissionDomain;
  access: "read" | "write";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: `/api/manage/${string}`;
  permission?: ManageEndpointPermission;
  audit?: false;
};

/** 端点 ID 是授权快照中的稳定标识；新增能力使用新 ID，不能复用旧 ID 扩权。 */
export const MANAGE_ENDPOINTS = {
  whoami: {
    domain: "identity",
    access: "read",
    method: "GET",
    path: "/api/manage/whoami",
    audit: false,
  },
  contents: { domain: "contents", access: "read", method: "GET", path: "/api/manage/contents" },
  "contents.detail": {
    domain: "contents",
    access: "read",
    method: "GET",
    path: "/api/manage/contents/{id}",
  },
  users: {
    domain: "users",
    access: "read",
    method: "GET",
    path: "/api/manage/users",
    permission: "admin.users",
  },
  "posts.review": {
    domain: "contents",
    access: "write",
    method: "POST",
    path: "/api/manage/posts/{postId}/review",
  },
  "threads.lock": {
    domain: "contents",
    access: "write",
    method: "PUT",
    path: "/api/manage/threads/{threadId}/lock",
  },
  "users.detail": {
    domain: "users",
    access: "read",
    method: "GET",
    path: "/api/manage/users/{uid}",
    permission: "admin.users",
  },
  stats: {
    domain: "stats",
    access: "read",
    method: "GET",
    path: "/api/manage/stats",
    permission: "admin.logs",
  },
  "audit-logs": {
    domain: "audit-logs",
    access: "read",
    method: "GET",
    path: "/api/manage/audit-logs",
    permission: "admin.logs",
  },
  emails: {
    domain: "emails",
    access: "read",
    method: "GET",
    path: "/api/manage/emails",
    permission: "admin.logs",
  },
  "push-logs": {
    domain: "push-logs",
    access: "read",
    method: "GET",
    path: "/api/manage/push-logs",
    permission: "admin.logs",
  },
} as const satisfies Record<string, ManageEndpointDefinition>;

export type ManageEndpointId = keyof typeof MANAGE_ENDPOINTS;

/** M20 历史九读固定快照；不可用当前目录的域、方法或条目列表推导。 */
export const LEGACY_M20_ENDPOINTS = Object.freeze([
  "whoami",
  "contents",
  "contents.detail",
  "users",
  "users.detail",
  "stats",
  "audit-logs",
  "emails",
  "push-logs",
] as const satisfies readonly ManageEndpointId[]);

function isManageEndpointId(value: unknown): value is ManageEndpointId {
  return typeof value === "string" && Object.hasOwn(MANAGE_ENDPOINTS, value);
}

export function getManageEndpoint(id: ManageEndpointId): ManageEndpointDefinition {
  if (!isManageEndpointId(id)) throw new Error("管理 REST 端点没有登记权限");
  return MANAGE_ENDPOINTS[id];
}

/** 校验库内快照。不补权、不回落；未知、重复或空快照都拒绝。 */
export function parseManagePermissionSnapshot(value: unknown): readonly ManageEndpointId[] | null {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(isManageEndpointId) &&
    new Set(value).size === value.length
    ? value
    : null;
}

/** 仅在签发时将域和档位展开成精确端点 ID；不存在写端点的域不能选择读写。 */
export function expandManagePermissionSelection(value: unknown): ManageEndpointId[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = (Object.keys(MANAGE_ENDPOINTS) as ManageEndpointId[]).map(
    (id) => [id, getManageEndpoint(id)] as const,
  );
  const grants: ManageEndpointId[] = [];
  for (const [domain, level] of Object.entries(value)) {
    if (!Object.hasOwn(MANAGE_PERMISSION_DOMAINS, domain)) return null;
    if (level === "none") continue;
    if (level !== "read" && level !== "write") return null;
    const endpoints = entries.filter(([, endpoint]) => endpoint.domain === domain);
    if (!endpoints.some(([, endpoint]) => endpoint.access === level)) return null;
    for (const [id, endpoint] of endpoints) {
      if (endpoint.access === "read" || level === "write") grants.push(id);
    }
  }
  return grants.length > 0 ? grants : null;
}
