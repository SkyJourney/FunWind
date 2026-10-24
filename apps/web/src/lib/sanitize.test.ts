import { describe, expect, it } from "vitest";
import { harden, sanitizeSchema, sanitizeStyleValue, safeHref } from "./sanitize";
import { renderMarkdown } from "./markdown";
import { rehype } from "rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Root } from "hast";

/** 与 markdown.ts 相同管线的直通 HTML 版本（测试内嵌 HTML 用例） */
function renderHtml(html: string): string {
  const processor = rehype()
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema() as never)
    .use(function hardenPlugin() {
      return (t: Root): void => {
        harden(t);
      };
    })
    .use(rehypeStringify);
  return String(processor.processSync(html));
}

describe("sanitizeStyleValue", () => {
  it("保留白名单声明", () => {
    expect(sanitizeStyleValue("color:#cb4042; font-size:20px")).toBe(
      "color:#cb4042; font-size:20px",
    );
    expect(sanitizeStyleValue("background-color:#cccccc")).toBe("background-color:#cccccc");
    expect(sanitizeStyleValue("text-align:center")).toBe("text-align:center");
  });

  it("丢弃非白名单属性", () => {
    expect(sanitizeStyleValue("position:fixed; color:red")).toBe("color:red");
    expect(sanitizeStyleValue("width:100px")).toBe("");
  });

  it("封死危险值形态（url/expression/脚本注入）", () => {
    expect(sanitizeStyleValue("background:url(javascript:alert(1))")).toBe("");
    expect(sanitizeStyleValue("color:expression(alert(1))")).toBe("");
    expect(sanitizeStyleValue("color:red; background-image:url(http://x)")).toBe("color:red");
  });

  it("大小写绕过被封", () => {
    expect(sanitizeStyleValue("COLOR:red; POSITION:fixed")).toBe("COLOR:red");
  });

  it("畸形声明（无冒号/空）整体忽略", () => {
    expect(sanitizeStyleValue("color")).toBe("");
    expect(sanitizeStyleValue("")).toBe("");
  });
});

describe("safeHref", () => {
  it("放行 http/https/mailto/相对/锚点", () => {
    expect(safeHref("https://a.b/c")).toBe("https://a.b/c");
    expect(safeHref("http://a.b")).toBe("http://a.b");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("/t/123")).toBe("/t/123");
    expect(safeHref("#p9")).toBe("#p9");
  });

  it("拒绝 javascript:/data:/vbscript:", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>1</script>")).toBeNull();
    expect(safeHref("vbscript:x")).toBeNull();
  });
});

