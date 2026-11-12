// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmoothAnchors } from "./smooth-anchors";

/**
 * SmoothAnchors 单测（M16.1 Step 4 补齐 M16 残值）：reduce 分支是**点击时的 JS 参数分支**
 * （behavior auto + 不挂 fw-floor-hl-on），不能套弹层的 animationName 断言。
 * 滚动存档在点击前钉住（否则平滑滚动每一帧会把「点击前位置」刷成锚点位置）。
 */
const pinScrollAtCurrent = vi.hoisted(() => vi.fn());
vi.mock("./scroll-record", () => ({ pinScrollAtCurrent }));

const reduced = (matches: boolean) => {
  window.matchMedia = vi.fn().mockReturnValue({ matches }) as never;
};
const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

let scrollIntoView: ReturnType<typeof vi.fn<(arg?: ScrollIntoViewOptions) => void>>;
let pushState: ReturnType<typeof vi.fn<(data: unknown, unused: string, url?: string) => void>>;

beforeEach(() => {
  vi.useFakeTimers();
  pinScrollAtCurrent.mockClear();
  reduced(false);
  scrollIntoView = vi.fn<(arg?: ScrollIntoViewOptions) => void>();
  pushState = vi.fn<(data: unknown, unused: string, url?: string) => void>();
  Element.prototype.scrollIntoView = scrollIntoView;
  window.history.pushState = pushState;
  document.body.innerHTML = `
    <a id="jump" href="#floor-5">↩ 回复 #5</a>
    <a id="offsite" href="/t/9">站内链接</a>
    <a id="empty" href="#">空锚点</a>
    <a id="missing" href="#nope">目标不存在</a>
    <div id="floor-5" class="fw-floor">第五楼</div>
    <div id="floor-6" class="fw-floor">第六楼</div>
  `;
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const target = (id = "floor-5") => document.getElementById(id)!;
const link = (id = "jump") => document.getElementById(id)!;

describe("SmoothAnchors 点击路径", () => {
  it("拦截同页 hash：preventDefault + 平滑滚动 + pushState 写 hash + 挂高亮类", () => {
    render(<SmoothAnchors />);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      link().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(pushState).toHaveBeenCalledWith(null, "", "#floor-5");
    expect(target().classList.contains("fw-floor-hl-on")).toBe(true);
  });

  it("点击前先钉住滚动存档（否则平滑滚动会把点击前位置刷成锚点位置）", () => {
    render(<SmoothAnchors />);
    click(link());
    expect(pinScrollAtCurrent).toHaveBeenCalledTimes(1);
    // 钉住必须早于滚动：调用顺序有意义
    expect(pinScrollAtCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      scrollIntoView.mock.invocationCallOrder[0]!,
    );
  });

  it("高亮 2.1s 后自动摘除", () => {
    render(<SmoothAnchors />);
    click(link());
    expect(target().classList.contains("fw-floor-hl-on")).toBe(true);
    act(() => vi.advanceTimersByTime(2100));
    expect(target().classList.contains("fw-floor-hl-on")).toBe(false);
  });

  it("连点同目标：旧 timer 先清，新高亮不被旧 timer 提前掐断", () => {
    render(<SmoothAnchors />);
    click(link());
    act(() => vi.advanceTimersByTime(2000)); // 距首个 timer 到期只剩 100ms
    click(link()); // 重新挂高亮并重置计时
    act(() => vi.advanceTimersByTime(200)); // 旧 timer 若未清，这里就会摘掉
    expect(target().classList.contains("fw-floor-hl-on")).toBe(true);
    act(() => vi.advanceTimersByTime(1900)); // 新 timer 到期
    expect(target().classList.contains("fw-floor-hl-on")).toBe(false);
  });

  it("连点不同目标：旧目标高亮立即摘除，且再点回旧目标能重播（Step 4.5 修复）", () => {
    render(<SmoothAnchors />);
    const jump = link();
    jump.setAttribute("href", "#floor-5");
    click(jump);
    expect(target("floor-5").classList.contains("fw-floor-hl-on")).toBe(true);

    jump.setAttribute("href", "#floor-6");
    click(jump);
    expect(target("floor-6").classList.contains("fw-floor-hl-on")).toBe(true);
    // 旧目标必须被摘掉：否则类残留，再点回去时 classList.add 是 no-op、动画不重播
    expect(target("floor-5").classList.contains("fw-floor-hl-on")).toBe(false);

    jump.setAttribute("href", "#floor-5");
    click(jump);
    expect(target("floor-5").classList.contains("fw-floor-hl-on")).toBe(true); // 能重新挂上=能重播
    expect(target("floor-6").classList.contains("fw-floor-hl-on")).toBe(false);
    act(() => vi.advanceTimersByTime(2100));
    expect(target("floor-5").classList.contains("fw-floor-hl-on")).toBe(false);
  });
});

describe("SmoothAnchors reduce 降级", () => {
  it("reduce：瞬时跳转（behavior auto）且**不挂高亮类**", () => {
    reduced(true);
    render(<SmoothAnchors />);
    click(link());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(target().classList.contains("fw-floor-hl-on")).toBe(false);
    // 导航语义不受 reduce 影响：hash 照常写、存档照常钉
    expect(pushState).toHaveBeenCalledWith(null, "", "#floor-5");
    expect(pinScrollAtCurrent).toHaveBeenCalledTimes(1);
  });

  it("reduce 偏好在每次点击时实时读取", () => {
    render(<SmoothAnchors />);
    click(link());
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "smooth", block: "start" });
    reduced(true);
    click(link());
    expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: "auto", block: "start" });
  });
});

describe("SmoothAnchors 不越权拦截", () => {
  it.each([
    ["站内路径链接", "offsite"],
    ["空锚点 #", "empty"],
    ["目标不存在的锚点", "missing"],
  ])("%s：不拦截、不滚动、不写历史", (_label, id) => {
    render(<SmoothAnchors />);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      link(id).dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(pinScrollAtCurrent).not.toHaveBeenCalled();
  });

  it("非链接点击不处理", () => {
    render(<SmoothAnchors />);
    click(target());
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("SmoothAnchors 生命周期", () => {
  it("卸载后不再拦截点击，且清掉在跑的高亮 timer", () => {
    const { unmount } = render(<SmoothAnchors />);
    click(link());
    unmount();
    act(() => vi.advanceTimersByTime(3000)); // 不得抛「已卸载组件」相关异常
    scrollIntoView.mockClear();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      link().dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
