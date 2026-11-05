import { afterEach, describe, expect, it, vi } from "vitest";
import { jumpToTokenRow } from "./jump-to-row";

const realGetComputedStyle = globalThis.getComputedStyle;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mount() {
  document.body.innerHTML = `
    <div id="root">
      <div data-token-key="primary-foreground"><input type="text" id="pf-input" /><button id="pf-btn">恢复继承</button></div>
      <div data-token-key="primary"><button id="p-btn">覆盖</button></div>
      <div data-token-key="foreground"><span>没有可聚焦的东西</span></div>
    </div>
    <div id="sticky"></div>`;
  const q = (id: string) => document.getElementById(id)!;
  const row = (key: string) => document.querySelector<HTMLElement>(`[data-token-key="${key}"]`)!;
  return { root: q("root"), sticky: q("sticky"), q, row };
}

/** 让 sticky 元素的计算样式 position 是指定值，其余元素用真实的 */
function stickyIs(sticky: HTMLElement, position: string) {
  vi.stubGlobal("getComputedStyle", (element: Element) =>
    element === sticky ? ({ position } as CSSStyleDeclaration) : realGetComputedStyle(element),
  );
}

/** 给定吸顶区下沿与行上沿（视口坐标），jsdom 自己不排版 */
function layout(sticky: HTMLElement, row: HTMLElement, stickyBottom: number, rowTop: number) {
  sticky.getBoundingClientRect = () => ({ bottom: stickyBottom }) as DOMRect;
  row.getBoundingClientRect = () => ({ top: rowTop }) as DOMRect;
}

describe("jumpToTokenRow：找行与聚焦", () => {
  it("找不到行或没有根节点：返回 false，什么都不做", () => {
    const { root } = mount();
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    expect(jumpToTokenRow(root, "no-such-key", null)).toBe(false);
    expect(jumpToTokenRow(null, "primary", null)).toBe(false);
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("键必须整串相等：找 primary 不会落到排在前面的 primary-foreground 上", () => {
    const { root, q } = mount();
    expect(jumpToTokenRow(root, "primary", null)).toBe(true);
    expect(q("p-btn")).toHaveFocus();
    expect(q("pf-input")).not.toHaveFocus();
  });

  it("行里有文本框（已覆盖）：聚焦文本框，不是后面的按钮", () => {
    const { root, q } = mount();
    jumpToTokenRow(root, "primary-foreground", null);
    expect(q("pf-input")).toHaveFocus();
  });

  it("行里只有按钮（继承）：聚焦按钮", () => {
    const { root, q } = mount();
    jumpToTokenRow(root, "primary", null);
    expect(q("p-btn")).toHaveFocus();
  });

  it("行里没有可聚焦的东西：照样返回 true，焦点不动", () => {
    const { root } = mount();
    expect(jumpToTokenRow(root, "foreground", null)).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("聚焦时不让浏览器再滚一次（滚动已经由 scrollIntoView 和修正做完）", () => {
    const { root, q } = mount();
    const focus = vi.spyOn(q("p-btn"), "focus");
    jumpToTokenRow(root, "primary", null);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("滚到视口中间，用 instant（量位置前不能还在平滑滚动中）", () => {
    const { root, row } = mount();
    const scroll = vi.fn();
    row("primary").scrollIntoView = scroll;
    jumpToTokenRow(root, "primary", null);
    expect(scroll).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
  });
});

describe("jumpToTokenRow：吸顶预览挡住行时再往下挪", () => {
  it("行的上沿在吸顶区下沿之上：多滚 覆盖量 + 8px", () => {
    const { root, sticky, row } = mount();
    stickyIs(sticky, "sticky");
    layout(sticky, row("primary"), 300, 100);
    const by = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    jumpToTokenRow(root, "primary", sticky);
    expect(by).toHaveBeenCalledWith({ top: -208, behavior: "instant" });
  });

  it("只遮住 5px 也挪：多滚 5 + 8px", () => {
    const { root, sticky, row } = mount();
    stickyIs(sticky, "sticky");
    layout(sticky, row("primary"), 300, 295);
    const by = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    jumpToTokenRow(root, "primary", sticky);
    expect(by).toHaveBeenCalledWith({ top: -13, behavior: "instant" });
  });

  it.each([
    ["行在吸顶区下面", 300, 400],
    ["行的上沿恰好贴着吸顶区下沿", 300, 300],
  ])("%s：不挪", (_name, stickyBottom, rowTop) => {
    const { root, sticky, row } = mount();
    stickyIs(sticky, "sticky");
    layout(sticky, row("primary"), stickyBottom, rowTop);
    const by = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    jumpToTokenRow(root, "primary", sticky);
    expect(by).not.toHaveBeenCalled();
  });

  it("吸顶区当前不是 sticky（小屏）：不量不挪", () => {
    const { root, sticky, row } = mount();
    stickyIs(sticky, "static");
    layout(sticky, row("primary"), 300, 100);
    const by = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    jumpToTokenRow(root, "primary", sticky);
    expect(by).not.toHaveBeenCalled();
  });

  it("没有吸顶区：不挪", () => {
    const { root } = mount();
    const by = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    jumpToTokenRow(root, "primary", null);
    expect(by).not.toHaveBeenCalled();
  });

  it("顺序：先滚到中间，再按量好的位置修正，最后聚焦", () => {
    const { root, sticky, row, q } = mount();
    stickyIs(sticky, "sticky");
    layout(sticky, row("primary-foreground"), 300, 100);
    const order: string[] = [];
    row("primary-foreground").scrollIntoView = vi.fn(() => void order.push("滚动"));
    vi.spyOn(window, "scrollBy").mockImplementation(() => void order.push("修正"));
    vi.spyOn(q("pf-input"), "focus").mockImplementation(() => void order.push("聚焦"));
    jumpToTokenRow(root, "primary-foreground", sticky);
    expect(order).toEqual(["滚动", "修正", "聚焦"]);
  });
});
