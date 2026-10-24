/**
 * UBB/BBCODE → Markdown 转换器（迁移适配用）
 *
 *  - 门控：[sell=N,…] → points 门控，[post] / [hide] → reply 门控；隐藏内容拆出为 GateDraft，md 只留占位
 *  - 表情：[s:N] 展开为静态资源 /emoji/{id}.gif；映射外的遗留码（旧站自己也渲染不出）直接删除
 *  - 站内链接：job.php?action=topost / read.php / thread.php → /t/.. /f/..；回到原帖图标 → 「↩ 原帖」
 *  - 文件引用（附件、旧站内部图片）经调用方注入的解析回调改写为 /files/… 地址；解析不到的保留原样并告警
 *  - 内容只有 Markdown：color / size / backcolor / align / font 等样式标签一律降级为纯文本语义（只留内容，记告警）
 *  - table → Markdown 表格；hr → ---；删除线 → ~~；sup/sub/u 保留为 HTML；媒体标签降级为链接
 *
 * 门控的安全不变量（有专门的性质测试）：被拆出的隐藏内容绝不会出现在 md 中。
 * 位于引用/列表/表格等非顶层位置的门控，宁可丢弃内容也不留在公开正文里。
 *
 * 策略：树解析（未闭合标签自动收拢，未匹配闭合标签按字面量处理），未知标签剥壳留肉。
 */
import { MAX_GATES_PER_POST, type GateDraft } from "@funwind/content";

export interface UbbContext {
  /** 有静态资源的表情 id（旧站 120–169）；其余 [s:N] 视为遗留码并删除 */
  emojiIds: ReadonlySet<number>;
  /** 表情 id → 静态地址，默认 /emoji/{id}.gif */
  emojiUrl?: (id: number) => string;
  /**
   * [attachment=N] → 已入库文件的最终地址。image=true 渲染为内联图片，否则渲染为下载链接。
   * 返回 null 表示该附件无法解析（文件缺失等），输出占位 `[附件 #N]`。
   */
  resolveAttachment?: (aid: number) => { name: string; url: string; image?: boolean } | null;
  /**
   * 旧站内部上传路径（p_w_upload/ 之后的相对路径）→ 已入库文件的最终地址；
   * 返回 null 表示文件不存在或未入库（保留原绝对地址并告警）。缺省视为全部解析不到。
   */
  resolveUpload?: (relPath: string) => string | null;
  /** 站内域名（小写、不含 www.），用于识别站内链接，默认 qingyisub.com / qingyisub.top */
  siteHosts?: readonly string[];
  /** 门控 key 分配（帖内唯一）；缺省 g{seq}，转换结果因此是确定的 */
  gateKey?: (seq: number) => string;
  /** 价格 ≥ 该值的 [sell] 一律改为免费（站长决策：旧「9999」是永不可买的占位），默认 9999 */
  freeAbovePrice?: number;
}

export type ConvertWarningCode =
  | "emoji-legacy-stripped"
  | "gate-nested-dropped"
  | "gate-unclosed"
  | "gate-stray-close"
  | "gate-empty-dropped"
  | "gate-price-invalid"
  | "gate-price-reset"
  | "level-stripped"
  | "style-degraded"
  | "image-dropped"
  | "image-unresolved";

export interface ConvertWarning {
  code: ConvertWarningCode;
  detail?: string;
}

/** 正文里一处 `[attachment=N]` 引用及其所在位置：gateSeq 为所在门控的帖内序号，null = 公开正文 */
export interface AttachmentRef {
  aid: number;
  gateSeq: number | null;
}

export interface ConvertResult {
  /** 公开 Markdown（含门控占位） */
  md: string;
  gates: GateDraft[];
  warnings: ConvertWarning[];
  /** 全部 `[attachment=N]` 引用的位置（附件归属门控的依据，docs/ATTACHMENT-GATES.md §7）；被丢弃的门控内的引用不记 */
  attachmentRefs: AttachmentRef[];
}

interface Node {
  /** 仅根节点：没有对应开标签而被丢弃的门控闭合标签数 */
  strayGateClosers?: number;
  /** 仅根节点：没有对应开标签而被丢弃的样式闭合标签数 */
  strayStyleClosers?: number;
  tag?: string;
  arg?: string;
  /** 开标签的原文（保留大小写与参数），未知且未闭合的标签按字面量还原时使用 */
  raw?: string;
  text?: string;
  children: Node[];
  /** 是否被匹配的闭合标签正常闭合 */
  closed?: boolean;
}

