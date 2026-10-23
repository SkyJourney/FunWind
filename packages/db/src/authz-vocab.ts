/**
 * 权限点词汇表 v2（M5.5 单一事实源）：旧 57 键 → 25 个权限点。
 * 消费方：bootstrap 的 seedSystemData、迁移 v2 的权限翻译、web 评估器（级别隐含）。
 * 扩展权限点 = 修改本文件 + 在 docs/AUTHZ.md 说明（与模块清单同纪律）。
 *
 * v2 相对 M5 的变化（详见 docs/AUTHZ.md §8）：
 *  - forum.manage 并入 forum.moderate；版主由 forum.moderate 派生，forum.write 仅表示「可发帖/回帖/编辑自己的帖」
 *  - thread.sell / thread.hide → gate.points / gate.reply（保留 legacy_key）
 *  - 已取消功能的权限点删除：thread.award、thread.remoteImage、media.*、invite.buy、remind.receive、
 *    forum.viewLog、forum.forceReason、design.manage、fresh.delete
 *  - muted 退出内置角色，禁言改走 user_restrictions
 */

export type PermLevel = "read" | "write" | "manage";

export interface PermissionDef {
  key: string;
  resource: string;
  level: PermLevel | null;
  description: string;
  legacyKey: string | null;
  /** 数值型旧键转为 ABAC 条件参数（M6 消费），不作为权限点 */
  conditionParams?: Record<string, unknown>;
}

const def = (
  key: string,
  resource: string,
  description: string,
  opts: { level?: PermLevel; legacyKey?: string; conditionParams?: Record<string, unknown> } = {},
): PermissionDef => ({
  key,
  resource,
  level: opts.level ?? null,
  description,
  legacyKey: opts.legacyKey ?? null,
  ...(opts.conditionParams ? { conditionParams: opts.conditionParams } : {}),
});

export const PERMISSION_DEFINITIONS: PermissionDef[] = [
  // ---- 站点与后台 ----
  def("site.visit", "site", "访问站点", { legacyKey: "allow_visit" }),
  def("site.admin", "site", "进入后台管理"),
  def("admin.roles", "admin", "角色与授权矩阵管理"),
  def("admin.users", "admin", "后台用户管理", { legacyKey: "panel_user_manage" }),
  def("admin.reports", "admin", "后台举报处理", { legacyKey: "panel_report_manage" }),
  def("admin.logs", "admin", "后台审计日志查看", { legacyKey: "panel_log_manage" }),
  def("admin.recycle", "admin", "后台已删除内容管理", { legacyKey: "panel_recycle_manage" }),
  // ---- 版块（分级域：moderate ⊃ write ⊃ read）----
  def("forum.read", "forum", "浏览版块与帖子", { level: "read", legacyKey: "allow_read" }),
  def("forum.write", "forum", "发帖/回帖/编辑自己的帖", {
    level: "write",
    legacyKey: "allow_post",
  }),
  // 注意：不映射旧 operate_thread——它对普通会员组只是「置顶有效时长」之类的设置数组，不是开关；
  // 版主权限在新模型里只通过 forum.moderate 的作用域授权（角色 ∩ 持有人）表达。
  def("forum.moderate", "forum", "版主管理（置顶/加精/删除/审核）", { level: "manage" }),
  def("forum.report", "forum", "举报内容", { legacyKey: "allow_report" }),
  def("thread.replyLocked", "thread", "回复锁定帖", { legacyKey: "reply_locked_threads" }),
  // ---- 门控（docs/GATES.md）----
  def("gate.points", "gate", "创建积分购买型门控", { legacyKey: "allow_thread_extend" }),
  def("gate.reply", "gate", "创建回复可见型门控", { legacyKey: "allow_thread_extend" }),
  // ---- 附件 ----
  def("attachment.upload", "attachment", "上传附件", { legacyKey: "allow_upload" }),
  def("attachment.download", "attachment", "下载附件", { legacyKey: "allow_download" }),
  // ---- 投票 ----
  def("vote.create", "vote", "发起投票", { legacyKey: "allow_add_vote" }),
  def("vote.participate", "vote", "参与投票", { legacyKey: "allow_participate_vote" }),
  def("vote.view", "vote", "查看投票结果", { legacyKey: "allow_view_vote" }),
  // ---- 签名 ----
  def("sign.use", "sign", "使用签名档", {
    legacyKey: "allow_sign",
    conditionParams: { maxLength: "sign_max_length", maxHeight: "sign_max_height" },
  }),
  // ---- 私信 ----
  def("pm.send", "pm", "发送私信", {
    legacyKey: "message_allow_send",
    conditionParams: { dailyLimit: "message_max_send" },
  }),
  // ---- 标签 ----
  def("tag.add", "tag", "添加标签", { legacyKey: "tag_allow_add" }),
  def("tag.edit", "tag", "编辑标签", { legacyKey: "tag_allow_edit" }),
  def("tag.manage", "tag", "管理标签", { legacyKey: "tag_allow_manage" }),
  // ---- 用户 ----
  def("user.viewIp", "user", "查看用户 IP", { legacyKey: "view_ip_address" }),
];

