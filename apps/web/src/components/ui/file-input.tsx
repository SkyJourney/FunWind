"use client";

import { useId, useState, type ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { FileName } from "@/components/ui/file-name";

/** 原生文件框限制在父容器内，选择后的完整文件名另行展示，不依赖浏览器的单行截断。 */
export function FileInput({
  className,
  onChange,
  showSelection = true,
  "aria-describedby": describedBy,
  ...props
}: Omit<ComponentProps<"input">, "type"> & { showSelection?: boolean }) {
  const selectionId = useId();
  const [names, setNames] = useState<string[]>([]);
  return (
    <span className="block max-w-full min-w-0 flex-[1_1_14rem] space-y-1">
      <input
        {...props}
        type="file"
        aria-describedby={
          [describedBy, showSelection ? selectionId : undefined].filter(Boolean).join(" ") ||
          undefined
        }
        className={cn(
          "block w-full max-w-full min-w-0 rounded-lg border bg-background px-2 py-1.5 text-xs file:mr-2 file:max-w-[55%] file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs",
          className,
        )}
        onChange={(event) => {
          onChange?.(event);
          setNames(Array.from(event.currentTarget.files ?? [], (file) => file.name));
        }}
      />
      {showSelection && (
        <span
          id={selectionId}
          className="block min-w-0 text-xs text-muted-foreground"
          aria-live="polite"
        >
          {names.map((name, index) => (
            <FileName key={`${index}-${name}`} name={name} className="block" />
          ))}
        </span>
      )}
    </span>
  );
}
