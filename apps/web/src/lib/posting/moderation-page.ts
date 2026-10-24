import type { Subject } from "@/lib/authz/types";
import { readModerationView } from "./mutate";

/**
 * 删除 / 恢复确认页的加载结果（M6.2 第 5 步）。判定全部来自 readModerationView（即 canDelete / canRestore），
 * 这里只决定展示：
 * - notfound：无权限、不存在、状态不允许 → 404（不暴露存在性）；
 * - closed：有权操作但当前不能删（主题已有别人的回复、所属主题已隐藏或删除）→ 说明；
 * - form：确认页所需的事实。reasonRequired 为真时必须填写理由（版主操作、恢复）。
 */
export type DeletePageModel =
  | { kind: "notfound" }
  | { kind: "closed"; text: string }
  | {
      kind: "form";
      postId: number;
      threadId: number;
      threadKind: "thread" | "reply";
      title: string;
      reasonRequired: boolean;
    };

const DELETE_CLOSED: Record<string, string> = {
  has_replies: "主题已有其他人的回复，作者不能删除（可请版主处理）。",
  thread_gone: "所属主题已被隐藏或删除，无法操作。",
};

export async function loadDeletePage(viewer: Subject, postId: number): Promise<DeletePageModel> {
  const v = await readModerationView(viewer, postId);
  if (!v) return { kind: "notfound" };
  if (!v.delete.allowed) {
    const text = DELETE_CLOSED[v.delete.code];
    return text ? { kind: "closed", text } : { kind: "notfound" };
  }
  return {
    kind: "form",
    postId,
    threadId: v.threadId,
    threadKind: v.kind,
    title: v.title,
    reasonRequired: v.delete.reasonRequired,
  };
}

export type RestorePageModel =
  | { kind: "notfound" }
  | {
      kind: "form";
      postId: number;
      threadId: number;
      threadKind: "thread" | "reply";
      title: string;
    };

export async function loadRestorePage(viewer: Subject, postId: number): Promise<RestorePageModel> {
  const v = await readModerationView(viewer, postId);
  // 恢复只有版主能做；作者看到的一律 404（canRestore 已经拒绝）
  if (!v || !v.restore.allowed) return { kind: "notfound" };
  return {
    kind: "form",
    postId,
    threadId: v.threadId,
    threadKind: v.kind,
    title: v.title,
  };
}
