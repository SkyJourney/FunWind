import { readFileSync } from "node:fs";
import path from "node:path";
import { BUILTIN_THEME_PACK_SEEDS } from "@funwind/db";
import { describe, expect, it } from "vitest";
import { evaluateContrast } from "@/lib/theme/contrast-advisor";
import {
  BASE_BAND,
  BASE_COLORS,
  BASE_FONT,
  BASE_RADIUS,
  BASE_SHADOWS,
  SHADOW_SLOTS,
} from "@/lib/theme/token-base";
import { TOKEN_PREVIEW_ATTR } from "@/lib/theme/token-preview";
import { renderTokenVars } from "@/lib/theme/token-render";
import { COLOR_KEYS, type ColorKey, type Shadow } from "@/lib/theme/token-schema";

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
// qy2010 CSS 已删除（M11.6 Step 5c），从种子渲染令牌声明
const qy2010Seed = BUILTIN_THEME_PACK_SEEDS.find((s) => s.id === "qy2010");
if (!qy2010Seed?.definition) throw new Error("qy2010 种子缺失 definition");
const qy2010Light = (
  qy2010Seed.definition.tokens as { light?: Record<string, unknown> } | undefined
)?.light;
// 缺 tokens.light 必须明确失败：回退成空对象会让 qy2010 与默认浅色完全相同，下面的断言空转通过
if (!qy2010Light) throw new Error("qy2010 种子缺失 tokens.light，无法计算对比度");
const qy2010Vars = renderTokenVars(qy2010Light as Parameters<typeof renderTokenVars>[0]);
const THEMES = {
  "默认·浅色": themeColors(primitives, semantic),
  "默认·暗色": themeColors(
    primitives,
    semantic,
    declarations("themes/dark.css", '[data-mode="dark"]'),
  ),
  "情怀包 qy2010·浅色": themeColors(primitives, semantic, qy2010Vars),
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
  // primary-tint-bg 4.487，差 0.013；M11.3.1 已对 AuthShell 提示条做局部加深，令牌本身不动。
  // muted-fg-muted / muted-fg-secondary 4.344：M11.6 Step 6 把这两对补进顾问后才暴露，
  // 默认主题的 muted-foreground 压在弱化底和次色上略低于 4.5，不属于 qy2010 的范围，登记为已知缺口
  "默认·浅色": ["muted-fg-muted", "muted-fg-secondary", "primary-tint-bg"],
  "默认·暗色": [],
  // primary 在两种淡底上 4.08 / 3.75（M11.6 Step 6 换品牌色后应消失）；
  // muted-foreground #8a8265 压页面底 / 卡片底 3.46 / 3.77，次要文字普遍不达标；
  // 站长 2026-11-05 决定并入 Step 6 与品牌色一起加深（docs/milestones/M11.6 的 D6）
  "情怀包 qy2010·浅色": [
    "muted-fg-bg",
    "muted-fg-card",
    "muted-fg-muted",
    "muted-fg-secondary",
    "muted-fg-accent",
    "primary-fg-bg",
    "primary-tint-card",
    "primary-tint-bg",
  ],
};

