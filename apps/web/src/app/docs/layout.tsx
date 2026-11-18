import { ThemeSwitcher } from "@/components/theme-switcher";
import { DocsMobileNav } from "@/app/docs/rest-api/docs-nav";

/**
 * 独立文档站壳（M20.1）：/docs/** 不套前台形态（根 layout 的前台壳由 ChromeGate 收起）——
 * 极简顶条（FunWind REST API 标识 + 返回后台）+ 全宽内容区；配色沿用全站统一令牌（浅/暗自适应）。
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="lg:hidden">
              <DocsMobileNav />
            </span>
            <p className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs text-primary">
                FunWind
              </span>
              Developer
            </p>
          </div>
          <ThemeSwitcher />
        </div>
      </header>
      {children}
    </div>
  );
}
