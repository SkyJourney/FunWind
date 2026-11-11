// @vitest-environment jsdom
/**
 * 引擎状态级 VT 驱动单测（M15 Step 3）：降级（无 API / reduce）、data-vt 选型、
 * 扩散圆心写入/清理、并发守卫。断言口径与旧助手一致：属性在快照回调期间就位，结束后清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playStateTransition, prefersReducedMotion, supportsViewTransition } from "./native";

type VTStub = { during: { vt: string; x: string; y: string }[] };

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

describe("playStateTransition", () => {
  it("无 API：直接执行 update，不设 data-vt；supportsViewTransition 为 false", async () => {
    setReduced(false);
    expect(supportsViewTransition()).toBe(false);
    const update = vi.fn();
    await playStateTransition(update, { kind: "expand", origin: { x: 1, y: 2 } });
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("显式 reducedMotion=true：装了 API 也直接执行 update", async () => {
    installVT();
    const update = vi.fn();
    await playStateTransition(update, { kind: "expand", reducedMotion: true });
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("matchMedia reduce：prefersReducedMotion 为 true 且降级不阻塞", async () => {
    setReduced(true);
    installVT();
    expect(prefersReducedMotion()).toBe(true);
    const update = vi.fn();
    await playStateTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("支持 VT：快照期间 data-vt=fade 且 update 已执行，结束后清理", async () => {
    setReduced(false);
    const stub = installVT();
    expect(supportsViewTransition()).toBe(true);
    let ran = false;
    await playStateTransition(() => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(stub.during).toEqual([{ vt: "fade", x: "", y: "" }]);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("expand：圆心在快照期间写入 --vt-x/--vt-y，结束后清理", async () => {
    setReduced(false);
    const stub = installVT();
    await playStateTransition(() => {}, { kind: "expand", origin: { x: 120, y: 80 } });
    expect(stub.during[0]).toEqual({ vt: "expand", x: "120px", y: "80px" });
    expect(document.documentElement.style.getPropertyValue("--vt-x")).toBe("");
  });

  it("较早的过渡结束不会清除较新过渡的状态", async () => {
    setReduced(false);
    const finish: Array<() => void> = [];
    (document as unknown as { startViewTransition?: unknown }).startViewTransition = (
      cb: () => void,
    ) => {
      cb();
      return { finished: new Promise<void>((resolve) => finish.push(resolve)) };
    };
    const first = playStateTransition(() => {}, { kind: "fade" });
    const second = playStateTransition(() => {}, { kind: "expand", origin: { x: 5, y: 6 } });
    finish[0]!();
    await first;
    expect(document.documentElement.dataset.vt).toBe("expand");
    expect(document.documentElement.style.getPropertyValue("--vt-x")).toBe("5px");
    finish[1]!();
    await second;
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });
});
