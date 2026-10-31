import { describe, expect, it } from "vitest";
import { isThemeValue, resolveDataMode, THEME_OPTIONS } from "./theme";

describe("THEME_OPTIONS", () => {
  it("包含浅色/暗色/跟随系统三态", () => {
    expect(THEME_OPTIONS.map((o) => o.value)).toEqual(["light", "dark", "system"]);
  });
});

describe("isThemeValue", () => {
  it("识别合法值", () => {
    expect(isThemeValue("light")).toBe(true);
    expect(isThemeValue("dark")).toBe(true);
    expect(isThemeValue("system")).toBe(true);
  });

  it("拒绝非法值", () => {
    expect(isThemeValue("blue")).toBe(false);
    expect(isThemeValue(undefined)).toBe(false);
  });
});

describe("resolveDataMode", () => {
  it("显式主题直接生效", () => {
    expect(resolveDataMode("dark", false)).toBe("dark");
    expect(resolveDataMode("light", true)).toBe("light");
  });

  it("system 跟随系统偏好", () => {
    expect(resolveDataMode("system", true)).toBe("dark");
    expect(resolveDataMode("system", false)).toBe("light");
  });

  it("未知值按系统偏好兜底", () => {
    expect(resolveDataMode("blue", true)).toBe("dark");
  });
});
