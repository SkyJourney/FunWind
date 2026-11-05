import { describe, expect, it } from "vitest";
import { BASE_COLORS } from "./token-base";
import { TOKEN_PREVIEW_ATTR, previewTokenVars } from "./token-preview";
import { COLOR_KEYS, type TokenSet } from "./token-schema";

const NON_COLOR_KEYS = [
  "--radius",
  "--shadow-1",
  "--shadow-2",
  "--shadow-3",
  "--fw-font-display",
  "--band-width",
  "--band-angle",
  "--band-fade",
  "--band-dim-opacity",
  "--band-mask-display",
  "--band-mask-color",
];
const ALL_KEYS = [...COLOR_KEYS.map((key) => `--${key}`), ...NON_COLOR_KEYS].sort();

const SHADOW = { x: 1, y: 2, blur: 3, spread: 4, color: "#112233", alpha: 0.5 };

describe("previewTokenVars：没有覆盖时就是基础层", () => {
  it("浅色：键集合固定（33 项，不含品牌渐变），22 色等于基础层", () => {
    const vars = previewTokenVars("light", undefined);
    expect(Object.keys(vars).sort()).toEqual(ALL_KEYS);
    for (const key of COLOR_KEYS) expect(vars[`--${key}`]).toBe(BASE_COLORS.light[key]);
    expect(vars).not.toHaveProperty("--gradient-brand");
  });

  it("浅色：圆角、字体、阴影写成与站点一致的引用，板块卡参数是基础值", () => {
    const vars = previewTokenVars("light", undefined);
    expect(vars["--radius"]).toBe("var(--fw-radius-lg)");
    expect(vars["--fw-font-display"]).toBe("var(--fw-font-sans)");
    expect(vars["--shadow-1"]).toBe("var(--fw-shadow-1)");
    expect(vars["--shadow-2"]).toBe("var(--fw-shadow-2)");
    expect(vars["--shadow-3"]).toBe("var(--fw-shadow-3)");
    expect(vars["--band-width"]).toBe("7rem");
    expect(vars["--band-angle"]).toBe("105deg");
    expect(vars["--band-fade"]).toBe("50%");
    expect(vars["--band-dim-opacity"]).toBe("0.85");
    expect(vars["--band-mask-display"]).toBe("block");
    expect(vars["--band-mask-color"]).toBe(BASE_COLORS.light.card);
  });

  it("深色：颜色是深色基础层，阴影写成深色的字面值，板块卡遮罩色是深色卡片底", () => {
    const vars = previewTokenVars("dark", undefined);
    expect(Object.keys(vars).sort()).toEqual(ALL_KEYS);
    for (const key of COLOR_KEYS) expect(vars[`--${key}`]).toBe(BASE_COLORS.dark[key]);
    expect(vars["--shadow-1"]).toBe("0px 1px 2px 0px rgb(0 0 0 / 0.5)");
    expect(vars["--shadow-2"]).toBe("0px 4px 12px 0px rgb(0 0 0 / 0.55)");
    expect(vars["--shadow-3"]).toBe("0px 12px 32px 0px rgb(0 0 0 / 0.65)");
    expect(vars["--band-mask-color"]).toBe(BASE_COLORS.dark.card);
  });

  it("undefined 与空对象等价", () => {
    expect(previewTokenVars("light", {})).toEqual(previewTokenVars("light", undefined));
    expect(previewTokenVars("dark", {})).toEqual(previewTokenVars("dark", undefined));
  });
});