const TAG_RE = /\[(\/?)([a-zA-Z][a-zA-Z_]*)(?:=([^\][\n]*))?\]/g;
const EMO_RE = /\[s:(\d+)\]/gi;
const GATE_TAGS = new Set(["SELL", "POST", "HIDE"]);
/** 旧站（windwind 时代）的别名标签：[p_w_upload=N] 与 [attachment=N] 同义 */
const TAG_ALIAS: Record<string, string> = { P_W_UPLOAD: "ATTACHMENT" };
/** 内联样式标签：降级为纯文本；没有开标签的闭合标签直接丢弃，不留字面量 */
const STYLE_TAGS = new Set(["COLOR", "BACKCOLOR", "SIZE", "ALIGN", "FONT"]);
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
    const tag = TAG_ALIAS[rawTag!.toUpperCase()] ?? rawTag!.toUpperCase();
    const top = stack[stack.length - 1]!;
    if (m.index > last) top.children.push({ text: src.slice(last, m.index), children: [] });
    last = m.index + full.length;
    if (!slash) {
      const node: Node = { tag, arg: rawArg, raw: full, children: [] };
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
        // 没有对应开标签的门控闭合标签：丢弃（保留字面量会在页面上露出 [/sell]）
        if (GATE_TAGS.has(tag)) {
          root.strayGateClosers = (root.strayGateClosers ?? 0) + 1;
          continue;
        }
        if (STYLE_TAGS.has(tag)) {
          root.strayStyleClosers = (root.strayStyleClosers ?? 0) + 1;
          continue;
        }
        top.children.push({ text: full, children: [] });
        continue;
      }
      // 门控优先：非门控的闭合标签不得越过仍未闭合的门控。否则门控会被一并弹出栈，
      // 之后本该隐藏的内容就落到公开区（交叉嵌套如 [color][sell]…[/color]…[/sell]）。
      // 此时把这个闭合标签当作字面量留在隐藏内容里。
      if (!GATE_TAGS.has(tag) && stack.slice(idx + 1).some((n) => GATE_TAGS.has(n.tag ?? ""))) {
        if (STYLE_TAGS.has(tag)) {
          root.strayStyleClosers = (root.strayStyleClosers ?? 0) + 1; // 样式闭合标签：丢弃，不留字面量
        } else {
          top.children.push({ text: full, children: [] });
        }
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
      out.push(
        unclosedAsLiteral({ ...self, children: [] }) ?? { ...self, children: [], closed: true },
        ...children,
      );
    } else if (c.tag && !c.closed && c.children.length === 0 && unclosedAsLiteral(c)) {
      out.push(unclosedAsLiteral(c)!);
    } else {
      out.push(c);
    }
  }
  node.children = out;
}

/**
 * 未知且没有闭合标签的方括号词（`[QYsub][DVDRip][Skip_Beat]` 这类发布名）：旧站不认识它们，字面显示。
 * 此前一律「剥壳」，字幕组发布名里的方括号词因此被整个吃掉（迁移库 258 篇）。成对出现的未知标签（`[foo]x[/foo]`）仍剥壳。
 * `[li]` 是常不写闭合的列表项，除外。
 */
function unclosedAsLiteral(n: Node): Node | null {
  if (!n.tag || n.closed || KNOWN_TAGS.has(n.tag) || n.tag === "LI" || n.raw === undefined)
    return null;
  return { text: n.raw, children: [] };
}
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
const DEFAULT_SITE_HOSTS = ["qingyisub.com", "qingyisub.top", "qingyisub.gotoip1.com"];

/**
 * 去掉围栏代码块之外每一行的首尾空白。
 * 行首 ≥4 个空格会被 Markdown 当成缩进代码块，行尾两个空格是硬换行，都不是旧帖作者的本意（旧站是 HTML，空白折叠）。
 * 围栏内保持原样；以 `>` 开头的引用行首尾本就没有可去的空白。
 */
function stripLineSpace(md: string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line.trim();
      }
      return inFence ? line : line.trim();
    })
    .join("\n");
}

