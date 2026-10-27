// @vitest-environment jsdom
/**
 * View Transitions 助手单测（S4）：降级路径（无 API / reduce）与 data-vt 选型、扩散圆心写入/清理。
 * 断言口径：属性在「快照回调执行期间」必须就位（动画读取的是这个时点），结束后被助手清理。
 * 真实过渡表现由 /design/motion 演示页人工验收（E2E 不测视觉动效）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureTransitionOrigin, withViewTransition } from "./view-transition";

type VTSnapshot = { vt: string; x: string; y: string };
type VTStub = { during: VTSnapshot[] };

function installVT(): VTStub {
  const stub: VTStub = { during: [] };
  (document as unknown as { startViewTransition?: unknown }).startViewTransition = (
    cb: () => Promise<void> | void,
  ) => {
    const root = document.documentElement;
    stub.during.push({
      vt: root.dataset.vt ?? "",
      x: root.style.getPropertyValue("--vt-x"),
      y: root.style.getPropertyValue("--vt-y"),
    });
    return { finished: Promise.resolve(cb()).then(() => {}) };
  };
  return stub;
}

function setReduced(reduced: boolean) {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: reduced }) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  delete document.documentElement.dataset.vt;
  document.documentElement.style.removeProperty("--vt-x");
  document.documentElement.style.removeProperty("--vt-y");
});

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  vi.restoreAllMocks();
});

describe("withViewTransition", () => {
  it("无 startViewTransition：直接执行 update（降级不阻塞，不设 data-vt）", async () => {
    setReduced(false);
    const update = vi.fn();
    await withViewTransition(update, "push");
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("prefers-reduced-motion：安装了 VT API 也直接执行 update", async () => {
    setReduced(true);
    installVT();
    const update = vi.fn();
    await withViewTransition(update, "expand");
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("支持 VT：快照回调期间 data-vt=push 且 update 已执行；结束后 data-vt 清除", async () => {
    setReduced(false);
    const stub = installVT();
    let ran = false;
    await withViewTransition(() => {
      ran = true;
    }, "push");
    expect(ran).toBe(true);
    expect(stub.during).toEqual([{ vt: "push", x: "", y: "" }]);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("expand：显式圆心在快照期间写入 --vt-x/--vt-y，结束后清理", async () => {
    setReduced(false);
    const stub = installVT();
    await withViewTransition(() => {}, "expand", { x: 120, y: 80 });
    expect(stub.during[0]).toEqual({ vt: "expand", x: "120px", y: "80px" });
    expect(document.documentElement.style.getPropertyValue("--vt-x")).toBe("");
  });

  it("expand：captureTransitionOrigin 的指针位置作圆心，且一次性消费", async () => {
    setReduced(false);
    const stub = installVT();
    captureTransitionOrigin(10, 20);
    await withViewTransition(() => {}, "expand");
    expect(stub.during[0]?.x).toBe("10px");
    await withViewTransition(() => {}, "expand");
    expect(stub.during[1]?.x).toBe("");
  });
});
