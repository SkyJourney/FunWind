import { X } from "lucide-react";
import Link from "next/link";

export type AdminFlashKind = "success" | "error" | "info";

const KIND_CLS: Record<AdminFlashKind, string> = {
  success: "border-success/30 bg-success/10 text-success",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-border bg-muted text-foreground",
};

/**
 * 后台操作反馈条（M9.5 统一基线）：读约定 searchParams 渲染（Server Action redirect 的自然产物），
 * 成功条 role="status"、失败条 role="alert"，带关闭按钮（清掉该参数，刷新不再残留）。
 * 服务端组件；关闭按钮用 <Link href={dismissHref}> 实现（去 flash 参数即关闭，零 JS）。
 */
export function AdminFlash({
  kind,
  children,
  dismissHref,
}: {
  kind: AdminFlashKind;
  children: React.ReactNode;
  /** 去掉 flash 参数后的页面 URL（调用方负责拼好保留其余 query） */
  dismissHref?: string;
}) {
  return (
    <p
      role={kind === "error" ? "alert" : "status"}
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${KIND_CLS[kind]}`}
    >
      <span className="min-w-0">{children}</span>
      {dismissHref && (
        <Link
          href={dismissHref}
          aria-label="关闭提示"
          className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
        >
          <X className="size-3.5" aria-hidden />
        </Link>
      )}
    </p>
  );
}
