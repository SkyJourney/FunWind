/** 主题包清单（与 src/styles/tokens/themes/ 保持一致；M11 新增主题包时同步） */
export const THEME_OPTIONS = [
  { value: "light", label: "浅色", icon: "Sun" },
  { value: "dark", label: "暗色", icon: "Moon" },
  { value: "system", label: "跟随系统", icon: "Monitor" },
] as const;

export type ThemeValue = (typeof THEME_OPTIONS)[number]["value"];

export function isThemeValue(v: string | undefined): v is ThemeValue {
  return THEME_OPTIONS.some((o) => o.value === v);
}

/** html[data-theme] 的实际取值（next-themes attribute 模式） */
export function resolveDataTheme(theme: string, systemPrefersDark: boolean): "light" | "dark" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return systemPrefersDark ? "dark" : "light";
}
