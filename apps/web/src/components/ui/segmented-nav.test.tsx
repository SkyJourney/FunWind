import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedNav } from "./segmented-nav";

// 站内 Link 在 jsdom 里没有 App Router 上下文：换成普通锚点，并阻止真实跳转
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...rest }: ComponentProps<"a"> & { href: string }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </a>
  ),
}));

const items = [
  { key: "threads", href: "/u/1", label: "主题 12" },
  { key: "replies", href: "/u/1?tab=replies", label: "回复 34" },
  { key: "likes", href: "/u/1?tab=likes", label: "赞 5" },
];
const setup = (activeKey = "threads") =>
  render(<SegmentedNav items={items} activeKey={activeKey} ariaLabel="用户内容" />);
const indicator = () => screen.getByTestId("segmented-indicator");

describe("SegmentedNav（Tab 滑动指示器，M10.7 Step 5c）", () => {
  it("语义仍是链接：导航地标 + aria-current 标出当前格", () => {
    setup("replies");
    expect(screen.getByRole("navigation", { name: "用户内容" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "回复 34" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "主题 12" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "回复 34" })).toHaveAttribute(
      "href",
      "/u/1?tab=replies",
    );
  });

  it("指示器按当前格定位（translateX = 序号 × (自身宽度 + 间隙)），宽度按格数等分；只动 transform", () => {
    setup("replies");
    expect(indicator().style.transform).toContain("calc(1 * (100% + 0.125rem))");
    // 宽度 = (容器 − 两侧内边距 − 间隙) / n（jsdom 会把除法规范化成乘法，这里只断言关键成分）
    expect(indicator().style.width).toMatch(/0\.33/);
    expect(indicator().style.width).toContain("100% - 0.25rem - 0.25rem");
    expect(indicator()).toHaveClass("transition-transform", "ease-spring", "duration-spring");
    expect(indicator()).toHaveAttribute("aria-hidden", "true");
  });

  it("点击即移动：不等服务端把 activeKey 换成新值", async () => {
    setup("threads");
    expect(indicator().style.transform).toContain("calc(0 *");
    await userEvent.click(screen.getByRole("link", { name: "赞 5" }));
    expect(indicator().style.transform).toContain("calc(2 *"); // 乐观移动
    // aria-current 仍以服务端的 activeKey 为准（导航提交前不改语义）
    expect(screen.getByRole("link", { name: "主题 12" })).toHaveAttribute("aria-current", "page");
  });

  it("导航提交（activeKey 变化）后以真实值为准，点击记录自动失效", async () => {
    const { rerender } = setup("threads");
    await userEvent.click(screen.getByRole("link", { name: "回复 34" }));
    rerender(<SegmentedNav items={items} activeKey="replies" ariaLabel="用户内容" />);
    expect(indicator().style.transform).toContain("calc(1 *");
    // 之后若真实值又回到点击前的 threads（如浏览器返回），不会被陈旧的点击记录劫持（真实缺陷的回归用例）
    rerender(<SegmentedNav items={items} activeKey="threads" ariaLabel="用户内容" />);
    expect(indicator().style.transform).toContain("calc(0 *");
  });

  it("当前格文字加粗，其余为弱化色", () => {
    setup("replies");
    expect(screen.getByRole("link", { name: "回复 34" })).toHaveClass(
      "font-semibold",
      "text-foreground",
    );
    expect(screen.getByRole("link", { name: "主题 12" })).toHaveClass("text-muted-foreground");
  });
});
