import type { Element, ElementContent, Root } from "hast";
import { HIGHLIGHT_BUDGET_CHARS, HIGHLIGHT_MAX_CHARS, lowlight } from "./highlight";

/**
 * 代码块语法高亮（M10.8 Step 5）：rehype 插件，放在 `rehypeSanitize` 与 `rehypeHarden` **之后**。
 *
 * 安全：净化白名单没有放宽——`class` 仍然只放行 `language-xxx`，作者写不出任何自定义 class。
 * 高亮产生的 `<span class="hljs-…">` 由本插件在净化之后生成：class 来自 highlight.js 的固定词表，文本节点原样保留
 * （由 rehype-stringify 统一转义），语言名只用来查 lowlight 的注册表，不会被拼进任何输出。
 *
 * 只处理 `<pre><code class="language-xxx">` 且 code 里只有文本的情形；没写语言、语言未注册、含内嵌元素、
 * 单段超过 HIGHLIGHT_MAX_CHARS、或本篇累计超过 HIGHLIGHT_BUDGET_CHARS 的一律保持原样（纯文本）。
 */
const LANG_CLASS = /^language-([\w-]+)$/;

function languageOf(code: Element): string | undefined {
  const cls = code.properties?.className;
  const list = Array.isArray(cls) ? cls : [];
  for (const c of list) {
    const m = LANG_CLASS.exec(String(c));
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** code 的纯文本；含内嵌元素（作者在代码里写了 HTML 标签）则返回 null，保持原样 */
function plainTextOf(code: Element): string | null {
  let text = "";
  for (const child of code.children) {
    if (child.type !== "text") return null;
    text += child.value;
  }
  return text;
}

/** 一篇内容的累计高亮预算（每次转换新建一份） */
interface Budget {
  left: number;
}

function highlightCode(code: Element, budget: Budget): void {
  const lang = languageOf(code);
  if (lang === undefined || !lowlight.registered(lang)) return;
  const text = plainTextOf(code);
  if (text === null || text.length > HIGHLIGHT_MAX_CHARS || text.length > budget.left) return;
  budget.left -= text.length;
  try {
    code.children = lowlight.highlight(lang, text).children as ElementContent[];
  } catch {
    // 个别语法解析失败：保持纯文本，不影响整篇渲染
  }
}

function walk(node: Root | Element, budget: Budget): void {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === "pre") {
      for (const inner of child.children) {
        if (inner.type === "element" && inner.tagName === "code") highlightCode(inner, budget);
      }
    } else {
      walk(child, budget);
    }
  }
}

export function rehypeHighlight() {
  return (tree: Root): void => {
    walk(tree, { left: HIGHLIGHT_BUDGET_CHARS });
  };
}
