import { hexColorSchema } from "./color";
import { COLOR_KEYS, type ColorKey } from "./token-schema";

/**
 * 基础层颜色表（M11.6 Step 3b）：默认包的 22 个语义色在浅色（semantic.css）与暗色（dark.css）下的最终值。
 *
 * 令牌只覆盖基础层，缺省的键继承它。编辑器要给「继承默认」的颜色显示占位值，对比度顾问要用它给缺省键补缺，
 * 而这两处都运行在浏览器里，读不到 CSS，所以这里放一份 TS 常量。
 * 常量和 CSS 是同一份事实的两份拷贝，防漂移由 src/test/token-contrast.test.ts 守住：
 * 它按同样的口径解析令牌 CSS，逐键比对。改了 CSS 里的语义色而没改这里，那条测试会变红。
 *
 * 暗色表是完整的 22 项（dark.css 自己定义了全部语义色），不依赖浅色表。
 */

export type ColorMode = "light" | "dark";

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
