/**
 * 表情元数据的转换（M10.9，设计稿 §2.4）：旧库 nw_common_emotion(_category) → emoji_groups / emojis。
 * 纯函数，便于独立单测；加载（幂等 INSERT IGNORE）在 steps-content.ts 的 emojiStep。
 *
 * 口径（Step 1 核实结论，docs/milestones/M10.9-emoji.md §1.1）：
 *  · 分组 = **有成员的**旧分类（实测仅 2 个：117「茉莉 01」、118「茉莉 02」；其余分类 isopen=0 无成员，不建）；
 *  · 表情 = 显式 id（120–169）、storage_key 为空（内容是 public/emoji/{id}.gif 静态资源）、组内 sort 按 emotion_id；
 *  · 名称：旧库 emotion_name 实测全空 → 「旧表情 {id}」占位，站长之后在后台改。
 */

export interface OldEmojiRow {
  /** emotion_id（120–169） */
  id: number;
  categoryId: number | null;
  /** emotion_name：旧库列全空 */
  name: string | null;
  categoryName: string | null;
  orderid: number | null;
}

export interface EmojiGroupPlan {
  /** 幂等键 = 展示名（uq_emoji_groups_name） */
  name: string;
  /** 展示排序：旧 orderid，缺失时用 categoryId 兜底 */
  sort: number;
}

export interface EmojiPlan {
  id: number;
  /** 所属分组的展示名（加载端按名解析出 id） */
  groupName: string;
  /** 展示名（正文 alt 与面板提示） */
  name: string;
  /** 组内展示排序：按 emotion_id */
  sort: number;
}

export function transformEmojiMeta(rows: readonly OldEmojiRow[]): {
  groups: EmojiGroupPlan[];
  emojis: EmojiPlan[];
} {
  // 分组：只建有成员的分类，顺序按 (orderid, categoryId)
  const byCategory = new Map<number, { name: string; orderid: number | null }>();
  for (const r of rows) {
    if (r.categoryId === null || byCategory.has(r.categoryId)) continue;
    byCategory.set(r.categoryId, {
      name: (r.categoryName ?? "").trim() || `旧分组 ${r.categoryId}`,
      orderid: r.orderid,
    });
  }
  const groups: EmojiGroupPlan[] = [...byCategory.entries()]
    .sort((a, b) => (a[1].orderid ?? a[0]) - (b[1].orderid ?? b[0]) || a[0] - b[0])
    .map(([id, v]) => ({ name: v.name.slice(0, 50), sort: v.orderid ?? id }));

  const emojis: EmojiPlan[] = rows.map((r) => {
    const groupName =
      r.categoryId === null ? "" : (byCategory.get(r.categoryId)?.name ?? "").slice(0, 50);
    return {
      id: r.id,
      groupName,
      name: ((r.name ?? "").trim() || `旧表情 ${r.id}`).slice(0, 50),
      sort: r.id,
    };
  });
  return { groups, emojis };
}
