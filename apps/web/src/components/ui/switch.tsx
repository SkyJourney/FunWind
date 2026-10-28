"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * 开关（M10.7 Step 5d，S4 §3.1「开关 / 勾选弹跳」）：轨道 + 滑块。
 * 滑块位移用 spring 曲线（过冲回弹）、轨道换色用 base 时长；只动 transform / 颜色，全部走令牌。
 * 轨道 40×22、滑块 18：关 = 距左 2px，开 = 距左 20px（40 − 18 − 2）。减少动态效果下无过渡（globals.css）。
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors duration-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[18px] rounded-full bg-background shadow-sm ring-0 transition-transform duration-spring ease-spring data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0.5"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
