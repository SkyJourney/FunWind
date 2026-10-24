import { Crepe } from "@milkdown/crepe";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";
import { $node, $remark, $view, replaceAll } from "@milkdown/kit/utils";
import remarkDirective from "remark-directive";
import { remarkGFMPlugin } from "@milkdown/kit/preset/gfm";
import type { Adapter } from "../types";

const directive = $remark("remarkDirective", () => remarkDirective);

/** remark-directive 会把正文里的「:D」「(:з」∠)」「::x」当成文本 / 叶子指令，Milkdown 不认识会直接抛错。
 *  这里把除 gate 以外的所有指令还原成原文文字（用 position 偏移从原文里切），保证真实帖子能载入 */
const directiveFallback = $remark("directiveFallback", () => () => (tree: any, file: any) => {
  const src = String(file.value ?? "");
  const raw = (n: any) => src.slice(n.position.start.offset, n.position.end.offset);
  const walk = (node: any) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.map((c: any) => {
      if (c.type === "textDirective") return { type: "text", value: raw(c) };
      if (c.type === "leafDirective" || (c.type === "containerDirective" && c.name !== "gate"))
        return { type: "paragraph", children: [{ type: "text", value: raw(c) }] };
      walk(c);
      return c;
    });
  };
  walk(tree);
});

/** 门控：remark-directive 的 containerDirective(name=gate) ↔ ProseMirror 的 gate 节点 */
const gateNode = $node("gate", () => ({
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  attrs: {
    key: { default: "" },
    unlock: { default: "points" },
    price: { default: "" },
    match: { default: "" },
  },
  parseDOM: [
    {
      tag: "div[data-gate]",
      getAttrs: (dom: any) => ({
        key: dom.dataset.key ?? "",
        unlock: dom.dataset.unlock ?? "points",
        price: dom.dataset.price ?? "",
        match: dom.dataset.match ?? "",
      }),
    },
  ],
  toDOM: (node: any) => [
    "div",
    {
      "data-gate": "",
      "data-key": node.attrs.key,
      "data-unlock": node.attrs.unlock,
      "data-price": node.attrs.price,
      "data-match": node.attrs.match,
    },
    0,
  ],
  parseMarkdown: {
    match: (n: any) => n.type === "containerDirective" && n.name === "gate",
    runner: (state: any, node: any, type: any) => {
      const a = node.attributes ?? {};
      state.openNode(type, {
        key: a.key ?? "",
        unlock: a.unlock ?? "points",
        price: a.price ?? "",
        match: a.match ?? "",
      });
      state.next(node.children);
      state.closeNode();
    },
  },
  toMarkdown: {
    match: (n: any) => n.type.name === "gate",
    runner: (state: any, node: any) => {
      const attrs: Record<string, string> = {};
      if (node.attrs.key) attrs.key = node.attrs.key;
      attrs.unlock = node.attrs.unlock;
      if (node.attrs.unlock === "points")
        attrs.price = String(node.attrs.price === "" ? "0" : node.attrs.price);
      if (node.attrs.match) attrs.match = node.attrs.match;
      state.openNode("containerDirective", undefined, { name: "gate", attributes: attrs });
      state.next(node.content);
      state.closeNode();
    },
  },
}));

/** 可视块：头部是「付费 / 回复可见」下拉与价格输入框 */
const gateView = $view(gateNode, () => (node: any, view: any, getPos: any) => {
  const dom = document.createElement("div");
  dom.className = "gate-block";
  const head = document.createElement("div");
  head.className = "gate-head";
  head.contentEditable = "false";
  const lock = document.createElement("span");
  lock.textContent = "🔒 门控";
  const sel = document.createElement("select");
  for (const [v, t] of [
    ["points", "付费可见"],
    ["reply", "回复可见"],
  ])
    sel.add(new Option(t, v));
  const price = document.createElement("input");
  price.type = "number";
  price.min = "0";
  price.inputMode = "numeric";
  price.placeholder = "价格";
  const content = document.createElement("div");
  content.className = "gate-content";
  head.append(lock, sel, price);
  dom.append(head, content);
  const patch = (attrs: Record<string, string>) =>
    view.dispatch(view.state.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, ...attrs }));
  sel.onchange = () => patch({ unlock: sel.value });
  price.onchange = () => patch({ price: price.value });
  const sync = (n: any) => {
    sel.value = n.attrs.unlock;
    price.value = n.attrs.price;
    price.style.display = n.attrs.unlock === "points" ? "" : "none";
  };
  sync(node);
  return {
    dom,
    contentDOM: content,
    update: (n: any) => {
      if (n.type !== node.type) return false;
      node = n;
      sync(n);
      return true;
    },
    stopEvent: (e: Event) => head.contains(e.target as Node),
    ignoreMutation: (m: any) => !content.contains(m.target),
  };
});

export const milkdownAdapter: Adapter = {
  id: "milkdown",
  label: "Milkdown Crepe（所见即所得）",
  async mount(el, md, onChange) {
    const crepe = new Crepe({
      root: el,
      defaultValue: md,
      features: { [Crepe.Feature.ImageBlock]: false },
    });
    // 中文语气词 ~x~ 不是删除线（迁移库 1136 篇）：关掉 GFM 的单波浪线
    crepe.editor.config((ctx: any) => {
      ctx.update(remarkGFMPlugin.options.key, (o: any) => ({ ...(o ?? {}), singleTilde: false }));
    });
    crepe.editor.use(directive).use(directiveFallback).use(gateNode).use(gateView);
    await crepe.create();
    crepe.on((l: any) =>
      l.markdownUpdated((_ctx: unknown, markdown: string) => onChange(markdown)),
    );
    return {
      getMarkdown: () => crepe.getMarkdown(),
      setMarkdown: (next) => {
        crepe.editor.action(replaceAll(next));
      },
      destroy: () => crepe.destroy(),
    };
  },
};
