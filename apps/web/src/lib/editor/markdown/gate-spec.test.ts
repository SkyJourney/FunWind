// @vitest-environment jsdom
/**
 * 门控节点视图的分支（M6.3 第 3 步）：事件归属（头部自处理、正文交给编辑器）、
 * 节点类型不同时拒绝原地更新、选区变化不触发 DOM 重建。
 * 直接取 ProseMirror 为该节点保存的视图对象（spec），逐个分支断言。
 */
import { Editor } from "@tiptap/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editorExtensions } from "./extensions";

type GateSpec = {
  update: (n: unknown) => boolean;
  stopEvent: (e: Event) => boolean;
  ignoreMutation: (m: { type: string; target: unknown }) => boolean;
};

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

/** 第一个节点（门控）的视图对象 */
function gateSpec(): GateSpec {
  const docView = (editor.view as unknown as { docView: { children: { spec?: GateSpec }[] } })
    .docView;
  const spec = docView.children[0]?.spec;
  if (!spec) throw new Error("门控节点视图不存在");
  return spec;
}

const head = () => host.querySelector<HTMLElement>(".fw-gate > div")!;
const content = () => host.querySelector<HTMLElement>(".fw-gate-content")!;

describe("门控节点视图：事件归属", () => {
  it("头部控件的事件由视图自己处理（stopEvent 为真）", () => {
    const select = host.querySelector("select")!;
    expect(gateSpec().stopEvent({ target: select } as unknown as Event)).toBe(true);
  });

  it("正文区的事件交给编辑器（stopEvent 为假）", () => {
    expect(gateSpec().stopEvent({ target: content() } as unknown as Event)).toBe(false);
  });

  it("选区变化不忽略（编辑器需要同步光标）", () => {
    expect(gateSpec().ignoreMutation({ type: "selection", target: content() })).toBe(false);
  });

  it("正文区内的 DOM 变化交给编辑器（不忽略）", () => {
    expect(gateSpec().ignoreMutation({ type: "childList", target: content() })).toBe(false);
  });

  it("头部的 DOM 变化（如下拉选项）忽略，避免重建", () => {
    expect(gateSpec().ignoreMutation({ type: "attributes", target: head() })).toBe(true);
  });

  it("目标不是 DOM 节点时视为头部变化，忽略", () => {
    expect(gateSpec().ignoreMutation({ type: "characterData", target: "文本" })).toBe(true);
  });
});

describe("门控节点视图：更新", () => {
  it("同类型节点：原地更新，返回真，并同步控件的值", () => {
    const spec = gateSpec();
    const next = editor.state.doc.firstChild!.type.create(
      { key: "g1", unlock: "reply", params: {} },
      editor.state.doc.firstChild!.content,
    );
    expect(spec.update(next)).toBe(true);
    expect(host.querySelector<HTMLSelectElement>("select")!.value).toBe("reply");
  });

  it("缺省属性时回落为积分解锁，价格为空", () => {
    const spec = gateSpec();
    const next = editor.state.doc.firstChild!.type.create(
      { key: "g1", unlock: null, params: null },
      editor.state.doc.firstChild!.content,
    );
    expect(spec.update(next)).toBe(true);
    expect(host.querySelector<HTMLSelectElement>("select")!.value).toBe("points");
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')!.value).toBe("");
  });

  it("不同类型的节点：拒绝原地更新（交给 ProseMirror 重建）", () => {
    const paragraph = editor.state.schema.nodes.paragraph.create();
    expect(gateSpec().update(paragraph)).toBe(false);
  });
});
