import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BoardsSkeleton, FeedSkeleton, ListSkeleton, ReadingSkeleton } from "./page-skeletons";

const css = readFileSync(`${__dirname}/../app/globals.css`, "utf8");

describe("骨架占位条样式（.sk）", () => {
  it("必须有定义：此前 `sk` 类从未被定义，所有骨架屏的占位条都是透明的，用户只看到卡片边框", () => {
    expect(css).toMatch(/\n\.sk\s*\{/);
    // 有底色（不能是透明）与呼吸动画
    const rule = /\n\.sk\s*\{([^}]*)\}/.exec(css)![1]!;
    expect(rule).toMatch(/background-color:/);
    expect(rule).toMatch(/animation:/);
  });

  it("减少动态效果下占位条静止（明确决策）", () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.sk\s*\{\s*animation:\s*none/.test(
        css,
      );
    expect(reduced).toBe(true);
  });

  it("所有骨架组件都用 sk 类画占位条", () => {
    for (const ui of [
      <ListSkeleton key="l" />,
      <FeedSkeleton key="f" />,
      <ReadingSkeleton key="r" />,
      <BoardsSkeleton key="b" />,
    ]) {
      const { container, unmount } = render(ui);
      expect(container.querySelectorAll(".sk").length).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe("BoardsSkeleton（板块目录骨架，M10.7 站长反馈）", () => {
  it("静态标题「板块目录」直接显示，不等数据", () => {
    render(<BoardsSkeleton />);
    expect(screen.getByRole("heading", { level: 1, name: "板块目录" })).toBeInTheDocument();
  });

  it("「N 个板块 · N 个主题」一行有占位条；至少一个一级分区（标题条）与若干板块卡片占位", () => {
    const { container } = render(<BoardsSkeleton />);
    // 人数行：header 里的占位条
    expect(container.querySelectorAll("header .sk")).toHaveLength(1);
    // 分区标题条：带下分隔线的容器里
    expect(container.querySelectorAll("section > div > .border-b .sk")).toHaveLength(1);
    // 默认 4 张板块卡片占位
    expect(container.querySelectorAll("section .rounded-xl")).toHaveLength(4);
  });

  it("分区数与卡片数可配", () => {
    const { container } = render(<BoardsSkeleton sections={2} forums={3} />);
    expect(container.querySelectorAll("section > div")).toHaveLength(2);
    expect(container.querySelectorAll("section .rounded-xl")).toHaveLength(6);
  });

  it("容器宽度 / 间距与真实页面一致（max-w-5xl），避免数据到达时布局跳动", () => {
    const { container } = render(<BoardsSkeleton />);
    const main = container.querySelector("main")!;
    expect(main).toHaveClass("max-w-5xl", "space-y-6", "px-4", "py-8");
  });

  it("可访问性：aria-busy + 屏幕阅读器可读的「加载中」；占位条本身对读屏隐藏", () => {
    const { container } = render(<BoardsSkeleton />);
    expect(container.querySelector("main")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("加载中");
    expect(container.querySelector("section")).toHaveAttribute("aria-hidden", "true");
  });
});
