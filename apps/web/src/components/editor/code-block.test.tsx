// @vitest-environment jsdom
/**
 * 编辑器代码块（M10.8 Step 5）：语言下拉写回围栏，编辑区高亮与渲染侧同一套语法，不自动探测。
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EditorShell } from "./editor-shell";

const hidden = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[name="source"]')!;

async function mount(initial: string) {
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
const select = () => screen.getByLabelText("代码语言") as HTMLSelectElement;
const pick = async (value: string) => {
  await act(async () => {
    fireEvent.change(select(), { target: { value } });
  });
};

describe("代码块语言下拉", () => {
  it("显示文档里的语言；手写别名（ts）不在下拉里时临时补一个同名选项", async () => {
    await mount("```ts\nconst a = 1;\n```");
    expect(select().value).toBe("ts");
  });

  it("下拉里的规范名直接选中", async () => {
    await mount("```python\nx = 1\n```");
    expect(select().value).toBe("python");
    expect([...select().options].some((o) => o.value === "ts")).toBe(false);
  });

  it("改成 Python：围栏写回 ```python", async () => {
    const { container } = await mount("```ts\nx = 1\n```");
    await pick("python");
    await waitFor(() => expect(hidden(container).value).toMatch(/^```python\n/));
  });

  it("改回「纯文本」：围栏不带语言", async () => {
    const { container } = await mount("```python\nx = 1\n```");
    await pick("");
    await waitFor(() => expect(hidden(container).value).toMatch(/^```\n/));
  });

  it("带语言的代码块在编辑区内高亮；没写语言的不高亮（不自动探测，与渲染一致）", async () => {
    await mount("```javascript\nconst a = 1;\n```\n\n```\nconst b = 2;\n```");
    const blocks = document.querySelectorAll(".fw-codeblock");
    expect(blocks).toHaveLength(2);
    await waitFor(() => expect(blocks[0]!.querySelector(".hljs-keyword")).not.toBeNull());
    expect(blocks[1]!.querySelector('[class*="hljs-"]')).toBeNull();
  });

  it("往返：未编辑时带语言与无语言的围栏逐字不变", async () => {
    const src = "```ts\nconst a = 1;\n```\n\n```\nplain\n```";
    const { container } = await mount(src);
    expect(hidden(container).value).toBe(src);
  });
});
