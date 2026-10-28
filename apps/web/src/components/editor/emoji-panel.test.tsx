// @vitest-environment jsdom
/**
 * 表情面板（M10.8 Step 7）：工具栏「表情」→ 搜索 / 分类 / 最近使用 / 肤色 → 插入编辑区。
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { EditorShell } from "./editor-shell";

const hidden = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[name="source"]')!;

async function mount(initial = "") {
  const r = render(
    <EditorShell
      name="source"
      initialSource={initial}
      draftKey={null}
      restoreDraft={false}
      label="正文"
    />,
  );
  await screen.findByRole("toolbar", { name: "编辑工具栏" });
  return r;
}
const openPanel = async () => {
  await act(async () => {
    screen.getByRole("button", { name: "表情" }).click();
  });
  return screen.findByLabelText("搜索表情");
};

beforeEach(() => localStorage.clear());

describe("表情面板", () => {
  it("打开后默认在「笑脸与情绪」；点一个表情：插入正文并关闭面板", async () => {
    const { container } = await mount("好");
    await openPanel();
    expect(screen.getByRole("tab", { name: "笑脸与情绪" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.setup().click(screen.getByRole("gridcell", { name: "大笑" }));
    await waitFor(() => expect(hidden(container).value).toContain("😀"));
    await waitFor(() => expect(screen.queryByLabelText("搜索表情")).toBeNull());
  });

  it("搜索：按中文关键词出结果；无结果给提示", async () => {
    await mount();
    const input = await openPanel();
    await act(async () => {
      fireEvent.change(input, { target: { value: "点赞" } });
    });
    expect(screen.getByRole("gridcell", { name: "赞" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull(); // 搜索时隐藏分类页签
    await act(async () => {
      fireEvent.change(input, { target: { value: "zzzz不存在" } });
    });
    expect(screen.getByText("没有找到相关表情")).toBeInTheDocument();
  });

  it("分类页签：切到「食物饮料」显示食物", async () => {
    await mount();
    await openPanel();
    await userEvent.setup().click(screen.getByRole("tab", { name: "食物饮料" }));
    expect(screen.getByRole("gridcell", { name: "苹果" })).toBeInTheDocument();
    expect(screen.queryByRole("gridcell", { name: "大笑" })).toBeNull();
  });

  it("肤色：选中档位后手势带修饰符，非手势不变；偏好记住", async () => {
    const user = userEvent.setup();
    const { container } = await mount();
    await openPanel();
    await user.click(screen.getByRole("radio", { name: "中等肤色" }));
    await user.click(screen.getByRole("tab", { name: "手势与人物" }));
    await user.click(screen.getByRole("gridcell", { name: "赞" }));
    await waitFor(() => expect(hidden(container).value).toContain("👍\u{1F3FD}"));
    expect(localStorage.getItem("funwind:emoji:skin")).toBe("3");
  });

  it("最近使用：插入后再次打开出现「最近使用」页签并默认选中；置顶去重", async () => {
    const user = userEvent.setup();
    await mount();
    await openPanel();
    await user.click(screen.getByRole("gridcell", { name: "大笑" }));
    await waitFor(() => expect(screen.queryByLabelText("搜索表情")).toBeNull());
    // Radix 的 FocusScope 在关闭时用 setTimeout(0) 延后执行「关闭后聚焦」（这里是聚焦编辑器）；
    // 测试里紧接着重开会让这次延后的聚焦落在新弹层上、被当成「焦点在外面」而关掉——真人操作不会在 0ms 内重开
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await openPanel();
    expect(screen.getByRole("tab", { name: "最近使用" })).toHaveAttribute("aria-selected", "true");
    const grid = screen.getByRole("grid", { name: "最近使用" });
    expect(within(grid).getByRole("gridcell", { name: "😀" })).toBeInTheDocument();
  });

  it("Shift 点击：连续插入，面板不关", async () => {
    const { container } = await mount();
    await openPanel();
    const cell = screen.getByRole("gridcell", { name: "大笑" });
    await act(async () => {
      fireEvent.click(cell, { shiftKey: true });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("gridcell", { name: "开心" }), { shiftKey: true });
    });
    await waitFor(() => expect(hidden(container).value).toContain("😀"));
    expect(hidden(container).value).toContain("😃");
    expect(screen.getByLabelText("搜索表情")).toBeInTheDocument();
  });

  it("本地存储不可用时仍能插入（只是不记最近 / 肤色）", async () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      const { container } = await mount();
      await openPanel();
      await userEvent.setup().click(screen.getByRole("gridcell", { name: "大笑" }));
      await waitFor(() => expect(hidden(container).value).toContain("😀"));
    } finally {
      Storage.prototype.setItem = orig;
    }
  });
});

describe("行内图片（为 M10.9 的图片表情预留）", () => {
  it("文字中间的图片保持行内，Markdown 往返逐字不变", async () => {
    const src = "你好 ![表情](/emoji/134.gif) 再见";
    const { container } = await mount(src);
    await waitFor(() => expect(document.querySelector(".fw-rich-editor p img")).not.toBeNull());
    expect(document.querySelectorAll(".fw-rich-editor p")).toHaveLength(1);
    expect(hidden(container).value).toBe(src);
  });
});
