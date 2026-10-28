// @vitest-environment jsdom
/**
 * 工具栏命令（M6.3 第 2 步）：每个按钮都要真正改变编辑器的状态或内容。
 * 通过外壳的隐藏字段（即提交给服务端的 Markdown）与按钮的按下状态来验证。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorShell } from "./editor-shell";
import { editorExtensions } from "./markdown/extensions";
import { normalizeHref } from "./toolbar";

const hidden = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>('input[name="source"]')!;
const press = async (name: string) => {
  await act(async () => {
    screen.getByRole("button", { name }).click();
  });
};

async function mount(initial = "") {
  const rendered = render(
    <EditorShell
      name="source"
      initialSource={initial}
      draftKey={null}
      restoreDraft={false}
      label="正文"
    />,
  );
  await screen.findByRole("toolbar", { name: "编辑工具栏" });
  return rendered;
}

describe("工具栏：格式按钮切换按下状态", () => {
  it.each(["加粗", "斜体", "删除线", "无序列表", "有序列表", "引用", "代码块"])(
    "%s 可切换",
    async (name) => {
      await mount();
      expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
      await press(name);
      await waitFor(() =>
        expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true"),
      );
    },
  );
});

describe("工具栏：插入类按钮改变 Markdown", () => {
  it("插入表格：Markdown 中出现表格分隔行", async () => {
    const { container } = await mount();
    await press("插入表格");
    await waitFor(() => expect(hidden(container).value).toMatch(/\|\s*-{3,}\s*\|/));
  });

  it("分隔线：Markdown 中出现 ---", async () => {
    const { container } = await mount("上文");
    await press("分隔线");
    await waitFor(() => expect(hidden(container).value).toContain("---"));
  });
});

describe("工具栏：撤销与重做", () => {
  it("初始不可撤销；插入表格后可撤销，撤销后表格消失", async () => {
    const { container } = await mount();
    expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
    await press("插入表格");
    await waitFor(() => expect(screen.getByRole("button", { name: "撤销" })).toBeEnabled());
    await press("撤销");
    await waitFor(() => expect(hidden(container).value).not.toMatch(/\|\s*-{3,}\s*\|/));
    await waitFor(() => expect(screen.getByRole("button", { name: "重做" })).toBeEnabled());
  });
});

describe("工具栏：占位按钮", () => {
  it("工具栏不含图片按钮（图片由外壳提供，见 editor-shell.test）", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: /插入图片/ })).toBeNull();
  });
});

/** 全选编辑区内容（Mod-a 由 Tiptap 的键盘映射处理） */
const selectAll = async () => {
  const ed = screen.getByRole("textbox", { name: "正文" });
  await act(async () => {
    fireEvent.keyDown(ed, { key: "a", ctrlKey: true });
  });
};

describe("工具栏：插入类命令不吞选中的文字（M10.8 Step 1 实测缺陷）", () => {
  it.each(["插入表格", "分隔线", "插入锁定内容"])("全选后点「%s」，原文字仍在", async (name) => {
    const { container } = await mount("测试文字");
    await selectAll();
    await press(name);
    await waitFor(() => expect(hidden(container).value).toContain("测试文字"));
    // 且确实插入了对应结构
    const md = hidden(container).value;
    if (name === "插入表格") expect(md).toMatch(/\|\s*-{3,}\s*\|/);
    if (name === "分隔线") expect(md).toContain("---");
    if (name === "插入锁定内容") expect(md).toContain(":::gate{");
  });
});

describe("工具栏：新增能力", () => {
  it("行内代码：Markdown 出现反引号", async () => {
    const { container } = await mount("测试文字");
    await selectAll();
    await press("行内代码");
    await waitFor(() => expect(hidden(container).value).toBe("`测试文字`"));
  });

  it("链接：选中文字后经弹层设置地址，输出 Markdown 链接；无协议自动补 https://", async () => {
    const { container } = await mount("测试文字");
    await selectAll();
    await press("链接");
    const input = await screen.findByLabelText("链接地址");
    await act(async () => {
      fireEvent.change(input, { target: { value: "example.com/a" } });
      fireEvent.submit(input.closest("form")!);
    });
    await waitFor(() => expect(hidden(container).value).toBe("[测试文字](https://example.com/a)"));
  });

  it("清除格式：去掉加粗与块级结构", async () => {
    const { container } = await mount("测试文字");
    await selectAll();
    await press("加粗");
    await press("引用");
    await waitFor(() => expect(hidden(container).value).toContain("> **测试文字**"));
    await press("清除格式");
    await waitFor(() => expect(hidden(container).value.trim()).toBe("测试文字"));
  });

  it("没有「换行」按钮（Shift+Enter 即可，按钮既无反馈又易误解）", async () => {
    await mount();
    expect(screen.queryByRole("button", { name: "换行" })).toBeNull();
  });

  it("标题：下拉里选「标题 2」，Markdown 出现 ##", async () => {
    const { container } = await mount("测试文字");
    await selectAll();
    const trigger = screen.getByRole("button", { name: "标题" });
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    const item = await screen.findByRole("menuitem", { name: "标题 2" });
    await act(async () => {
      fireEvent.click(item);
    });
    await waitFor(() => expect(hidden(container).value).toContain("## 测试文字"));
  });

  it("代码块内标记类按钮置灰（点了没反应 → 直接不可点）", async () => {
    await mount("测试文字");
    await selectAll();
    await press("代码块");
    await waitFor(() => expect(screen.getByRole("button", { name: "加粗" })).toBeDisabled());
  });
});