describe.each(Object.entries(THEMES))("%s：对比度顾问与独立实现一致", (name, color) => {
  const palette = Object.fromEntries(
    COLOR_KEYS.map((key) => [key, toHex(color(`--${key}`))]),
  ) as Record<ColorKey, string>;
  const checks = evaluateContrast(palette);

  it("每一对的比值都等于本文件独立算出的值", () => {
    expect(checks).toHaveLength(23);
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

/**
 * 基础层颜色表（lib/theme/token-base.ts）防漂移：TS 常量与令牌 CSS 解析出的值逐键相等。
 * 常量供浏览器端（编辑器「继承默认」的占位值、对比度顾问给缺省键补缺）使用，那里读不到 CSS，
 * 只能放一份拷贝；谁改了 semantic.css / dark.css 里的语义色而没同步常量，这里会变红。
 */
describe.each([
  ["light", "默认·浅色"],
  ["dark", "默认·暗色"],
] as const)("基础层颜色表 %s 档与令牌 CSS 一致", (mode, themeName) => {
  const color = THEMES[themeName];
  it.each(COLOR_KEYS)("%s", (key) => {
    expect(BASE_COLORS[mode][key]).toBe(toHex(color(`--${key}`)));
  });
});

/** 解析基础层阴影的最后一层：`x y blur [spread] rgb(r g b / a)` → 令牌 Shadow；认不出的写法直接报错，不静默放过 */
function parseLastShadowLayer(css: string): Shadow {
  const layer = css.split(",").at(-1)!.trim();
  const m = layer.match(
    /^(-?\d+)(?:px)?\s+(-?\d+)(?:px)?\s+(\d+)(?:px)?\s+(?:(-?\d+)(?:px)?\s+)?rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/,
  );
  if (!m) throw new Error(`无法解析阴影：${css}`);
  return {
    x: Number(m[1]),
    y: Number(m[2]),
    blur: Number(m[3]),
    spread: Number(m[4] ?? 0),
    color: toHex([Number(m[5]), Number(m[6]), Number(m[7])]),
    alpha: Number(m[8]),
  };
}

/**
 * 基础层非颜色事实（圆角、展示字体、阴影、板块卡）防漂移。
 * 这些常量是编辑器「覆盖」按钮的起点：点下去之后写进包里的值，经令牌渲染器输出，
 * 应当与继承时的 CSS 值一致，视觉上没有跳变。所以圆角、字体、板块卡比的是
 * 「常量经渲染器输出的变量」对「令牌 CSS 声明的变量」；阴影的 CSS 写法与渲染器输出的格式不同
 * （`0 1px` 对 `0px 1px`），改为解析 CSS 后逐字段比较。
 */
describe("基础层非颜色事实与令牌 CSS 一致", () => {
  const darkLayer = declarations("themes/dark.css", '[data-mode="dark"]');
  const bandLayer = declarations("themes/default.css", ":root");

  it("圆角档：覆盖为基础档，输出的 --radius 与 semantic.css 相同", () => {
    const rendered = renderTokenVars({ radius: BASE_RADIUS })["--radius"];
    expect(rendered).toBeTypeOf("string");
    expect(rendered).toBe(semantic["--radius"]);
  });

  it("展示字体档：覆盖为基础档，输出的 --fw-font-display 与 primitives.css 相同", () => {
    const rendered = renderTokenVars({ displayFont: BASE_FONT })["--fw-font-display"];
    expect(rendered).toBeTypeOf("string");
    expect(rendered).toBe(primitives["--fw-font-display"]);
  });

  it("浅色阴影：semantic 的 --shadow-N 引用 primitives 的 --fw-shadow-N", () => {
    for (const n of ["1", "2", "3"]) {
      expect(semantic[`--shadow-${n}`]).toBe(`var(--fw-shadow-${n})`);
    }
  });

  it("只有浅色 s1 是两层叠加，其余五项都是单层（起点取最后一层的前提）", () => {
    const layers = (css: string) => css.split(",").length;
    expect(layers(primitives["--fw-shadow-1"])).toBe(2);
    expect(layers(primitives["--fw-shadow-2"])).toBe(1);
    expect(layers(primitives["--fw-shadow-3"])).toBe(1);
    for (const n of ["1", "2", "3"]) expect(layers(darkLayer[`--shadow-${n}`])).toBe(1);
  });

  it.each(["light", "dark"] as const)(
    "阴影 %s 档：三档起点与 CSS（最后一层）逐字段相等",
    (mode) => {
      for (const slot of SHADOW_SLOTS) {
        const n = slot.slice(1);
        const css = mode === "light" ? primitives[`--fw-shadow-${n}`] : darkLayer[`--shadow-${n}`];
        expect(css, `${mode} ${slot} 的 CSS`).toBeTypeOf("string");
        expect(BASE_SHADOWS[mode][slot], `${mode} ${slot}`).toStrictEqual(
          parseLastShadowLayer(css),
        );
      }
    },
  );

  it("板块卡：覆盖为基础值，输出的五个变量与 default.css 逐项相同", () => {
    const rendered = renderTokenVars({ band: BASE_BAND });
    for (const name of [
      "--band-width",
      "--band-angle",
      "--band-fade",
      "--band-dim-opacity",
      "--band-mask-display",
    ]) {
      expect(rendered[name], name).toBeTypeOf("string");
      expect(rendered[name], name).toBe(bandLayer[name]);
    }
  });

  it("板块卡遮罩色在基础层跟随卡片底色，所以起点不含 maskColor", () => {
    expect(bandLayer["--band-mask-color"]).toBe("var(--card)");
    expect(renderTokenVars({ band: BASE_BAND })).not.toHaveProperty("--band-mask-color");
    expect(Object.hasOwn(BASE_BAND, "maskColor")).toBe(false);
  });
});

/**
 * 品牌渐变的声明位置（M11.6 Step 3d）：var() 在声明它的元素上取值，后台令牌预览容器要让渐变跟着草稿的
 * --primary / --accent / --secondary 变，所以 semantic.css 里它单独成块，选择器同时覆盖 :root 与预览容器。
 * 守住三件事：只有一处声明；选择器恰好是这两个；公式仍然引用那三个颜色变量。
 */
describe("品牌渐变的声明位置", () => {
  const css = read("semantic.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf("--gradient-brand");
  const open = css.lastIndexOf("{", at);
  const close = css.lastIndexOf("}", open);

  it("semantic.css 里只声明一次", () => {
    expect(css.match(/--gradient-brand\s*:/g)).toHaveLength(1);
  });

  it("第一个 :root 块里没有它（令牌守卫解析的就是那个块）", () => {
    expect(semantic["--gradient-brand"]).toBeUndefined();
  });

  it("所在块的选择器恰好是 :root 加令牌预览属性", () => {
    const selector = css
      .slice(close + 1, open)
      .replace(/\s+/g, " ")
      .trim();
    expect(selector).toBe(`:root, [${TOKEN_PREVIEW_ATTR}]`);
  });

  it("公式引用 primary、accent、secondary 三个变量（预览里才会跟着草稿变）", () => {
    const body = css.slice(open + 1, css.indexOf("}", open));
    for (const key of ["primary", "accent", "secondary"]) expect(body).toContain(`var(--${key})`);
  });
});
