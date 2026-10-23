/**
 * UBB/BBCODE → Markdown 转换器 v2（M5.5）
 *
 * 相对 v1（migration/src/ubb.ts）的变化：
 *  - 门控：[sell=N,…] → points 门控，[post] / [hide] → reply 门控；隐藏内容拆出为 GateDraft，md 只留占位
 *  - 表情：[s:N] 展开为静态资源 /emoji/{id}.gif；映射外的遗留码（旧站自己也渲染不出）直接删除
 *  - 站内链接：job.php?action=topost / read.php / thread.php → /t/.. /f/..；回到原帖图标 → 「↩ 原帖」
 *  - 旧站内部图片 p_w_upload/… → /attachment/…（以磁盘实际存在为准），p_w_picpath/ 内置图丢弃
 *  - table → Markdown 表格；hr → ---；sup/sub 保留；媒体标签降级为链接
 *
 * 门控的安全不变量（有专门的性质测试）：被拆出的隐藏内容绝不会出现在 md 中。
 * 位于引用/列表/表格等非顶层位置的门控，宁可丢弃内容也不留在公开正文里。
 *
 * 策略：树解析（未闭合标签自动收拢，未匹配闭合标签按字面量处理），未知标签剥壳留肉。
 */
import type { GateDraft } from "./types.js";
import { MAX_GATES_PER_POST } from "./gate-syntax.js";

export interface UbbContext {
  /** 有静态资源的表情 id（旧站 120–169）；其余 [s:N] 视为遗留码并删除 */
  emojiIds: ReadonlySet<number>;
  /** 表情 id → 静态地址，默认 /emoji/{id}.gif */
  emojiUrl?: (id: number) => string;
  /** [attachment=N] → 附件元数据，渲染为 /attachment/{path} */
  resolveAttachment?: (aid: number) => { name: string; path: string } | null;
  /** 相对 attachment/ 的路径在磁盘上是否存在（p_w_upload 改写依据）；缺省视为不存在 */
  attachmentExists?: (relPath: string) => boolean;
  /** 站内域名（小写、不含 www.），用于识别站内链接，默认 qingyisub.com / qingyisub.top */
  siteHosts?: readonly string[];
  /** 门控 id 分配：迁移用确定性公式 postId*16+seq */
  allocateGateId: (seq: number) => number;
  /** 价格 ≥ 该值的 [sell] 一律改为免费（站长决策：旧「9999」是永不可买的占位），默认 9999 */
  freeAbovePrice?: number;
}

export type ConvertWarningCode =
  | "emoji-legacy-stripped"
  | "gate-nested-dropped"
  | "gate-unclosed"
  | "gate-empty-dropped"
  | "gate-price-invalid"
  | "gate-price-reset"
  | "level-stripped"
  | "image-dropped"
  | "image-unresolved";

export interface ConvertWarning {
  code: ConvertWarningCode;
  detail?: string;
}

export interface ConvertResult {
  /** 公开 Markdown（含门控占位） */
  md: string;
  gates: GateDraft[];
  warnings: ConvertWarning[];
}

interface Node {
  tag?: string;
  arg?: string;
  text?: string;
  children: Node[];
  /** 是否被匹配的闭合标签正常闭合 */
  closed?: boolean;
}

const TAG_RE = /\[(\/?)([a-zA-Z]+)(?:=([^\][\n]*))?\]/g;
const EMO_RE = /\[s:(\d+)\]/gi;
/** 没有闭合标签的标签：不入栈，避免吞掉后续内容 */
const VOID_TAGS = new Set(["HR", "BR"]);

function parse(src: string): Node {
  const root: Node = { children: [] };
  const stack: Node[] = [root];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(src)) !== null) {
    const [full, slash, rawTag, rawArg] = m;
    const tag = rawTag!.toUpperCase();
    const top = stack[stack.length - 1]!;
    if (m.index > last) top.children.push({ text: src.slice(last, m.index), children: [] });
    last = m.index + full.length;
    if (!slash) {
      const node: Node = { tag, arg: rawArg, children: [] };
      top.children.push(node);
      if (VOID_TAGS.has(tag)) node.closed = true;
      else stack.push(node);
    } else {
      let idx = -1;
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tag === tag) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        top.children.push({ text: full, children: [] });
        continue;
      }
      stack[idx]!.closed = true;
      // 未正常闭合的内层节点保持挂在原位（内容不丢），栈截断到匹配层
      stack.length = idx;
    }
  }
  if (last < src.length)
    stack[stack.length - 1]!.children.push({ text: src.slice(last), children: [] });
  return root;
}

