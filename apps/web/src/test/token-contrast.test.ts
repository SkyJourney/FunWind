import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateContrast } from "@/lib/theme/contrast-advisor";
import { COLOR_KEYS, type ColorKey } from "@/lib/theme/token-schema";

/**
 * 语义色对比度守卫（M11.3 目视验收的遗留清账）。
 *
 * 直接解析 src/styles/tokens 下的令牌 CSS（primitives → semantic → 主题覆盖），不依赖浏览器，
 * 对「语义文字色在自己的 /10 淡底上」这一项目通用的提示条写法做 WCAG AA（4.5:1）断言。
 * 起因：2026-11-04 实测浅色下 warning 2.86、success 2.96、destructive 4.13，全站 56 + 78 处文字用法受影响。
 * 只断言当前已达标或已修复的组合；已知未达标项写在下面的「已知缺口」里，不靠放宽阈值掩盖。
 */

const TOKENS_DIR = path.resolve(import.meta.dirname, "../styles/tokens");
const read = (file: string) => readFileSync(path.join(TOKENS_DIR, file), "utf8");

type Rgb = [number, number, number];

/** 去注释后取出某个选择器块内的自定义属性声明（令牌块内没有嵌套花括号） */
function declarations(file: string, selector: string): Record<string, string> {
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`${file} 中找不到选择器 ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, close).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** 按层叠顺序合并令牌，并展开 var(--x) 引用链；遇到非十六进制色值直接报错，不静默放过 */
function themeColors(...layers: Record<string, string>[]) {
  const merged = Object.assign({}, ...layers) as Record<string, string>;
  const resolve = (name: string, depth = 0): Rgb => {
    if (depth > 10) throw new Error(`令牌引用链过深：${name}`);
    const raw = merged[name];
    if (raw === undefined) throw new Error(`未定义的令牌 ${name}`);
    const ref = raw.match(/^var\((--[a-z0-9-]+)\)$/);
    if (ref) return resolve(ref[1], depth + 1);
    const hex = raw.match(/^#([0-9a-f]{6})$/i);
    if (!hex) throw new Error(`令牌 ${name} 的值 ${raw} 不是 #rrggbb，守卫无法计算`);
    const n = hex[1];
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16)) as Rgb;
  };
  return resolve;
}

const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** 前景色以 alpha 叠在背景上的合成色（对应 Tailwind 的 bg-x/10） */
const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  fg.map((c, i) => Math.round(alpha * c + (1 - alpha) * bg[i])) as Rgb;

const primitives = declarations("primitives.css", ":root");
const semantic = declarations("semantic.css", ":root");
const THEMES = {
  "默认·浅色": themeColors(primitives, semantic),
  "默认·暗色": themeColors(
    primitives,
    semantic,
    declarations("themes/dark.css", '[data-mode="dark"]'),
  ),
  "情怀包 qy2010·浅色": themeColors(
    primitives,
    semantic,
    declarations("themes/qy2010.css", ':root[data-pack="qy2010"]:not([data-mode="dark"])'),
  ),
} as const;

