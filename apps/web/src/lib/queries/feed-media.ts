/**
 * 首页内容流的轻量媒体提取（查询层启发式，精确渲染仍走 rich-content 管线）。
 * 纯函数、无 DB 依赖；与 getHomeFeed 配套（threads.ts）。
 */
export interface FeedMedia {
  coverUrl: string | null;
  excerpt: string | null;
}

/** 从首帖 Markdown 提取首图 URL 与纯文本摘要（≤120 字）；代码块先剔除，避免把示例当封面 */
export function extractFeedMedia(bodyMd: string | null): FeedMedia {
  if (!bodyMd) return { coverUrl: null, excerpt: null };
  const stripped = bodyMd.replace(/```[\s\S]*?```/g, " ");
  const img = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/.exec(stripped);
  const coverUrl = img?.[1] ?? null;
  const text = stripped
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*`~_[\]-]/g, " ")
    .replace(/\\+/g, " ") // 裸反斜杠归一（旧帖转义残留会形成不可断行长序列撑破卡片）
    .replace(/\s+/g, " ")
    .trim();
  return { coverUrl, excerpt: text ? text.slice(0, 120) : null };
}
