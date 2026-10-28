import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "./sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

/**
 * 弹层动画时长对齐动效令牌（M10.7 Step 5f，S4 §4）：tw-animate 的 animate-in / out 默认时长是 150ms，
 * 与令牌脱节；这里让遮罩 / 内容显式引用 --fw-dur-* 令牌（duration-fast / base / slow）。
 */
describe("弹层时长令牌", () => {
  it("Dialog：遮罩与内容都是 base 时长", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>t</DialogTitle>
          <DialogDescription>d</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass("duration-base");
    expect(document.querySelector('[data-slot="dialog-content"]')).toHaveClass("duration-base");
  });

  it("Sheet：遮罩 base；内容打开 slow（滑入）、关闭 fast（利落退出）", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>t</SheetTitle>
          <SheetDescription>d</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass("duration-base");
    const content = document.querySelector('[data-slot="sheet-content"]')!;
    expect(content).toHaveClass(
      "data-[state=open]:duration-slow",
      "data-[state=closed]:duration-fast",
    );
  });

  it("DropdownMenu：菜单是 fast 时长", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>x</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>a</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toHaveClass(
      "duration-fast",
    );
  });
});
