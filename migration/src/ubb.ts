/**
 * UBB/BBCODE → Markdown 转换器
 * 标签清单来自对旧库 36,771 行正文的实测统计（2026-10-23）：
 *   FONT 13844 / SIZE 12022 / COLOR 11865 / URL 2457 / QUOTE 2212 /
 *   BACKCOLOR 1464 / ALIGN 1354 / ATTACHMENT 377 / SELL 334 / TD 225 /
 *   WMV 86 / EMAIL 43 / SKIP 31 / TABLE 28 / FLASH 28 / HIDE 8 / CODE 8 /
 *   LIST 2 / IMG 2 / LEVEL 2 + [s:N] 表情码
 * 策略：树解析（未闭合标签自动收拢，未匹配闭合标签按字面量处理），
 *       未知标签剥壳留肉；content_raw 永远保留原文可回滚。
 */

export interface UbbContext {
  /** [s:N] → { folder, icon }，渲染为 /emotion/{folder}/{icon} */
  emoticons: Map<number, { folder: string; icon: string }>;
  /** [attachment=N] → 附件元数据，渲染为 /attachment/{path} */
  resolveAttachment?: (aid: number) => { name: string; path: string } | null;
}

interface Node {
  tag?: string;
  arg?: string;
  text?: string;
  children: Node[];
}

const TAG_RE = /\[(\/?)([a-zA-Z]+)(?:=([^\][\n]*))?\]/g;
const EMO_RE = /\[s:(\d+)\]/gi;

function parse(src: string): Node {
  const root: Node = { children: [] };
  const stack: Node[] = [root];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src)) !== null) {
    const [full, slash, rawTag, rawArg] = m;
    const tag = rawTag.toUpperCase();
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ text: src.slice(last, m.index), children: [] });
    last = m.index + full.length;
    if (!slash) {
      const node: Node = { tag, arg: rawArg, children: [] };
      top.children.push(node);
      stack.push(node);
    } else {
      let idx = -1;
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === tag) { idx = i; break; }
      }
      if (idx === -1) { top.children.push({ text: full, children: [] }); continue; }
      // 未正常闭合的内层节点保持挂在原位（内容不丢），栈截断到匹配层
      stack.length = idx;
    }
  }
  if (last < src.length) stack[stack.length - 1].children.push({ text: src.slice(last), children: [] });
  return root;
}

const MEDIA_TAGS = new Set(['WMV', 'RM', 'RMVB', 'FLASH', 'MEDIA', 'MP3', 'AVI']);
// phpwind [size=1..7] 语义 → px；超出按 px 直读
const SIZE_PX: Record<string, number> = { '1': 12, '2': 14, '3': 16, '4': 18, '5': 20, '6': 24, '7': 32 };

function safeUrl(u: string): string {
  const t = u.trim().replace(/[\s"']/g, '');
  if (/^(https?:\/\/|ftp:\/\/|\/|\.\/|\.\.\/|#)/i.test(t)) return t;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return `http://${t}`; // 裸域名补协议
  return '';
}
function safeCss(v: string | undefined): string {
  return (v ?? '').replace(/[^#\w(),.%\s-]/g, '').trim();
}
function blockquote(inner: string): string {
  return '\n' + inner.trim().split('\n').map((l) => `> ${l}`).join('\n') + '\n';
}

function render(n: Node, ctx: UbbContext): string {
  if (n.text !== undefined) return n.text;
  const inner = n.children.map((c) => render(c, ctx)).join('');
  switch (n.tag) {
    case 'B': case 'STRONG': return `**${inner.trim() || inner}**`;
    case 'I': case 'EM': return `*${inner.trim() || inner}*`;
    case 'U': return `<u>${inner}</u>`;
    case 'S': case 'STRIKE': case 'DEL': return `<s>${inner}</s>`;
    case 'COLOR': { const c = safeCss(n.arg); return c ? `<span style="color:${c}">${inner}</span>` : inner; }
    case 'BACKCOLOR': { const c = safeCss(n.arg); return c ? `<span style="background-color:${c}">${inner}</span>` : inner; }
    case 'SIZE': {
      const v = (n.arg ?? '').trim();
      const px = SIZE_PX[v] ?? (/^\d{2,3}$/.test(v) ? Number(v) : 0);
      return px ? `<span style="font-size:${px}px">${inner}</span>` : inner;
    }
    case 'ALIGN': {
      const a = /center/i.test(n.arg ?? '') ? 'center' : /right/i.test(n.arg ?? '') ? 'right' : 'left';
      return `\n<div style="text-align:${a}">${inner.trim()}</div>\n`;
    }
    case 'FONT': return inner; // 字体族不保留
    case 'QUOTE': return blockquote(inner);
    case 'CODE': return '\n```\n' + inner.replace(/^\n+|\n+$/g, '') + '\n```\n';
    case 'URL': {
      const url = safeUrl(n.arg?.trim() || inner);
      const label = inner.trim() || n.arg?.trim() || url;
      return url ? `[${label}](${url})` : label;
    }
    case 'IMG': {
      const url = safeUrl(n.arg?.trim() || inner);
      return url ? `![img](${url})` : (inner.trim() ? `\n${inner.trim()}\n` : '');
    }
    case 'EMAIL': {
      const a = (n.arg?.trim() || inner.trim()).replace(/[^\w.@+-]/g, '');
      return a ? `[${inner.trim() || a}](mailto:${a})` : inner;
    }
    case 'ATTACHMENT': {
      const aid = parseInt((n.arg ?? inner).trim(), 10);
      if (!Number.isFinite(aid)) return inner;
      const att = ctx.resolveAttachment?.(aid);
      return att ? `[📎 ${att.name}](/attachment/${att.path})` : `[附件 #${aid}]`;
    }
    case 'SELL': {
      const price = (n.arg ?? '').trim();
      return blockquote(`💰 付费内容${price ? `（${price}）` : ''}，购买后可见\n\n${inner}`);
    }
    case 'HIDE': return blockquote('🔒 回复本帖后可见');
    case 'LEVEL': return blockquote(`🔒 需要等级 ${n.arg ?? '?'} 才能查看`);
    case 'LIST':
      return '\n' + inner.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => (l.startsWith('- ') ? l : `- ${l.replace(/^\[\*\]\s*/, '')}`)).join('\n') + '\n';
    case 'TABLE': case 'TR': case 'TD': return inner; // 28 处，保内容即可
    default:
      if (MEDIA_TAGS.has(n.tag ?? '')) {
        const url = safeUrl(n.arg?.trim() || inner);
        return `\n\n🎬 嵌入媒体${n.arg ? `（${n.arg}）` : ''}${url ? `：${url}` : ''}\n\n`;
      }
      return inner; // 未知标签：剥壳留肉
  }
}

export function ubbToMarkdown(input: string | null | undefined, ctx: UbbContext): string {
  if (!input) return '';
  const src = input.replace(/\r\n?/g, '\n');
  let out = render(parse(src), ctx);
  // [s:N] 表情码 → 表情图（树上不存在该标签形态，统一后置替换）
  out = out.replace(EMO_RE, (whole, num: string) => {
    const e = ctx.emoticons.get(Number(num));
    return e ? `![表情](/emotion/${e.folder}/${e.icon})` : whole;
  });
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
