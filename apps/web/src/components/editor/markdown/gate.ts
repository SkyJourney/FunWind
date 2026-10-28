import { Node, mergeAttributes, type JSONContent } from "@tiptap/core";
import { listConditionUi } from "@funwind/content";

/**
 * 门控节点（M6.3）：编辑器里的 `:::gate{key="…" unlock="…" price="…"}` 容器块。
 *
 * 这里只负责数据与 Markdown 语法（分词、解析、渲染）；节点视图（下拉、价格输入、锁图标）在第 3 步加入。
 * 语法的权威仍是服务端 `splitSource`：本模块只是编辑体验，保存时一律以服务端拆分的结果为准。
 *
 * 围栏长度：外层围栏可以是 3 个以上冒号。内层的 `:::` 只有在外层用更长的围栏（如 `::::`）时才会被包住，
 * 因此分词器要求闭合围栏与开头的围栏长度完全相同，渲染时若正文里出现 `:::` 行则自动把外层加长一个冒号。
 */

/** 编辑器里一种可选的解锁方式（来自 packages/content 的条件目录） */
export type GateConditionOption = ReturnType<typeof listConditionUi>[number];

/**
 * 锁定内容块的属性（与 packages/content 的 GateDraft 对齐，编辑器内只用字符串）。
 * `params` 是解锁条件的参数字典（积分解锁的 price 等）：具体有哪些参数由条件目录描述，
 * 所以新增一种条件不需要改这个节点。
 */
export interface GateAttrs {
  key: string;
  unlock: string;
  match: string;
  params: Record<string, string>;
}

/** 新建锁定内容块的默认属性：取目录里的第一种解锁方式及其参数默认值 */
export function defaultGateAttrs(
  key: string,
  conditions: readonly GateConditionOption[] = listConditionUi(),
): GateAttrs {
  const first = conditions[0];
  const params: Record<string, string> = {};
  for (const f of first?.fields ?? []) params[f.name] = f.defaultValue;
  return { key, unlock: first?.type ?? "points", match: "", params };
}

const RESERVED = new Set(["key", "unlock", "match"]);

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

export const Gate = Node.create<{ conditions: readonly GateConditionOption[] }>({
  name: "gate",

  addOptions() {
    // 解锁方式目录：默认取 packages/content 的内置规格；测试 / 将来的新条件可经 configure 注入
    return { conditions: listConditionUi() };
  },
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      key: { default: "" },
      unlock: { default: "points" },
      match: { default: "" },
      params: { default: {} },
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
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(a)) if (!RESERVED.has(k)) params[k] = v;
    const attrs: GateAttrs = {
      key: a.key ?? "",
      unlock: a.unlock ?? "points",
      match: a.match ?? "",
      params,
    };
    return { type: "gate", attrs, content: helpers.parseChildren(children) };
  },

  renderMarkdown(node: JSONContent, helpers) {
    const attrs = (node.attrs ?? {}) as Partial<GateAttrs>;
    const unlock = attrs.unlock || "points";
    const params = attrs.params ?? {};
    const parts: string[] = [];
    if (attrs.key) parts.push(`key="${attrs.key}"`);
    parts.push(`unlock="${unlock}"`);
    const known = this.options.conditions.find((c) => c.type === unlock);
    if (known) {
      // 目录里认识的解锁方式：只写它声明的参数（切换解锁方式后残留的别家参数不写出）；留空按字段约定写出（如价格空按 0）
      for (const f of known.fields) {
        const v = params[f.name];
        if (v !== undefined && v !== "") parts.push(`${f.name}="${v}"`);
        else if (f.emptyValue !== undefined) parts.push(`${f.name}="${f.emptyValue}"`);
      }
    } else {
      // 目录里没有的解锁方式（旧数据 / 将来的条件）：原样保留全部参数，编辑器不替它丢信息
      for (const [k, v] of Object.entries(params)) parts.push(`${k}="${v}"`);
    }
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
    const conditions = this.options.conditions;
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
      lock.textContent = "🔒 锁定内容";

      // 解锁方式：按条件目录生成选项
      const select = document.createElement("select");
      select.setAttribute("aria-label", "解锁方式");
      for (const c of conditions) {
        const opt = new Option(c.label, c.type);
        opt.title = c.hint;
        select.add(opt);
      }

      // 该解锁方式的参数输入：由目录的字段描述生成，解锁方式变化时重建
      const fields = document.createElement("span");
      fields.className = "fw-gate-fields";

      const content = document.createElement("div");
      content.className = "fw-gate-content";

      head.append(lock, select, fields);
      dom.append(head, content);

      const patch = (attrs: Partial<GateAttrs>) => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(
          editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }),
        );
      };
      select.addEventListener("change", () => {
        // 换解锁方式：参数回到新方式的默认值（旧方式的参数不带过去）
        const next = conditions.find((c) => c.type === select.value);
        const params: Record<string, string> = {};
        for (const f of next?.fields ?? []) params[f.name] = f.defaultValue;
        patch({ unlock: select.value, params });
      });

      let renderedFor: string | null = null;
      const buildFields = (unlock: string) => {
        fields.replaceChildren();
        const cond = conditions.find((c) => c.type === unlock);
        for (const f of cond?.fields ?? []) {
          const input = document.createElement("input");
          input.type = "number";
          input.min = String(f.min);
          input.max = String(f.max);
          input.step = "1";
          input.inputMode = "numeric";
          input.placeholder = f.label;
          input.name = f.name;
          input.setAttribute("aria-label", f.label);
          input.addEventListener("change", () => {
            const current = (node.attrs.params ?? {}) as Record<string, string>;
            patch({ params: { ...current, [f.name]: input.value } });
          });
          fields.append(input);
        }
        renderedFor = unlock;
      };

      const sync = (n: typeof node) => {
        const unlock = String(n.attrs.unlock || "points");
        // 目录里没有的解锁方式（旧数据 / 将来的条件）：临时补一个同名选项，显示的就是文档里的值
        if (![...select.options].some((o) => o.value === unlock))
          select.add(new Option(unlock, unlock));
        select.value = unlock;
        if (renderedFor !== unlock) buildFields(unlock);
        const params = (n.attrs.params ?? {}) as Record<string, string>;
        for (const input of fields.querySelectorAll<HTMLInputElement>("input"))
          input.value = params[input.name] ?? "";
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
