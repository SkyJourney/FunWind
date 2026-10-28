/**
 * 权限点词汇表（schema v2.1 单一事实源）：27 个权限点。
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
  // M7：积分与荣誉的管理动作（规则配置/手工调整、徽章授予），页面与动作均要求 site.admin 总门 + 此处权限点
  def("admin.points", "admin", "积分规则配置与手工调整"),
  def("admin.badges", "admin", "荣誉徽章授予"),
  // ---- 版块（分级域：moderate ⊃ write ⊃ read）----
  def("forum.read", "forum", "浏览版块与帖子", { level: "read" }),
  def("forum.write", "forum", "发帖/回帖/编辑自己的帖", { level: "write" }),
  // 版主权限只通过 forum.moderate 的作用域授权（角色 ∩ 持有人）表达，不存在任何自动授予路径。
  def("forum.moderate", "forum", "版主管理（置顶/加精/删除/审核）", { level: "manage" }),
  def("forum.report", "forum", "举报内容"),
  def("thread.replyLocked", "thread", "回复锁定帖"),
  // ---- 门控（docs/GATES.md）----
  def("gate.points", "gate", "创建积分购买型锁定内容"),
  def("gate.reply", "gate", "创建回复可见型锁定内容"),
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
    "admin.points",
    "admin.badges",
    "forum.read",
    "forum.write",
    "forum.moderate",
    "thread.replyLocked",
    "user.viewIp",
    "tag.edit",
    "tag.manage",
  ],
};

/**
 * 写入限制的默认值（site_settings 的 `limits` 键；M6.1，设计见 docs/milestones/M6.1-write-path.md §6）。
 * web 侧用 zod 校验这份配置，校验失败回落到本常量，所以默认值只此一份。
 *  · titleMax / bodyMax：字符数。迁移数据实测最大值分别是 100 / 26503，默认留出余量；
 *  · roles：按角色键的每项限制，**0 = 不限**；主体有多个角色时每项取最宽松的值；
 *  · postIntervalSec：两次发帖（主题或回帖）的最短间隔；threadsPerDay / uploadsPerDay：每个自然日（库端时间）上限；
 *  · editWindowSec：作者可自行编辑的时限（发布后多少秒内）。缺省 0 = 不限；旧库里没有这个字段的配置仍然有效（见 web 侧 zod）。
 */
export const DEFAULT_LIMITS = {
  titleMax: 100,
  bodyMax: 50000,
  roles: {
    member: {
      postIntervalSec: 5,
      threadsPerDay: 100,
      uploadsPerDay: 20,
      editWindowSec: 0,
      pmPerDay: 50,
    },
    admin: {
      postIntervalSec: 0,
      threadsPerDay: 0,
      uploadsPerDay: 0,
      editWindowSec: 0,
      pmPerDay: 0,
    },
  },
} as const;

/**
 * 积分奖励默认值（site_settings 的 `points.reward` 键；M7，设计见 docs/POINTS.md §3）。
 * web 侧用 zod 校验，校验失败回落到本常量；数值来自旧站实测（credit.strategy：post_topic=3、post_reply=1）。
 *  · post / reply：发帖、回帖奖励；
 *  · postDailyCap / replyDailyCap：北京时间自然日上限，**0 = 不限**（旧站即无上限，后台可设）。
 */
export const DEFAULT_POINT_REWARD = {
  post: 3,
  reply: 1,
  postDailyCap: 0,
  replyDailyCap: 0,
} as const;

/** 签到奖励默认值（site_settings 的 `punch.reward` 键）：旧站 punch.reward（随机 min=1 max=5）原样 */
export const DEFAULT_PUNCH_REWARD = { min: 1, max: 5 } as const;

/** 站点设置默认值（零数据部署；导入路径可覆盖，如积分显示名） */
export const DEFAULT_SITE_SETTINGS: Record<string, unknown> = {
  "register.mode": { mode: "invite" },
  "points.name": { name: "积分" },
  "points.gate_fee_rate": { rate: 0 },
  "points.reward": DEFAULT_POINT_REWARD,
  "punch.reward": DEFAULT_PUNCH_REWARD,
  limits: DEFAULT_LIMITS,
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
