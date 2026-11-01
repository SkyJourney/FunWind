/**
 * 明暗模式（data-mode）选项清单。next-themes attribute="data-mode"、storageKey 保持默认
 * "theme"（不丢用户已选模式）。M11 起明暗与主题包（html[data-pack]，见 lib/theme-packs）正交。
 */
export const THEME_OPTIONS = [
  { value: "light", label: "浅色", icon: "Sun" },
  { value: "dark", label: "暗色", icon: "Moon" },
  { value: "system", label: "跟随系统", icon: "Monitor" },
] as const;

export type ThemeValue = (typeof THEME_OPTIONS)[number]["value"];

export function isThemeValue(v: string | undefined): v is ThemeValue {
  return THEME_OPTIONS.some((o) => o.value === v);
}

/** html[data-mode] 的实际取值（next-themes attribute 模式） */
export function resolveDataMode(theme: string, systemPrefersDark: boolean): "light" | "dark" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}