const MEDIA_TAGS = new Set(["WMV", "RM", "RMVB", "FLASH", "MEDIA", "MP3", "AVI"]);
/** 转换器认识的全部标签；其余为未知标签（剥壳留肉，对门控位置判定透明） */
const KNOWN_TAGS = new Set([
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "S",
  "STRIKE",
  "DEL",
  "SUP",
  "SUB",
  "HR",
  "BR",
  "COLOR",
  "BACKCOLOR",
  "SIZE",
  "FONT",
  "ALIGN",
  "QUOTE",
  "CODE",
  "URL",
  "IMG",
  "EMAIL",
  "ATTACHMENT",
  "SELL",
  "POST",
  "HIDE",
  "LEVEL",
  "LIST",
  "TABLE",
  "TR",
  "TD",
  "TH",
  ...MEDIA_TAGS,
]);
/**
 * 旧站里经常不写闭合标签的标签（[attachment=N]、列表项 [li]、媒体、站内自定义标签）。
 * 未闭合时它们**不包裹**后续内容：自身渲染后，原本被收进去的子节点提升为同级。
 * 否则 [attachment=N] 之后的整段正文会被当作它的子节点而丢失（v1 的数据丢失缺陷）。
 */
const UNWRAP_WHEN_UNCLOSED = (tag: string) =>
  tag === "ATTACHMENT" || tag === "LI" || MEDIA_TAGS.has(tag) || !KNOWN_TAGS.has(tag);

function unwrapUnclosed(node: Node): void {
  const out: Node[] = [];
  for (const c of node.children) {
    unwrapUnclosed(c);
    if (c.tag && !c.closed && c.children.length > 0 && UNWRAP_WHEN_UNCLOSED(c.tag)) {
      const { children, ...self } = c;
      out.push({ ...self, children: [], closed: true }, ...children);
    } else {
      out.push(c);
    }
  }
  node.children = out;
}
const GATE_TAGS = new Set(["SELL", "POST", "HIDE"]);
/** 样式包装：不改变「是否顶层」，门控可以穿过它们被提升为顶层块 */
const TRANSPARENT = new Set([
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "S",
  "STRIKE",
  "DEL",
  "COLOR",
  "BACKCOLOR",
  "SIZE",
  "FONT",
  "ALIGN",
]);
// phpwind [size=1..7] 语义 → px；超出按 px 直读
const SIZE_PX: Record<string, number> = {
  "1": 12,
  "2": 14,
  "3": 16,
  "4": 18,
  "5": 20,
  "6": 24,
  "7": 32,
};

const DEFAULT_SITE_HOSTS = ["qingyisub.com", "qingyisub.top"];

