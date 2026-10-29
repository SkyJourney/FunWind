import { describe, expect, it } from "vitest";
import { transformEmojiMeta, type OldEmojiRow } from "./emoji.js";

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
  it("只建有成员的分类（2 组），顺序按 orderid；表情 id 120–169、组内 sort 按 id", () => {
    const { groups, emojis } = transformEmojiMeta(REAL_LIKE);
    expect(groups).toEqual([
      { name: "茉莉 01", sort: 1 },
      { name: "茉莉 02", sort: 2 },
    ]);
    expect(emojis).toHaveLength(50);
    expect(emojis[0]).toEqual({ id: 120, groupName: "茉莉 01", name: "旧表情 120", sort: 120 });
    expect(emojis[49]).toEqual({ id: 169, groupName: "茉莉 02", name: "旧表情 169", sort: 169 });
  });

  it("名称旧库有值则取用；空串 / 空白同样按占位处理", () => {
    const rows: OldEmojiRow[] = [
      { id: 120, categoryId: 117, name: "微笑", categoryName: "茉莉 01", orderid: 1 },
      { id: 121, categoryId: 117, name: "   ", categoryName: "茉莉 01", orderid: 1 },
      { id: 122, categoryId: 117, name: "", categoryName: "茉莉 01", orderid: 1 },
    ];
    const { emojis } = transformEmojiMeta(rows);
    expect(emojis.map((e) => e.name)).toEqual(["微笑", "旧表情 121", "旧表情 122"]);
  });

  it("分类名缺失时用「旧分组 {id}」兜底；orderid 缺失时用 categoryId 兜底排序", () => {
    const rows: OldEmojiRow[] = [
      { id: 120, categoryId: 7, name: null, categoryName: null, orderid: null },
    ];
    const { groups, emojis } = transformEmojiMeta(rows);
    expect(groups).toEqual([{ name: "旧分组 7", sort: 7 }]);
    expect(emojis[0]!.groupName).toBe("旧分组 7");
  });

  it("无分类的表情 groupName 为空串（加载端必须拒绝，不允许静默丢数据）", () => {
    const rows: OldEmojiRow[] = [
      { id: 120, categoryId: null, name: null, categoryName: null, orderid: null },
    ];
    const { emojis } = transformEmojiMeta(rows);
    expect(emojis[0]!.groupName).toBe("");
  });

  it("超过 50 字的旧名称 / 分类名截断到列宽", () => {
    const long = "长".repeat(60);
    const rows: OldEmojiRow[] = [
      { id: 120, categoryId: 117, name: long, categoryName: long, orderid: 1 },
    ];
    const { groups, emojis } = transformEmojiMeta(rows);
    expect(groups[0]!.name).toHaveLength(50);
    expect(emojis[0]!.name).toHaveLength(50);
  });
});
