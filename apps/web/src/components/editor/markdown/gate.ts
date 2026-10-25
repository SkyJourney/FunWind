import { Node, mergeAttributes, type JSONContent } from "@tiptap/core";

/**
 * 门控节点（M6.3）：编辑器里的 `:::gate{key="…" unlock="…" price="…"}` 容器块。
 *
 * 这里只负责数据与 Markdown 语法（分词、解析、渲染）；节点视图（下拉、价格输入、锁图标）在第 3 步加入。
 * 语法的权威仍是服务端 `splitSource`：本模块只是编辑体验，保存时一律以服务端拆分的结果为准。
 *
 * 围栏长度：外层围栏可以是 3 个以上冒号。内层的 `:::` 只有在外层用更长的围栏（如 `::::`）时才会被包住，
 * 因此分词器要求闭合围栏与开头的围栏长度完全相同，渲染时若正文里出现 `:::` 行则自动把外层加长一个冒号。
 */

/** 门控的属性（与 packages/content 的 GateDraft 对齐，编辑器内只用字符串） */
export interface GateAttrs {
  key: string;
  unlock: string;
  price: string;
  match: string;
}

const ATTR_RE = /([A-Za-z_][\w-]*)="([^"]*)"/g;
const GATE_BLOCK_RE = /^(:{3,})gate\{([^}\n]*)\}[ \t]*\n([\s\S]*?)\n\1[ \t]*(?:\n|$)/;

function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(ATTR_RE)) {
    const k = m[1];
    const v = m[2];
    if (k !== undefined && v !== undefined) out[k] = v;
  }
  return out;
}

export const Gate = Node.create({
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

  markdownTokenizer: {
    name: "gate",
    level: "block",
    start: (src: string) => src.indexOf(":::"),
    tokenize: (src, _tokens, lexer) => {
      const m = GATE_BLOCK_RE.exec(src);
      if (!m || m[2] === undefined || m[3] === undefined) return undefined;
      return {
        type: "gate",
        raw: m[0],
        gateAttrs: parseAttrs(m[2]),
        tokens: lexer.blockTokens(m[3]),
      };
    },
  },

  parseMarkdown: (token, helpers) => {
    const a = (token as unknown as { gateAttrs?: Record<string, string> }).gateAttrs ?? {};
    const children = (token as unknown as { tokens?: never[] }).tokens ?? [];
    const attrs: GateAttrs = {
      key: a.key ?? "",
      unlock: a.unlock ?? "points",
      price: a.price ?? "",
      match: a.match ?? "",
    };
    return { type: "gate", attrs, content: helpers.parseChildren(children) };
  },

  renderMarkdown: (node: JSONContent, helpers) => {
    const attrs = (node.attrs ?? {}) as Partial<GateAttrs>;
    const unlock = attrs.unlock || "points";
    const parts: string[] = [];
    if (attrs.key) parts.push(`key="${attrs.key}"`);
    parts.push(`unlock="${unlock}"`);
    // 付费门控必须写价格；空价格按 0 写出（服务端校验会给出可读的错误）
    if (unlock === "points")
      parts.push(`price="${attrs.price === "" || attrs.price === undefined ? "0" : attrs.price}"`);
    if (attrs.match) parts.push(`match="${attrs.match}"`);
    const body = helpers.renderChildren(node.content ?? [], "\n\n");
    const fence = /^:{3,}/m.test(body) ? "::::" : ":::";
    return `${fence}gate{${parts.join(" ")}}\n${body.replace(/\n+$/, "")}\n${fence}\n\n`;
  },

  /**
   * 节点视图（M6.3 第 3 步）：头部是门控类型下拉与价格输入（头部不可编辑，stopEvent 让它的事件不进入编辑器），
   * 正文区（contentDOM）是普通的块级内容，可以在门控里打字、插入段落与列表。
   * 改动通过 setNodeMarkup 写回节点属性，保存时仍以服务端 splitSource 为准。
   */
  addNodeView() {
    return ({ node: initialNode, getPos, editor }) => {
      let node = initialNode;

      const dom = document.createElement("div");
      dom.className = "fw-gate";
      dom.setAttribute("data-gate", "");

      const head = document.createElement("div");
      head.className = "fw-gate-head";
      head.contentEditable = "false";

      const lock = document.createElement("span");
      lock.className = "fw-gate-lock";
      lock.textContent = "🔒 门控";

      const select = document.createElement("select");
      select.setAttribute("aria-label", "门控类型");
      select.add(new Option("付费可见", "points"));
      select.add(new Option("回复可见", "reply"));

      const price = document.createElement("input");
      price.type = "number";
      price.min = "0";
      price.step = "1";
      price.inputMode = "numeric";
      price.placeholder = "价格";
      price.setAttribute("aria-label", "价格（积分）");

      const content = document.createElement("div");
      content.className = "fw-gate-content";

      head.append(lock, select, price);
      dom.append(head, content);

      const patch = (attrs: Record<string, string>) => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }),
        );
      };
      select.addEventListener("change", () => patch({ unlock: select.value }));
      price.addEventListener("change", () => patch({ price: price.value }));

      const sync = (n: typeof node) => {
        select.value = String(n.attrs.unlock ?? "points");
        price.value = String(n.attrs.price ?? "");
        // 回复可见的门控没有价格
        price.style.display = select.value === "points" ? "" : "none";
      };
      sync(node);

      return {
        dom,
        contentDOM: content,
        update(n) {
          if (n.type.name !== node.type.name) return false;
          node = n;
          sync(n);
          return true;
        },
        // 头部的控件自己处理事件（下拉、输入），不交给编辑器
        stopEvent: (e: Event) => head.contains(e.target as globalThis.Node | null),
        // 只有正文区的变化需要编辑器处理；头部的 DOM 变化（下拉选项）忽略
        ignoreMutation: (m) => {
          if (m.type === "selection") return false;
          // 注意：这里的 Node 是 DOM 的 Node（文件顶部的 Node 来自 @tiptap/core）
          const target: unknown = m.target;
          return !(target instanceof globalThis.Node && content.contains(target));
        },
      };
    };
  },
});
