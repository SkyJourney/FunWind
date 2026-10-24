/**
 * 权限点词汇表（schema v2.1 单一事实源）：25 个权限点。
 * 消费方：bootstrap 的 seedSystemData、web 评估器（级别隐含）、导入适配层（把外部权限翻译到这些键）。
 * 扩展权限点 = 修改本文件 + 在 docs/AUTHZ.md 说明（与模块清单同纪律）。
 *
 * 本文件不认识旧站：旧键映射、旧用户组、团队角色都只存在于 migration/（见 docs/DESIGN-MODEL.md §1）。
 * 约定：forum.moderate 只能通过作用域授权获得，禁止任何自动映射把它授予全体会员。
 */

export type PermLevel = "read" | "write" | "manage";

export interface PermissionDef {
  key: string;
  resource: string;
  level: PermLevel | null;
  description: string;
}

const def = (
  key: string,
  resource: string,
  description: string,
  opts: { level?: PermLevel } = {},
): PermissionDef => ({ key, resource, level: opts.level ?? null, description });

export const PERMISSION_DEFINITIONS: PermissionDef[] = [
  // ---- 站点与后台 ----
  def("site.visit", "site", "访问站点"),
  def("site.admin", "site", "进入后台管理"),
  def("admin.roles", "admin", "角色与授权矩阵管理"),
  def("admin.users", "admin", "后台用户管理"),
  def("admin.reports", "admin", "后台举报处理"),
  def("admin.logs", "admin", "后台审计日志查看"),
  def("admin.recycle", "admin", "后台已删除内容管理"),
  // ---- 版块（分级域：moderate ⊃ write ⊃ read）----
  def("forum.read", "forum", "浏览版块与帖子", { level: "read" }),
  def("forum.write", "forum", "发帖/回帖/编辑自己的帖", { level: "write" }),
  // 版主权限只通过 forum.moderate 的作用域授权（角色 ∩ 持有人）表达，不存在任何自动授予路径。
  def("forum.moderate", "forum", "版主管理（置顶/加精/删除/审核）", { level: "manage" }),
  def("forum.report", "forum", "举报内容"),
  def("thread.replyLocked", "thread", "回复锁定帖"),
  // ---- 门控（docs/GATES.md）----
  def("gate.points", "gate", "创建积分购买型门控"),
  def("gate.reply", "gate", "创建回复可见型门控"),
  // ---- 附件 ----
  def("attachment.upload", "attachment", "上传附件"),
  def("attachment.download", "attachment", "下载附件"),
  // ---- 投票 ----
  def("vote.create", "vote", "发起投票"),
  def("vote.participate", "vote", "参与投票"),
  def("vote.view", "vote", "查看投票结果"),
  // ---- 签名 ----
  def("sign.use", "sign", "使用签名档"),
  // ---- 私信 ----
  def("pm.send", "pm", "发送私信"),
  // ---- 标签 ----
  def("tag.add", "tag", "添加标签"),
  def("tag.edit", "tag", "编辑标签"),
  def("tag.manage", "tag", "管理标签"),
  // ---- 用户 ----
  def("user.viewIp", "user", "查看用户 IP"),
];

/** 级别隐含序：moderate(manage) ⊃ write ⊃ read */
export const LEVEL_RANK: Record<NonNullable<PermissionDef["level"]>, number> = {
  read: 1,
  write: 2,
  manage: 3,
};

export const BUILTIN_ROLE_KEYS = ["guest", "member", "admin"] as const;
export type BuiltinRoleKey = (typeof BUILTIN_ROLE_KEYS)[number];

export interface RoleDef {
  key: string;
  name: string;
  kind: "builtin" | "custom";
  description: string;
}

/** 内置角色只有三个；团队角色是站点数据，由管理员创建（青翼的由迁移创建） */
export const ROLE_DEFINITIONS: RoleDef[] = [
  { key: "guest", name: "游客", kind: "builtin", description: "未登录访客" },
  { key: "member", name: "会员", kind: "builtin", description: "注册用户的默认角色" },
  { key: "admin", name: "管理员", kind: "builtin", description: "全站管理" },
];

/**
 * 零数据部署的基线授权（全局，scope_id = 0）。
 * 导入路径可在此之上追加角色与授权。
 * admin 在评估器中短路放行，此处仍显式授予后台权限点，保证矩阵页可见。
 */
export const DEFAULT_ROLE_GRANTS: Record<BuiltinRoleKey, string[]> = {
  guest: ["site.visit", "vote.view"],
  member: [
    "site.visit",
    "forum.write",
    "forum.report",
    "gate.points",
    "gate.reply",
    "attachment.upload",
    "attachment.download",
    "vote.create",
    "vote.participate",
    "vote.view",
    "sign.use",
    "pm.send",
    "tag.add",
  ],
  admin: [
    "site.visit",
    "site.admin",
    "admin.roles",
    "admin.users",
    "admin.reports",
    "admin.logs",
    "admin.recycle",
    "forum.read",
    "forum.write",
    "forum.moderate",
    "thread.replyLocked",
    "user.viewIp",
    "tag.edit",
    "tag.manage",
  ],
};

/** 站点设置默认值（零数据部署；导入路径可覆盖，如积分显示名） */
export const DEFAULT_SITE_SETTINGS: Record<string, unknown> = {
  "register.mode": { mode: "invite" },
  "points.name": { name: "积分" },
  "points.gate_fee_rate": { rate: 0 },
};

/** 版块可见性策略（forums.read_policy） */
export const READ_POLICIES = ["inherit", "public", "members", "restricted"] as const;
export type ReadPolicy = (typeof READ_POLICIES)[number];

/** 版块审核策略（forums.review_policy）：threads = 新主题需审核，all = 所有发帖需审核 */
export const REVIEW_POLICIES = ["inherit", "none", "threads", "all"] as const;
export type ReviewPolicy = (typeof REVIEW_POLICIES)[number];

/** 版块写入策略（forums.write_policy） */
export const WRITE_POLICIES = ["inherit", "members", "restricted"] as const;
export type WritePolicy = (typeof WRITE_POLICIES)[number];

/** 级别隐含判定：granted level 满足 required level */
export function levelSatisfies(required: PermLevel, granted: PermLevel): boolean {
  return LEVEL_RANK[granted] >= LEVEL_RANK[required];
}

const VOCAB_BY_KEY = new Map(PERMISSION_DEFINITIONS.map((p) => [p.key, p]));

/** 权限点是否在词汇表中（脏键拦截） */
export function isKnownPermission(key: string): boolean {
  return VOCAB_BY_KEY.has(key);
}

/**
 * 授权键是否满足所需权限点：
 * - 键精确相等 → 满足
 * - 同资源分级域 → 级别隐含（moderate 满足 write/read）
 * - 动作型（level NULL）仅精确键自身
 */
export function permissionSatisfies(grantedKey: string, requiredKey: string): boolean {
  if (grantedKey === requiredKey) return true;
  const g = VOCAB_BY_KEY.get(grantedKey);
  const r = VOCAB_BY_KEY.get(requiredKey);
  if (!g || !r) return false;
  if (g.resource !== r.resource) return false;
  if (r.level === null || g.level === null) return false;
  return levelSatisfies(r.level, g.level);
}
