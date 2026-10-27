"use client";

import Link from "next/link";
import {
  ChevronDown,
  Coins,
  ImagePlus,
  MessageCircle,
  ShieldCheck,
  Star,
  UserRound,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LogoutForm } from "@/components/auth/logout-form";
import { ThemeOptionsRow } from "@/components/site/theme-menu";

/**
 * 顶栏用户菜单：低频入口（积分/动态/私信/设置/管理/主题/退出）聚合处，
 * 也是移动端「我的」之外的主要个人入口。管理后台入口由服务端按权限传入。
 */
export function UserMenu({
  username,
  profileHref,
  showAdmin,
  logoutAction,
}: {
  username: string;
  profileHref: string;
  showAdmin: boolean;
  logoutAction: (formData: FormData) => Promise<void>;
}) {
  const items = [
    { href: profileHref, label: "个人主页", icon: UserRound },
    { href: "/points", label: "我的积分", icon: Coins },
    { href: "/follows", label: "关注动态", icon: Star },
    { href: "/messages", label: "私信", icon: MessageCircle },
    { href: "/settings/avatar", label: "头像设置", icon: ImagePlus },
    ...(showAdmin ? [{ href: "/admin", label: "管理后台", icon: ShieldCheck }] : []),
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`用户菜单：${username}`}
        className="inline-flex items-center gap-1.5 rounded-md p-1 transition-colors hover:bg-accent"
      >
        <Avatar size="sm">
          <AvatarFallback>{username.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <span className="hidden max-w-28 truncate font-medium md:inline">{username}</span>
        <ChevronDown className="hidden size-3.5 text-muted-foreground md:inline" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate">{username}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map(({ href, label, icon: Icon }) => (
          <DropdownMenuItem key={href} asChild>
            <Link href={href}>
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <ThemeOptionsRow />
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <LogoutForm action={logoutAction}>
            <button
              type="submit"
              className="w-full rounded-sm px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-accent"
            >
              退出登录
            </button>
          </LogoutForm>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
