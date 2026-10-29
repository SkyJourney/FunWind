/**
 * 表情元数据的转换（M10.9，设计稿 §2.4；2026-10-29 站长追加修订）：旧库 nw_common_emotion(_category) → emoji_groups / emojis。
 * 纯函数，便于独立单测；加载（幂等 INSERT IGNORE）在 steps-content.ts 的 emojiStep。
 *
 * 口径：
 *  · **分组 = 合并后的单组「茉莉」**（站长拍板：旧分类「茉莉 01 / 茉莉 02」在新系统合并为一个表情包；
 *    旧库分类名不再成为分组——Step 1 曾按旧分类建 2 组，合并决策后改为单组产出）；
 *  · 表情 = 显式 id（120–169）、storage_key 为空（内容是 public/emoji/{id}.gif 静态资源）、组内 sort 按 emotion_id；
 *  · 名称 = `transform/emoji-names.ts` 的读图拍板名（旧库 emotion_name 全空，无名字可考古）。
 */

import { EMOJI_NAMES, MERGED_GROUP_NAME } from "./emoji-names.js";

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
  /** 展示排序 */
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
  const groups: EmojiGroupPlan[] = rows.length > 0 ? [{ name: MERGED_GROUP_NAME, sort: 0 }] : [];
  const emojis: EmojiPlan[] = rows.map((r) => ({
    id: r.id,
    groupName: MERGED_GROUP_NAME,
    // 名称优先取站长读图拍板名；表里没有的 id（未来旧库变化）回落占位
    name: (EMOJI_NAMES[r.id] ?? `旧表情 ${r.id}`).slice(0, 50),
    sort: r.id,
  }));
  return { groups, emojis };
}
