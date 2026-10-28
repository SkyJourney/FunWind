import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { CODE_LANGUAGES, lowlight } from "@/lib/highlight";

/**
 * 编辑器的代码块（M10.8 Step 5）：带语言下拉，编辑区内按语言高亮。
 *
 * 高亮与渲染侧共用同一个 lowlight（`lib/highlight.ts`），所以编辑区的颜色就是发布后的颜色。
 * 扩展自带的高亮在「没写语言」时会自动探测语言，而渲染侧不做探测（纯文本），两边会不一致——
 * 所以交给扩展的是一个把 highlightAuto 换成「原样输出文本」的包装对象。
 *
 * 序列化沿用代码块节点自己的规则：有语言写 ```lang，没有写 ```。语言下拉只改节点属性。
 */
const noAutoDetect = {
  highlight: lowlight.highlight.bind(lowlight),
  highlightAuto: (value: string) => ({
    type: "root" as const,
    children: [{ type: "text" as const, value }],
    data: { language: "plaintext" },
  }),
  listLanguages: lowlight.listLanguages.bind(lowlight),
  registered: lowlight.registered.bind(lowlight),
  register: lowlight.register.bind(lowlight),
  registerAlias: lowlight.registerAlias.bind(lowlight),
};

export const CodeBlock = CodeBlockLowlight.configure({
  lowlight: noAutoDetect as unknown as typeof lowlight,
  defaultLanguage: null,
}).extend({
  /**
   * 节点视图：右上角语言下拉（不可编辑的头部，stopEvent 让它的事件不进入编辑器），代码在 <pre><code> 里。
   * 当前语言不在下拉里（作者手写的别名如 js）时，临时补一个同名选项，保证显示的就是文档里的值。
   */
  addNodeView() {
    return ({ node: initialNode, getPos, editor }) => {
      let node = initialNode;

      const dom = document.createElement("div");
      dom.className = "fw-codeblock";

      const select = document.createElement("select");
      select.contentEditable = "false";
      select.setAttribute("aria-label", "代码语言");
      select.add(new Option("纯文本", ""));
      for (const l of CODE_LANGUAGES) select.add(new Option(l.label, l.value));

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.append(code);
      dom.append(select, pre);

      const sync = () => {
        const lang = (node.attrs.language as string | null) ?? "";
        if (lang && !CODE_LANGUAGES.some((l) => l.value === lang)) {
          if (![...select.options].some((o) => o.value === lang))
            select.add(new Option(lang, lang));
        }
        select.value = lang;
      };
      sync();

      select.addEventListener("change", () => {
        const pos = getPos();
        if (typeof pos !== "number") return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, {
            ...node.attrs,
            language: select.value || null,
          }),
        );
        editor.view.focus();
      });

      return {
        dom,
        contentDOM: code,
        update(updated) {
          if (updated.type !== node.type) return false;
          node = updated;
          sync();
          return true;
        },
        stopEvent: (event) => event.target === select,
        ignoreMutation: (mutation) =>
          mutation.target === select || select.contains(mutation.target),
      };
    };
  },
});
