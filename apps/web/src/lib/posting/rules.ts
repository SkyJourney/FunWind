import type { ContentState } from "@/lib/authz/evaluator";

/**
 * 写路径的"谁能对哪条内容做什么"（M6.1，纯函数；设计稿 §5.2）。
 *
 * 不进评估器：评估器只回答 RBAC 问题（有没有 forum.write / forum.moderate），"这是不是你的帖子""主题有没有人回复"
 * 是内容事实，在这里与评估器的结论组合。调用方负责把事实取对（事务内持锁重读），本模块只做决定。
 */

export type PostKind = "thread" | "reply";

export interface ActorFacts {
  userId: number;
  /** 在目标版块持有 forum.moderate */
  isModerator: boolean;
  /** 评估器对 forum.write 的结论（目标版块；已含禁言 / 封禁 / 归档 / 分区）。作者改自己的内容也要求它仍然成立 */
  canWrite: boolean;
}

export interface TargetFacts {
  kind: PostKind;
  authorId: number;
  /** 这条帖子自己的状态；kind=thread 时是首帖状态 */
  state: ContentState;
  /** 所属主题的状态 */
  threadState: ContentState;
  /** 该主题里**别人**（非该帖作者）的可见回帖数；删除"无人回复的主题"的判据 */
  othersVisibleReplies: number;
  /** 发布至今的秒数（编辑时限的判据） */
  ageSec: number;
}

export type DenyCode =
  | "forbidden" // 无权
  | "already_deleted"
  | "thread_gone" // 所属主题已不可见，作者不能再动里面的回帖
  | "bad_state" // 当前状态下不允许这个动作
  | "has_replies" // 主题已有别人的回复，作者不能删
  | "not_restorable"
  | "edit_window_closed"; // 超出作者可自行编辑的时限（版主不受限）

export type RuleDecision =
  | {
      allowed: true;
      /** 是否必须填理由（版主动作作用于别人的内容；理由写审计） */
      reasonRequired: boolean;
      /** 编辑后是否要重新提交审核（rejected → pending） */
      resubmit: boolean;
    }
  | { allowed: false; code: DenyCode };

const allow = (reasonRequired = false, resubmit = false): RuleDecision => ({
  allowed: true,
  reasonRequired,
  resubmit,
});
const deny = (code: DenyCode): RuleDecision => ({ allowed: false, code });

/** 所属主题对非版主已经不存在（隐藏 / 删除）：里面的内容作者也动不了 */
const threadGoneForAuthor = (t: TargetFacts) =>
  t.threadState === "hidden" || t.threadState === "deleted";

/**
 * 编辑。
 *  · 作者本人：须 forum.write 仍成立；pending / visible / rejected 可改（rejected 改完重新提交）；hidden / deleted 是版主的决定，作者不能动。
 *  · 版主改别人的：除 deleted 外都可改，必须填理由。
 */
export function canEdit(actor: ActorFacts, t: TargetFacts, editWindowSec = 0): RuleDecision {
  const isAuthor = actor.userId === t.authorId;
  if (isAuthor) {
    if (!actor.canWrite) return actor.isModerator ? moderatorEdit(t) : deny("forbidden");
    if (threadGoneForAuthor(t)) return deny("thread_gone");
    // 编辑时限：0 = 不限；版主不受限（版主编辑别人的内容本来就要理由）
    if (!actor.isModerator && editWindowSec > 0 && t.ageSec > editWindowSec) {
      return deny("edit_window_closed");
    }
    if (t.state === "visible" || t.state === "pending") return allow();
    if (t.state === "rejected") return allow(false, true);
    if (t.state === "deleted") return deny("already_deleted");
    return deny("bad_state");
  }
  return actor.isModerator ? moderatorEdit(t) : deny("forbidden");
}

function moderatorEdit(t: TargetFacts): RuleDecision {
  if (t.state === "deleted") return deny("already_deleted");
  return allow(true, false);
}

/**
 * 删除（软删）。
 *  · 已删除的不能再删。
 *  · 作者本人：须 forum.write 仍成立；只能删自己的回帖，或"没有别人回复的主题"；hidden 是版主的决定，不能自删。
 *  · 版主：任何内容，作用于别人的内容必须填理由。
 */
export function canDelete(actor: ActorFacts, t: TargetFacts): RuleDecision {
  if (t.state === "deleted") return deny("already_deleted");
  const isAuthor = actor.userId === t.authorId;
  if (actor.isModerator) return allow(!isAuthor);
  if (!isAuthor || !actor.canWrite) return deny("forbidden");
  if (threadGoneForAuthor(t)) return deny("thread_gone");
  if (t.state === "hidden") return deny("bad_state");
  if (t.kind === "thread" && t.othersVisibleReplies > 0) return deny("has_replies");
  return allow();
}

/** 恢复：只有版主能做（作者不能恢复自己删的，避免绕过版主的删除决定），必须填理由，只针对 deleted / hidden */
export function canRestore(actor: ActorFacts, t: TargetFacts): RuleDecision {
  if (!actor.isModerator) return deny("forbidden");
  if (t.state !== "deleted" && t.state !== "hidden") return deny("not_restorable");
  return allow(true);
}
