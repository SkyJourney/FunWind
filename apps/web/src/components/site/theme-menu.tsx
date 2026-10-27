"use client";

import { useSyncExternalStore } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_OPTIONS, isThemeValue, type ThemeValue } from "@/lib/theme";
import { cn } from "@/lib/utils";

const ICONS = { Sun, Moon, Monitor } as const;
const ICON_FOR_THEME: Record<ThemeValue, keyof typeof ICONS> = {
  light: "Sun",
  dark: "Moon",
  system: "Monitor",
};

/** 水合前 false、水合后 true（无 setState-in-effect 的 mounted 检测） */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * 顶栏主题切换（图标下拉）。挂载前渲染「跟随系统」图标：
 * theme 在客户端水合前不可知，先按 system 渲染避免服务端/客户端不一致。
 */
export function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();
  const Current =
    ICONS[mounted && theme && isThemeValue(theme) ? ICON_FOR_THEME[theme] : "Monitor"];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="主题切换"
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Current className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_OPTIONS.map(({ value, label, icon }) => {
          const Icon = ICONS[icon];
          return (
            <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
              <Icon className="size-4" aria-hidden />
              {label}
              {theme === value && <Check className="ml-auto size-4" aria-hidden />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 用户菜单内的主题行：移动端顶栏不放主题图标，从这里切。 */
export function ThemeOptionsRow() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex items-center gap-1 px-2 py-1.5" role="group" aria-label="主题切换">
      {THEME_OPTIONS.map(({ value, label, icon }) => {
        const Icon = ICONS[icon];
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
