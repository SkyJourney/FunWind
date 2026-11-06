import { describe, expect, it } from "vitest";
import {
  compositeOver,
  contrastRatio,
  contrastWarnings,
  evaluateContrast,
  relativeLuminance,
  TEXT_CONTRAST_MIN,
} from "./contrast-advisor";
import { COLOR_KEYS, type ColorKey } from "./token-schema";

/**
 * 对比度顾问（M11.6 Step 1）。
 * 数学部分用独立算出的基准值（WCAG 公布的 #767676 / #777777 临界灰等）固定；
 * 配对表用「好调色板 + 逐键扰动」固定：每个键被劣化后，恰好应当变红哪几对。
 * 与真实主题 CSS 的交叉核对见 src/test/token-contrast.test.ts。
 */

describe("relativeLuminance", () => {
  it("黑 0、白 1", () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });

  it("三个通道的权重：0.2126 / 0.7152 / 0.0722", () => {
    expect(relativeLuminance([255, 0, 0])).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance([0, 255, 0])).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance([0, 0, 255])).toBeCloseTo(0.0722, 4);
  });

  it("sRGB 线性化的低值分支（≤ 0.03928 时除以 12.92）", () => {
    expect(relativeLuminance([10, 10, 10])).toBeCloseTo(0.003035, 6);
  });
});

describe("contrastRatio", () => {
  it("黑白 21:1，相同颜色 1:1", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 6);
    expect(contrastRatio([100, 100, 100], [100, 100, 100])).toBe(1);
  });

  it("WCAG 公布的 AA 临界灰：#767676 对白 4.54（过），#777777 对白 4.48（不过）", () => {
    expect(contrastRatio([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.5422, 3);
    expect(contrastRatio([0x77, 0x77, 0x77], [255, 255, 255])).toBeCloseTo(4.4781, 3);
  });

  it("与参数顺序无关", () => {
    expect(contrastRatio([20, 40, 60], [200, 220, 240])).toBe(
      contrastRatio([200, 220, 240], [20, 40, 60]),
    );
  });
});

describe("compositeOver", () => {
  it("alpha 为 0 / 1 时分别得到背景 / 前景", () => {
    expect(compositeOver([10, 20, 30], [200, 210, 220], 0)).toEqual([200, 210, 220]);
    expect(compositeOver([10, 20, 30], [200, 210, 220], 1)).toEqual([10, 20, 30]);
  });

  it("逐通道按 alpha 混合并四舍五入", () => {
    expect(compositeOver([255, 0, 0], [0, 0, 0], 0.5)).toEqual([128, 0, 0]);
    expect(compositeOver([0, 0, 0], [255, 255, 255], 0.1)).toEqual([230, 230, 230]);
    expect(compositeOver([0x14, 0x7b, 0xa9], [0xff, 0xfd, 0xf4], 0.1)).toEqual([232, 240, 237]);
  });
});

/** 23 个配对的固定顺序：设计稿 §3.3 的 18 个，加 M11.6 Step 6 补入的 5 个（插在 muted-fg-card 之后） */
const PAIR_IDS = [
  "fg-bg",
  "fg-card",
  "card-fg-card",
  "popover-fg-popover",
  "primary-fg-primary",
  "secondary-fg-secondary",
  "accent-fg-accent",
  "destructive-fg-destructive",
  "muted-fg-bg",
  "muted-fg-card",
  "muted-fg-muted",
  "muted-fg-secondary",
  "muted-fg-accent",
  "primary-fg-bg",
  "primary-fg-card",
  "primary-tint-card",
  "primary-tint-bg",
  "destructive-tint-card",
  "destructive-tint-bg",
  "success-tint-card",
  "success-tint-bg",
  "warning-tint-card",
  "warning-tint-bg",
];

/** 好调色板：文字黑、表面白、实心色黑配白字，23 对全部远超 4.5:1 */
const GOOD: Record<ColorKey, string> = {
  background: "#ffffff",
  foreground: "#000000",
  card: "#ffffff",
  "card-foreground": "#000000",
  popover: "#ffffff",
  "popover-foreground": "#000000",
  primary: "#000000",
  "primary-foreground": "#ffffff",
  secondary: "#ffffff",
  "secondary-foreground": "#000000",
  muted: "#ffffff",
  "muted-foreground": "#000000",
  accent: "#ffffff",
  "accent-foreground": "#000000",
  destructive: "#000000",
  "destructive-foreground": "#ffffff",
  success: "#000000",
  warning: "#000000",
  info: "#000000",
  border: "#000000",
  input: "#000000",
  ring: "#000000",
};

