"use client";

import { useEffect, useRef } from "react";
import { readDraft, removeDraft, writeDraft } from "./draft";

/** 标题沿用独立草稿键：挂载后按 restore 恢复或清理，仅输入时写入；回复可禁用。 */
export function useTitleDraft(draftKey: string | null, restore: boolean, enabled = true) {
  const titleRef = useRef<HTMLInputElement>(null);
  const titleKey = draftKey === null || !enabled ? null : `${draftKey}:title`;

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

  return { titleRef, saveTitle };
}
