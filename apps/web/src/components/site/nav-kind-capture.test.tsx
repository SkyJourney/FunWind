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
  const event = Object.assign(new Event("navigate"), {
    navigationType,
    destination: { url: new URL(to, window.location.href).href },
    // jsdom 无 Navigation API：intercept 以 spy 代替（同站遍历会被组件调用）
    intercept: vi.fn(),
  });
  navigation.dispatchEvent(event);
  return event as Event & { intercept: ReturnType<typeof vi.fn> };
};

/** 安装 startViewTransition 探针：记录 update 执行与当时的 data-vt，finished 立即兑现 */
const stubStartViewTransition = () => {
  const calls: { updateRan: boolean; vtDuringUpdate: string | undefined }[] = [];
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: (update: () => Promise<void> | void) => {
      const call = { updateRan: false, vtDuringUpdate: undefined as string | undefined };
      calls.push(call);
      return {
        finished: Promise.resolve(update?.()).then(() => {
          call.updateRan = true;
          call.vtDuringUpdate = document.documentElement.dataset.vt;
        }),
      };
    },
  });
  return calls;
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

describe("M16 Step 2：返回键动画与滚动恢复", () => {
  const setScrollY = (value: number) =>
    Object.defineProperty(window, "scrollY", { configurable: true, value });

  let originalScrollY: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalScrollY = Object.getOwnPropertyDescriptor(window, "scrollY");
  });
  afterEach(() => {
    if (originalScrollY) Object.defineProperty(window, "scrollY", originalScrollY);
    document.body.innerHTML = "";
  });

  it("同站 traverse：intercept 被调用，update 前置 data-vt=fade、popstate 提交后清除", async () => {
    const calls = stubStartViewTransition();
    render(<NavKindCapture />);
    const event = traverse("/a");
    expect(event.intercept).toHaveBeenCalledTimes(1);
    // jsdom 不会自动调起 intercept 的 handler：手动驱动（真实浏览器由浏览器调起）。
    // handler 同步置位 data-vt，随后等待 popstate（遍历提交）。
    const handler = (event.intercept.mock.calls[0]![0] as { handler: () => Promise<void> }).handler;
    let running!: Promise<void>;
    act(() => {
      running = handler();
    });
    expect(document.documentElement.dataset.vt).toBe("fade");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await act(async () => {
      await running;
    });
    expect(calls[0]!.updateRan).toBe(true);
    expect(calls[0]!.vtDuringUpdate).toBe("fade");
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("跨站 traverse 不拦截（intercept 未调用，不置 data-vt）", () => {
    render(<NavKindCapture />);
    const event = Object.assign(new Event("navigate"), {
      navigationType: "traverse",
      destination: { url: "https://evil.example.com/page" },
      intercept: vi.fn(),
    });
    navigation.dispatchEvent(event);
    expect(event.intercept).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("点击捕获快照取最大值（UA 上滚不覆盖用户更深位置），pop 后按到达页恢复", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    setScrollY(800);
    document.body.innerHTML = '<a id="link" href="/t/9">正文链接</a><a id="top" href="/">顶部</a>';
    render(<NavKindCapture />);
    // 用户在 /t/9 滚到 800 后点击列表链接：快照取 max(已有 0, 800) = 800 + 锁
    act(() => {
      document
        .getElementById("link")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    // 软导航 push（Next 提交时的滚顶与 replace 记账）不得覆盖快照
    setScrollY(0);
    act(() => {
      traverse("/f/109", "push");
    });
    act(() => {
      traverse("/f/109", "replace");
    });
    // 返回：到达页 = /t/9，恢复其记录 800
    window.history.replaceState(null, "", "/t/9");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 800));
  });

  it("到达页无记录（首次访问）不恢复；replace 记账不写快照", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    setScrollY(72); // Next 滚顶后的残值
    document.body.innerHTML = '<a id="link" href="/f/109">列表链接</a>';
    render(<NavKindCapture />); // 当前页 /t/9
    // replace 记账派发：永不写快照
    act(() => {
      traverse("/f/109", "replace");
    });
    // 返回到 /f/109（无记录）：不恢复
    window.history.replaceState(null, "", "/f/109");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await vi.waitFor(() => expect(scrollTo).not.toHaveBeenCalled());
    // 同一 replace 派发期间滚动记录未被污染（/f/109 无条目，/t/9 保留原值）
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
