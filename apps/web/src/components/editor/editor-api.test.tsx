// @vitest-environment jsdom
/**
 * 两种编辑器交出的插入能力（M6.4d2）：挂载时交出，卸载时收回（null）；插入后内容正确；isComposing 反映输入法状态。
 */
import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SourceEditor from "./source-editor";
import { RichEditor } from "./rich-editor";
import type { InsertApi } from "./insert-api";

describe("RichEditor 插入能力", () => {
  it("挂载后交出能力；插入图片节点并序列化为 Markdown；卸载时收回", async () => {
    const onApi = vi.fn<(api: InsertApi | null) => void>();
    const onChange = vi.fn();
    const { unmount } = render(
      <RichEditor initialMarkdown="正文" onChange={onChange} onApi={onApi} label="正文" />,
    );
    await vi.waitFor(() =>
      expect(onApi).toHaveBeenCalledWith(
        expect.objectContaining({ insertImage: expect.any(Function) }),
      ),
    );
    const api = onApi.mock.calls.find((c) => c[0] !== null)![0]!;
    expect(api.isComposing()).toBe(false);
    await act(async () => api.insertImage("/files/ab/cd/x.png"));
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining("/files/ab/cd/x.png"));
    unmount();
    expect(onApi).toHaveBeenLastCalledWith(null);
  });
});

describe("SourceEditor 插入能力", () => {
  it("在光标处插入 Markdown 图片语法；卸载时收回", async () => {
    const onApi = vi.fn<(api: InsertApi | null) => void>();
    const onChange = vi.fn();
    const { unmount } = render(
      <SourceEditor initialMarkdown="甲乙" onChange={onChange} onApi={onApi} label="正文" />,
    );
    const api = onApi.mock.calls.find((c) => c[0] !== null)![0]!;
    expect(api.isComposing()).toBe(false);
    act(() => api.insertImage("/files/ab/cd/y.png"));
    // 光标默认在文档开头：图片插入在光标处，原文保留
    expect(onChange).toHaveBeenLastCalledWith("![](/files/ab/cd/y.png)甲乙");
    unmount();
    expect(onApi).toHaveBeenLastCalledWith(null);
  });
});