/** 颜色值白名单：命名色 / 十六进制 / rgb()、hsl()；其余（含任何其它函数调用）一律丢弃 */
function safeCss(v: string | undefined): string {
  const t = (v ?? "").replace(/[^#\w(),.%\s-]/g, "").trim();
  if (t.includes("(")) return /^(?:rgb|rgba|hsl|hsla)\(\s*[\d\s,.%]+\)$/i.test(t) ? t : "";
  return t;
}

function blockquote(inner: string): string {
  return (
    "\n" +
    inner
      .trim()
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n") +
    "\n"
  );
}

interface State {
  ctx: UbbContext;
  gates: GateDraft[];
  warnings: ConvertWarning[];
  seq: number;
}

interface Env {
  /** top = 位于文档顶层（可提升为门控）；nested = 位于引用/列表/表格等容器内 */
  pos: "top" | "nested";
  /** 正在渲染某个门控的隐藏内容：内部再出现的门控直接并入该门控 */
  inGate: boolean;
  /** 代码块：不展开表情 */
  raw: boolean;
  /** 最近的非样式容器标签（QUOTE / LIST / TABLE / URL …），仅用于告警诊断 */
  container?: string;
}

// ---------- URL 与图片 ----------

const TOPOST_RE = /job\.php\?action=topost;tid=(\d+);pid=(\d+)/i;
const READ_RE = /read\.php\?(?:[^#\s]*&)?tid=(\d+)/i;
const THREAD_RE = /thread\.php\?(?:[^#\s]*&)?fid=(\d+)/i;
const UPLOAD_RE = /(?:^|\/)p_w_upload\/(.+)$/i;

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/[\s"']/g, "");
}

function isSiteUrl(u: string, hosts: readonly string[]): boolean {
  const m = /^https?:\/\/(?:www\.)?([^/:?#]+)/i.exec(u);
  return !!m && hosts.includes(m[1]!.toLowerCase());
}

/** 站内链接改写；返回 null 表示不是可识别的站内形态 */
function rewriteInternalLink(u: string, hosts: readonly string[]): string | null {
  const relative = !/^[a-z]+:\/\//i.test(u);
  if (!relative && !isSiteUrl(u, hosts)) return null;
  const topost = TOPOST_RE.exec(u);
  if (topost) return `/t/${topost[1]}#p${topost[2]}`;
  const read = READ_RE.exec(u);
  if (read) {
    const pid = /[?&;]pid=(\d+)/i.exec(u);
    return pid ? `/t/${read[1]}#p${pid[1]}` : `/t/${read[1]}`;
  }
  const thread = THREAD_RE.exec(u);
  if (thread) return `/f/${thread[1]}`;
  return null;
}

/** p_w_upload/… → /attachment/…（仅当文件存在）；返回 null 表示不是该形态或文件不存在 */
function rewriteUpload(u: string, st: State): { url: string | null; matched: boolean } {
  const hosts = st.ctx.siteHosts ?? DEFAULT_SITE_HOSTS;
  const relative = !/^[a-z]+:\/\//i.test(u);
  if (!relative && !isSiteUrl(u, hosts)) return { url: null, matched: false };
  const m = UPLOAD_RE.exec(u.split(/[?#]/)[0]!);
  if (!m) return { url: null, matched: false };
  const rel = decodeURIComponent(m[1]!);
  const exists = st.ctx.attachmentExists?.(rel) ?? false;
  return { url: exists ? `/attachment/${rel}` : null, matched: true };
}

function safeUrl(u: string): string {
  const t = normalizeUrl(u);
  if (/^(https?:\/\/|ftp:\/\/|\/|\.\/|\.\.\/|#)/i.test(t)) return t;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(t)) return `http://${t}`; // 裸域名补协议
  return "";
}

function resolveHref(raw: string, st: State): string {
  const t = normalizeUrl(raw);
  const hosts = st.ctx.siteHosts ?? DEFAULT_SITE_HOSTS;
  const internal = rewriteInternalLink(t, hosts);
  if (internal) return internal;
  const up = rewriteUpload(t, st);
  if (up.matched && up.url) return up.url;
  return safeUrl(t);
}

function renderImage(raw: string, inner: string, st: State): string {
  const t = normalizeUrl(raw);
  if (/(?:^|\/)p_w_picpath\/back\.gif$/i.test(t)) return "↩ 原帖";
  if (/(?:^|\/)p_w_picpath\//i.test(t)) {
    st.warnings.push({ code: "image-dropped", detail: t });
    return "";
  }
  const up = rewriteUpload(t, st);
  if (up.matched) {
    if (up.url) return `![img](${up.url})`;
    st.warnings.push({ code: "image-unresolved", detail: t });
    const keep = safeUrl(t);
    return keep ? `![img](${keep})` : "";
  }
  const url = safeUrl(t);
  return url ? `![img](${url})` : inner.trim() ? `\n${inner.trim()}\n` : "";
}

// ---------- 门控 ----------

function parsePrice(arg: string | undefined): number | null {
  const m = /^\s*(\d+)/.exec(arg ?? "");
  return m ? Number(m[1]) : null;
}

function renderGate(n: Node, st: State): string {
  const tag = n.tag!;
  const hidden = renderChildren(n, st, { pos: "nested", inGate: true, raw: false })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (hidden === "") {
    st.warnings.push({ code: "gate-empty-dropped", detail: tag });
    return "";
  }

  let condition: GateDraft["conditions"][number];
  if (tag === "SELL") {
    const free = st.ctx.freeAbovePrice ?? 9999;
    let price = parsePrice(n.arg);
    if (price === null) {
      st.warnings.push({ code: "gate-price-invalid", detail: n.arg ?? "" });
      price = 0;
    } else if (price >= free) {
      st.warnings.push({ code: "gate-price-reset", detail: String(price) });
      price = 0;
    }
    condition = { type: "points", price };
  } else {
    condition = { type: "reply" };
  }

  const seq = ++st.seq;
  if (seq > MAX_GATES_PER_POST) throw new RangeError(`一个帖子最多 ${MAX_GATES_PER_POST} 个门控`);
  const id = st.ctx.allocateGateId(seq);
  st.gates.push({ id, seq, conditions: [condition], matchMode: "all", hiddenMd: hidden });
  return `\n\n:::gate{id="${id}"}\n:::\n\n`;
}

// ---------- 渲染 ----------

const GATE_PLACEHOLDER_RE = /(\n\n:::gate\{id="\d+"\}\n:::\n\n)/;

/**
 * 样式包装：门控占位必须保持顶层独立块（不能被塞进 HTML 标签里，否则无法被识别为门控）。
 * 内容含占位时，只包裹占位两侧的文本段，占位原样提升到包装之外。
 */
function wrap(inner: string, fn: (s: string) => string): string {
  if (!GATE_PLACEHOLDER_RE.test(inner)) return fn(inner);
  return inner
    .split(GATE_PLACEHOLDER_RE)
    .map((part, i) => (i % 2 === 1 ? part : part.trim() === "" ? "" : fn(part)))
    .join("");
}

function renderChildren(n: Node, st: State, env: Env): string {
  return n.children.map((c) => render(c, st, env)).join("");
}

function renderTable(n: Node, st: State, env: Env): string {
  const rows = n.children.filter((c) => c.tag === "TR");
  if (rows.length === 0) return renderChildren(n, st, env);
  const cellText = (c: Node) =>
    renderChildren(c, st, env)
      .replace(/\s*\n\s*/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
  const grid = rows.map((r) =>
    r.children.filter((c) => c.tag === "TD" || c.tag === "TH").map(cellText),
  );
  const width = Math.max(...grid.map((r) => r.length), 1);
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  const [head, ...body] = grid as [string[], ...string[][]];
  return [
    "",
    line(head),
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map(line),
    "",
  ].join("\n");
}

function render(n: Node, st: State, env: Env): string {
  if (n.text !== undefined) {
    if (env.raw) return n.text;
    return n.text.replace(EMO_RE, (_whole, num: string) => {
      const id = Number(num);
      if (st.ctx.emojiIds.has(id)) {
        const url = st.ctx.emojiUrl?.(id) ?? `/emoji/${id}.gif`;
        return `![表情](${url})`;
      }
      st.warnings.push({ code: "emoji-legacy-stripped", detail: num });
      return "";
    });
  }

  const tag = n.tag!;

  // 门控标签：顶层提升为门控；门控内并入；容器内丢弃；未闭合当作普通文本
  if (GATE_TAGS.has(tag)) {
    if (env.inGate) return renderChildren(n, st, env);
    // 失败即封闭：门控标签缺少闭合时，把它到所在容器末尾的内容都当作隐藏内容，
    // 绝不把子节点渲染进公开输出。旧库实证（tid 2023：未闭合的 [sell] 有 22 条购买记录）说明
    // 旧站确实把这类帖子当作付费帖处理。仍记录告警，供站长复核。
    if (!n.closed) st.warnings.push({ code: "gate-unclosed", detail: tag });
    if (env.pos === "top") return renderGate(n, st);
    st.warnings.push({ code: "gate-nested-dropped", detail: `${tag} in ${env.container ?? "?"}` });
    return "\n\n🔒 （此处原有隐藏内容，已省略）\n\n";
  }

  // 门控位置判定：样式包装、未知标签、未正常闭合的标签都是透明的（只有真正闭合的容器才算「嵌套」）
  const transparent = TRANSPARENT.has(tag) || !KNOWN_TAGS.has(tag) || n.closed !== true;
  const childEnv: Env = transparent ? env : { ...env, pos: "nested", container: tag };
  const inner = renderChildren(n, st, tag === "CODE" ? { ...childEnv, raw: true } : childEnv);

  switch (tag) {
    case "B":
    case "STRONG":
      return wrap(inner, (x) => `**${x.trim() || x}**`);
    case "I":
    case "EM":
      return wrap(inner, (x) => `*${x.trim() || x}*`);
    case "U":
      return wrap(inner, (x) => `<u>${x}</u>`);
    case "S":
    case "STRIKE":
    case "DEL":
      return wrap(inner, (x) => `<s>${x}</s>`);
    case "SUP":
      return `<sup>${inner}</sup>`;
    case "SUB":
      return `<sub>${inner}</sub>`;
    case "HR":
      return "\n\n---\n\n";
    case "BR":
      return "\n";
    case "COLOR": {
      const c = safeCss(n.arg);
      return c ? wrap(inner, (x) => `<span style="color:${c}">${x}</span>`) : inner;
    }
    case "BACKCOLOR": {
      const c = safeCss(n.arg);
      return c ? wrap(inner, (x) => `<span style="background-color:${c}">${x}</span>`) : inner;
    }
    case "SIZE": {
      const v = (n.arg ?? "").trim();
      const px = SIZE_PX[v] ?? (/^\d{2,3}$/.test(v) ? Number(v) : 0);
      return px ? wrap(inner, (x) => `<span style="font-size:${px}px">${x}</span>`) : inner;
    }
    case "ALIGN": {
      const a = /center/i.test(n.arg ?? "")
        ? "center"
        : /right/i.test(n.arg ?? "")
          ? "right"
          : "left";
      return wrap(inner, (x) => `\n<div style="text-align:${a}">${x.trim()}</div>\n`);
    }
    case "FONT":
      return inner; // 字体族不保留
    case "QUOTE":
      return wrap(inner, blockquote);
    case "CODE":
      return "\n```\n" + inner.replace(/^\n+|\n+$/g, "") + "\n```\n";
    case "URL": {
      const url = resolveHref(n.arg?.trim() || inner, st);
      const label = inner.trim() || n.arg?.trim() || url;
      return url ? `[${label}](${url})` : label;
    }
    case "IMG":
      return renderImage(n.arg?.trim() || inner, inner, st);
    case "EMAIL": {
      const a = (n.arg?.trim() || inner.trim()).replace(/[^\w.@+-]/g, "");
      return a ? `[${inner.trim() || a}](mailto:${a})` : inner;
    }
    case "ATTACHMENT": {
      const aid = parseInt((n.arg ?? inner).trim(), 10);
      if (!Number.isFinite(aid)) return inner;
      const att = st.ctx.resolveAttachment?.(aid);
      const link = att ? `[📎 ${att.name}](/attachment/${att.path})` : `[附件 #${aid}]`;
      return n.arg !== undefined && inner.trim() ? `${link}${inner}` : link;
    }
    case "LEVEL":
      st.warnings.push({ code: "level-stripped", detail: n.arg });
      return inner; // 等级体系已取消：去掉标签，内容公开
    case "LIST":
      return (
        "\n" +
        inner
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => (l.startsWith("- ") ? l : `- ${l.replace(/^\[\*\]\s*/, "")}`))
          .join("\n") +
        "\n"
      );
    case "TABLE":
      return renderTable(n, st, childEnv);
    case "TR":
    case "TD":
    case "TH":
      return inner;
    default:
      if (MEDIA_TAGS.has(tag)) {
        // 媒体标签的参数是宽高/自动播放等设置，URL 在内容里；参数仅作兜底
        const url = safeUrl(inner) || safeUrl(n.arg?.trim() ?? "");
        return url ? `\n\n[🎬 媒体](${url})\n\n` : inner;
      }
      return inner; // 未知标签：剥壳留肉
  }
}

export function ubbToMarkdown(input: string | null | undefined, ctx: UbbContext): ConvertResult {
  const st: State = { ctx, gates: [], warnings: [], seq: 0 };
  if (!input) return { md: "", gates: [], warnings: [] };
  const src = input.replace(/\r\n?/g, "\n");
  // 根节点没有 tag：直接渲染其子节点，保持顶层语义（不能走 render，否则会被当成非透明容器）
  const tree = parse(src);
  unwrapUnclosed(tree);
  const md = renderChildren(tree, st, { pos: "top", inGate: false, raw: false })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { md, gates: st.gates, warnings: st.warnings };
}