/**
 * 行内强调：`**x**` / `*x*` / `~~x~~`。
 * CommonMark 的定界符规则：内容以标点开头或结尾、且紧挨汉字 / 字母时，`**` 不成立
 * （`**【staff】**原作`、`**“引号”**后文` 会残留字面 `**`，迁移库约 175 篇）。这类边界直接输出 HTML 标签（净化白名单已放行）；
 * 其余仍用 Markdown 记号，保持源码干净，也让所见即所得编辑器能无损往返。
 */
const PUNCT_EDGE = /^[\p{P}\p{S}]|[\p{P}\p{S}]$/u;
function emphasis(x: string, mark: string, tag: string): string {
  // Markdown 的强调不能跨段落：内容里有空行就按段分别包裹（否则开头的记号成了字面量）
  if (/\n[ \t]*\n/.test(x))
    return x
      .split(/(\n[ \t]*\n)/)
      .map((part, i) => (i % 2 === 1 ? part : emphasis(part, mark, tag)))
      .join("");
  const t = x.trim();
  if (t === "") return x; // 只有空白的 [b]  [/b]：不产生记号
  // 内层自己的强调记号（`*粗斜*`）不是标点内容，判断边界前先去掉
  // 只剥 `*` 串与恰好两个的 `~~`；用户自己的单个 `~`（语气词）是标点边界，必须走 HTML（否则与收尾的 `~~` 连成 `~~~`）
  const core = t.replace(/^(?:\*+|~~)|(?:\*+|~~)$/g, "");
  return PUNCT_EDGE.test(core) ? `<${tag}>${t}</${tag}>` : `${mark}${t}${mark}`;
}

/** 相邻两段加粗（`**甲****乙**`）在 CommonMark 里会错位解析：未转义的连续 4 个 `*` 一定是相邻加粗的交界（文本里的 `*` 都已转义），合并掉。围栏代码内不动 */
function mergeAdjacentBold(md: string): string {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      return inFence ? line : line.replace(/(?<![\\*])\*{4}(?!\*)/g, "");
    })
    .join("\n");
}

/** 引用块：前后各留空行（否则后文会被「懒续行」吞进引用）；空行输出 `>`，不留尾部空格 */
function blockquote(inner: string): string {
  const lines = stripLineSpace(inner.trim().replace(/\n{3,}/g, "\n\n")).split("\n");
  return "\n\n" + lines.map((l) => (l === "" ? ">" : `> ${l}`)).join("\n") + "\n\n";
}

// ---------- 纯文本转义 ----------

/**
 * 旧站正文是 HTML 里的纯文本：用户打的 `5*3=15`、`~~心情~~`、行首的 `#` 都是字面显示。
 * 转成 Markdown 后这些字符会被解析成强调 / 删除线 / 标题，所以普通文本节点必须转义（代码块内不动）。
 * 行首标记（`# > - + 1.` 等）无法在文本节点里确知是否真在行首，宁可多转义——`\#` 渲染出来仍是 `#`。
 * 整行只由 `- = :` 与空白组成的行也要转义（`---`、`- - -`、`===`、`:-:`）：会把上一行变标题、画分割线，或成为单列表格的对齐行（GFM 不要求有竖线）。
 * `~` 只转义连续两个以上：渲染器 `singleTilde:false`，单个 `~` 是语气词（「1~12集」）。
 * `<` 默认转义让它字面显示（旧站对 `<embed>`、`<<pp>>`、用户贴的错误页源码都是字面显示）；只有整篇以 `<标签` 开头的帖子
 * （管理员贴的原生 HTML 页面，迁移库 7 篇）才放行渲染器净化白名单里的 HTML 标签（keepHtml）。`&` 不处理：库里的 `&#46;` 之类实体旧站同样按 HTML 解码显示。
 */
const SAFE_HTML_TAGS =
  "div|span|p|table|thead|tbody|tr|td|th|a|img|br|hr|b|i|u|s|del|strong|em|sup|sub|code|pre|ul|ol|li|blockquote";
const LT_RE = new RegExp(`<(?!/?(?:${SAFE_HTML_TAGS})\\b)`, "gi");
const LINE_START_RE = /^([ \t]*)(#{1,6}(?=[ \t]|$)|>|[-+](?=[ \t]|$))/gm;
const ORDERED_START_RE = /^([ \t]*\d{1,9})([.)])(?=[ \t]|$)/gm;
const RULE_LINE_RE = /^([ \t]*)([-=:])(?=[-=: \t]*$)/gm;
const FENCE_LIKE_RE = /^([ \t]*):{3,}/gm;

