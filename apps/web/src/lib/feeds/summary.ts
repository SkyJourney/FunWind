import { splitByGatePlaceholders } from "@funwind/content";
import type { ElementContent, RootContent } from "hast";
import { sanitizeMarkdown } from "@/lib/markdown";

const PARAGRAPH_CONTAINERS = new Set(["p", "div", "blockquote", "ul", "ol", "li"]);
const OTHER_BLOCKS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "hr", "pre", "table"]);
const MAX_SUMMARY_CODE_POINTS = 120;
// XML 1.0 允许的码点范围。使用 Unicode 模式区分合法增补字符和孤立代理项。
const INVALID_XML_CHARS = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

/** 清除摘要及 XML 字段均无法使用的非法码点。 */
export function cleanXmlText(value: string): string {
  return value.replace(INVALID_XML_CHARS, "");
}

/** 仅提取净化后的可见文字，链接地址、图片属性等均不属于文字。 */
function inlineText(node: RootContent | ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  return node.tagName === "br" ? " " : node.children.map(inlineText).join("");
}

function normalizeParagraph(value: string): string {
  // 实体引用可在 Markdown 净化时解码，判空之前也要检查实际码点。
  return cleanXmlText(value).replace(/\s+/gu, " ").trim();
}

/** 查找首个有文字的段落，也支持旧帖直接放在对齐容器内的文字。 */
function firstParagraph(nodes: readonly (RootContent | ElementContent)[]): string {
  let text = "";
  for (const node of nodes) {
    if (node.type === "element") {
      const container = PARAGRAPH_CONTAINERS.has(node.tagName);
      if (container || OTHER_BLOCKS.has(node.tagName)) {
        const paragraph =
          normalizeParagraph(text) || (container ? firstParagraph(node.children) : "");
        if (paragraph) return paragraph;
        text = "";
        continue;
      }
    }
    text += inlineText(node);
  }
  return normalizeParagraph(text);
}

/** 从公开首帖取首个有文字的正文段，门控占位只负责划分边界。 */
export function summarizeFeedBody(bodyMd: string): string {
  for (const segment of splitByGatePlaceholders(bodyMd)) {
    if (segment.kind === "gate") continue;
    const text = firstParagraph(sanitizeMarkdown(cleanXmlText(segment.text)).children);
    if (text) return Array.from(text).slice(0, MAX_SUMMARY_CODE_POINTS).join("").trimEnd();
  }
  return "";
}
