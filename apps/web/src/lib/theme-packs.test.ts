import { describe, expect, it } from "vitest";
import { DEFAULT_PACK, isPackValue, packLabel, THEME_PACKS } from "./theme-packs";

describe("THEME_PACKS", () => {
  it("default 包始终在册（CSS themes/default.css 与注册表一一对应）", () => {
    expect(THEME_PACKS.map((p) => p.id)).toContain("default");
  });
});

describe("isPackValue", () => {
  it("识别合法包 id", () => {
    expect(isPackValue("default")).toBe(true);
  });

  it("拒绝非法值", () => {
    expect(isPackValue("blue")).toBe(false);
    expect(isPackValue(null)).toBe(false);
    expect(isPackValue(undefined)).toBe(false);
    expect(isPackValue("")).toBe(false);
  });
});

describe("packLabel", () => {
  it("返回注册表中的中文标签", () => {
    expect(packLabel("default")).toBe("现代浅色");
  });

  it("未知 id 原样返回（不抛错）", () => {
    expect(packLabel("blue" as never)).toBe("blue");
  });
});

describe("DEFAULT_PACK", () => {
  it("兜底为 default 且在册", () => {
    expect(DEFAULT_PACK).toBe("default");
    expect(isPackValue(DEFAULT_PACK)).toBe(true);
  });
});
