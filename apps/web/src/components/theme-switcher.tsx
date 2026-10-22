"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

const OPTIONS = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "暗色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
] as const;

export function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card p-1"
      role="group"
      aria-label="主题切换"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <Button
          key={value}
          variant={theme === value ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setTheme(value)}
          aria-pressed={theme === value}
          title={label}
        >
          <Icon className="size-4" aria-hidden />
          <span className="hidden sm:inline">{label}</span>
        </Button>
      ))}
    </div>
  );
}
