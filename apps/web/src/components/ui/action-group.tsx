import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 操作区按可用宽度换行，按钮与表单内部的尺寸契约由各自控件维护。 */
export function ActionGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex max-w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-2", className)}
      {...props}
    />
  );
}
