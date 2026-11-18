"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { docsNavGroups } from "@/lib/manage/api-docs-md";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/**
 * 桌面与移动抽屉共用分域导航；端点徽标显示目录登记的方法。
 * 点击移动端的原生锚点时关闭抽屉，不触发 Next 软导航。
 */
const METHOD_BADGE = "shrink-0 rounded px-1 font-mono text-[10px] font-medium";
const METHOD_TONE = {
  read: "bg-success/10 text-success",
  write: "bg-warning/10 text-warning",
};

export function DocsNav({ onNavigate }: { onNavigate?: () => void }) {
  const groups = docsNavGroups();
  return (
    <nav aria-label="文档导航" className="space-y-5 text-sm">
      {groups.map((group, gi) => (
        <div key={group.group}>
          {/* 组标题：不缩进、前景色、加重——是「节」的标题而非可点条目 */}
          <p
            className={[
              "px-2 py-1 text-[13px] font-semibold text-foreground",
              gi > 0 ? "mt-3" : "",
            ].join(" ")}
          >
            {group.group}
          </p>
          {/* 子项：深缩进 + 弱化色——明确是组内子项；hover 才亮起 */}
          <ul className="space-y-px">
            {group.items.map((item) => (
              <li key={item.slug}>
                <a
                  href={`#${item.slug}`}
                  onClick={onNavigate}
                  className="flex items-center gap-2 rounded-md py-1.5 pr-2 pl-6 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {"method" in item && (
                    <span className={`${METHOD_BADGE} ${METHOD_TONE[item.access]}`}>
                      {item.method}
                    </span>
                  )}
                  <span>{item.nav}</span>
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
        <div className="px-2 pt-7 pb-6">
          <DocsNav onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
