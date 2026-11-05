import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TokenSet } from "@/lib/theme/token-schema";
import { ContrastPanel } from "./contrast-panel";
import { contrastRows } from "./contrast-rows";

function mount(set?: TokenSet, mode: "light" | "dark" = "light") {
  const onJump = vi.fn();
  render(<ContrastPanel rows={contrastRows(mode, set)} onJump={onJump} />);
  return onJump;
}
const rows = () => screen.queryAllByTestId("contrast-row");
const ids = () => rows().map((row) => row.getAttribute("data-contrast-id"));
const toggle = () => screen.getByRole("button", { name: /^(显示全部|只看未达标)$/ });

describe("ContrastPanel：摘要与默认只列未达标", () => {
  it("默认浅色：一项未达标，只列这一行，写明比值（向下取整）和「来自默认主题」", () => {
    mount();
    expect(screen.getByRole("region", { name: "对比度检查" })).toBeInTheDocument();
    expect(
      screen.getByText(/^1 项未达标，共 18 项（需 ≥ 4\.5:1，只提示，不阻止保存）$/),
    ).toBeVisible();
    expect(ids()).toEqual(["primary-tint-bg"]);
    const [row] = rows();
    expect(within(row).getByText("4.48:1 未达标")).toBeInTheDocument();
    expect(within(row).getByText("来自默认主题")).toBeInTheDocument();
  });

  it("摘要里的总数取自传入的行数，不是写死的 18（未达标与全部达标两个分支）", () => {
    const failingRows = contrastRows("light", { colors: { foreground: "#f8fafc" } }).slice(0, 2);
    const { unmount } = render(<ContrastPanel rows={failingRows} onJump={vi.fn()} />);
    expect(screen.getByText(/^2 项未达标，共 2 项/)).toBeInTheDocument();
    unmount();
    render(<ContrastPanel rows={contrastRows("dark", undefined).slice(0, 3)} onJump={vi.fn()} />);
    expect(screen.getByText("3 项全部达标（≥ 4.5:1）")).toBeInTheDocument();
  });

  it("全部达标：摘要写明，没有列表", () => {
    mount(undefined, "dark");
    expect(screen.getByText("18 项全部达标（≥ 4.5:1）")).toBeInTheDocument();
    expect(rows()).toHaveLength(0);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(/未达标/)).toBeNull();
  });

  it("本包造成的未达标不标「来自默认主题」，默认主题自己的那项仍标", () => {
    mount({ colors: { foreground: "#f8fafc" } });
    expect(ids()).toEqual(["fg-bg", "fg-card", "primary-tint-bg"]);
    expect(screen.getByText(/^3 项未达标，共 18 项/)).toBeInTheDocument();
    expect(screen.getAllByText("来自默认主题")).toHaveLength(1);
    expect(within(rows()[0]).getByText("1.00:1 未达标")).toBeInTheDocument();
    expect(within(rows()[0]).queryByText("来自默认主题")).toBeNull();
  });
});

describe("ContrastPanel：显示全部", () => {
  it("展开 18 行再收回，按钮文字与 aria-expanded 跟着变", async () => {
    mount();
    expect(toggle()).toHaveTextContent("显示全部");
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle());
    expect(rows()).toHaveLength(18);
    expect(toggle()).toHaveTextContent("只看未达标");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle());
    expect(ids()).toEqual(["primary-tint-bg"]);
  });

  it("达标的行没有「未达标」和「来自默认主题」", async () => {
    mount(undefined, "dark");
    await userEvent.click(toggle());
    expect(rows()).toHaveLength(18);
    // 只看各行里面：切换按钮此时的文字是「只看未达标」，也含这三个字
    for (const row of rows()) {
      expect(row.textContent).not.toContain("未达标");
      expect(row.textContent).not.toContain("来自默认主题");
    }
    expect(within(rows()[0]).getByText(/^\d+\.\d{2}:1$/)).toBeInTheDocument();
  });
});

describe("ContrastPanel：定位按钮", () => {
  it("每行两个，名称带上整行的描述；点击带着对应的令牌键", async () => {
    const onJump = mount({ colors: { foreground: "#f8fafc" } });
    const [first] = rows();
    await userEvent.click(
      within(first).getByRole("button", { name: "正文文字 / 页面底：定位正文" }),
    );
    expect(onJump).toHaveBeenLastCalledWith("foreground");
    await userEvent.click(
      within(first).getByRole("button", { name: "正文文字 / 页面底：定位页面底" }),
    );
    expect(onJump).toHaveBeenLastCalledWith("background");
    expect(onJump).toHaveBeenCalledTimes(2);
  });

  it("展开全部后，所有按钮的可访问名称互不相同，都是 type=button，可见文字包含在名称里", async () => {
    mount();
    await userEvent.click(toggle());
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(18 * 2 + 1);
    const names = buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(new Set(names).size).toBe(names.length);
    for (const button of buttons) expect(button).toHaveAttribute("type", "button");
    // 「显示全部」没有 aria-label；定位按钮的名称必须包含它的可见文字（去掉「定位」二字后的颜色名）
    for (const button of buttons) {
      const label = button.getAttribute("aria-label");
      if (label) expect(label).toContain(button.textContent!.replace(/^定位/, ""));
    }
  });
});
