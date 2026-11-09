import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { OpsAutoRefresh } from "./auto-refresh";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

afterEach(() => {
  vi.useRealTimers();
  refresh.mockClear();
});

describe("OpsAutoRefresh（F21 轮询）", () => {
  it("有执行中记录：每 5 秒刷新一次（StrictMode 下也只保留一个定时器）", () => {
    vi.useFakeTimers();
    render(
      <StrictMode>
        <OpsAutoRefresh running />
      </StrictMode>,
    );
    expect(screen.getByTestId("ops-auto-refresh")).toHaveTextContent("每 5 秒自动刷新");
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("没有执行中记录：不渲染提示、不设定时器", () => {
    vi.useFakeTimers();
    const { container } = render(<OpsAutoRefresh running={false} />);
    expect(container).toBeEmptyDOMElement();
    vi.advanceTimersByTime(30_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("running 变 false：定时器被清理，不再刷新", () => {
    vi.useFakeTimers();
    const view = render(<OpsAutoRefresh running />);
    vi.advanceTimersByTime(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(<OpsAutoRefresh running={false} />);
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("卸载后定时器被清理", () => {
    vi.useFakeTimers();
    const view = render(<OpsAutoRefresh running />);
    view.unmount();
    vi.advanceTimersByTime(30_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
