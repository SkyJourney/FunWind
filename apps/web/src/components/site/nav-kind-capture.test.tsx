import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NavKindCapture } from "./nav-kind-capture";

const mocks = vi.hoisted(() => ({ path: "/t/9", search: "", controller: { pop: vi.fn() } }));
vi.mock("next/navigation", () => ({
  usePathname: () => mocks.path,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("./motion-provider", () => ({ useSiteMotion: () => mocks.controller }));
const original = Object.getOwnPropertyDescriptor(window, "navigation");
let navigation: EventTarget;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.path = "/t/9";
  mocks.search = "";
  window.history.replaceState(null, "", "/t/9");
  navigation = new EventTarget();
  Object.defineProperty(window, "navigation", { configurable: true, value: navigation });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  if (original) Object.defineProperty(window, "navigation", original);
  else Reflect.deleteProperty(window, "navigation");
});
const traverse = (to: string, navigationType = "traverse") => {
  navigation.dispatchEvent(
    Object.assign(new Event("navigate"), {
      navigationType,
      destination: { url: new URL(to, window.location.href).href },
    }),
  );
};

describe("NavKindCapture（原来源、更新与卸载场景保留，方向改由宿主统一解析）", () => {
  it("popstate：将当前页到地址栏新地址委托宿主，不在捕获器内再算一套方向", () => {
    render(<NavKindCapture />);
    window.history.replaceState(null, "", "/f/3");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(mocks.controller.pop).toHaveBeenCalledWith("/t/9", "/f/3");
  });
  it("当前页随路径更新：提交到新页后再返回，以新页为起点", () => {
    const { rerender } = render(<NavKindCapture />);
    mocks.path = "/";
    rerender(<NavKindCapture />);
    window.history.replaceState(null, "", "/boards");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(mocks.controller.pop).toHaveBeenCalledWith("/", "/boards");
  });
  it("卸载后不再监听", () => {
    const { unmount } = render(<NavKindCapture />);
    unmount();
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(mocks.controller.pop).not.toHaveBeenCalled();
  });
});
it("traverse先捕获来源，即使Next在pop前已刷新React上下文也不认错来源；缓存只消费一次", () => {
  const { rerender } = render(<NavKindCapture />);
  act(() => {
    traverse("/a");
  });
  window.history.replaceState(null, "", "/a");
  mocks.path = "/a";
  rerender(<NavKindCapture />);
  act(() => {
    traverse("/a", "replace"); // Next恢复历史项写状态，不应擦掉traverse来源。
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(mocks.controller.pop).toHaveBeenCalledExactlyOnceWith("/t/9", "/a");
  window.history.replaceState(null, "", "/f/3");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(mocks.controller.pop).toHaveBeenLastCalledWith("/a", "/f/3");
});
it("没有Navigation API时使用捕获阶段的最后显示key作降级", () => {
  Reflect.deleteProperty(window, "navigation");
  render(<NavKindCapture />);
  window.history.replaceState(null, "", "/a");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(mocks.controller.pop).toHaveBeenCalledExactlyOnceWith("/t/9", "/a");
});
it("traverse只改变hash时来源和目标仍是同一pathname/search，不伪造页面切换", () => {
  mocks.path = "/a/901";
  mocks.search = "motion=1";
  window.history.replaceState(null, "", "/a/901?motion=1#old");
  render(<NavKindCapture />);
  act(() => {
    traverse("/a/901?motion=1#top");
  });
  window.history.replaceState(null, "", "/a/901?motion=1#top");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(mocks.controller.pop).toHaveBeenCalledWith("/a/901?motion=1", "/a/901?motion=1");
});
it("其它导航替代traverse时清除缓存，目的地不匹配也不能用旧来源", () => {
  const { rerender } = render(<NavKindCapture />);
  act(() => {
    traverse("/a");
    traverse("/boards", "push");
  });
  window.history.replaceState(null, "", "/boards");
  mocks.path = "/boards";
  rerender(<NavKindCapture />);
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(mocks.controller.pop).toHaveBeenLastCalledWith("/boards", "/boards");
  act(() => {
    traverse("/a");
  });
  window.history.replaceState(null, "", "/t/1");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(mocks.controller.pop).toHaveBeenLastCalledWith("/boards", "/t/1");
});
it("StrictMode安装/卸载监听对称，同一次pop只分派一次", () => {
  const { unmount } = render(
    <StrictMode>
      <NavKindCapture />
    </StrictMode>,
  );
  act(() => {
    traverse("/a");
  });
  window.history.replaceState(null, "", "/a");
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(mocks.controller.pop).toHaveBeenCalledOnce();
  unmount();
  act(() => {
    traverse("/t/1");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(mocks.controller.pop).toHaveBeenCalledOnce();
});
