import { splitSource } from "@funwind/content";
import { roundtripMarkdown } from "@/components/editor/markdown/roundtrip";
import { renderMarkdown } from "@/lib/markdown";

/**
 * 往返保护（M6.3 §3）：原文经编辑器「载入 → 取回」后，站点渲染器的结果是否不变。
 * 不变（渲染等价）才允许以所见即所得编辑；否则只能以源码编辑，并说明原因。
 * 判定在服务端做（编辑页加载器），结论不依赖浏览器。
 */
export const SOURCE_ONLY_REASON =
  "本帖的格式在所见即所得中无法完整还原，已切换为源码编辑（发布后的显示不变）。";

/**
 * 渲染等价：两份源码都能被门控拆分（无错误），且整份源码经站点渲染器的结果相同。
 * 门控的属性（key、条件、匹配模式）与隐藏正文都在源码里，整体渲染即同时覆盖它们，且不需要单独读取门控字段。
 */
export function renderEquivalent(a: string, b: string): boolean {
  if (splitSource(a).errors.length > 0 || splitSource(b).errors.length > 0) return false;
  return renderMarkdown(a) === renderMarkdown(b);
}

/** 这份原文能否以所见即所得编辑（true）；否则返回只能源码编辑的原因 */
export function richEditReason(source: string): string | null {
  try {
    return renderEquivalent(source, roundtripMarkdown(source)) ? null : SOURCE_ONLY_REASON;
  } catch {
    return SOURCE_ONLY_REASON;
  }
}
