// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RichEditor } from "./rich-editor";

// 只替掉 useEditor：实例未就绪（返回 null）时的占位分支，正常路径由 editor-shell 系列用例覆盖
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return { ...actual, useEditor: () => null };
});

describe("RichEditor 初始占位（M16.1 Step 2）", () => {
  it("实例未就绪：给骨架脉冲而不是空白块（与源码模式 M16-D5 对称）", () => {
    const { container } = render(
      <RichEditor
        initialMarkdown=""
        onChange={vi.fn()}
        onReady={vi.fn()}
        label="正文"
        actions={null}
      />,
    );
    const busy = container.querySelector('[aria-busy="true"]');
    expect(busy).not.toBeNull();
    expect(busy!.className).toContain("min-h-48"); // 高度与原空白块一致，就绪时不跳布局
    const skeleton = busy!.querySelector('[data-slot="skeleton"]');
    expect(skeleton).not.toBeNull();
    expect(skeleton!.className).toContain("animate-pulse");
    // 未就绪时不渲染工具栏（避免点得到但编辑器还不存在）
    expect(screen.queryByRole("toolbar", { name: "编辑工具栏" })).toBeNull();
  });
});