export function escapeText(text: string, keepHtml = false): string {
  return text
    .replace(/[\\*_`[\]|]/g, "\\$&")
    .replace(/~{2,}/g, (m) => "\\~".repeat(m.length))
    .replace(keepHtml ? LT_RE : /</g, "\\<")
    .replace(LINE_START_RE, "$1\\$2")
    .replace(ORDERED_START_RE, "$1\\$2")
    .replace(RULE_LINE_RE, "$1\\$2")
    .replace(FENCE_LIKE_RE, (m) => m.replace(/:/, "\\:"));
}

/** 节点内全部文本节点的原文拼接（不渲染、不产生告警）：[url] / [img] 等把正文当地址用时取这个，而不是已转义的 inner */
function flatText(n: Node): string {
  if (n.text !== undefined) return n.text;
  return n.children.map(flatText).join("");
}

interface State {
  ctx: UbbContext;
  gates: GateDraft[];
  warnings: ConvertWarning[];
  seq: number;
  /** `[attachment=N]` 引用；渲染门控期间追加的条目在门控成立后回填 gateSeq */
  attachmentRefs: AttachmentRef[];
  /** 整篇是管理员贴的原生 HTML 页面（以 `<标签` 开头）：其中白名单内的 HTML 标签保持为 HTML，不转义 */
  htmlMode: boolean;
}

interface Env {
  /** top = 位于文档顶层（可提升为门控）；nested = 位于引用/列表/表格等容器内 */
  pos: "top" | "nested";
  /** 正在渲染某个门控的隐藏内容：内部再出现的门控直接并入该门控 */
  inGate: boolean;
  /** 代码块：不展开表情 */
  raw: boolean;
  /** 已处于同类强调之内：再嵌套同类标签是冗余的，省略内层记号（原文常有未闭合的 [b] 把后文全部收进来，嵌套记号 CommonMark 无法解析） */
  inBold?: boolean;
  inItalic?: boolean;
  inStrike?: boolean;
  /** 最近的非样式容器标签（QUOTE / LIST / TABLE / URL …），仅用于告警诊断 */
  container?: string;
}

// ---------- URL 与图片 ----------

const TOPOST_RE = /job\.php\?action=topost;tid=(\d+);pid=(\d+)/i;
const READ_RE = /read\.php\?(?:[^#\s]*&)?tid=(\d+)/i;
const THREAD_RE = /thread\.php\?(?:[^#\s]*&)?fid=(\d+)/i;
/** 旧站上传文件的两种 URL 形态：phpwind 8 的 p_w_upload/ 与 phpwind 9 的 attachment/，相对路径都落在同一磁盘目录下 */
const UPLOAD_RE = /(?:^|\/)(?:p_w_upload|attachment)\/(.+)$/i;

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

/** p_w_upload/… → 已入库文件地址；url 为 null 表示不是该形态或文件未入库，matched 表示形态命中 */
function rewriteUpload(u: string, st: State): { url: string | null; matched: boolean } {
  const hosts = st.ctx.siteHosts ?? DEFAULT_SITE_HOSTS;
  const relative = !/^[a-z]+:\/\//i.test(u);
  if (!relative && !isSiteUrl(u, hosts)) return { url: null, matched: false };
  const m = UPLOAD_RE.exec(u.split(/[?#]/)[0]!);
  if (!m) return { url: null, matched: false };
  const rel = decodeURIComponent(m[1]!);
  return { url: st.ctx.resolveUpload?.(rel) ?? null, matched: true };
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
  const refsFrom = st.attachmentRefs.length; // 本门控渲染期间新增的引用都属于它
  const hidden = stripLineSpace(
    mergeAdjacentBold(
      renderChildren(n, st, { pos: "nested", inGate: true, raw: false })
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    ),
  );
  if (hidden === "") {
    st.warnings.push({ code: "gate-empty-dropped", detail: tag });
    st.attachmentRefs.length = refsFrom;
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
  const key = st.ctx.gateKey?.(seq) ?? `g${seq}`;
  for (let i = refsFrom; i < st.attachmentRefs.length; i++) st.attachmentRefs[i]!.gateSeq = seq;
  st.gates.push({ key, seq, conditions: [condition], matchMode: "all", hiddenMd: hidden });
  return `\n\n:::gate{key="${key}"}\n:::\n\n`;
}

// ---------- 渲染 ----------

const GATE_PLACEHOLDER_RE = /(\n\n:::gate\{key="[\w-]+"\}\n:::\n\n)/;

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

/** 门控占位块（renderGate 的输出形态） */
const GATE_PLACEHOLDER_ANY = /\n*:::gate\{key="[\w-]+"\}\n:::\n*/g;

function renderTable(n: Node, st: State, env: Env): string {
  const rows = n.children.filter((c) => c.tag === "TR");
  if (rows.length === 0) return renderChildren(n, st, env);
  // 单元格里的门控占位不能留在表格行内（会被压成一行而失效）：提升到表格之后，内容不丢
  const hoisted: string[] = [];
  const cellText = (c: Node) =>
    renderChildren(c, st, env)
      .replace(GATE_PLACEHOLDER_ANY, (m) => {
        hoisted.push(m.trim());
        return " ";
      })
      .replace(/\s*\n\s*/g, " ")
      // 文本里的 | 已在 escapeText 转义过：只补转义尚未转义的（如链接地址里的），避免变成 \\| 而把单元格劈开
      .replace(/(\\*)\|/g, (m, bs: string) => (bs.length % 2 === 1 ? m : `${bs}\\|`))
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
    "",
    line(head),
    `| ${Array(width).fill("---").join(" | ")} |`,
    ...body.map(line),
    "",
    "",
    ...(hoisted.length ? ["", ...hoisted.flatMap((h) => [h, ""])] : []),
  ].join("\n");
}

function render(n: Node, st: State, env: Env): string {
  if (n.text !== undefined) {
    if (env.raw) return n.text;
    let out = "";
    let last = 0;
    for (const m of n.text.matchAll(EMO_RE)) {
      out += escapeText(n.text.slice(last, m.index), st.htmlMode);
      last = m.index + m[0].length;
      const id = Number(m[1]);
      if (st.ctx.emojiIds.has(id)) {
        const url = st.ctx.emojiUrl?.(id) ?? `/emoji/${id}.gif`;
        out += `![表情](${url})`;
      } else {
        st.warnings.push({ code: "emoji-legacy-stripped", detail: m[1] });
      }
    }
    return out + escapeText(n.text.slice(last), st.htmlMode);
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
  const transparent =
    TRANSPARENT.has(tag) || tag === "TABLE" || !KNOWN_TAGS.has(tag) || n.closed !== true;
  const childEnv: Env = transparent ? env : { ...env, pos: "nested", container: tag };
  // TABLE 由 renderTable 自行渲染各单元格；这里若再预渲染一遍，门控会被渲染两次（产生重复/孤立门控）
  const innerEnv: Env =
    tag === "B" || tag === "STRONG"
      ? { ...childEnv, inBold: true }
      : tag === "I" || tag === "EM"
        ? { ...childEnv, inItalic: true }
        : tag === "S" || tag === "STRIKE" || tag === "DEL"
          ? { ...childEnv, inStrike: true }
          : tag === "CODE"
            ? { ...childEnv, raw: true }
            : childEnv;
  const inner = tag === "TABLE" ? "" : renderChildren(n, st, innerEnv);

  switch (tag) {
    case "B":
    case "STRONG":
      return env.inBold ? inner : wrap(inner, (x) => emphasis(x, "**", "strong"));
    case "I":
    case "EM":
      return env.inItalic ? inner : wrap(inner, (x) => emphasis(x, "*", "em"));
    case "U":
      return wrap(inner, (x) => `<u>${x}</u>`);
    case "S":
    case "STRIKE":
    case "DEL":
      return env.inStrike ? inner : wrap(inner, (x) => emphasis(x, "~~", "del"));
    case "SUP":
      return `<sup>${inner}</sup>`;
    case "SUB":
      return `<sub>${inner}</sub>`;
    case "HR":
      return "\n\n---\n\n";
    case "BR":
      return "\n";
    case "COLOR":
    case "BACKCOLOR":
    case "SIZE":
    case "ALIGN":
    case "FONT":
      // 内容只有 Markdown：样式标签只留内容，不产生任何内联样式
      st.warnings.push({ code: "style-degraded", detail: tag.toLowerCase() });
      return inner;
    case "QUOTE":
      return wrap(inner, blockquote);
    case "CODE":
      return "\n```\n" + inner.replace(/^\n+|\n+$/g, "") + "\n```\n";
    case "URL": {
      const url = resolveHref(n.arg?.trim() || flatText(n), st);
      const label = inner.trim() || escapeText(n.arg?.trim() || url);
      return url ? `[${label}](${url})` : label;
    }
    case "IMG":
      return renderImage(n.arg?.trim() || flatText(n), inner, st);
    case "EMAIL": {
      const a = (n.arg?.trim() || flatText(n).trim()).replace(/[^\w.@+-]/g, "");
      return a ? `[${inner.trim() || escapeText(a)}](mailto:${a})` : inner;
    }
    case "ATTACHMENT": {
      const aid = parseInt((n.arg ?? flatText(n)).trim(), 10);
      if (!Number.isFinite(aid)) return inner;
      st.attachmentRefs.push({ aid, gateSeq: null });
      const att = st.ctx.resolveAttachment?.(aid);
      const link = att
        ? att.image
          ? `![${escapeText(att.name)}](${att.url})`
          : `[📎 ${escapeText(att.name)}](${att.url})`
        : `[附件 #${aid}]`;
      return n.arg !== undefined && inner.trim() ? `${link}${inner}` : link;
    }
    case "LEVEL":
      st.warnings.push({ code: "level-stripped", detail: n.arg });
      return inner; // 等级体系已取消：去掉标签，内容公开
    case "LIST":
      // 列表项标记 [*] 在文本节点里已被转义成 \[\*\]；前后留空行，否则后文会被吞进最后一项
      return (
        "\n\n" +
        inner
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) =>
            l.startsWith("- ") ? l : `- ${l.replace(/^(?:\\\[\\\*\\\]|\[\*\])\s*/, "")}`,
          )
          .join("\n") +
        "\n\n"
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
        const url = safeUrl(flatText(n)) || safeUrl(n.arg?.trim() ?? "");
        return url ? `\n\n[🎬 媒体](${url})\n\n` : inner;
      }
      return inner; // 未知标签：剥壳留肉
  }
}

