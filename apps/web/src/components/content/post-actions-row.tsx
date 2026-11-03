import "server-only";
import Link from "next/link";
import { PostActionLink } from "@/components/posting/post-action-link";
import { SubmitButton } from "@/components/ui/submit-button";

type PostAction = (formData: FormData) => Promise<void>;

/** 帖子动作的服务端展示：只消费页面已计算的权限与注入的 Action，不读取主体或重新鉴权。 */
export function PostActionsRow({
  postId,
  canEdit,
  canHide,
  canReview,
  canDisable,
  canRestore,
  canReport,
  reasonRequired,
  actions,
}: {
  postId: number;
  canEdit: boolean;
  canHide: boolean;
  canReview: boolean;
  canDisable: boolean;
  canRestore: boolean;
  canReport: boolean;
  reasonRequired: boolean;
  actions: {
    delete: PostAction;
    hide: PostAction;
    approve: PostAction;
    reject: PostAction;
    disable: PostAction;
    restore: PostAction;
    report: PostAction;
  };
}) {
  return (
    <>
      {canEdit && (
        <>
          <Link href={`/p/${postId}/edit`} className="text-primary hover:underline">
            编辑
          </Link>
          <PostActionLink
            postId={postId}
            kind="delete"
            action={actions.delete}
            reasonRequired={reasonRequired}
          />
        </>
      )}
      {canHide && <PostActionLink postId={postId} kind="hide" action={actions.hide} />}
      {/* 待审内容就地过审；权限仍由页面计算、写入 Action 再校验。 */}
      {canReview && (
        <>
          <form action={actions.approve}>
            <input type="hidden" name="postId" value={postId} />
            <SubmitButton pendingText="通过中…" className="text-primary hover:underline">
              通过
            </SubmitButton>
          </form>
          <form action={actions.reject} className="inline-flex items-center gap-1">
            <input type="hidden" name="postId" value={postId} />
            <input
              name="reason"
              required
              maxLength={255}
              placeholder="驳回理由（必填）"
              aria-label="驳回理由"
              className="w-32 rounded border bg-background px-1.5 py-0.5 text-xs"
            />
            <SubmitButton pendingText="驳回中…" className="text-destructive hover:underline">
              驳回
            </SubmitButton>
          </form>
        </>
      )}
      {canDisable && (
        <form action={actions.disable} className="inline-flex items-center gap-1">
          <input type="hidden" name="postId" value={postId} />
          <input
            name="reason"
            required
            maxLength={255}
            placeholder="封禁理由（作者可见）"
            aria-label="封禁理由（作者可见）"
            className="w-32 rounded border bg-background px-1.5 py-0.5 text-xs"
          />
          <SubmitButton pendingText="封禁中…" className="text-destructive hover:underline">
            封禁
          </SubmitButton>
        </form>
      )}
      {canRestore && <PostActionLink postId={postId} kind="restore" action={actions.restore} />}
      {canReport && <PostActionLink postId={postId} kind="report" action={actions.report} />}
    </>
  );
}
