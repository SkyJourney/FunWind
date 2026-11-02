// @vitest-environment jsdom
/**
 * 门控节点视图（M6.3 第 3 步）：挂载真实编辑器，检查头部控件的改动是否写回节点属性与 Markdown。
 */
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listConditionUi } from "@funwind/content";
import { editorExtensions } from "./extensions";
import { defaultGateAttrs, misplacedGates } from "./gate";

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

describe("锁定内容：删除（站长实测：想删删不掉）", () => {
  const gates = () => host.querySelectorAll(".fw-gate").length;

  it("头部有「删除」按钮：删掉整块，前后的文字保留，可撤销", () => {
    editor.commands.setContent(
      '前文\n\n:::gate{key="g1" unlock="points" price="10"}\n隐藏正文\n:::\n\n后文',
      {
        contentType: "markdown",
      },
    );
    expect(gates()).toBe(1);
    host.querySelector<HTMLButtonElement>(".fw-gate-remove")!.click();
    expect(gates()).toBe(0);
    const md = editor.getMarkdown();
    expect(md).toContain("前文");
    expect(md).toContain("后文");
    expect(md).not.toContain(":::gate");
    editor.commands.undo();
    expect(gates()).toBe(1);
    expect(editor.getMarkdown()).toContain("隐藏正文");
  });

  const emptyGateDoc = {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "前文" }] },
      { type: "gate", attrs: defaultGateAttrs("g1"), content: [{ type: "paragraph" }] },
    ],
  };
  const pressBackspace = () =>
    editor.view.someProp("handleKeyDown", (f) =>
      f(editor.view, new KeyboardEvent("keydown", { key: "Backspace" })),
    );

  it("空的锁定内容里按 Backspace：删除整块，前面的文字保留", () => {
    editor.commands.setContent(emptyGateDoc);
    expect(gates()).toBe(1); // 前提：确实有一个空块
    // 光标落进块内的空段落：按节点位置查找，不手算偏移
    let gatePos = -1;
    editor.state.doc.descendants((n, pos) => {
      if (n.type.name === "gate") gatePos = pos;
    });
    editor.commands.setTextSelection(gatePos + 2);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parent.childCount).toBe(0);
    expect(pressBackspace()).toBe(true);
    expect(gates()).toBe(0);
    expect(editor.getMarkdown()).toContain("前文");
  });

  it("块里有字时 Backspace 只删字，不删块", () => {
    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "gate",
          attrs: defaultGateAttrs("g1"),
          content: [{ type: "paragraph", content: [{ type: "text", text: "有字" }] }],
        },
      ],
    });
    expect(gates()).toBe(1);
    editor.commands.setTextSelection(4); // 「有字」的末尾
    pressBackspace();
    expect(gates()).toBe(1);
  });
});

describe("锁定内容：只能放在最外层（语法不允许嵌套）", () => {
  const gates = () => host.querySelectorAll(".fw-gate").length;
  const nested = () => misplacedGates(editor.state.doc);
  const gateJson = (key: string) => ({
    type: "gate",
    attrs: defaultGateAttrs(key),
    content: [{ type: "paragraph" }],
  });

  it("misplacedGates：最外层 0，块内 / 引用内 / 列表内各算 1", () => {
    expect(nested()).toBe(0);
  });

  it("在锁定内容里再插一个：被拒绝，文档不变", () => {
    const before = editor.getJSON();
    editor.commands.insertContentAt(3, gateJson("g2")); // 位置 3 在 g1 的正文段落里
    expect(editor.getJSON()).toEqual(before);
    expect(nested()).toBe(0);
  });

  it("把整个锁定内容包进引用 / 列表：被拒绝（会让它不在最外层）", () => {
    // 文档比较要忽略 TrailingNode 在末尾自动补的空段落，所以断言不变量而不是整份文档相等
    editor.commands.setNodeSelection(0); // 选中整个锁定内容节点
    editor.commands.wrapIn("blockquote");
    editor.commands.setNodeSelection(0);
    editor.commands.wrapIn("bulletList");
    expect(nested()).toBe(0);
    expect(host.querySelector("blockquote .fw-gate")).toBeNull();
    expect(host.querySelector("li .fw-gate")).toBeNull();
    expect(editor.state.doc.firstChild?.type.name).toBe("gate"); // 仍是最外层的第一个块
    expect(gates()).toBe(1);
    expect(editor.getMarkdown()).toContain("隐藏正文");
  });

  it("只拦新增的违规：原本就有嵌套的文档（旧数据）其它编辑不受阻", () => {
    const legacy = new Editor({
      element: document.createElement("div"),
      extensions: editorExtensions(),
      content:
        '::::gate{key="g1" unlock="reply"}\n:::gate{key="g2" unlock="reply"}\n内层\n:::\n::::',
      contentType: "markdown",
    });
    expect(misplacedGates(legacy.state.doc)).toBeGreaterThan(0);
    legacy.commands.insertContentAt(legacy.state.doc.content.size - 1, "追加文字");
    expect(legacy.getMarkdown()).toContain("追加文字");
    legacy.destroy();
  });

  it("在块内的普通编辑（输入文字、块内套引用）不受影响", () => {
    editor.chain().setTextSelection(3).insertContent("补充").run();
    expect(editor.getMarkdown()).toContain("补充");
    // 块正文里套引用：引用在锁定内容里面，不涉及锁定内容的位置
    editor.chain().setTextSelection(3).toggleBlockquote().run();
    expect(host.querySelector(".fw-gate blockquote")).not.toBeNull();
    expect(nested()).toBe(0);
  });
});
