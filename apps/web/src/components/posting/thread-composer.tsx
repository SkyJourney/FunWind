"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * 发主题表单的草稿层（M6.2）。表单仍是原生 `<form action>`，直接提交 Server Action；
 * 这里只做草稿：未发送的内容保存在 sessionStorage，失败跳回时恢复。
 *
 * 草稿规则：
 * - 用户每次输入都写入 sessionStorage（键含用户 id 与版块号，换账号不会串草稿；只在本标签页内有效）；
 * - 页面带 `restore`（即上次提交失败跳回）时恢复草稿；否则是一次全新的发帖，清空草稿；
 * - 草稿只是浏览器里的个人便利：读写均包在 try/catch 里，存储不可用时表单照常工作。
 *
 * 输入框保持非受控（由 ref 读写 DOM 值）：恢复发生在挂载时，不需要为此增加状态，也避免在 effect 里同步 setState。
 */
interface Props {
  action: (formData: FormData) => Promise<void>;
  forumId: number;
  /** 草稿键（含用户与版块），由服务端生成 */
  draftKey: string;
  /** 本次页面是否为失败后的跳回：是则恢复草稿 */
  restore: boolean;
  /** 标题与正文上限，仅用于提示文字；真正的判定在服务端 */
  titleMax: number;
  bodyMax: number;
}

interface Draft {
  title: string;
  source: string;
}

export function ThreadComposer({ action, forumId, draftKey, restore, titleMax, bodyMax }: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  // 挂载时：失败跳回则恢复草稿，否则清空（新一次发帖从空白开始）
  useEffect(() => {
    try {
      if (!restore) {
        window.sessionStorage.removeItem(draftKey);
        return;
      }
      const raw = window.sessionStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw) as Partial<Draft>;
      if (titleRef.current && typeof d.title === "string") titleRef.current.value = d.title;
      if (sourceRef.current && typeof d.source === "string") sourceRef.current.value = d.source;
    } catch {
      // 存储不可用（隐私模式、被禁用）：不恢复，表单照常使用
    }
  }, [draftKey, restore]);

  // 每次输入后保存当前两个字段
  const saveDraft = () => {
    try {
      const d: Draft = {
        title: titleRef.current?.value ?? "",
        source: sourceRef.current?.value ?? "",
      };
      window.sessionStorage.setItem(draftKey, JSON.stringify(d));
    } catch {
      // 同上：写入失败只是少了草稿，不影响发帖
    }
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
          onInput={saveDraft}
          placeholder="给主题起个名字"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">最多 {titleMax} 字</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="thread-source" className="text-sm font-medium">
          正文
        </label>
        <textarea
          id="thread-source"
          name="source"
          ref={sourceRef}
          onInput={saveDraft}
          rows={12}
          placeholder="写点什么……"
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
        <p className="text-xs text-muted-foreground">最多 {bodyMax} 字</p>
      </div>

      <Button type="submit">发布主题</Button>
    </form>
  );
}
