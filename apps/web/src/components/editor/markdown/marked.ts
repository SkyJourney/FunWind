import { Marked, Tokenizer, type Tokens } from "marked";

/**
 * 编辑器用的 marked 实例（M6.3）。Tiptap 的 Markdown 扩展基于 marked 解析，而站点的渲染器基于 remark；
 * 两者对若干语法的理解不完全一致，这里修正的是会改写内容的几处（都经公开的 tokenizer 扩展点注入）：
 *
 * 1. 删除线：marked 默认把 `~x~` 也当删除线；中文语气词 `握爪~我也是~` 不是删除线（迁移库 1136 篇含单个 `~`）。
 *    只识别 `~~x~~`（与 GFM 一致），单个 `~` 不产生 token，落回普通文字。
 * 2. 段落内的换行：站点渲染器（remark-breaks）把段落里的单个 `\n` 显示为换行；marked 把它留在文本里，
 *    编辑器里会变成空格，换行就丢了。这里产生硬换行词元 `br`（编辑器的 HardBreak 节点）。
 *
 * 关于第 2 条的实现：marked 会把 `inlineText` 返回的词元并入前一个文本词元，所以换行词元不能从 `inlineText` 产生
 * （那样会得到字符串 "undefined"）。换行由独立的 `br` 规则产生；`inlineText` 只负责换行之前的文本。
 *
 * 不访问任何内部实例：`Tokenizer.prototype.inlineText` 是 marked 的公开类，这里只用它处理换行之前的文本。
 */

/** 双波浪线的删除线：内容首尾不是空白或 ~，闭合的 ~~ 后面不能再接 ~（与 GFM 一致） */
const DEL_RE = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?=[^~]|$)/;

export function createEditorMarked(): Marked {
  const marked = new Marked();
  marked.use({
    tokenizer: {
      del(src: string): Tokens.Del | undefined {
        const m = DEL_RE.exec(src);
        if (!m || m[1] === undefined) return undefined;
        return {
          type: "del",
          raw: m[0],
          text: m[1],
          tokens: this.lexer.inlineTokens(m[1]),
        };
      },
      // 位置恰好是换行符时产生硬换行；其它情况（如 `  \n`）回落到 marked 默认的 br 规则
      br(src: string): Tokens.Br | false {
        return src.startsWith("\n") ? { type: "br", raw: "\n" } : false;
      },
      // 文本只到下一个换行为止（换行由 br 规则处理），其余交给 marked 原有的文本规则，保证加粗、斜体、转义不受影响
      inlineText(src: string): Tokens.Text | false {
        const nl = src.indexOf("\n");
        if (nl < 0) return false;
        return Tokenizer.prototype.inlineText.call(this, src.slice(0, nl)) ?? false;
      },
    },
  });
  return marked;
}
