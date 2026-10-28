import { describe, expect, it } from "vitest";
import { CODE_LANGUAGES, HIGHLIGHT_BUDGET_CHARS, HIGHLIGHT_MAX_CHARS, lowlight } from "./highlight";
import { renderMarkdown } from "./markdown";

const fence = (lang: string, code: string) => "```" + lang + "\n" + code + "\n```";

describe("语言集", () => {
  it("下拉里的每个语言都已注册，且值只含净化白名单放行的字符", () => {
    for (const l of CODE_LANGUAGES) {
      expect(lowlight.registered(l.value), l.value).toBe(true);
      expect(l.value).toMatch(/^[\w-]+$/);
    }
  });
  it("常见别名可用（作者手写 js / ts / py / sh / html）", () => {
    for (const a of ["js", "ts", "py", "sh", "html"]) expect(lowlight.registered(a), a).toBe(true);
  });
});

describe("渲染：代码块高亮", () => {
  it("带语言的围栏：产出 hljs 的 span，保留 language-xxx", () => {
    const html = renderMarkdown(fence("ts", "const a: number = 1;"));
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
  });

  it("别名与规范名等价", () => {
    const a = renderMarkdown(fence("js", "function f() {}"));
    const b = renderMarkdown(fence("javascript", "function f() {}"));
    expect(a).toContain("hljs-keyword");
    expect(a.replace("language-js", "x")).toBe(b.replace("language-javascript", "x"));
  });

  it("没写语言：不自动探测，保持纯文本（旧帖形状不变）", () => {
    const html = renderMarkdown(fence("", "const a = 1;"));
    expect(html).toBe("<pre><code>const a = 1;\n</code></pre>");
  });

  it("语言未注册：保持纯文本", () => {
    const html = renderMarkdown(fence("klingon", "const a = 1;"));
    expect(html).not.toContain("hljs");
    expect(html).toContain("const a = 1;");
  });

  it("代码里的 HTML 被转义，不会变成标签", () => {
    const html = renderMarkdown(fence("html", '<script>alert(1)</script><img src=x onerror="y">'));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&#x3C;");
  });

  it("作者无法借语言名注入 class：带引号 / 多余 class 的写法被净化后不再高亮", () => {
    const html = renderMarkdown(
      '<pre><code class="language-js fixed inset-0 z-50">const a = 1;</code></pre>',
    );
    expect(html).not.toMatch(/fixed|inset-0|z-50/);
    // 允许的只有 language-js 与高亮产生的 hljs-*
    for (const m of html.matchAll(/class="([^"]*)"/g)) {
      expect(m[1]).toMatch(/^(language-[\w-]+|hljs-[\w-]+( hljs-[\w-]+)*)$/);
    }
  });

  it("code 里含内嵌元素（原始 HTML）时保持原样，不高亮", () => {
    const html = renderMarkdown('<pre><code class="language-js">a <b>b</b></code></pre>');
    expect(html).not.toContain("hljs");
  });

  it("超过上限的代码按纯文本输出", () => {
    const big = "const a = 1;\n".repeat(Math.ceil(HIGHLIGHT_MAX_CHARS / 12) + 10);
    const html = renderMarkdown(fence("js", big), { cache: false });
    expect(html).not.toContain("hljs");
  });

  it("本篇累计预算用尽后，后面的代码块按纯文本输出（前面的仍高亮）", () => {
    const one = "const a = 1;\n".repeat(Math.floor((HIGHLIGHT_MAX_CHARS - 100) / 13));
    const n = Math.ceil(HIGHLIGHT_BUDGET_CHARS / one.length) + 1;
    const html = renderMarkdown(Array.from({ length: n }, () => fence("js", one)).join("\n\n"), {
      cache: false,
    });
    const blocks = html.split("<pre>").slice(1);
    expect(blocks).toHaveLength(n);
    expect(blocks[0]).toContain("hljs-keyword");
    expect(blocks[n - 1]).not.toContain("hljs-");
  });

  it("同一页里多个代码块各自高亮，行内代码不受影响", () => {
    const html = renderMarkdown(
      `${fence("python", "def f(): pass")}\n\n行内 \`const x\` 文字\n\n${fence("json", '{"a": 1}')}`,
    );
    expect(html.match(/<pre>/g)).toHaveLength(2);
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("<code>const x</code>");
  });
});
