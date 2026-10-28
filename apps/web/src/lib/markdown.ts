import { unified } from "unified";
import remarkBreaks from "remark-breaks";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Root } from "hast";
import { remarkGfmLite } from "./gfm-lite";
import { rehypeHighlight } from "./highlight-rehype";
import { harden, sanitizeSchema } from "./sanitize";

/**
 * content_md → 净化后 HTML（服务端渲染，M3）。
 * 管线：remark 解析（+ 精简 GFM：表格 / 删除线，见 gfm-lite.ts；+ 软换行转 <br>）→ hast（保留内嵌 HTML）→ rehype-raw 展开 → rehype-sanitize 白名单
 *       → harden 细化（style 值过滤/a 协议/img 来源）→ 代码块语法高亮（净化之后，不放宽白名单，见 highlight-rehype.ts）→ HTML 字符串。
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
  return (
    unified()
      .use(remarkParse)
      .use(remarkGfmLite)
      // 段落内的单个换行 → <br>：旧站帖子的换行即换行；不加的话浏览器把 <p>a\nb</p> 显示成「a b」（M5.6 S1b-2，约 27% 的帖子受影响）
      .use(remarkBreaks)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize, sanitizeSchema())
      .use(rehypeHarden)
      .use(rehypeHighlight)
      .use(rehypeStringify)
  );
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

/**
 * 渲染 Markdown 为净化后的 HTML 片段。输入不可信（用户内容），输出可直接 dangerouslySetInnerHTML。
 * `cache: false`：不读写共享缓存。预览等由任意输入触发的渲染必须用它，否则攻击者可用大量内容挤掉真实帖子的缓存。
 */
export function renderMarkdown(md: string, options: { cache?: boolean } = {}): string {
  const trimmed = md.trim();
  if (trimmed === "") return "";
  const render = () => String(getProcessor().processSync(trimmed));
  return options.cache === false ? render() : cached(trimmed, render);
}

/** 当前共享缓存的条目数（观测与测试用） */
export function markdownCacheSize(): number {
  return cache.size;
}
