// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionStatus } from "./connection-status";

const toast = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));

const setOnline = (value: boolean) => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
};
const fire = (type: "online" | "offline") =>
  act(() => {
    window.dispatchEvent(new Event(type));
  });

beforeEach(() => {
  vi.clearAllMocks();
  setOnline(true);
});
afterEach(() => setOnline(true));

describe("ConnectionStatus（M16.1 Step 3）", () => {
  it("首次进站在线：不提示（不能平白喊「网络已恢复」）", () => {
    render(<ConnectionStatus />);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("断网：常驻提示（duration Infinity）且带固定 id，便于恢复时精确撤下", () => {
    render(<ConnectionStatus />);
    setOnline(false);
    fire("offline");
    expect(toast.warning).toHaveBeenCalledWith(
      "网络已断开",
      expect.objectContaining({ id: "fw-connection", duration: Infinity }),
    );
  });

  it("恢复：撤掉断网提示并确认一次", () => {
    render(<ConnectionStatus />);
    setOnline(false);
    fire("offline");
    setOnline(true);
    fire("online");
    expect(toast.dismiss).toHaveBeenCalledWith("fw-connection");
    expect(toast.success).toHaveBeenCalledWith("网络已恢复", expect.anything());
  });

  it("进站即离线：也要提示（不是只有「中途断网」才管）", () => {
    setOnline(false);
    render(<ConnectionStatus />);
    expect(toast.warning).toHaveBeenCalledWith("网络已断开", expect.anything());
  });

  it("反复断网/恢复：提示不堆积（同一 id 复用，恢复确认每次一条）", () => {
    render(<ConnectionStatus />);
    for (let i = 0; i < 3; i += 1) {
      setOnline(false);
      fire("offline");
      setOnline(true);
      fire("online");
    }
    expect(toast.warning).toHaveBeenCalledTimes(3);
    expect(toast.success).toHaveBeenCalledTimes(3);
    for (const call of toast.warning.mock.calls)
      expect(call[1]).toMatchObject({ id: "fw-connection" });
  });

  it("卸载后不再响应网络事件（监听对称清理）", () => {
    const { unmount } = render(<ConnectionStatus />);
    unmount();
    setOnline(false);
    fire("offline");
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
