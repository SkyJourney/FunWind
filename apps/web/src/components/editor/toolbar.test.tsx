// @vitest-environment jsdom
/**
 * 工具栏命令（M6.3 第 2 步）：每个按钮都要真正改变编辑器的状态或内容。
 * 通过外壳的隐藏字段（即提交给服务端的 Markdown）与按钮的按下状态来验证。
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorShell } from "./editor-shell";

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
  it("图片按钮在本里程碑禁用（M6.4 接入）", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "插入图片（M6.4 接入）" })).toBeDisabled();
  });
});
