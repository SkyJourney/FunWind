import { renderMarkdown } from "@repo/apps/web/src/lib/markdown";
import { splitSource } from "@repo/packages/content/src/index";

const norm = (h: string) => h.replace(/\s+/g, " ").replace(/> </g, "><").trim();

/** 「渲染等价」：公开部分渲染相同，且门控的条件 / key / 隐藏正文渲染相同。不是逐字相同 */
export function equivalent(a: string, b: string): { ok: boolean; reason?: string } {
  const sa = splitSource(a);
  const sb = splitSource(b);
  if (sa.errors.length) return { ok: false, reason: "原文本身门控语法有误: " + sa.errors[0]?.code };
  if (sb.errors.length)
    return { ok: false, reason: "往返后门控语法被破坏: " + sb.errors.map((e) => e.code).join(",") };
  if (sa.gates.length !== sb.gates.length)
    return { ok: false, reason: `门控数 ${sa.gates.length} → ${sb.gates.length}` };
  const pa = norm(renderMarkdown(sa.publicMd));
  const pb = norm(renderMarkdown(sb.publicMd));
  if (pa !== pb) return { ok: false, reason: "公开部分渲染不同" };
  for (let i = 0; i < sa.gates.length; i++) {
    const x = sa.gates[i]!,
      y = sb.gates[i]!;
    if (
      JSON.stringify(x.conditions) !== JSON.stringify(y.conditions) ||
      x.matchMode !== y.matchMode
    )
      return {
        ok: false,
        reason: `门控 ${i + 1} 条件变化: ${JSON.stringify(x.conditions)} → ${JSON.stringify(y.conditions)}`,
      };
    if (x.key !== y.key)
      return { ok: false, reason: `门控 ${i + 1} key 变化: ${x.key} → ${y.key}` };
    if (norm(renderMarkdown(x.hiddenMd)) !== norm(renderMarkdown(y.hiddenMd)))
      return { ok: false, reason: `门控 ${i + 1} 隐藏正文渲染不同` };
  }
  return { ok: true };
}

/** 去掉首尾空白后逐字相同？（比「渲染等价」更严；用来看编辑器是否静默改写了源码） */
export const sameText = (a: string, b: string) => a.trim() === b.trim();
