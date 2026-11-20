import { MANAGE_ENDPOINTS } from "./catalog";

export { MANAGE_ENDPOINTS } from "./catalog";

/** 管理 REST 的域名称供签发矩阵和在线文档共用。域不是运行时授权单位。 */
export const MANAGE_PERMISSION_DOMAINS = {
  identity: "令牌身份",
  contents: "内容治理",
  users: "用户管理",
  reports: "举报处理",
  forums: "版块管理",
  polls: "投票",
  pm: "私信",
  badges: "徽章",
  points: "积分",
  emojis: "表情",
  roles: "角色权限",
  settings: "站点设置",
  ops: "运维任务",
  themes: "主题包",
  announcements: "公告",
  campaigns: "活动",
  invites: "邀请码",
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
