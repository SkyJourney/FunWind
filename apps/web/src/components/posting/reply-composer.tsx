"use client";

import { Button } from "@/components/ui/button";
import { EditorShell } from "@/components/editor/editor-shell";

/**
 * 快速回复表单（M6.3 第 5 步）：正文是编辑器外壳（所见即所得 / 源码）。草稿规则与外壳一致：
 * 键含用户与主题号（换主题不串草稿）；失败跳回时恢复，否则清掉旧草稿。表单仍是原生 `<form action>`。
 */
interface Props {
  action: (formData: FormData) => Promise<void>;
  threadId: number;
  /** 主题所在版块：上传图片与附件的权限按版块判定 */
  forumId: number;
  /** 表单所在的回帖页，失败后原样跳回 */
  page: number;
  draftKey: string | null;
  restore: boolean;
  bodyMax: number;
}

export function ReplyComposer({
  action,
  threadId,
  forumId,
  page,
  draftKey,
  restore,
  bodyMax,
}: Props) {
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="page" value={page} />

      <EditorShell
        name="source"
        initialSource=""
        draftKey={draftKey}
        restoreDraft={restore}
        label="回复内容"
        forumId={forumId}
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">最多 {bodyMax} 字</p>
        <Button type="submit">发表回复</Button>
      </div>
    </form>
  );
}
