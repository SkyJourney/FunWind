// @vitest-environment jsdom
/**
 * 门控节点视图（M6.3 第 3 步）：挂载真实编辑器，检查头部控件的改动是否写回节点属性与 Markdown。
 */
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editorExtensions } from "./extensions";

let host: HTMLDivElement;
let editor: Editor;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  editor = new Editor({
    element: host,
    extensions: editorExtensions(),
    content: ':::gate{key="g1" unlock="points" price="10"}\n隐藏正文\n:::',
    contentType: "markdown",
  });
});

afterEach(() => {
  editor.destroy();
  host.remove();
});

const gateDom = () => host.querySelector<HTMLElement>(".fw-gate")!;
const select = () => gateDom().querySelector<HTMLSelectElement>("select")!;
const price = () => gateDom().querySelector<HTMLInputElement>('input[type="number"]')!;
const gateAttrs = () => editor.getJSON().content?.[0]?.attrs as Record<string, string>;

describe("门控节点视图", () => {
  it("门控渲染为带头部控件与正文区的节点视图", () => {
    expect(gateDom()).not.toBeNull();
    expect(select().value).toBe("points");
    expect(price().value).toBe("10");
    expect(gateDom().querySelector(".fw-gate-content")?.textContent).toContain("隐藏正文");
  });

  it("改为「回复可见」：属性写回文档，价格隐藏，Markdown 不再写价格", () => {
    select().value = "reply";
    select().dispatchEvent(new Event("change"));
    expect(gateAttrs().unlock).toBe("reply");
    expect(price().style.display).toBe("none");
    const md = editor.getMarkdown();
    expect(md).toContain('unlock="reply"');
    expect(md).not.toContain("price=");
  });

  it("修改价格：属性写回，Markdown 中的价格随之变化", () => {
    price().value = "25";
    price().dispatchEvent(new Event("change"));
    expect(gateAttrs().price).toBe("25");
    expect(editor.getMarkdown()).toContain('price="25"');
  });

  it("门控正文可以继续编辑：在正文区插入段落后，门控仍然存在且包含新段落", () => {
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
      type: "paragraph",
      content: [{ type: "text", text: "新增段落" }],
    });
    const md = editor.getMarkdown();
    expect(md).toContain('key="g1"');
    expect(md).toContain("新增段落");
    expect(gateDom().querySelector(".fw-gate-content")?.textContent).toContain("新增段落");
  });
});