describe("harden（HTML 级净化）", () => {
  const XSS_CASES: [string, string][] = [
    ["<script>alert(1)</script>", ""],
    ["<iframe src=//x></iframe>", ""],
    ["<img src=x onerror=alert(1)>", ""],
    ["<svg onload=alert(1)></svg>", ""],
    ["<object data=//x></object>", ""],
    ["<embed src=//x>", ""],
    ["<form action=//x><input></form>", ""],
    ['<a href="javascript:alert(1)">x</a>', "x"], // 降级为 span，文本保留
    ['<a href="DATA:text/html,1">x</a>', "x"],
    ['<span style="background:url(javascript:1)">x</span>', "x"],
    ["<style>body{}</style>", ""],
    ["<link rel=stylesheet href=//x>", ""],
    ["<meta http-equiv=refresh content=0>", ""],
    ['<div style="position:fixed">x</div>', "x"],
    ["<math><mtext></mtext></math>", ""],
    ["<base href=//x>", ""],
  ];

  it.each(XSS_CASES)("XSS 用例：%s", (input, expectText) => {
    const out = renderHtml(input);
    expect(out).not.toMatch(
      /<script|<iframe|onerror|onload|javascript:|<iframe|position:fixed|<style|<link|<meta|<base|<object|<embed|<form|<math/i,
    );
    if (expectText) expect(out).toContain(expectText);
  });

  it("白名单保留：span 颜色/字号、u/s", () => {
    const out = renderHtml(
      '<span style="color:#6600cc">紫</span><span style="font-size:20px">大</span><u>下划</u><s>删除</s>',
    );
    expect(out).toContain("color:#6600cc");
    expect(out).toContain("font-size:20px");
    expect(out).toContain("<u>");
    expect(out).toContain("<s>");
  });

  it("白名单保留：div 对齐", () => {
    const out = renderHtml('<div style="text-align:center">居中</div>');
    expect(out).toContain("text-align:center");
  });

  it("a 注入安全属性", () => {
    const out = renderHtml('<a href="https://example.com">外链</a>');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it("img 降级：来源不合法时变成纯文本 span——不留任何属性，alt 作为可见文字（复查 A4）", () => {
    expect(renderMarkdown("![替代文字](javascript:alert(1))")).toBe("<p><span>替代文字</span></p>");
    const out = renderHtml('<img src="/etc/passwd" alt="a" title="t" width="9" height="9">');
    expect(out).toBe("<span>a</span>");
    expect(renderHtml('<img src="/etc/passwd">')).toBe("<span></span>");
  });

  it("img 站内路由保留并加 lazy；外站 http 保留；其他来源降级", () => {
    const out = renderHtml(
      '<img src="/emoji/130.gif"><img src="/files/ab/cd/x.png"><img src="https://x/a.png"><img src="/etc/passwd"><img src="/emotion/01/17.gif"><img src="/attachment/a.jpg">',
    );
    expect(out).toContain('src="/emoji/130.gif"');
    expect(out).toContain('src="/files/ab/cd/x.png"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain("https://x/a.png");
    expect(out).not.toContain("/etc/passwd");
    // 旧站路径已随 /attachment、/emotion 路由一起退役，不再放行
    expect(out).not.toContain("/emotion/");
    expect(out).not.toContain("/attachment/");
  });

  it("Markdown 管线：引用/代码块/表情图/附件链接完整保留", () => {
    const md = [
      "> 一段引用",
      "",
      "```js",
      "const a = 1;",
      "```",
      "![表情](/emoji/130.gif)",
      "[📎 字幕.rar](/files/ab/cd/x.rar)",
    ].join("\n");
    const out = renderMarkdown(md);
    expect(out).toContain("<blockquote>");
    expect(out).toContain("<pre><code");
    expect(out).toContain('src="/emoji/130.gif"');
    expect(out).toContain('href="/files/ab/cd/x.rar"');
  });

  it("code / pre 的 class 只放行 language-xxx：注入站内 Tailwind 类做整页覆盖被剥掉（审查 P2-8）", () => {
    const overlay = "fixed inset-0 z-50 bg-background";
    // HTML 直通：纯注入类 → 整个 class 属性消失
    const a = renderHtml(`<pre class="${overlay}"><code class="${overlay}">x</code></pre>`);
    expect(a).not.toContain("class");
    expect(a).not.toContain("fixed");
    // 合法语言类与注入类混写：只留 language-xxx
    const b = renderHtml(`<pre><code class="language-ts ${overlay}">x</code></pre>`);
    expect(b).toContain("language-ts");
    expect(b).not.toContain("fixed");
    expect(b).not.toContain("z-50");
    // 看起来像语言类但夹带符号 / 空格后缀的也不行
    const c = renderHtml(
      '<pre><code class="language-ts&quot;onmouseover=&quot;x language-">x</code></pre>',
    );
    expect(c).not.toContain("onmouseover");
    // 其他标签的 class 本来就不在白名单
    expect(renderHtml(`<div class="${overlay}">x</div>`)).not.toContain("class");
    expect(renderHtml(`<span class="${overlay}">x</span>`)).not.toContain("class");
  });

  it("Markdown 管线：代码围栏的 language-xxx 保留（语法高亮依赖它）", () => {
    const out = renderMarkdown("```ts\nconst a = 1;\n```");
    expect(out).toContain('class="language-ts"');
  });

  it("Markdown 管线：脚本注入被净化", () => {
    const out = renderMarkdown("<script>alert(1)</script>\n\n正文");
    expect(out).not.toContain("script");
    expect(out).toContain("正文");
  });
});
