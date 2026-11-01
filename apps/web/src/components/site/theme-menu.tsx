"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { Check, Monitor, Moon, Palette, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { THEME_OPTIONS, isThemeValue, type ThemeValue } from "@/lib/theme";
import { THEME_PACKS, packLabel, type PackId } from "@/lib/theme-packs";
import { patchPreference } from "@/lib/api/settings-pref";
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

/** 主题包偏好（服务端传入，仅登录用户）：user = 本人偏好（null = 跟随站点默认）、site = 站点默认 */
export interface PackPref {
  user: PackId | null;
  site: PackId;
}

/**
 * 主题包即时切换（M11）：改 html[data-pack] 立即生效（CSS 只看属性，零重载），
 * 同时 PATCH /api/settings/preferences 持久化到 profile；失败回滚属性与选中态并提示。
 * 下次 SSR 由 root layout 直出同一值，无闪烁。
 */
function usePackSwitch(pref: PackPref) {
  const [user, setUser] = useState<PackId | null>(pref.user);
  const [pending, startTransition] = useTransition();
  const choose = (next: PackId | null) => {
    const prev = user;
    setUser(next);
    document.documentElement.dataset.pack = next ?? pref.site;
    startTransition(async () => {
      try {
        const res = await patchPreference({ kind: "themePack", pack: next });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        setUser(prev);
        document.documentElement.dataset.pack = prev ?? pref.site;
        toast.error("主题包保存失败，请重试");
      }
    });
  };
  return { user, pending, choose };
}

/** 主题包选项：首项「跟随站点默认」（value=null）+ 注册表全部包 */
function packOptions(site: PackId): { value: PackId | null; label: string }[] {
  return [
    { value: null, label: `跟随站点默认（${packLabel(site)}）` },
    ...THEME_PACKS.map((p) => ({ value: p.id as PackId, label: p.label })),
  ];
}

/**
 * 顶栏主题切换（图标下拉）。挂载前渲染「跟随系统」图标：
 * theme 在客户端水合前不可知，先按 system 渲染避免服务端/客户端不一致。
 * 登录用户追加「主题包」分组（packPref 由服务端传入；游客无持久化载体，不显示）。
 */
export function ThemeMenu({ packPref = null }: { packPref?: PackPref | null }) {
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
        {packPref && <PackMenuItems pref={packPref} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PackMenuItems({ pref }: { pref: PackPref }) {
  const { user, pending, choose } = usePackSwitch(pref);
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Palette className="size-3.5" aria-hidden /> 主题包
      </DropdownMenuLabel>
      {packOptions(pref.site).map(({ value, label }) => (
        <DropdownMenuItem
          key={value ?? "site"}
          disabled={pending}
          onSelect={() => choose(value)}
          data-pack-option={value ?? "site"}
        >
          {label}
          {user === value && <Check className="ml-auto size-4" aria-hidden />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/** 用户菜单内的主题行：移动端顶栏不放主题图标，从这里切。 */
export function ThemeOptionsRow() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="flex items-stretch gap-1 px-2 py-1.5" role="group" aria-label="主题切换">
      {THEME_OPTIONS.map(({ value, label, icon }) => {
        const Icon = ICONS[icon];
        const active = theme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={active}
            title={label}
            className={cn(
              // 纵向小卡：图标上、文字下——窄菜单里「跟随系统」不再横向挤压换行（M10.6d 站长反馈）
              "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] leading-none whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** 用户菜单内的主题包行（M11）：与 ThemeOptionsRow 同形态的横向小卡，移动端从这里切主题包。 */
export function PackOptionsRow({ pref }: { pref: PackPref }) {
  const { user, pending, choose } = usePackSwitch(pref);
  return (
    <div className="flex items-stretch gap-1 px-2 py-1.5" role="group" aria-label="主题包">
      {packOptions(pref.site).map(({ value, label }) => {
        const active = user === value;
        return (
          <button
            key={value ?? "site"}
            type="button"
            disabled={pending}
            onClick={() => choose(value)}
            aria-pressed={active}
            title={label}
            data-pack-option={value ?? "site"}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground",
            )}
          >
            <Palette className="size-4" aria-hidden />
            <span className="truncate">{value === null ? "跟随站点" : label}</span>
          </button>
        );
      })}
    </div>
  );
}
