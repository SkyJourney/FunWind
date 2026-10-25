import { assembleSource } from "@funwind/content";
import type { Subject } from "@/lib/authz/types";
import { loadEditableGates } from "@/lib/gates/service";
import { locatePost } from "@/lib/queries/locate-post";
import { readEditView } from "./mutate";
import { richEditReason } from "./roundtrip-check";

/**
 * 编辑页的加载结果（M6.2 第 4 步）。
 * - notfound：不可见 / 不存在 / 无编辑权限 → 404（不暴露存在性，与其它入口一致）；
 * - closed：有权编辑但当前不能改（时限已过、所属主题已隐藏或删除）→ 说明文字；
 * - broken：门控数据读不全或与正文对不上 → 明确告知，**绝不**带残缺的正文渲染（保存会丢掉隐藏内容）；
 * - form：表单所需的全部事实。source 是完整源码（含门控块的隐藏正文），只对有权编辑且能读到全部门控的人给出。
 */
export type EditPageModel =
  | { kind: "notfound" }
  | { kind: "closed"; text: string }
  | { kind: "broken"; text: string }
  | {
      kind: "form";
      postId: number;
      threadId: number;
      forumId: number;
      threadKind: "thread" | "reply";
      title: string;
      source: string;
      editedAt: string | null;
      /** 版主编辑别人的内容：必须填理由 */
      reasonRequired: boolean;
      /** 编辑后要重新提交审核（驳回后的修改） */
      resubmit: boolean;
      /** 驳回理由（仅驳回后的修改有；没有理由则 null） */
      reviewNote: string | null;
      /** 往返不等价：只能源码编辑，这里是原因（null = 可以所见即所得） */
      forceSource: string | null;
    };

export async function loadEditPage(viewer: Subject, postId: number): Promise<EditPageModel> {
  // 先看可见性：不可见的帖子对谁都是 404，不进入权限判定
  const loc = await locatePost(viewer, postId);
  if (!loc) return { kind: "notfound" };

  const view = await readEditView(viewer, postId);
  if (!view) return { kind: "notfound" };
  if (!view.decision.allowed) {
    if (view.decision.code === "edit_window_closed") {
      return { kind: "closed", text: "已超出编辑时限，无法修改此内容。" };
    }
    if (view.decision.code === "thread_gone") {
      return { kind: "closed", text: "所属主题已被隐藏或删除，无法编辑。" };
    }
    return { kind: "notfound" };
  }

  let source = view.bodyMd;
  if (view.hasGate) {
    const gates = await loadEditableGates(viewer, postId);
    if (!gates) {
      return { kind: "broken", text: "无法读取完整正文（部分门控内容不可见），请联系版主。" };
    }
    const assembled = assembleSource(view.bodyMd, gates);
    if (assembled.errors.length > 0) {
      return { kind: "broken", text: "门控数据与正文不一致，无法编辑，请联系版主。" };
    }
    source = assembled.source;
  }

  return {
    kind: "form",
    postId,
    threadId: view.threadId,
    forumId: view.forumId,
    threadKind: view.kind,
    title: view.title,
    source,
    editedAt: view.editedAt,
    reasonRequired: view.decision.reasonRequired,
    resubmit: view.decision.resubmit,
    reviewNote: view.decision.resubmit ? view.reviewNote : null,
    forceSource: richEditReason(source),
  };
}
