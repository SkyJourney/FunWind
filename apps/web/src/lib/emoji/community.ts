/**
 * 社区表情数据源（M10.9）：`GET /api/emojis`（公开只读）的客户端取数与搜索。
 * 面板打开时拉一次；失败或零数据返回空数组——面板于是不显示社区页签（零数据站点不受影响）。
 */

export interface CommunityEmoji {
  id: number;
  name: string;
  /** 空格分隔的搜索关键词（空串 = 无） */
  keywords: string;
  /** /emoji/{id}.{ext}，与正文引用同形 */
  url: string;
  group: string;
  width: number | null;
  height: number | null;
}

export async function fetchCommunityEmojis(signal?: AbortSignal): Promise<CommunityEmoji[]> {
  try {
    const res = await fetch("/api/emojis", { signal });
    if (!res.ok) return [];
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return [];
    return data.filter(
      (x): x is CommunityEmoji =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as CommunityEmoji).id === "number" &&
        typeof (x as CommunityEmoji).name === "string" &&
        typeof (x as CommunityEmoji).url === "string" &&
        typeof (x as CommunityEmoji).group === "string",
    );
  } catch {
    return [];
  }
}

/** 按名称与关键词搜索社区表情（忽略大小写，所有词都命中才算；空查询返回空数组） */
export function searchCommunity(list: CommunityEmoji[], query: string): CommunityEmoji[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return list.filter((e) => {
    const hay = `${e.name} ${e.keywords}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** 面板的分组展示顺序：按接口给定的顺序（(group.sort, emoji.sort, id)），收集不重复的组名 */
export function groupNames(list: CommunityEmoji[]): string[] {
  return [...new Set(list.map((e) => e.group))];
}
