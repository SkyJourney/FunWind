// @vitest-environment jsdom
/**
 * 门控节点视图（M6.3 第 3 步）：挂载真实编辑器，检查头部控件的改动是否写回节点属性与 Markdown。
 */
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConditionUi } from "@funwind/content";
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
const gateAttrs = () =>
  editor.getJSON().content?.[0]?.attrs as { unlock: string; params: Record<string, string> };

describe("锁定内容节点视图", () => {
  it("门控渲染为带头部控件与正文区的节点视图", () => {
    expect(gateDom()).not.toBeNull();
    expect(select().value).toBe("points");
    expect(price().value).toBe("10");
    expect(gateDom().querySelector(".fw-gate-content")?.textContent).toContain("隐藏正文");
  });

  it("改为「回复解锁」：属性写回文档，价格隐藏，Markdown 不再写价格", () => {
    select().value = "reply";
    select().dispatchEvent(new Event("change"));
    expect(gateAttrs().unlock).toBe("reply");
    // 回复解锁没有参数：价格输入框不存在
    expect(gateDom().querySelector('input[type="number"]')).toBeNull();
    expect(gateAttrs().params).toEqual({});
    const md = editor.getMarkdown();
    expect(md).toContain('unlock="reply"');
    expect(md).not.toContain("price=");
  });

  it("修改价格：属性写回，Markdown 中的价格随之变化", () => {
    price().value = "25";
    price().dispatchEvent(new Event("change"));
    expect(gateAttrs().params.price).toBe("25");
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

describe("锁定内容节点视图：解锁方式由条件目录驱动", () => {
  it("下拉选项来自目录（显示名），不是写死的两项", () => {
    expect([...select().options].map((o) => o.text)).toEqual(["积分解锁", "回复解锁"]);
  });

  it("目录里新增一种条件：下拉里出现，选中后渲染它声明的参数输入，并写回 Markdown", () => {
    const extra = Editor;
    const e2 = new extra({
      element: host.appendChild(document.createElement("div")),
      extensions: editorExtensions({
        conditions: [
          ...listConditionUi(),
          {
            type: "level",
            label: "等级解锁",
            hint: "达到指定等级",
            fields: [
              {
                name: "min",
                label: "最低等级",
                kind: "integer",
                min: 1,
                max: 99,
                defaultValue: "3",
              },
            ],
          },
        ],
      }),
      content: ':::gate{key="g1" unlock="level" min="5"}\n隐藏\n:::',
      contentType: "markdown",
    });
    const root = host.lastElementChild!;
    const sel = root.querySelector<HTMLSelectElement>("select")!;
    expect([...sel.options].map((o) => o.value)).toEqual(["points", "reply", "level"]);
    expect(sel.value).toBe("level");
    const input = root.querySelector<HTMLInputElement>('input[name="min"]')!;
    expect(input.value).toBe("5");
    input.value = "7";
    input.dispatchEvent(new Event("change"));
    expect(e2.getMarkdown()).toContain('unlock="level" min="7"');
    e2.destroy();
  });

  it("目录里没有的解锁方式（旧数据 / 将来的条件）：显示原值，参数原样保留不丢", () => {
    const e2 = new Editor({
      element: host.appendChild(document.createElement("div")),
      extensions: editorExtensions(),
      content: ':::gate{key="g1" unlock="future" foo="1" bar="x"}\n隐藏\n:::',
      contentType: "markdown",
    });
    const sel = host.lastElementChild!.querySelector<HTMLSelectElement>("select")!;
    expect(sel.value).toBe("future");
    expect(e2.getMarkdown()).toContain('unlock="future" foo="1" bar="x"');
    e2.destroy();
  });

  it("换解锁方式：参数回到新方式的默认值，旧方式的参数不带过去", () => {
    select().value = "reply";
    select().dispatchEvent(new Event("change"));
    select().value = "points";
    select().dispatchEvent(new Event("change"));
    expect(gateAttrs().params).toEqual({ price: "10" });
  });
});
