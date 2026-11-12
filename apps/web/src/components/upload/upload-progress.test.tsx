// @vitest-environment jsdom
import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UploadProgress, useUploadProgress } from "./upload-progress";

describe("UploadProgress（M16.1 Step 1）", () => {
  it("上行中：显示真实百分比，progressbar 带 aria-valuenow", () => {
    render(<UploadProgress value={{ loaded: 45, total: 100 }} label="附件上传" />);
    const bar = screen.getByRole("progressbar", { name: "附件上传进度" });
    expect(bar).toHaveAttribute("aria-valuenow", "45");
    expect(screen.getByText("45%")).toBeInTheDocument();
  });

  it("上行完成（loaded>=total）：切不定态「处理中…」，不再显示会误导的 100%", () => {
    render(<UploadProgress value={{ loaded: 100, total: 100 }} label="附件上传" />);
    const bar = screen.getByRole("progressbar", { name: "附件上传：服务端处理中" });
    // 不定态：不报具体值（读屏不会念「100%」却迟迟不结束）
    expect(bar).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("处理中…")).toBeInTheDocument();
    expect(screen.queryByText("100%")).toBeNull();
  });

  it("百分比四舍五入且封顶 100（total 含 multipart 开销，loaded 可能略超）", () => {
    const { rerender } = render(<UploadProgress value={{ loaded: 1, total: 3 }} />);
    expect(screen.getByText("33%")).toBeInTheDocument();
    rerender(<UploadProgress value={{ loaded: 120, total: 100 }} />);
    expect(screen.getByText("处理中…")).toBeInTheDocument();
  });

  it("total 为 0（总长未知）：不除零、不报 NaN，停在 0%", () => {
    render(<UploadProgress value={{ loaded: 0, total: 0 }} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  it("宽度是布局型过渡：必须带 motion-reduce 归零（motion-spec §6 第 6 条）", () => {
    const { container } = render(<UploadProgress value={{ loaded: 30, total: 100 }} />);
    const fill = container.querySelector<HTMLElement>("[role='progressbar'] > div")!;
    expect(fill.className).toContain("motion-reduce:transition-none");
    expect(fill.style.width).toBe("30%");
  });
});

describe("useUploadProgress", () => {
  it("初始无进度；onProgress 写入；resetProgress 清空", () => {
    const { result } = renderHook(() => useUploadProgress());
    expect(result.current.progress).toBeNull();
    act(() => result.current.onProgress(10, 40));
    expect(result.current.progress).toEqual({ loaded: 10, total: 40 });
    act(() => result.current.resetProgress());
    expect(result.current.progress).toBeNull();
  });

  it("回调引用稳定：透传给 uploadFile 不会因重渲染而换函数", () => {
    const { result, rerender } = renderHook(() => useUploadProgress());
    const first = result.current.onProgress;
    act(() => result.current.onProgress(1, 2));
    rerender();
    expect(result.current.onProgress).toBe(first);
  });
});
