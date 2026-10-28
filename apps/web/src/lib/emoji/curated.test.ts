import { describe, expect, it } from "vitest";
import { applySkin, EMOJI_CATEGORIES, searchEmoji, SKIN_TONES } from "./curated";

const all = EMOJI_CATEGORIES.flatMap((c) => c.items);

describe("精选数据", () => {
  it("规模在 300–500 之间，9 个分类，每类非空", () => {
    expect(all.length).toBeGreaterThanOrEqual(300);
    expect(all.length).toBeLessThanOrEqual(500);
    expect(EMOJI_CATEGORIES).toHaveLength(9);
    for (const c of EMOJI_CATEGORIES) expect(c.items.length, c.id).toBeGreaterThan(5);
  });

  it("每条都是 emoji 字符、有中文名；整表没有重复", () => {
    const seen = new Set<string>();
    for (const it of all) {
      expect(it.char, it.name).toMatch(/\p{Extended_Pictographic}/u);
      expect(it.name.length).toBeGreaterThan(0);
      expect(seen.has(it.char), `重复 ${it.char}`).toBe(false);
      seen.add(it.char);
    }
  });

  it("不含 ZWJ 组合序列与国旗（口径：单码位，字体普遍支持）", () => {
    for (const it of all) {
      expect(it.char).not.toContain("‍");
      expect(it.char).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
    }
  });

  it("只有「手势与人物」支持肤色", () => {
    for (const c of EMOJI_CATEGORIES)
      for (const it of c.items) if (it.skin) expect(c.id, it.char).toBe("people");
    expect(all.filter((i) => i.skin).length).toBeGreaterThan(30);
  });
});

describe("肤色", () => {
  const thumbs = all.find((i) => i.char === "👍")!;
  const victory = all.find((i) => i.char.startsWith("✌"))!;
  const heart = all.find((i) => i.char === "❤️")!;

  it("默认不加修饰；加修饰时去掉 VS16；不支持肤色的原样", () => {
    expect(applySkin(thumbs, 0)).toBe("👍");
    expect(applySkin(thumbs, 3)).toBe("👍\u{1F3FD}");
    expect(victory.char).toContain("️");
    expect(applySkin(victory, 5)).toBe("✌\u{1F3FF}");
    expect(applySkin(heart, 4)).toBe("❤️");
  });

  it("共 6 档（默认 + 5 种）", () => {
    expect(SKIN_TONES).toHaveLength(6);
  });
});

describe("搜索", () => {
  it("按中文名、关键词、英文都能命中；多词取交集；忽略大小写", () => {
    expect(searchEmoji("大笑").some((i) => i.char === "😀")).toBe(true);
    expect(searchEmoji("THUMBS").some((i) => i.char === "👍")).toBe(true);
    expect(searchEmoji("点赞").map((i) => i.char)).toContain("👍");
    expect(searchEmoji("thumbs down").map((i) => i.char)).toEqual(["👎"]);
  });
  it("空查询与无结果返回空数组", () => {
    expect(searchEmoji("   ")).toEqual([]);
    expect(searchEmoji("zzzz不存在")).toEqual([]);
  });
});
