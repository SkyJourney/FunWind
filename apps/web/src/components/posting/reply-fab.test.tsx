// @vitest-environment jsdom
/**
 * 移动端回复悬浮按钮（M10.8 Step 8）：与回复区互斥、点击滚动并聚焦编辑器、键盘弹起时收起、减少动态效果。
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplyFab } from "./reply-fab";

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
  const r = render(<ReplyFab />);
  return { ...r, reply, box, scroll };
}
const bar = () => screen.getByTestId("reply-fab");
const seeReply = (v: boolean) => act(() => ioCallback?.([{ isIntersecting: v }]));

describe("回复悬浮按钮", () => {
  it("回复区在视口内：隐藏且 inert；离开视口：显示；再进入：再隐藏", () => {
    mount();
    expect(bar()).toHaveAttribute("inert");
    expect(bar()).toHaveAttribute("aria-hidden", "true");
    seeReply(false);
    expect(bar()).not.toHaveAttribute("inert");
    expect(bar().className).toContain("scale-100");
    seeReply(true);
    expect(bar()).toHaveAttribute("inert");
    expect(bar().className).toContain("scale-50");
  });

  it("点击：跳到回复区并立即聚焦编辑器（仍在用户手势内，iOS 才能唤起软键盘）", () => {
    const { scroll, box } = mount();
    seeReply(false);
    fireEvent.click(bar());
    expect(scroll).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(document.activeElement).toBe(box);
  });

  it("编辑器稍后才创建：轮询直到能聚焦", async () => {
    const { reply, box } = mount();
    box.remove(); // 编辑器尚未就绪
    seeReply(false);
    fireEvent.click(bar());
    reply.append(box);
    await vi.waitFor(() => expect(document.activeElement).toBe(box));
  });

  it("软键盘弹起（visualViewport 明显矮于窗口）：即使回复区不在视口也隐藏", () => {
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

  it("按钮本身：圆形、无整行背景层（回归：固定条的背景层遮挡浏览）", () => {
    mount();
    seeReply(false);
    expect(bar().tagName).toBe("BUTTON");
    expect(bar().className).toContain("rounded-full");
    expect(bar().className).toContain("size-12");
    expect(bar().className).not.toMatch(/inset-x-0|backdrop-blur|border-t/);
    expect(bar()).toHaveAccessibleName("回复本帖");
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
    expect(() => render(<ReplyFab />)).not.toThrow();
  });
});
