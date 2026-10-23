"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { THEME_OPTIONS } from "@/lib/theme";

const ICONS = { Sun, Moon, Monitor } as const;

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
      role="group"
      aria-label="主题切换"
    >
      {THEME_OPTIONS.map(({ value, label, icon }) => {
        const Icon = ICONS[icon];
        const active = theme === value;
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
