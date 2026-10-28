import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "./switch";

describe("Switch（M10.7 Step 5d）", () => {
  it("role=switch + aria-checked，名称取自 aria-label；点击触发 onCheckedChange", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onChange} aria-label="新回复 · 站内通知" />);
    const sw = screen.getByRole("switch", { name: "新回复 · 站内通知" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("滑块走 spring 过渡（只动 transform）、轨道走 base 时长换色：关 = 距左 2px，开 = 20px", () => {
    const { rerender } = render(<Switch checked={false} aria-label="x" />);
    const thumb = () => document.querySelector('[data-slot="switch-thumb"]')!;
    expect(thumb()).toHaveClass("ease-spring", "duration-spring", "transition-transform");
    expect(thumb()).toHaveClass("data-[state=unchecked]:translate-x-0.5");
    expect(screen.getByRole("switch")).toHaveClass(
      "duration-base",
      "data-[state=checked]:bg-primary",
    );
    rerender(<Switch checked aria-label="x" />);
    expect(thumb()).toHaveAttribute("data-state", "checked");
    expect(thumb()).toHaveClass("data-[state=checked]:translate-x-5");
  });

  it("禁用时不可点击", async () => {
    const onChange = vi.fn();
    render(<Switch checked={false} disabled onCheckedChange={onChange} aria-label="x" />);
    await userEvent.click(screen.getByRole("switch"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
