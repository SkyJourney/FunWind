import { splitByGatePlaceholders, splitSource } from "@funwind/content";
import { renderMarkdown } from "@/lib/markdown";

/**
 * 编辑器的预览（M6.3 §5）：用站点的真实渲染器渲染作者输入的源码。
 * 门控块只显示占位说明，不显示其中的正文：预览的输入只来自作者自己，不读库，
 * 但预览也不替代发布后的真实样子，所以门控正文与锁定的读者一样不出现在预览里。
 * 纯函数，无 I/O。
 */
export const GATE_PREVIEW_NOTE = "> 🔒 门控内容（发布后，未解锁的读者看不到这一段）";

export function previewHtml(source: string): string {
  // splitSource 即使有错误也会尽力返回公开部分；预览不因语法错误中断，错误由保存时给出
  const { publicMd } = splitSource(source);
  const md = splitByGatePlaceholders(publicMd)
    .map((seg) => (seg.kind === "md" ? seg.text : GATE_PREVIEW_NOTE))
    .join("\n\n");
  return renderMarkdown(md);
}
