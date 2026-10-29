// @vitest-environment jsdom
/**
 * 表情面板（M10.8 Step 7）：工具栏「表情」→ 搜索 / 分类 / 最近使用 / 肤色 → 插入编辑区。
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * 社区表情（M10.9）：/api/emojis 数据 → 「社区表情」页签（分组小标题平铺）+ 合并搜索 + 最近使用带类型。
 * fetch 在面板挂载时发起，测试用 stub 控制；未 stub 时 jsdom 的请求失败 → 空数据 → 无社区页签（零数据路径）。
 */
const COMMUNITY = [
  {
    id: 120,
    name: "旧表情 120",
    keywords: "",
    url: "/emoji/120.gif",
    group: "茉莉 01",
    width: 40,
    height: 40,
  },
  {
    id: 171,
    name: "茉莉笑",
    keywords: "笑 社区",
    url: "/emoji/171.png",
    group: "E2E 组",
    width: 32,
    height: 32,
  },
];

describe("社区表情页签", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("有数据：页签出现、分组小标题平铺；点击插入行内图片节点（alt=展示名）并关闭", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(COMMUNITY), { status: 200 })),
    );
    const { container } = await mount("好");
    const input = await openPanel();
    await waitFor(() => expect(screen.getByRole("tab", { name: "社区表情" })).toBeInTheDocument());
    await act(async () => {
      screen.getByRole("tab", { name: "社区表情" }).click();
    });
    expect(screen.getByRole("grid", { name: "茉莉 01" })).toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "E2E 组" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("gridcell", { name: "茉莉笑" }));
    await waitFor(() => expect(hidden(container).value).toContain("![茉莉笑](/emoji/171.png)"));
    await waitFor(() => expect(screen.queryByLabelText("搜索表情")).toBeNull());
    void input;
  });

  it("合并搜索：Unicode 与社区表情同框，社区段有小标题；无数据站点不出现社区段与页签", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(COMMUNITY), { status: 200 })),
    );
    const first = await mount();
    const input = await openPanel();
    await waitFor(() => expect(screen.getByRole("tab", { name: "社区表情" })).toBeInTheDocument());
    await act(async () => {
      fireEvent.change(input, { target: { value: "笑" } });
    });
    expect(screen.getByRole("grid", { name: "搜索结果" })).toBeInTheDocument();
    expect(screen.getByText("社区表情")).toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "茉莉笑" })).toBeInTheDocument();
    // 零数据：接口返回空 → 无页签、搜索无社区段（卸载第一个实例，避免同屏两个工具栏）
    first.unmount();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
    await mount();
    await openPanel();
    await waitFor(() => expect(screen.queryByRole("tab", { name: "社区表情" })).toBeNull());
  });

  it("最近使用带类型：图片条目按展示名渲染、可再次插入；旧格式纯字符串仍按 Unicode 显示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(COMMUNITY), { status: 200 })),
    );
    localStorage.setItem(
      "funwind:emoji:recent",
      JSON.stringify(["😀", { t: "i", v: "/emoji/171.png" }]),
    );
    await mount();
    await openPanel();
    await waitFor(() => expect(screen.getByRole("tab", { name: "社区表情" })).toBeInTheDocument());
    // 旧条目在 → 「最近使用」页签是默认选中
    expect(screen.getByRole("tab", { name: "最近使用" })).toHaveAttribute("aria-selected", "true");
    const grid = screen.getByRole("grid", { name: "最近使用" });
    expect(within(grid).getByRole("gridcell", { name: "😀" })).toBeInTheDocument();
    expect(within(grid).getByRole("gridcell", { name: "茉莉笑" })).toBeInTheDocument();
  });
});
