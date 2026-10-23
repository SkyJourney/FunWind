/**
 * 权限点词汇表（M5 单一事实源）：57 个旧键 → resource.action 归一映射。
 * 消费方：迁移实体（写入 permissions/role_grants）与 web 评估器（级别隐含）。
 * 扩展权限点 = 修改本文件 + 在 docs/AUTHZ.md 说明（与模块清单同纪律）。
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
  // ---- 站点与浏览 ----
  def("site.visit", "site", "访问站点"),
  def("site.admin", "site", "进入后台管理"),
  def("admin.roles", "admin", "角色与授权矩阵管理"),
  def("forum.read", "forum", "浏览版块与帖子", { level: "read", legacyKey: "allow_read" }),
  def("forum.write", "forum", "发帖/回帖/编辑", { level: "write", legacyKey: "allow_post" }),
  def("forum.manage", "forum", "版主管理（置顶/加精/删除/审核）", { level: "manage" }),
  def("forum.report", "forum", "举报内容", { legacyKey: "allow_report" }),
  // ---- 发帖细化 ----
  def("thread.sell", "thread", "发布付费帖", { legacyKey: "allow_thread_extend" }),
  def("thread.hide", "thread", "发布隐藏内容帖"),
  def("thread.award", "thread", "悬赏帖", { legacyKey: "thread_award" }),
  def("thread.remoteImage", "thread", "引用远程图片", { legacyKey: "remote_download" }),
  def("thread.replyLocked", "thread", "回复锁定帖", { legacyKey: "reply_locked_threads" }),
  // ---- 附件 ----
  def("attachment.upload", "attachment", "上传附件", { legacyKey: "allow_upload" }),
  def("attachment.download", "attachment", "下载附件", { legacyKey: "allow_download" }),
  // ---- 多媒体 ----
  def("media.embed", "media", "嵌入多媒体", { legacyKey: "multimedia_auto_open" }),
  def("media.publishVideo", "media", "发布视频", { legacyKey: "allow_publish_vedio" }),
  def("media.publishMusic", "media", "发布音乐", { legacyKey: "allow_publish_music" }),
  // ---- 投票 ----
  def("vote.create", "vote", "发起投票", { legacyKey: "allow_add_vote" }),
  def("vote.participate", "vote", "参与投票", { legacyKey: "allow_participate_vote" }),
  def("vote.view", "vote", "查看投票结果", { legacyKey: "allow_view_vote" }),
  // ---- 签名 ----
  def("sign.use", "sign", "使用签名档", {
    legacyKey: "allow_sign",
    conditionParams: {
      maxLength: "sign_max_length",
      maxHeight: "sign_max_height",
      allowUbb: "sign_ubb",
      allowImg: "sign_ubb_img",
    },
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
  // ---- 邀请 ----
  def("invite.buy", "invite", "购买邀请码", {
    legacyKey: "invite_allow_buy",
    conditionParams: { price: "invite_buy_credit_num", dailyLimit: "invite_limit_24h" },
  }),
  // ---- 提醒 ----
  def("remind.receive", "remind", "接收 @ 提醒", {
    legacyKey: "remind_open",
    conditionParams: { mentionLimit: "remind_max_num" },
  }),
  // ---- 管理（后台 + 版主操作）----
  def("forum.moderate", "forum", "版主管理操作", { level: "manage" }),
  def("forum.forceReason", "forum", "操作必填理由", { legacyKey: "force_operate_reason" }),
  def("forum.viewLog", "forum", "查看帖子操作日志", { legacyKey: "look_thread_log" }),
  def("user.viewIp", "user", "查看用户 IP", { legacyKey: "view_ip_address" }),
  def("admin.users", "admin", "后台用户管理", { legacyKey: "panel_user_manage" }),
  def("admin.recycle", "admin", "后台回收站管理", { legacyKey: "panel_recycle_manage" }),
  def("admin.reports", "admin", "后台举报处理", { legacyKey: "panel_report_manage" }),
  def("admin.logs", "admin", "后台日志查看", { legacyKey: "panel_log_manage" }),
  def("design.manage", "design", "装修管理（预留）", { legacyKey: "design_allow_manage" }),
  def("fresh.delete", "fresh", "删除动态", { legacyKey: "fresh_delete" }),
];

/** ABAC 条件参数型旧键（转条件而非权限点，M6 消费） */
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
  sell_credits: { target: "thread.sell", param: "sellEnabled", description: "售帖开关" },
  sell_credit_range: { target: "thread.sell", param: "sellRange", description: "售帖价格区间" },
  enhide_credits: { target: "thread.hide", param: "hideEnabled", description: "隐藏帖开关" },
  post_check: { target: "thread.create", param: "reviewMode", description: "发帖审核模式" },
  invite_buy_credit_num: { target: "invite.buy", param: "price", description: "邀请码单价" },
  invite_limit_24h: { target: "invite.buy", param: "dailyLimit", description: "24H 购买上限" },
  message_max_send: { target: "pm.send", param: "dailyLimit", description: "每日私信上限" },
  remind_max_num: { target: "remind.receive", param: "mentionLimit", description: "每日 @ 上限" },
  sign_max_length: { target: "sign.use", param: "maxLength", description: "签名最大长度" },
  sign_max_height: { target: "sign.use", param: "maxHeight", description: "签名图片最大高度" },
  sign_ubb: { target: "sign.use", param: "allowUbb", description: "签名 UBB 开关" },
  sign_ubb_img: { target: "sign.use", param: "allowImg", description: "签名图片开关" },
  multimedia_auto_open: { target: "media.embed", param: "autoOpen", description: "多媒体自动播放" },
};

/** 级别隐含序：manage ⊃ write ⊃ read */
export const LEVEL_RANK: Record<NonNullable<PermissionDef["level"]>, number> = {
  read: 1,
  write: 2,
  manage: 3,
};

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
    key: "muted",
    name: "禁言",
    kind: "builtin",
    description: "禁止发帖/回帖/私信（其余权限不变）",
    legacyGids: [6],
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
  { key: "team-planning", name: "策划组", kind: "custom", description: "", legacyGids: [23] },
  { key: "team-resource", name: "资源组", kind: "custom", description: "", legacyGids: [36] },
  { key: "team-art", name: "美工组", kind: "custom", description: "", legacyGids: [37] },
  { key: "team-intern", name: "实习组", kind: "custom", description: "", legacyGids: [38] },
];

/** 级别隐含判定：granted level 满足 required level */
export function levelSatisfies(required: PermLevel, granted: PermLevel): boolean {
  return LEVEL_RANK[granted] >= LEVEL_RANK[required];
}

const VOCAB_BY_KEY = new Map(PERMISSION_DEFINITIONS.map((p) => [p.key, p]));

/**
 * 授权键是否满足所需权限点：
 * - 键精确相等 → 满足
 * - 同资源分级域 → 级别隐含（manage 满足 write/read）
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
