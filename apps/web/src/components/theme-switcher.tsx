"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { THEME_OPTIONS } from "@/lib/theme";

const ICONS = { Sun, Moon, Monitor } as const;

/** 水合前 false、水合后 true（无 setState-in-effect 的 mounted 检测） */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

/**
 * 设置页/演示页的主题切换（按钮组）。theme 在服务端不可知，挂载前一律不标激活态
 * （aria-pressed=false + ghost），水合后才呈现真实激活档——否则「跟随系统」档会
 * 服务端 false / 客户端 true 的 hydration mismatch（M6-carryover O-2，本组件曾长期是来源）。
 */
export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
      role="group"
      aria-label="主题切换"
    >
      {THEME_OPTIONS.map(({ value, label, icon }) => {
        const Icon = ICONS[icon];
        const active = mounted && theme === value;
        return (
          <Button
            key={value}
            variant={active ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            title={label}
          >
            <Icon className="size-4" aria-hidden />
            <span className="hidden sm:inline">{label}</span>
          </Button>
        );
      })}
    </div>
  );
}