/**
 * 旧站少数主题里混有原始 HTML 图片：<img src="…"> 改写成 [img]…[/img]，走统一的图片/路径改写；
 * 只包着一张图片的 <a href> 去掉外层链接（链接目标就是原图）。其余 HTML 不处理，保持原样（渲染期由净化管线负责）。
 */
function htmlImagesToUbb(src: string): string {
  return src
    .replace(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi, "[img]$1[/img]")
    .replace(
      /<a\b[^>]*?\bhref\s*=\s*["'][^"']*["'][^>]*>\s*(\[img\][^[\]]*\[\/img\])\s*<\/a>/gi,
      "$1",
    );
}

export function ubbToMarkdown(input: string | null | undefined, ctx: UbbContext): ConvertResult {
  const st: State = {
    ctx,
    gates: [],
    warnings: [],
    seq: 0,
    attachmentRefs: [],
    htmlMode: /^\s*<[a-z]/i.test(input ?? ""),
  };
  if (!input) return { md: "", gates: [], warnings: [], attachmentRefs: [] };
  const src = htmlImagesToUbb(input.replace(/\r\n?/g, "\n"));
  // 根节点没有 tag：直接渲染其子节点，保持顶层语义（不能走 render，否则会被当成非透明容器）
  const tree = parse(src);
  for (let i = 0; i < (tree.strayGateClosers ?? 0); i++)
    st.warnings.push({ code: "gate-stray-close" });
  for (let i = 0; i < (tree.strayStyleClosers ?? 0); i++)
    st.warnings.push({ code: "style-degraded", detail: "stray-close" });
  unwrapUnclosed(tree);
  const md = stripLineSpace(
    mergeAdjacentBold(
      renderChildren(tree, st, { pos: "top", inGate: false, raw: false })
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    ),
  );
  return { md, gates: st.gates, warnings: st.warnings, attachmentRefs: st.attachmentRefs };
}
