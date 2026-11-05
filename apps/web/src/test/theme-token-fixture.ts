import type { ThemePackTokens } from "@/lib/theme/token-schema";

/**
 * 完整的语义令牌夹具（M11.6 Step 3g，导入导出往返测试共用）：
 * 浅色与深色两档，各带颜色、圆角、三档阴影、展示字体、品牌渐变、板块卡参数；
 * 刻意混用大小写的色值（schema 只校验格式，不做规范化，往返后必须逐字相同）。
 * 声明为 ThemePackTokens：schema 改了字段，这里先在类型检查里报错，而不是等到运行时。
 */
export const FULL_TOKENS: ThemePackTokens = {
  light: {
    colors: {
      background: "#F6F3E7",
      foreground: "#2B2A24",
      primary: "#147BA9",
      "primary-foreground": "#ffffff",
      border: "#d9d2b8",
    },
    radius: "lg",
    shadows: {
      s1: { x: 0, y: 1, blur: 2, spread: 0, color: "#78641e", alpha: 0.1 },
      s2: { x: 0, y: 4, blur: 12, spread: -2, color: "#78641e", alpha: 0.16 },
      s3: { x: 2, y: 8, blur: 24, spread: 0, color: "#3c320f", alpha: 0.24 },
    },
    displayFont: "songti",
    brandGradient: { angle: 135, from: "#147BA9", to: "#efe9b5" },
    band: { width: 5.25, angle: 100, fade: 40, dim: 0.35, mask: true, maskColor: "#f6f3e7" },
  },
  dark: {
    colors: { background: "#14161a", foreground: "#e8e6df", primary: "#4FB0DB" },
    radius: "sm",
    shadows: { s1: { x: 0, y: 1, blur: 3, spread: 0, color: "#000000", alpha: 0.5 } },
    displayFont: "serif",
    brandGradient: { angle: 200, from: "#0b4a66", to: "#1d2a33" },
    band: { width: 4, angle: 90, fade: 25, dim: 0.5, mask: false },
  },
};