describe("previewTokenVars：草稿覆盖叠在基础层上", () => {
  it("只覆盖的颜色变，其余仍是基础层；大写规范为小写", () => {
    const vars = previewTokenVars("light", { colors: { primary: "#ABCDEF" } });
    expect(vars["--primary"]).toBe("#abcdef");
    expect(vars["--ring"]).toBe(BASE_COLORS.light.ring);
    expect(vars["--background"]).toBe(BASE_COLORS.light.background);
  });

  it("不合法的颜色被忽略，回落基础层", () => {
    const bad = { colors: { primary: "红", ring: "#12" } } as unknown as TokenSet;
    const vars = previewTokenVars("light", bad);
    expect(vars["--primary"]).toBe(BASE_COLORS.light.primary);
    expect(vars["--ring"]).toBe(BASE_COLORS.light.ring);
  });

  it("圆角与展示字体", () => {
    const vars = previewTokenVars("light", { radius: "none", displayFont: "songti" });
    expect(vars["--radius"]).toBe("0px");
    expect(vars["--fw-font-display"]).toContain("Songti SC");
    expect(previewTokenVars("light", { radius: "xl" })["--radius"]).toBe("var(--fw-radius-xl)");
  });

  it("浅色：覆盖的那一档是字面值，没覆盖的仍引用原子变量", () => {
    const vars = previewTokenVars("light", { shadows: { s2: SHADOW } });
    expect(vars["--shadow-2"]).toBe("1px 2px 3px 4px rgb(17 34 51 / 0.5)");
    expect(vars["--shadow-1"]).toBe("var(--fw-shadow-1)");
    expect(vars["--shadow-3"]).toBe("var(--fw-shadow-3)");
  });

  it("深色：覆盖的那一档是字面值，没覆盖的是深色基础的字面值", () => {
    const vars = previewTokenVars("dark", { shadows: { s1: SHADOW } });
    expect(vars["--shadow-1"]).toBe("1px 2px 3px 4px rgb(17 34 51 / 0.5)");
    expect(vars["--shadow-2"]).toBe("0px 4px 12px 0px rgb(0 0 0 / 0.55)");
  });

  it("品牌渐变：覆盖了才输出，没覆盖交给样式表按公式算", () => {
    const set: TokenSet = { brandGradient: { angle: 90, from: "#000000", to: "#FFFFFF" } };
    expect(previewTokenVars("light", set)["--gradient-brand"]).toBe(
      "linear-gradient(90deg, #000000 0%, #ffffff 100%)",
    );
    expect(previewTokenVars("light", {})).not.toHaveProperty("--gradient-brand");
  });

  it("板块卡：覆盖的字段生效，没写的字段保留基础值（含遮罩开关）", () => {
    const vars = previewTokenVars("light", {
      band: { width: 8.5, angle: 90, fade: 0, dim: 1, mask: false },
    });
    expect(vars["--band-width"]).toBe("8.5rem");
    expect(vars["--band-angle"]).toBe("90deg");
    expect(vars["--band-fade"]).toBe("0%");
    expect(vars["--band-dim-opacity"]).toBe("1");
    expect(vars["--band-mask-display"]).toBe("none");
  });

  it("遮罩色：没指定时跟随本档生效的卡片底色，指定了用指定的", () => {
    const card = previewTokenVars("light", { colors: { card: "#fffdf4" } });
    expect(card["--band-mask-color"]).toBe("#fffdf4");
    const explicit = previewTokenVars("light", {
      colors: { card: "#fffdf4" },
      band: { width: 7, angle: 105, fade: 50, dim: 0.85, mask: true, maskColor: "#00FF00" },
    });
    expect(explicit["--band-mask-color"]).toBe("#00ff00");
  });
});

describe("previewTokenVars：纯函数", () => {
  it("不改入参，相同入参相同结果", () => {
    const set: TokenSet = {
      colors: { primary: "#112233" },
      shadows: { s1: SHADOW },
      band: { width: 8, angle: 90, fade: 0, dim: 1, mask: false },
    };
    const before = structuredClone(set);
    const first = previewTokenVars("dark", set);
    expect(set).toEqual(before);
    expect(previewTokenVars("dark", set)).toEqual(first);
  });

  it("每个值都是非空字符串，没有 undefined 或 NaN", () => {
    for (const mode of ["light", "dark"] as const) {
      for (const value of Object.values(previewTokenVars(mode, { colors: { ring: "#445566" } }))) {
        expect(typeof value).toBe("string");
        expect(value.length).toBeGreaterThan(0);
        expect(value).not.toMatch(/undefined|NaN/);
      }
    }
  });
});

describe("TOKEN_PREVIEW_ATTR", () => {
  it("属性名固定（semantic.css 的选择器写的就是它）", () => {
    expect(TOKEN_PREVIEW_ATTR).toBe("data-token-preview");
  });
});
