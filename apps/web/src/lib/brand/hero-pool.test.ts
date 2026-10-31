import { describe, expect, it } from "vitest";
import { parseHeroPool } from "./hero-pool";
import { parseLogoPool } from "./logo-pool";

describe("brand-pool 实例前缀隔离（logo / hero）", () => {
  it("hero 池只认 hero- 前缀文件名；logo 池只认 logo-（同一 JSON 互不串台）", () => {
    const raw = {
      items: [
        { file: "hero-abc.png", name: "新年横幅" },
        { file: "logo-abc.png", name: "LOGO" },
      ],
      active: "hero-abc.png",
    };
    expect(parseHeroPool(raw)).toEqual({
      items: [{ file: "hero-abc.png", name: "新年横幅" }],
      active: "hero-abc.png",
    });
    expect(parseLogoPool(raw)).toEqual({
      items: [{ file: "logo-abc.png", name: "LOGO" }],
      active: null, // active 指向的是 hero 文件 → 对 logo 池是悬空指针
    });
  });

  it("空值 / 坏结构回空池", () => {
    expect(parseHeroPool(null)).toEqual({ items: [], active: null });
    expect(parseHeroPool({ items: "x", active: 1 })).toEqual({ items: [], active: null });
  });
});