describe("编辑器扩展：Markdown 没有对应语法的能力不提供", () => {
  it("没有下划线（序列化会写出渲染器不认识的 ++x++）", () => {
    const names = editorExtensions().map((e) => e.name);
    expect(names).not.toContain("underline");
  });
});

describe("normalizeHref", () => {
  it.each([
    ["", ""],
    ["  ", ""],
    ["example.com", "https://example.com"],
    ["http://a.cn/x", "http://a.cn/x"],
    ["HTTPS://A.CN", "HTTPS://A.CN"],
    ["/t/123", "/t/123"],
    ["#p9", "#p9"],
    ["a@b.com", "mailto:a@b.com"],
    ["mailto:a@b.com", "mailto:a@b.com"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeHref(input)).toBe(expected);
  });
});

describe("工具栏：链接弹层的其余分支", () => {
  const openByKey = async () => {
    const ed = screen.getByRole("textbox", { name: "正文" });
    await act(async () => {
      fireEvent.keyDown(ed, { key: "k", ctrlKey: true });
    });
    return screen.findByLabelText("链接地址");
  };
  const submit = async (input: HTMLElement, value: string) => {
    await act(async () => {
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(input.closest("form")!);
    });
  };

  it("Ctrl+K 打开弹层；没选文字时把地址本身作为链接文字插入", async () => {
    const { container } = await mount();
    const input = await openByKey();
    await submit(input, "https://a.cn");
    await waitFor(() => expect(hidden(container).value).toBe("[https://a.cn](https://a.cn)"));
  });

  it("已有链接：弹层带出地址，「移除链接」去掉链接保留文字", async () => {
    const { container } = await mount("[测试文字](https://a.cn)");
    await selectAll();
    await press("链接");
    const input = (await screen.findByLabelText("链接地址")) as HTMLInputElement;
    expect(input.value).toBe("https://a.cn");
    await act(async () => {
      screen.getByRole("button", { name: "移除链接" }).click();
    });
    await waitFor(() => expect(hidden(container).value.trim()).toBe("测试文字"));
  });

  it("地址清空后确定：等同移除链接", async () => {
    const { container } = await mount("[测试文字](https://a.cn)");
    await selectAll();
    await press("链接");
    const input = await screen.findByLabelText("链接地址");
    await submit(input, "");
    await waitFor(() => expect(hidden(container).value.trim()).toBe("测试文字"));
  });

  it("标题按钮显示当前级别", async () => {
    await mount("# 标题文字");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "标题" })).toHaveTextContent("1"),
    );
  });
});

describe("工具栏：行内代码可以取消（增删改查审计发现的缺陷）", () => {
  it("应用行内代码后，该按钮仍可点（按下状态），再点一次取消；此时加粗等其它标记不可用", async () => {
    const { container } = await mount("文字");
    await selectAll();
    await press("行内代码");
    await waitFor(() => expect(hidden(container).value).toBe("`文字`"));
    const code = screen.getByRole("button", { name: "行内代码" });
    expect(code).toHaveAttribute("aria-pressed", "true");
    expect(code).toBeEnabled(); // 回归：曾与加粗共用禁用判断，在行内代码里连自己也被置灰
    expect(screen.getByRole("button", { name: "加粗" })).toBeDisabled(); // 代码标记排斥其它标记
    await press("行内代码");
    await waitFor(() => expect(hidden(container).value).toBe("文字"));
    expect(screen.getByRole("button", { name: "加粗" })).toBeEnabled();
  });

  it("加粗 / 斜体 / 删除线也一样：已激活时按钮可点，点一下取消", async () => {
    for (const [name, wrapped] of [
      ["加粗", "**文字**"],
      ["斜体", "*文字*"],
      ["删除线", "~~文字~~"],
    ] as const) {
      const { container, unmount } = await mount("文字");
      await selectAll();
      await press(name);
      await waitFor(() => expect(hidden(container).value).toBe(wrapped));
      expect(screen.getByRole("button", { name })).toBeEnabled();
      await press(name);
      await waitFor(() => expect(hidden(container).value).toBe("文字"));
      unmount();
    }
  });
});
