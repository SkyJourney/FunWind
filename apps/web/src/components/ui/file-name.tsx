import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** 文件名允许在容器内断行，完整名称同时保留在可访问文本中。 */
export function FileName({ name, className, ...props }: { name: string } & ComponentProps<"span">) {
  return (
    <span className={cn("min-w-0 [overflow-wrap:anywhere]", className)} title={name} {...props}>
      {name}
    </span>
  );
}