/**
 * ABAC 条件参数型旧键（转条件而非权限点，M6 消费）。
 * 已取消功能（邀请购买、@提醒、多媒体）的条件键不再保留。
 */
export const LEGACY_CONDITION_KEYS: Record<
  string,
  { target: string; param: string; description: string }
> = {
  threads_perday: { target: "thread.create", param: "threadsPerDay", description: "每日发帖上限" },
  post_pertime: { target: "thread.replied", param: "postIntervalSec", description: "回帖间隔时间" },
  post_url_num: { target: "thread.replied", param: "maxUrls", description: "单帖链接数上限" },
  post_modify_time: {
    target: "thread.editOwn",
    param: "editWindowMin",
    description: "编辑时限（分钟）",
  },
  uploads_perday: {
    target: "attachment.upload",
    param: "uploadsPerDay",
    description: "每日上传数",
  },
  sell_credits: { target: "gate.points", param: "enabled", description: "积分门控开关" },
  sell_credit_range: {
    target: "gate.points",
    param: "priceRange",
    description: "积分门控价格区间",
  },
  enhide_credits: { target: "gate.reply", param: "enabled", description: "回复门控开关" },
  post_check: { target: "thread.create", param: "reviewMode", description: "发帖审核模式" },
  message_max_send: { target: "pm.send", param: "dailyLimit", description: "每日私信上限" },
  sign_max_length: { target: "sign.use", param: "maxLength", description: "签名最大长度" },
  sign_max_height: { target: "sign.use", param: "maxHeight", description: "签名图片最大高度" },
};

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
  /** 旧 gid（考古对照；一个内置角色可对应多个旧组） */
  legacyGids: number[];
}

export const ROLE_DEFINITIONS: RoleDef[] = [
  { key: "guest", name: "游客", kind: "builtin", description: "未登录访客", legacyGids: [2] },
  {
    key: "member",
    name: "会员",
    kind: "builtin",
    description: "注册用户默认角色（旧 default + LV1-12 合并基线）",
    legacyGids: [1, 8, 9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 33],
  },
  {
    key: "admin",
    name: "管理员",
    kind: "builtin",
    description: "全站管理（旧 大魔王/领主/守卫 收编）",
    legacyGids: [3, 4, 5],
  },
  {
    key: "team-subtitle",
    name: "字幕制作组",
    kind: "custom",
    description: "旧 special 组（内部版块访问 + 制作协作）",
    legacyGids: [18],
  },
  { key: "team-tech", name: "技术分流组", kind: "custom", description: "", legacyGids: [21] },
  { key: "team-planning", name: "策划组", kind: "custom", description: "", legacyGids: [38] },
  { key: "team-resource", name: "资源组", kind: "custom", description: "", legacyGids: [36] },
  { key: "team-art", name: "美工组", kind: "custom", description: "", legacyGids: [37] },
  { key: "team-intern", name: "实习组", kind: "custom", description: "", legacyGids: [23] },
];

/**
 * 零数据部署的基线授权（全局，scope_id = 0）。
 * 青翼导入路径会在此之上由迁移 v2 的权限翻译覆盖/补充。
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

/** 站点设置默认值（零数据部署；青翼导入路径由迁移覆盖积分显示名等） */
export const DEFAULT_SITE_SETTINGS: Record<string, unknown> = {
  "register.mode": { mode: "invite" },
  "points.name": { name: "积分" },
  "points.gate_fee_rate": { rate: 0 },
};

/** 版块可见性策略（forums.read_policy） */
export const READ_POLICIES = ["inherit", "public", "members", "restricted"] as const;
export type ReadPolicy = (typeof READ_POLICIES)[number];

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
