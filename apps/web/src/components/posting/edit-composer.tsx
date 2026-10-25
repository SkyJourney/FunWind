"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditorShell } from "@/components/editor/editor-shell";
import type { AttachmentItem } from "@/components/upload/attachment-panel";
import { readDraft, removeDraft, writeDraft } from "@/components/editor/draft";

/**
 * 编辑帖子表单（M6.3 第 5 步）。正文是编辑器外壳，初值是服务端给出的完整源码（含门控的隐藏正文）。
 * - forceSource：往返不等价的旧帖只能以源码编辑（服务端判定，见 lib/posting/edit-page.ts）；
 * - expectedEditedAt 作为隐藏字段回传（乐观锁，M6.2 §4）；冲突（conflict）时不恢复草稿，展示最新版本；
 * - 草稿：正文由外壳保存；标题（主题）保存在 `<草稿键>:title`。
 */
interface Props {
  action: (formData: FormData) => Promise<void>;
  postId: number;
  threadKind: "thread" | "reply";
  title: string;
  source: string;
  editedAt: string | null;
  /** 版主编辑别人的内容：显示必填的理由输入框 */
  reasonRequired: boolean;
  /** 驳回后的修改：保存即重新提交审核 */
  resubmit: boolean;
  /** 驳回理由（驳回后的修改才有） */
  reviewNote: string | null;
  /** 往返不等价：只能以源码编辑，并说明原因 */
  forceSource: string | null;
  /** 已有人解锁的门控（改价提示） */
  gateUnlocks: { gateKey: string; count: number }[];
  /** 所在版块（上传图片与附件） */
  forumId: number;
  /** 本帖现有的下载附件 */
  initialAttachments: AttachmentItem[];
  draftKey: string | null;
  restore: boolean;
  titleMax: number;
  bodyMax: number;
}

export function EditComposer({
  action,
  postId,
  threadKind,
  title,
  source,
  editedAt,
  reasonRequired,
  resubmit,
  reviewNote,
  forceSource,
  gateUnlocks,
  forumId,
  initialAttachments,
  draftKey,
  restore,
  titleMax,
  bodyMax,
}: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const titleKey = draftKey === null || threadKind !== "thread" ? null : `${draftKey}:title`;

  useEffect(() => {
    if (titleKey === null) return;
    try {
      if (!restore) {
        removeDraft(titleKey);
        return;
      }
      const saved = readDraft(titleKey);
      if (saved !== null && titleRef.current) titleRef.current.value = saved;
    } catch {
      // 存储不可用：不恢复
    }
  }, [titleKey, restore]);

  const saveTitle = () => {
    if (titleKey !== null && titleRef.current) writeDraft(titleKey, titleRef.current.value);
  };

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="postId" value={postId} />
      <input type="hidden" name="expectedEditedAt" value={editedAt ?? ""} />

      {resubmit && (
        <div className="space-y-1 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-sm text-info">
          <p>这条内容曾被驳回。保存后将重新提交审核，通过后才对他人可见。</p>
          {reviewNote && <p>驳回理由：{reviewNote}</p>}
        </div>
      )}

      {threadKind === "thread" && (
        <div className="space-y-1.5">
          <label htmlFor="edit-title" className="text-sm font-medium">
            标题
          </label>
          <Input
            id="edit-title"
            name="title"
            ref={titleRef}
            defaultValue={title}
            onInput={saveTitle}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">最多 {titleMax} 字</p>
        </div>
      )}

      <div className="space-y-1.5">
        <span className="text-sm font-medium">正文</span>
        {gateUnlocks.length > 0 && (
          <div
            role="note"
            className="space-y-1 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm"
          >
            {gateUnlocks.map((g) => (
              <p key={g.gateKey}>
                门控 {g.gateKey} 已有 {g.count}{" "}
                人解锁：改价只影响之后的购买，已购买者不退差价；不能改变解锁方式或删除该门控。
              </p>
            ))}
          </div>
        )}

        <EditorShell
          name="source"
          initialSource={source}
          draftKey={draftKey}
          restoreDraft={restore}
          forceSource={forceSource === null ? null : { reason: forceSource }}
          label="正文"
          forumId={forumId}
          initialAttachments={initialAttachments}
        />
        <p className="text-xs text-muted-foreground">最多 {bodyMax} 字</p>
      </div>

      {reasonRequired && (
        <div className="space-y-1.5">
          <label htmlFor="edit-reason" className="text-sm font-medium">
            编辑理由（必填，写入审计记录）
          </label>
          <Input
            id="edit-reason"
            name="reason"
            placeholder="例如：删除广告链接"
            autoComplete="off"
          />
        </div>
      )}

      <Button type="submit">保存修改</Button>
    </form>
  );
}
