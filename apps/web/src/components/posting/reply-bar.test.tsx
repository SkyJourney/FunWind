// @vitest-environment jsdom
/**
 * 移动端回复固定条（M10.8 Step 8）：与回复区互斥、点击滚动并聚焦编辑器、键盘弹起时收起、减少动态效果。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyBar } from "./reply-bar";

type IoCallback = (entries: { isIntersecting: boolean }[]) => void;
let ioCallback: IoCallback | null = null;
let disconnected = false;

beforeEach(() => {
  ioCallback = null;
  disconnected = false;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IoCallback) {
        ioCallback = cb;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  );
  window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as never;
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mount() {
  const reply = document.createElement("section");
  reply.id = "reply";
  const box = document.createElement("div");
  box.setAttribute("role", "textbox");
  box.tabIndex = 0;
  reply.append(box);
  document.body.append(reply);
  const scroll = vi.fn();
  reply.scrollIntoView = scroll;
  const r = render(<ReplyBar />);
  return { ...r, reply, box, scroll };
}
const bar = () => screen.getByTestId("reply-bar");
const seeReply = (v: boolean) => act(() => ioCallback?.([{ isIntersecting: v }]));

describe("回复固定条", () => {
  it("回复区在视口内：收起且 inert；离开视口：滑出显示；再进入：再收起", () => {
    mount();
    expect(bar()).toHaveAttribute("inert");
    expect(bar()).toHaveAttribute("aria-hidden", "true");
    seeReply(false);
    expect(bar()).not.toHaveAttribute("inert");
    expect(bar().className).toContain("translate-y-0");
    seeReply(true);
    expect(bar()).toHaveAttribute("inert");
    expect(bar().className).toContain("translate-y-full");
  });

  it("点击：平滑滚到回复区并聚焦编辑器", () => {
    const { scroll, box } = mount();
    seeReply(false);
    fireEvent.click(screen.getByRole("button", { name: "写回复" }));
    expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(document.activeElement).toBe(box);
  });

  it("减少动态效果：直接跳转（不平滑）", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as never;
    const { scroll } = mount();
    seeReply(false);
    fireEvent.click(screen.getByRole("button", { name: "写回复" }));
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
  });

  it("编辑器稍后才创建：轮询直到能聚焦", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
    const { reply, box, scroll } = mount();
    box.remove(); // 编辑器尚未就绪
    seeReply(false);
    fireEvent.click(screen.getByRole("button", { name: "写回复" }));
    expect(scroll).toHaveBeenCalled();
    reply.append(box);
    await vi.advanceTimersByTimeAsync(50);
    expect(document.activeElement).toBe(box);
    vi.useRealTimers();
  });

  it("软键盘弹起（visualViewport 明显矮于窗口）：即使回复区不在视口也收起", () => {
    const listeners: (() => void)[] = [];
    const vv = {
      height: 800,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    };
    vi.stubGlobal("visualViewport", vv);
    window.visualViewport = vv as never;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    mount();
    seeReply(false);
    expect(bar()).not.toHaveAttribute("inert");
    vv.height = 400;
    act(() => listeners.forEach((fn) => fn()));
    expect(bar()).toHaveAttribute("inert");
    vv.height = 790;
    act(() => listeners.forEach((fn) => fn()));
    expect(bar()).not.toHaveAttribute("inert");
  });

  it("不支持 IntersectionObserver：一直显示（点击仍能到达回复区）", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    mount();
    expect(bar()).not.toHaveAttribute("inert");
  });

  it("卸载时断开观察器；页面没有回复区时不报错", () => {
    const { unmount } = mount();
    unmount();
    expect(disconnected).toBe(true);
    document.body.innerHTML = "";
    expect(() => render(<ReplyBar />)).not.toThrow();
  });
});