describe("对比度计算自检", () => {
  it("黑白 21:1；#767676 对白底约 4.54（WCAG 公布的 AA 临界灰）", () => {
    expect(contrast([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrast([0x76, 0x76, 0x76], [255, 255, 255])).toBeCloseTo(4.54, 2);
  });

  it("令牌解析能展开引用链并读到主题覆盖", () => {
    // semantic 里 --warning 引用 primitives 的 amber-800；情怀包改写为自己的色值
    expect(THEMES["默认·浅色"]("--warning")).toEqual([0x92, 0x40, 0x0e]);
    expect(THEMES["情怀包 qy2010·浅色"]("--warning")).toEqual([0x8a, 0x52, 0x00]);
  });
});

describe.each(Object.entries(THEMES))(
  "%s：语义文字色在自己的 /10 淡底上 ≥ 4.5:1",
  (_name, color) => {
    const surfaces = [
      ["卡片底", "--card"],
      ["页面底", "--background"],
    ] as const;
    for (const token of ["warning", "success", "destructive"] as const) {
      for (const [surfaceName, surfaceToken] of surfaces) {
        it(`${token} / ${surfaceName}`, () => {
          const fg = color(`--${token}`);
          const tint = over(fg, color(surfaceToken), 0.1);
          expect(contrast(fg, tint)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    it("destructive 实心按钮：前景色压在 destructive 上 ≥ 4.5:1", () => {
      expect(
        contrast(color("--destructive-foreground"), color("--destructive")),
      ).toBeGreaterThanOrEqual(4.5);
    });
  },
);

describe("primary（品牌色，不改令牌）", () => {
  it("默认浅色：主按钮前景压在 primary 上，以及 primary 文字在卡片 /10 淡底上 ≥ 4.5:1", () => {
    const color = THEMES["默认·浅色"];
    expect(contrast(color("--primary-foreground"), color("--primary"))).toBeGreaterThanOrEqual(4.5);
    const fg = color("--primary");
    expect(contrast(fg, over(fg, color("--card"), 0.1))).toBeGreaterThanOrEqual(4.5);
  });

  it("AuthShell 提示条的局部加深（primary 80% + 黑 20%）在两套浅色主题的页面底 /10 淡底上 ≥ 4.5:1", () => {
    // 与 app/(auth)/ui-bits.tsx 的 color-mix(in srgb, var(--primary) 80%, black) 保持同一比例
    for (const name of ["默认·浅色", "情怀包 qy2010·浅色"] as const) {
      const color = THEMES[name];
      const primary = color("--primary");
      const darkened = primary.map((c) => Math.round(c * 0.8)) as Rgb;
      expect(contrast(darkened, over(primary, color("--background"), 0.1))).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  // 已知缺口（非本次范围，登记在 M11.3 遗留事项）：情怀包 primary 文字压在淡底上不足 4.5:1，
  // 这里不写成断言，避免用放宽阈值掩盖；等站长决定是否调整情怀包品牌色再补。
});

/**
 * 对比度顾问（lib/theme/contrast-advisor.ts，M11.6）与真实主题 CSS 的交叉核对。
 * 顾问和本文件的 contrast() / over() 是两份独立实现：每一对的比值必须一致，
 * 说明顾问的配对表、淡底合成与取色没有写错。
 * 「未达标清单」是对现状的固定：谁改了令牌让清单变化，这里会变红，要求有意识地更新；
 * 清单里的项就是顾问在后台会给出的警告（只警告不阻止保存），不是被放过的缺陷。
 */
const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;

const KNOWN_FAILURES: Record<string, string[]> = {
  // 4.487，差 0.013；M11.3.1 已对 AuthShell 提示条做局部加深，令牌本身不动
  "默认·浅色": ["primary-tint-bg"],
  "默认·暗色": [],
  // primary 在两种淡底上 4.08 / 3.75（M11.6 Step 6 换品牌色后应消失）；
  // muted-foreground #8a8265 压页面底 / 卡片底 3.46 / 3.77，次要文字普遍不达标；
  // 站长 2026-11-05 决定并入 Step 6 与品牌色一起加深（docs/milestones/M11.6 的 D6）
  "情怀包 qy2010·浅色": ["muted-fg-bg", "muted-fg-card", "primary-tint-card", "primary-tint-bg"],
};

describe.each(Object.entries(THEMES))("%s：对比度顾问与独立实现一致", (name, color) => {
  const palette = Object.fromEntries(
    COLOR_KEYS.map((key) => [key, toHex(color(`--${key}`))]),
  ) as Record<ColorKey, string>;
  const checks = evaluateContrast(palette);

  it("每一对的比值都等于本文件独立算出的值", () => {
    expect(checks).toHaveLength(18);
    for (const check of checks) {
      const fg = color(`--${check.fg}`);
      const bg = color(`--${check.bg}`);
      const expected =
        check.tintAlpha === undefined
          ? contrast(fg, bg)
          : contrast(fg, over(fg, bg, check.tintAlpha));
      expect(check.ratio, check.id).toBeCloseTo(expected, 10);
    }
  });

  it("未达标的配对恰为已知清单", () => {
    expect(checks.filter((check) => !check.pass).map((check) => check.id)).toEqual(
      KNOWN_FAILURES[name],
    );
  });
});
