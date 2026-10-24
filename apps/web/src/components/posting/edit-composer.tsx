"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 编辑帖子的表单（M6.2 第 4 步）。原生 `<form action>` 提交 Server Action；这里只管草稿。
 * - 正文与标题以服务端给出的完整源码为初值（defaultValue），不由客户端拼装；
 * - 草稿规则与发帖一致：键含用户与帖子号；失败跳回（带 `restore`）时恢复，否则清空；
 *   冲突（conflict）时页面不带 `restore`，展示最新版本，避免把草稿套在新版本上静默覆盖别人的修改；
 * - expectedEditedAt 作为隐藏字段回传，服务端据此判断表单渲染后内容是否又被改过。
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
  /** 驳回后的修改：保存即重新提交审核，提示用户 */
  resubmit: boolean;
  /** 驳回理由（驳回后的修改才有） */
  reviewNote: string | null;
  draftKey: string;
  restore: boolean;
  titleMax: number;
  bodyMax: number;
}

interface Draft {
  title?: string;
  source?: string;
  reason?: string;
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
  draftKey,
  restore,
  titleMax,
  bodyMax,
}: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      if (!restore) {
        window.sessionStorage.removeItem(draftKey);
        return;
      }
      const raw = window.sessionStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as Draft;
      if (titleRef.current && typeof d.title === "string") titleRef.current.value = d.title;
      if (sourceRef.current && typeof d.source === "string") sourceRef.current.value = d.source;
      if (reasonRef.current && typeof d.reason === "string") reasonRef.current.value = d.reason;
    } catch {
      // 存储不可用：不恢复，表单照常使用
    }
  }, [draftKey, restore]);

  const saveDraft = () => {
    try {
      const d: Draft = {
        title: titleRef.current?.value,
        source: sourceRef.current?.value ?? "",
        reason: reasonRef.current?.value,
      };
      window.sessionStorage.setItem(draftKey, JSON.stringify(d));
    } catch {
      // 写入失败只是少了草稿
    }
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
            onInput={saveDraft}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">最多 {titleMax} 字</p>
        </div>
      )}

      <div className="space-y-1.5">
        <label htmlFor="edit-source" className="text-sm font-medium">
          正文
        </label>
        <textarea
          id="edit-source"
          name="source"
          ref={sourceRef}
          defaultValue={source}
          onInput={saveDraft}
          rows={14}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
            ref={reasonRef}
            onInput={saveDraft}
            placeholder="例如：删除广告链接"
            autoComplete="off"
          />
        </div>
      )}

      <Button type="submit">保存修改</Button>
    </form>
  );
}
