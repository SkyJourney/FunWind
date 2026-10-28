import { extractKeys } from "@funwind/content";

/**
 * 正文里的内嵌图片（M10.8 Step 4）：附件面板「正文图片」组的数据源。
 * 正文是唯一事实来源——这里只从 Markdown 里**派生**，不另存状态，所以编辑区与附件面板不会不同步。
 * 引用的合法性判定复用服务端登记用的 extractKeys（与 registerSourceFiles 同一口径：目录与哈希前缀须一致）。
 */

/** Markdown 图片语法 `![alt](url)`，url 不含空白与右括号（与编辑器序列化出的写法一致） */
const IMAGE_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/** 正文引用的站内文件图片（保序、去重）。`/emoji/` 表情与站外图不在其内 */
export function extractInlineImages(markdown: string): { key: string; url: string }[] {
  const seen = new Set<string>();
  const out: { key: string; url: string }[] = [];
  for (const m of markdown.matchAll(IMAGE_RE)) {
    const key = extractKeys(m[1] ?? "")[0];
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, url: `/files/${key}` });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 指向 url 的图片语法在文本中的区间（升序）。源码模式据此做最小改动（保留光标），也用于下面的整体删除 */
export function findImageRanges(markdown: string, url: string): { from: number; to: number }[] {
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${escapeRe(url)}\\)`, "g");
  return [...markdown.matchAll(re)].map((m) => ({ from: m.index!, to: m.index! + m[0].length }));
}

/** 从 Markdown 文本里删掉指向 url 的所有图片语法 */
export function removeImageFromMarkdown(markdown: string, url: string): string {
  let out = "";
  let at = 0;
  for (const r of findImageRanges(markdown, url)) {
    out += markdown.slice(at, r.from);
    at = r.to;
  }
  return out + markdown.slice(at);
}
