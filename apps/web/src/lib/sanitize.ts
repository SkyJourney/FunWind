import type { ElementContent, Root } from "hast";
import type { Schema } from "hast-util-sanitize";

/**
 * 净化白名单（基线安全核心，M3）。
 * 来源约束：content_md 由 UBB→Markdown 转换器产出，内嵌 HTML 只有转换器认识的有限形态
 * （span 颜色/字号/背景、u/s、div 对齐）+ Markdown 常规结构 + 表情/附件图。
 * 原则：不在白名单一律剥壳留肉或整删；style 值做声明级白名单（封死 url()/expression()）。
 */

/** style 属性中允许保留的 CSS 声明与值形态（情怀排版：UBB color/size/backcolor/align） */
const ALLOWED_STYLE_PROPS = new Set(["color", "background-color", "font-size", "text-align"]);
/** 无括号值：颜色名/十六进制/数字/百分比 */
const SAFE_PLAIN_VALUE_RE = /^[#a-zA-Z0-9%,.\s-]+$/;
/** 唯一放行的括号形态：颜色函数（防 url()/expression() 等借括号绕过） */
const SAFE_FUNC_VALUE_RE =
  /^(?:rgb|rgba|hsl|hsla)\(\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*,\s*\d{1,3}%?\s*(?:,\s*(?:0?\.\d+|1|100%)\s*)?\)$/i;
/** 黑名单关键词双保险（大小写不敏感） */
const DANGEROUS_RE = /url\s*\(|expression\s*\(|javascript:|eval\s*\(|script\s*:/i;

function isSafeDeclValue(value: string): boolean {
  if (value.length === 0 || DANGEROUS_RE.test(value)) return false;
  if (value.includes("(")) return SAFE_FUNC_VALUE_RE.test(value);
  return SAFE_PLAIN_VALUE_RE.test(value);
}

/** 清洗单条 style 值：仅保留白名单声明；非法值整体丢弃该声明 */
export function sanitizeStyleValue(style: string): string {
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter((decl) => {
      const idx = decl.indexOf(":");
      if (idx <= 0) return false;
      const prop = decl.slice(0, idx).trim().toLowerCase();
      const value = decl.slice(idx + 1).trim();
      return ALLOWED_STYLE_PROPS.has(prop) && isSafeDeclValue(value);
    })
    .join("; ");
}

const PROTO_SAFE = /^(https?:|mailto:|\/|#)/i;

/** href 协议白名单（javascript:/data:/vbscript: 全拒） */
export function safeHref(href: string): string | null {
  const t = href.trim();
  return PROTO_SAFE.test(t) ? t : null;
}

/** 代码围栏的语言 class：language-ts / language-c++ 之外的 class 一律剥掉 */
export const CODE_LANGUAGE_CLASS_RE = /^language-[\w-]+$/;

export function sanitizeSchema(): Schema {
  return {
    tagNames: [
      "p",
      "br",
      "hr",
      "strong",
      "em",
      "b",
      "i",
      "u",
      "s",
      "del",
      "blockquote",
      "code",
      "pre",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
      "img",
      "span",
      "div",
    ],
    attributes: {
      "*": [],
      a: ["href", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "loading", "referrerpolicy"],
      span: ["style"],
      div: ["style", "align"],
      th: ["style", "align"],
      td: ["style", "align"],
      // class 只放行代码围栏产生的 language-xxx（语法高亮用）。不限值会让作者注入站内已有的
      // Tailwind 类（如 fixed inset-0 z-50 bg-background）整页覆盖做钓鱼（审查 P2-8）；逐个 class token 校验
      code: [["className", CODE_LANGUAGE_CLASS_RE]],
      pre: [["className", CODE_LANGUAGE_CLASS_RE]],
    },
    strip: ["script", "style", "iframe", "object", "embed", "form", "link", "meta"],
    clobber: [],
    protocols: {
      href: ["http", "https", "mailto", "relative"],
      src: ["http", "https", "relative"],
    },
  };
}

/** 遍历 hast 树做 sanitize 覆盖不到的细化：style 值过滤 + a 安全属性 + img 约束 */
export function harden(tree: Root): Root {
  const visit = (node: Root | ElementContent): void => {
    if (node.type !== "element") {
      if ("children" in node && Array.isArray(node.children)) {
        for (const child of node.children as ElementContent[]) visit(child);
      }
      return;
    }
    const el = node;
    const props = (el.properties ?? {}) as Record<string, unknown>;

    if (
      el.tagName === "span" ||
      el.tagName === "div" ||
      el.tagName === "td" ||
      el.tagName === "th"
    ) {
      if (typeof props.style === "string") {
        const cleaned = sanitizeStyleValue(props.style);
        if (cleaned) props.style = cleaned;
        else delete props.style;
      }
    }
    // 逐 token 校验后 className 可能被剥空：不留空的 class 属性
    if (
      (el.tagName === "code" || el.tagName === "pre") &&
      Array.isArray(props.className) &&
      props.className.length === 0
    ) {
      delete props.className;
    }
    if (el.tagName === "a" && typeof props.href === "string") {
      const href = safeHref(props.href);
      if (href === null) {
        el.tagName = "span"; // 非法协议：降级为纯文本样式标签（内容保留）
        delete props.href;
      } else {
        props.href = href;
        props.rel = "noopener noreferrer nofollow";
        props.target = "_blank";
      }
    }
    if (el.tagName === "img") {
      const src = typeof props.src === "string" ? props.src : "";
      if (!/^(https?:\/\/|\/(emoji|files)\/)/i.test(src)) {
        el.tagName = "span"; // 非白名单来源：降级，alt 文本保留
        delete props.src;
      } else {
        props.loading = "lazy";
        props.referrerPolicy = "no-referrer";
      }
    }

    for (const child of el.children) visit(child);
  };
  visit(tree);
  return tree;
}
