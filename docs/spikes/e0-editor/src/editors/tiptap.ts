import { Editor, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import type { Adapter } from "../types";

const attrRe = /([A-Za-z_][\w-]*)="([^"]*)"/g;

/** 门控：`:::gate{...}` 容器块，自定义 marked 分词器（Tiptap 官方 Markdown 基于 marked，不是 remark） */
const Gate = Node.create({
  name: "gate",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addAttributes() {
    return {
      key: { default: "" },
      unlock: { default: "points" },
      price: { default: "" },
      match: { default: "" },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-gate]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes({ "data-gate": "" }, HTMLAttributes), 0];
  },
  // @ts-expect-error markdown 扩展点由 @tiptap/markdown 注入类型
  markdownTokenizer: {
    name: "gate",
    level: "block",
    start: (src: string) => src.indexOf(":::"),
    tokenize: (src: string, _tokens: unknown, lexer: any) => {
      const m = /^(:{3,})gate\{([^}\n]*)\}[ \t]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/.exec(src);
      if (!m) return undefined;
      const attrs: Record<string, string> = {};
      for (const a of m[2]!.matchAll(attrRe)) attrs[a[1]!] = a[2]!;
      return { type: "gate", raw: m[0], gateAttrs: attrs, tokens: lexer.blockTokens(m[3]) };
    },
  },
  parseMarkdown: (token: any, helpers: any) => {
    const a = token.gateAttrs ?? {};
    return {
      type: "gate",
      attrs: {
        key: a.key ?? "",
        unlock: a.unlock ?? "points",
        price: a.price ?? "",
        match: a.match ?? "",
      },
      content: helpers.parseChildren(token.tokens ?? []),
    };
  },
  renderMarkdown: (node: any, helpers: any) => {
    const attrs: string[] = [];
    if (node.attrs?.key) attrs.push(`key="${node.attrs.key}"`);
    attrs.push(`unlock="${node.attrs?.unlock ?? "points"}"`);
    if ((node.attrs?.unlock ?? "points") === "points")
      attrs.push(`price="${node.attrs?.price === "" ? "0" : node.attrs?.price}"`);
    if (node.attrs?.match) attrs.push(`match="${node.attrs.match}"`);
    const body = helpers.renderChildren(node.content ?? [], "\n\n");
    const fence = /^:{3,}/m.test(body) ? "::::" : ":::";
    return `${fence}gate{${attrs.join(" ")}}\n${body.replace(/\n+$/, "")}\n${fence}\n\n`;
  },
  addNodeView() {
    return ({ node: initial, getPos, editor }: any) => {
      let node = initial;
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
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(getPos(), undefined, { ...node.attrs, ...attrs }),
        );
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
    };
  },
});

export const tiptapAdapter: Adapter = {
  id: "tiptap",
  label: "Tiptap v3 + @tiptap/markdown（所见即所得）",
  async mount(el, md, onChange) {
    const editor = new Editor({
      element: el,
      extensions: [StarterKit, Markdown, TableKit, Image, Gate],
      content: md,
      contentType: "markdown",
      onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
    });
    // marked 默认把 ~x~ 也当删除线；中文语气词 ~x~ 不是（迁移库 1136 篇）。只放行 ~~x~~，单波浪线当普通文字
    (editor as any).markdown.instance.use({
      tokenizer: {
        del(src: string) {
          return /^~(?!~)/.test(src) ? undefined : false;
        },
      },
    });
    editor.commands.setContent(md, { contentType: "markdown" });
    return {
      getMarkdown: () => editor.getMarkdown(),
      setMarkdown: (next) => {
        editor.commands.setContent(next, { contentType: "markdown" });
      },
      destroy: () => editor.destroy(),
    };
  },
};
