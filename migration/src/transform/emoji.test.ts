import { describe, expect, it } from "vitest";
import { transformEmojiMeta, type OldEmojiRow } from "./emoji.js";
import { EMOJI_NAMES, MERGED_GROUP_NAME } from "./emoji-names.js";

/** Step 1 核实的真实形状：2 个在用分类各 25 枚，emotion_name 全空 */
const REAL_LIKE: OldEmojiRow[] = [
  ...Array.from({ length: 25 }, (_, i) => ({
    id: 120 + i,
    categoryId: 117,
    name: null,
    categoryName: "茉莉 01",
    orderid: 1,
  })),
  ...Array.from({ length: 25 }, (_, i) => ({
    id: 145 + i,
    categoryId: 118,
    name: null,
    categoryName: "茉莉 02",
    orderid: 2,
  })),
];

describe("transformEmojiMeta", () => {
  it("合并为单组「茉莉」；表情 id 120–169、组内 sort 按 id、名称用站长读图拍板名", () => {
    const { groups, emojis } = transformEmojiMeta(REAL_LIKE);
    expect(groups).toEqual([{ name: MERGED_GROUP_NAME, sort: 0 }]);
    expect(emojis).toHaveLength(50);
    expect(emojis[0]).toEqual({ id: 120, groupName: "茉莉", name: EMOJI_NAMES[120], sort: 120 });
    expect(emojis[49]).toEqual({ id: 169, groupName: "茉莉", name: EMOJI_NAMES[169], sort: 169 });
    // 两套旧分类的表情全部归入同一组
    expect(new Set(emojis.map((e) => e.groupName))).toEqual(new Set(["茉莉"]));
  });

  it("拍板名表覆盖全部 50 枚且非空、不超列宽", () => {
    const ids = Array.from({ length: 50 }, (_, i) => 120 + i);
    for (const id of ids) {
      expect(EMOJI_NAMES[id], `id ${id}`).toBeTruthy();
      expect(EMOJI_NAMES[id]!.length).toBeLessThanOrEqual(50);
    }
    expect(Object.keys(EMOJI_NAMES)).toHaveLength(50);
  });

  it("空输入产出空计划", () => {
    expect(transformEmojiMeta([])).toEqual({ groups: [], emojis: [] });
  });

  it("表外 id（旧库未来变化）回落「旧表情 {id}」占位，不丢行", () => {
    const rows: OldEmojiRow[] = [
      { id: 999, categoryId: 117, name: null, categoryName: "茉莉 01", orderid: 1 },
    ];
    const { emojis } = transformEmojiMeta(rows);
    expect(emojis[0]).toEqual({ id: 999, groupName: "茉莉", name: "旧表情 999", sort: 999 });
  });

  it("旧库 name 即使有值也不采用：正式名以站长读图拍板为准（旧库列实测全空）", () => {
    const rows: OldEmojiRow[] = [
      { id: 120, categoryId: 117, name: "旧站内部名", categoryName: "茉莉 01", orderid: 1 },
    ];
    const { emojis } = transformEmojiMeta(rows);
    expect(emojis[0]!.name).toBe(EMOJI_NAMES[120]);
  });
});
