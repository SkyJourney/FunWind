/**
 * 发主题页的展示决策与错误文案（纯函数，不做任何 I/O）。
 * 发帖页与版块页的「发新主题」入口共用 composeAccess，两边的判定不会不一致。
 * 错误码只认固定集合：未知码一律显示通用文案，URL 里的其它内容一律忽略。
 */

/** 发帖失败的固定提示码（?error=…）→ 文案。覆盖 createThread 可能返回的业务错误码 */
export const POSTING_NOTICES: Record<string, string> = {
  title_empty: "请填写标题。",
  title_too_long: "标题太长了，请精简后再发。",
  body_empty: "请填写正文。",
  body_too_long: "正文太长了，请精简后再发。",
  gate_syntax: "锁定内容语法有误，请检查 :::gate 块的写法。",
  gate_permission: "锁定内容设置不被允许（你没有使用该类锁定内容的权限）。",
  too_frequent: "发帖太频繁，请稍后再试。",
  quota_exceeded: "今日发主题次数已达上限，明天再来吧。",
  forbidden: "你没有权限执行此操作，或内容的状态已变化。",
  forum_not_found: "该版块不存在或你无法查看。",
  thread_closed: "该主题暂不接受回复。",
  thread_locked: "主题已锁定，暂不接受回复。",
  thread_gone: "该主题已被隐藏或删除，无法操作。",
  // 删除 / 恢复（M6.2 第 5 步）
  has_replies: "主题已有其他人的回复，作者不能删除（可请版主处理）。",
  not_restorable: "只能恢复已删除或已隐藏的内容。",
  not_found: "该主题不存在或你无法查看，无法回复。",
  // 编辑（M6.2 第 4 步）
  conflict: "这条内容刚刚被修改过，请刷新页面后再编辑。",
  reason_required: "版主编辑他人的内容须填写理由（会写入审计记录）。",
  reason_too_long: "理由太长了，请精简后再提交。",
  edit_window_closed: "已超出编辑时限，无法修改此内容。",
  already_deleted: "该内容已被删除，无法编辑。",
  bad_state: "当前状态下不能编辑此内容。",
  gate_has_unlocks: "这段内容已有人解锁，不能改变解锁方式或删除这段锁定内容（只能修改价格）。",
  file_missing: "有图片或附件已失效（可能未上传成功），请重新上传后再发布。",
  file_not_owned: "只能引用你自己上传过的图片或附件。",
  attachment_gate_invalid: "附件归属的锁定内容不存在于本帖，请重新选择归属。",
  attachment_limit: "附件数量超过上限，请精简后再发布。",
  upload_forbidden: "你在该版块没有上传附件或图片的权限，请删除新增的图片或附件后再发布。",
  inline_limit: "正文中的图片数量超过上限，请精简后再发布。",
  gate_conditions_locked: "这段锁定内容已有人解锁，不能修改它的解锁条件。",
  gate_has_attachments: "这个锁定内容下还挂着附件，请先处理附件再删除锁定内容。",
  // 标签（M8）
  tag_denied: "新建标签需要相应权限，请从已有标签中选择。",
  tag_too_many: "标签数量超过上限，请精简后再发布。",
  poll_option_count: "投票选项须 2–20 项。",
  poll_option_limit: "可选项数设置与选项数不匹配。",
};

/** 通用失败文案：未知码或不在白名单内的码统一用它，不把错误码原样显示 */
export const POSTING_FALLBACK = "发布失败，请稍后重试。";

/** 错误码 → 文案。undefined（没有错误）返回 null；不在白名单内的码返回通用文案 */
export function postingNoticeText(code: string | undefined): string | null {
  if (code === undefined) return null;
  return Object.hasOwn(POSTING_NOTICES, code) ? POSTING_NOTICES[code]! : POSTING_FALLBACK;
}

export type ReviewPolicyValue = "none" | "threads" | "all";

/** 判定所需的事实：都由调用方（lib/posting/compose-access.ts）从权限与版块树取得 */
export interface ComposeFacts {
  isGuest: boolean;
  /** 评估器对 forum.write 的结论（已含归档、分区、锁定以外的所有写权限判断） */
  canWrite: boolean;
  isSection: boolean;
  /** 版块自身或任一祖先已归档 */
  archived: boolean;
  /** 有效审核策略（继承已解析） */
  reviewPolicy: ReviewPolicyValue;
}

/** 发帖入口的展示结果：表单（附带是否需要审核的提示）或不可发帖的说明 */
export type ComposeAccess =
  | { mode: "form"; reviewHint: boolean }
  | { mode: "closed"; text: string; loginHref: string | null };

/**
 * 决定发帖入口怎么显示。判定顺序：能写 → 表单；否则按原因给说明（游客先提示登录，
 * 再依次归档、分区，最后通用）。拒绝的原因是固定文案，不泄露权限细节。
 */
export function composeAccess(f: ComposeFacts): ComposeAccess {
  if (f.canWrite) {
    return { mode: "form", reviewHint: f.reviewPolicy === "threads" || f.reviewPolicy === "all" };
  }
  if (f.isGuest) {
    return { mode: "closed", text: "登录后可在该版块发帖。", loginHref: "/login" };
  }
  if (f.archived) {
    return { mode: "closed", text: "该版块已归档，暂不接受新内容。", loginHref: null };
  }
  if (f.isSection) {
    return { mode: "closed", text: "这是分区，请进入其中的版块发帖。", loginHref: null };
  }
  return { mode: "closed", text: "你暂时不能在该版块发帖。", loginHref: null };
}

/** 审核提示（表单上方）：仅当该版块的新主题需要审核时显示 */
export const REVIEW_HINT = "本版块的新主题需版主审核，通过后才对他人可见。";

/** 回复入口的判定事实（与发主题相比多出主题是否锁定，且只有「全部审核」才审核回复） */
export interface ReplyFacts {
  isGuest: boolean;
  /** 评估器对 forum.write（带 threadLocked）的结论：锁定的主题只有持 thread.replyLocked 的人能写 */
  canWrite: boolean;
  archived: boolean;
  threadLocked: boolean;
  reviewPolicy: ReviewPolicyValue;
}

/**
 * 快速回复入口的展示。判定顺序：能写 → 表单；否则游客提示登录，再依次归档、锁定，最后通用。
 * 回复的审核只在版块策略为「全部审核」时发生（initialState 的 reply 分支）。
 */
export function replyAccess(f: ReplyFacts): ComposeAccess {
  if (f.canWrite) {
    return { mode: "form", reviewHint: f.reviewPolicy === "all" };
  }
  if (f.isGuest) {
    return { mode: "closed", text: "登录后可回复。", loginHref: "/login" };
  }
  if (f.archived) {
    return { mode: "closed", text: "该版块已归档，暂不接受新内容。", loginHref: null };
  }
  if (f.threadLocked) {
    return { mode: "closed", text: "主题已锁定，暂不接受回复。", loginHref: null };
  }
  return { mode: "closed", text: "你暂时不能回复该主题。", loginHref: null };
}

/** 回复的审核提示（回复表单上方）：仅当版块对回复全部审核时显示 */
export const REPLY_REVIEW_HINT = "本版块的回复需版主审核，通过后才对他人可见。";
