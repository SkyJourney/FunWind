"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EditorShell } from "@/components/editor/editor-shell";
import { readDraft, removeDraft, writeDraft } from "@/components/editor/draft";

/**
 * 发主题表单（M6.3 第 5 步）。标题是普通输入框；正文是编辑器外壳（所见即所得 / 源码，见 components/editor）。
 * 草稿：正文由外壳保存；标题保存在 `<草稿键>:title`，规则相同——失败跳回时恢复，否则清掉旧草稿。
 * 表单仍是原生 `<form action>`，直接提交 Server Action。
 */
interface Props {
  action: (formData: FormData) => Promise<void>;
  forumId: number;
  /** 草稿键（见 components/editor/draft.ts）；null 表示不保存草稿 */
  draftKey: string | null;
  /** 失败跳回：恢复草稿；否则清掉旧草稿 */
  restore: boolean;
  /** 标题与正文上限，仅用于提示；真正的判定在服务端 */
  titleMax: number;
  bodyMax: number;
}

export function ThreadComposer({ action, forumId, draftKey, restore, titleMax, bodyMax }: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const titleKey = draftKey === null ? null : `${draftKey}:title`;

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
      <input type="hidden" name="forumId" value={forumId} />

      <div className="space-y-1.5">
        <label htmlFor="thread-title" className="text-sm font-medium">
          标题
        </label>
        <Input
          id="thread-title"
          name="title"
          ref={titleRef}
          onInput={saveTitle}
          placeholder="给主题起个名字"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">最多 {titleMax} 字</p>
      </div>

      <div className="space-y-1.5">
        <span className="text-sm font-medium">正文</span>
        <EditorShell
          name="source"
          initialSource=""
          draftKey={draftKey}
          restoreDraft={restore}
          label="正文"
          forumId={forumId}
        />
        <p className="text-xs text-muted-foreground">最多 {bodyMax} 字</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="thread-tags" className="text-sm font-medium">
          标签{" "}
          <span className="text-xs text-muted-foreground">
            （选填，逗号分隔，最多 5 个；新建标签需要权限）
          </span>
        </label>
        <Input id="thread-tags" name="tags" placeholder="例如：字幕, 日剧" autoComplete="off" />
      </div>

      <Button type="submit">发布主题</Button>
    </form>
  );
}
