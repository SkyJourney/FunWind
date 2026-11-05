import { hexColorSchema } from "./color";
import {
  COLOR_KEYS,
  type ColorKey,
  type DisplayFont,
  type RadiusStep,
  type Shadow,
  type TokenSet,
} from "./token-schema";

/**
 * 基础层事实表（M11.6 Step 3b / 3c）：默认包在浅色（semantic.css）与暗色（dark.css）下的最终值。
 *
 * 令牌只覆盖基础层，缺省的键继承它。编辑器要给「继承默认」的颜色显示占位值、给「覆盖」按钮一个与继承值一致的起点，
 * 对比度顾问要用它给缺省键补缺，而这几处都运行在浏览器里，读不到 CSS，所以这里放一份 TS 常量。
 * 常量和 CSS 是同一份事实的两份拷贝，防漂移由 src/test/token-contrast.test.ts 守住：
 * 它按同样的口径解析令牌 CSS，逐项比对。改了 CSS 里的基础值而没改这里，那条测试会变红。
 *
 * 暗色表是完整的 22 项（dark.css 自己定义了全部语义色），不依赖浅色表。
 */

export type ColorMode = "light" | "dark";

/** 阴影档位，对应 `--shadow-1/2/3` */
export const SHADOW_SLOTS = ["s1", "s2", "s3"] as const;
export type ShadowSlot = (typeof SHADOW_SLOTS)[number];

type Band = NonNullable<TokenSet["band"]>;

/** 基础层的圆角档：semantic.css 的 `--radius: var(--fw-radius-lg)` */
export const BASE_RADIUS: RadiusStep = "lg";

/** 基础层的展示字体档：primitives.css 的 `--fw-font-display: var(--fw-font-sans)` */
export const BASE_FONT: DisplayFont = "system";

/**
 * 基础层阴影，作为「覆盖」按钮的起点。令牌只能表达单层阴影，
 * 而浅色 s1 在基础层是两层叠加（`0 1px 2px / 0.06` 加 `0 1px 3px / 0.08`），这里取较大的第二层。
 * 其余五项在基础层本来就是单层。
 */
export const BASE_SHADOWS: Readonly<Record<ColorMode, Readonly<Record<ShadowSlot, Shadow>>>> = {
  light: {
    s1: { x: 0, y: 1, blur: 3, spread: 0, color: "#0f172a", alpha: 0.08 },
    s2: { x: 0, y: 4, blur: 12, spread: 0, color: "#0f172a", alpha: 0.1 },
    s3: { x: 0, y: 12, blur: 32, spread: 0, color: "#0f172a", alpha: 0.16 },
  },
  dark: {
    s1: { x: 0, y: 1, blur: 2, spread: 0, color: "#000000", alpha: 0.5 },
    s2: { x: 0, y: 4, blur: 12, spread: 0, color: "#000000", alpha: 0.55 },
    s3: { x: 0, y: 12, blur: 32, spread: 0, color: "#000000", alpha: 0.65 },
  },
};

/**
 * 基础层的板块卡参数（default.css）。遮罩终点色在基础层是 `var(--card)`，令牌里没有这个键就是跟随卡片底色，
 * 所以这里不含 maskColor。
 */
export const BASE_BAND: Readonly<Omit<Band, "maskColor">> = {
  width: 7,
  angle: 105,
  fade: 50,
  dim: 0.85,
  mask: true,
};

export const BASE_COLORS: Readonly<Record<ColorMode, Readonly<Record<ColorKey, string>>>> = {
  light: {
    background: "#f8fafc",
    foreground: "#0f172a",
    card: "#ffffff",
    "card-foreground": "#0f172a",
    popover: "#ffffff",
    "popover-foreground": "#0f172a",
    primary: "#0e7490",
    "primary-foreground": "#ffffff",
    secondary: "#f1f5f9",
    "secondary-foreground": "#334155",
    muted: "#f1f5f9",
    "muted-foreground": "#64748b",
    accent: "#ecfeff",
    "accent-foreground": "#155e75",
    destructive: "#b91c1c",
    "destructive-foreground": "#ffffff",
    success: "#166534",
    warning: "#92400e",
    info: "#3b82f6",
    border: "#e2e8f0",
    input: "#e2e8f0",
    ring: "#06b6d4",
  },
  dark: {
    background: "#020617",
    foreground: "#f1f5f9",
    card: "#0f172a",
    "card-foreground": "#f1f5f9",
    popover: "#0f172a",
    "popover-foreground": "#f1f5f9",
    primary: "#22d3ee",
    "primary-foreground": "#020617",
    secondary: "#1e293b",
    "secondary-foreground": "#e2e8f0",
    muted: "#1e293b",
    "muted-foreground": "#94a3b8",
    accent: "#083344",
    "accent-foreground": "#a5f3fc",
    destructive: "#f87171",
    "destructive-foreground": "#020617",
    success: "#22c55e",
    warning: "#fbbf24",
    info: "#60a5fa",
    border: "#1e293b",
    input: "#1e293b",
    ring: "#22d3ee",
  },
};

/**
 * 某一档的生效颜色：基础层打底，再盖上包里提供的覆盖。
 * 覆盖里不合法的值（不是 #RRGGBB）和未知的键一律忽略，回落基础层；合法值规范化为小写。
 * 返回新对象，调用方改它不会污染 BASE_COLORS。
 */
export function effectiveColors(
  mode: ColorMode,
  overrides?: Partial<Record<ColorKey, string>>,
): Record<ColorKey, string> {
  const out = { ...BASE_COLORS[mode] };
  if (overrides) {
    for (const key of COLOR_KEYS) {
      const value = overrides[key];
      if (typeof value === "string" && hexColorSchema.safeParse(value).success) {
        out[key] = value.toLowerCase();
      }
    }
  }
  return out;
}
