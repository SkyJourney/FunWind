import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Root } from "hast";
import { harden, sanitizeSchema } from "./sanitize";

/**
 * content_md → 净化后 HTML（服务端渲染，M3）。
 * 管线：remark 解析 → hast（保留内嵌 HTML）→ rehype-raw 展开 → rehype-sanitize 白名单
 *       → harden 细化（style 值过滤/a 协议/img 来源）→ HTML 字符串。
 * content_raw 永远保留原文；本管线只对 content_md 负责。
 */

/** rehype 细化步骤：sanitize 之后补做 schema 表达不了的声明级清洗 */
function rehypeHarden() {
  return (tree: Root): void => {
    harden(tree);
  };
}

let processor: ReturnType<typeof createProcessor> | undefined;

function createProcessor() {
  return unified()
    .use(remarkParse)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema())
    .use(rehypeHarden)
    .use(rehypeStringify);
}

function getProcessor() {
  processor ??= createProcessor();
  return processor;
}

/** LRU 缓存：历史帖不可变，渲染结果按内容缓存（容量 500） */
const cache = new Map<string, string>();
const CACHE_MAX = 500;

function cached(key: string, render: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const value = render();
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/** 渲染 Markdown 为净化后的 HTML 片段。输入不可信（用户内容），输出可直接 dangerouslySetInnerHTML */
export function renderMarkdown(md: string): string {
  const trimmed = md.trim();
  if (trimmed === "") return "";
  return cached(trimmed, () => String(getProcessor().processSync(trimmed)));
}
