import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FadeImage } from "./fade-image";

/** jsdom 图片不真实加载：手动触发 load 事件（act 包裹确保 onLoad 状态落盘） */
function fireLoad(container: HTMLElement) {
  act(() => {
    container.querySelector("img")!.dispatchEvent(new Event("load"));
  });
}

describe("FadeImage（M16 Step 3 图片显影）", () => {
  beforeEach(() => {
    // jsdom 的 img 不加载：complete 恒 false（未缓存路径）
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("懒加载：未完成加载时隐藏（opacity-0），onLoad 后挂 fw-fade-in 淡入", () => {
    const { container } = render(<FadeImage src="/a.jpg" alt="图" className="w-10" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.className).toContain("opacity-0");
    expect(img.className).not.toContain("fw-fade-in");
    fireLoad(container);
    expect(img.className).toContain("fw-fade-in");
    expect(img.className).not.toContain("opacity-0");
    expect(img.className).toContain("w-10"); // 调用方尺寸类保留
    expect(img.className).toContain("bg-muted"); // 占位底色
  });

  it("eager（首屏 LCP 豁免）：直接可见、不懒加载、无任何显影类", () => {
    const { container } = render(<FadeImage src="/hero.jpg" alt="" eager />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("loading")).toBeNull();
    expect(img.className).not.toContain("opacity-0");
    expect(img.className).not.toContain("fw-fade-in");
  });

  it("缓存命中（挂载即 complete）：直接显示，不播动画", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    const { container } = render(<FadeImage src="/cached.jpg" alt="" />);
    const img = container.querySelector("img")!;
    expect(img.className).not.toContain("opacity-0");
    expect(img.className).not.toContain("fw-fade-in");
  });

  it("加载失败也显示（露出 alt/破图态，不无限隐藏）", () => {
    const { container } = render(<FadeImage src="/broken.jpg" alt="坏图" />);
    act(() => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img")!.className).not.toContain("opacity-0");
  });
});
