import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 空状态三要素（S2 states.html ②定稿）：图标占位 + 一句话解释 + 主行动。
 * 全站空态统一走本组件，禁止各页手写灰字。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** 主行动；link 版是常用的「按钮跳转」形态 */
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed bg-card/50 px-6 py-12 text-center">
      <Icon className="mx-auto size-10 text-muted-foreground/60" aria-hidden />
      <p className="mt-3 font-medium">{title}</p>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      {action && (
        <div className="mt-4 flex justify-center">
          {typeof action === "string" ? (
            <Button asChild variant="outline" size="sm">
              <Link href={action.startsWith("/") ? action : "/"}>{action}</Link>
            </Button>
          ) : (
            action
          )}
        </div>
      )}
    </div>
  );
}
