"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { docsNavGroups } from "@/lib/manage/api-docs-md";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * 文档站左树导航（M20.1）：概览组 + 功能域分组，接口条目带 GET 色标。
 * 桌面 = sticky 树；移动 = 顶条汉堡呼出的受控抽屉——锚点点击即关（onClick 手动关，
 * 锚点 hash 导航不触发 Next 软导航，无竞态窗口）。
 */

const METHOD_BADGE = "rounded bg-success/10 px-1 font-mono text-[10px] font-medium text-success";

export function DocsNav({ onNavigate }: { onNavigate?: () => void }) {
  const groups = docsNavGroups();
  return (
    <nav aria-label="文档导航" className="space-y-5 text-sm">
      {groups.map((group) => (
        <div key={group.group}>
          <p className="mb-1 px-2 text-xs font-medium tracking-wide text-muted-foreground">
            {group.group === "功能域" ? "功能域" : group.group}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => (
              <li key={item.slug}>
                <a
                  href={`#${item.slug}`}
                  onClick={onNavigate}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {item.withMethod && <span className={METHOD_BADGE}>GET</span>}
                  {item.nav}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** 移动端：顶条汉堡呼出的文档导航抽屉（受控；锚点点击后关闭） */
export function DocsMobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label="文档导航">
          <Menu className="size-4" aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 overflow-y-auto">
        <SheetTitle className="sr-only">文档导航</SheetTitle>
        <div className="px-2 pb-6">
          <DocsNav onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
