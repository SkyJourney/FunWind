/**
 * 旧站权限键 → 新权限点的映射（迁移适配层知识，运行时 schema 与词汇表不认识旧站）。
 * 权限点词汇表见 packages/db 的 authz-vocab.ts；扩展词汇表时在此补对应的旧键。
 */

/**
 * 旧 rkey → 新权限点。同一旧键映射多个点的（allow_thread_extend）在翻译器里单独处理。
 * 注意：不映射 operate_thread——它对普通会员组只是「置顶有效时长」之类的设置数组，不是开关；
 * 版主权限只能经 forum.moderate 的作用域授权获得，绝不能由全局权限表翻译出来。
 */
export const LEGACY_PERMISSION_KEYS: Readonly<Record<string, readonly string[]>> = {
  allow_visit: ["site.visit"],
  panel_user_manage: ["admin.users"],
  panel_report_manage: ["admin.reports"],
  panel_log_manage: ["admin.logs"],
  panel_recycle_manage: ["admin.recycle"],
  allow_read: ["forum.read"],
  allow_post: ["forum.write"],
  // 旧站「回复」与「发帖」是两个键，新模型统一为 forum.write
  allow_reply: ["forum.write"],
  allow_report: ["forum.report"],
  reply_locked_threads: ["thread.replyLocked"],
  allow_upload: ["attachment.upload"],
  allow_download: ["attachment.download"],
  allow_add_vote: ["vote.create"],
  allow_participate_vote: ["vote.participate"],
  allow_view_vote: ["vote.view"],
  allow_sign: ["sign.use"],
  message_allow_send: ["pm.send"],
  tag_allow_add: ["tag.add"],
  tag_allow_edit: ["tag.edit"],
  tag_allow_manage: ["tag.manage"],
  view_ip_address: ["user.viewIp"],
};

/** 旧站 allow_thread_extend（sell/hide 开关数组）→ 门控创建权限 */
export const THREAD_EXTEND_KEY = "allow_thread_extend";

/**
 * ABAC 条件参数型旧键：不作为权限点，翻译时只计数进报告（M6 实现频控/编辑时限时按真实需求设计，不预置映射）。
 * 已取消功能（邀请购买、@提醒、多媒体）的条件键不再保留。
 */
export const LEGACY_CONDITION_KEYS: Readonly<
  Record<string, { target: string; param: string; description: string }>
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