describe("evaluateContrast", () => {
  it("返回 23 对，id 与顺序固定", () => {
    expect(evaluateContrast(GOOD).map((check) => check.id)).toEqual(PAIR_IDS);
    expect(new Set(PAIR_IDS).size).toBe(23);
  });

  it("阈值是 4.5", () => {
    expect(TEXT_CONTRAST_MIN).toBe(4.5);
  });

  it("好调色板：全部通过，没有警告", () => {
    const checks = evaluateContrast(GOOD);
    expect(checks.every((check) => check.pass)).toBe(true);
    expect(contrastWarnings(GOOD)).toEqual([]);
    expect(checks.find((check) => check.id === "fg-bg")?.ratio).toBeCloseTo(21, 6);
    // 黑叠白 10% 的淡底是 #e6e6e6，黑字压在上面 16.83:1
    expect(checks.find((check) => check.id === "primary-tint-card")?.ratio).toBeCloseTo(16.826, 3);
  });

  it("淡底统一按 10% 合成（对应 Tailwind 的 bg-x/10）：后 8 对的 tintAlpha 恒为 0.1，前 15 对没有", () => {
    const checks = evaluateContrast(GOOD);
    expect(checks.filter((check) => check.tintAlpha === 0.1).map((check) => check.id)).toEqual(
      PAIR_IDS.slice(15),
    );
    expect(checks.filter((check) => check.tintAlpha === undefined)).toHaveLength(15);
  });

  it("全部同色：23 对都是 1:1，全部不通过", () => {
    const flat = Object.fromEntries(COLOR_KEYS.map((key) => [key, "#808080"])) as Record<
      ColorKey,
      string
    >;
    const checks = evaluateContrast(flat);
    expect(checks.every((check) => !check.pass && check.ratio === 1)).toBe(true);
    expect(contrastWarnings(flat)).toHaveLength(23);
  });

  it("刚好卡在临界：#767676 文字压白底通过，#777777 不通过", () => {
    const at = (gray: string) =>
      evaluateContrast({ ...GOOD, foreground: gray }).find((check) => check.id === "fg-bg")!;
    expect(at("#767676").pass).toBe(true);
    expect(at("#777777").pass).toBe(false);
  });

  /**
   * 逐键扰动：把某一个键改成 bad，恰好应当变红哪几对。
   * 文字类键改成 #aaaaaa（浅灰字压白底 2.32:1），表面类键改成 #555555（黑字压深灰 2.82:1）。
   * 没有出现在任何配对里的键（info / border / input / ring）改动后一对都不该变红。
   */
  const TEXT_BAD = "#aaaaaa";
  const SURFACE_BAD = "#555555";
  // 压在黑色实心底上的白字（primary-foreground / destructive-foreground）要劣化成深灰才会不达标
  const DARK_BAD = "#333333";
  const PERTURBATIONS: Array<[ColorKey, string, string[]]> = [
    [
      "background",
      SURFACE_BAD,
      [
        "fg-bg",
        "muted-fg-bg",
        "primary-fg-bg",
        "primary-tint-bg",
        "destructive-tint-bg",
        "success-tint-bg",
        "warning-tint-bg",
      ],
    ],
    ["foreground", TEXT_BAD, ["fg-bg", "fg-card"]],
    [
      "card",
      SURFACE_BAD,
      [
        "fg-card",
        "card-fg-card",
        "muted-fg-card",
        "primary-fg-card",
        "primary-tint-card",
        "destructive-tint-card",
        "success-tint-card",
        "warning-tint-card",
      ],
    ],
    ["card-foreground", TEXT_BAD, ["card-fg-card"]],
    ["popover", SURFACE_BAD, ["popover-fg-popover"]],
    ["popover-foreground", TEXT_BAD, ["popover-fg-popover"]],
    [
      "primary",
      TEXT_BAD,
      [
        "primary-fg-primary",
        "primary-fg-bg",
        "primary-fg-card",
        "primary-tint-card",
        "primary-tint-bg",
      ],
    ],
    ["primary-foreground", DARK_BAD, ["primary-fg-primary"]],
    ["secondary", SURFACE_BAD, ["secondary-fg-secondary", "muted-fg-secondary"]],
    ["secondary-foreground", TEXT_BAD, ["secondary-fg-secondary"]],
    ["accent", SURFACE_BAD, ["accent-fg-accent", "muted-fg-accent"]],
    ["accent-foreground", TEXT_BAD, ["accent-fg-accent"]],
    [
      "destructive",
      TEXT_BAD,
      ["destructive-fg-destructive", "destructive-tint-card", "destructive-tint-bg"],
    ],
    ["destructive-foreground", DARK_BAD, ["destructive-fg-destructive"]],
    ["success", TEXT_BAD, ["success-tint-card", "success-tint-bg"]],
    ["warning", TEXT_BAD, ["warning-tint-card", "warning-tint-bg"]],
    [
      "muted-foreground",
      TEXT_BAD,
      ["muted-fg-bg", "muted-fg-card", "muted-fg-muted", "muted-fg-secondary", "muted-fg-accent"],
    ],
    ["muted", SURFACE_BAD, ["muted-fg-muted"]],
    ["info", TEXT_BAD, []],
    ["border", TEXT_BAD, []],
    ["input", TEXT_BAD, []],
    ["ring", TEXT_BAD, []],
  ];

  it("扰动表覆盖全部 22 个键，一个不漏", () => {
    expect(PERTURBATIONS.map(([key]) => key).sort()).toEqual([...COLOR_KEYS].sort());
  });

  it.each(PERTURBATIONS)("把 %s 改成 %s：恰好 %j 变红", (key, bad, expected) => {
    const failing = contrastWarnings({ ...GOOD, [key]: bad }).map((check) => check.id);
    expect(failing.sort()).toEqual([...expected].sort());
  });

  it("警告项带着比值、阈值与前景 / 背景键，供面板展示", () => {
    const [warning] = contrastWarnings({ ...GOOD, foreground: TEXT_BAD });
    expect(warning).toMatchObject({ id: "fg-bg", fg: "foreground", bg: "background", pass: false });
    expect(warning.ratio).toBeCloseTo(2.3231, 3);
  });
});
