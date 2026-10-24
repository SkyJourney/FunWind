/**
 * 迁移语法契约：「转换器产出的 Markdown」与「渲染器能渲染的 Markdown」之间的对账表（M5.6 S1b）。
 *
 * 为什么需要它：迁移转换器（migration/）把旧站 UBB 翻译成 Markdown，渲染器（apps/web/lib/markdown.ts）把 Markdown 渲染成 HTML，
 * 两边各有各的测试，但**没人测两边接得上**。M5.6 S1 就是这样发现渲染器不解析转换器产出的表格与删除线；
 * S1b 的数据分析又发现换行塌陷（8664 篇）、引用后文字被吞（2168 篇）、普通文本里的 `*` `~~` `#` 被当成 Markdown（≥2043 篇）。
 *
 * 契约是纯数据，两侧各自断言一半：
 *  · migration 测试：转换器对每条 `ubb` 产出的 Markdown 必须**等于** `markdown`（防契约与转换器漂移）；
 *  · web 测试：渲染器对每条 `markdown` 的渲染结果必须**包含** `html` 里的片段、**不含** `notInHtml` 里的片段。
 * 新增转换器能产出的构造时，必须同步加一条契约；找不到对应渲染结果的构造会在 web 测试里直接变红。
 *
 * `markdown` 写的是**期望的最终形态**。转换器 / 渲染器尚未修好的条目，在各自测试文件里登记为已知缺陷（`it.fails`），
 * 修好后该登记会因「意外通过」而报错，逼着把它删掉——契约因此始终是真相来源。
 *
 * 不含门控：门控由 `splitSource` / `PostBody` 另行处理，有专门的测试。
 */

export interface SyntaxContractEntry {
  /** 稳定标识（测试名、已知缺陷登记都用它） */
  id: string;
  /** 一句话说明这条在守什么 */
  title: string;
  /** 旧站 UBB 输入（迁移转换器的输入） */
  ubb: string;
  /** 转换器应当产出的 Markdown（逐字，已 trim） */
  markdown: string;
  /** 渲染后的 HTML 必须包含的片段 */
  html: readonly string[];
  /** 渲染后的 HTML 不得包含的片段（用来抓「被误解析」） */
  notInHtml?: readonly string[];
  /** 转换器产出的 Markdown 经 splitSource 后不得出现任何门控（防止用户文本伪造门控） */
  noGates?: true;
}

/** 契约样例依赖的转换器上下文（测试夹具约定，转换器测试按此构造 ctx） */
export const CONTRACT_FIXTURES = {
  /** 附件 id → 解析结果 */
  attachments: {
    7: { name: "字幕.zip", url: "/files/ee/ff/eeff.zip" },
    8: { name: "截图.png", url: "/files/11/22/1122.png", image: true },
  },
  /** 旧站内部上传路径 → 最终文件地址 */
  uploads: { "photo/Mon_1003/3_abc.jpg": "/files/aa/bb/aabb-3.jpg" },
  /** 有静态资源的表情 id 范围（含两端） */
  emojiRange: [120, 169],
} as const;

const e = (x: SyntaxContractEntry): SyntaxContractEntry => x;

export const MIGRATION_SYNTAX_CONTRACT: readonly SyntaxContractEntry[] = [
  // ---------- 行内格式 ----------
  e({
    id: "bold",
    title: "加粗",
    ubb: "[b]粗[/b]",
    markdown: "**粗**",
    html: ["<strong>粗</strong>"],
  }),
  e({ id: "italic", title: "斜体", ubb: "[i]斜[/i]", markdown: "*斜*", html: ["<em>斜</em>"] }),
  e({
    id: "bold-italic",
    title: "加粗嵌斜体",
    ubb: "[b][i]粗斜[/i][/b]",
    markdown: "***粗斜***",
    html: ["<strong>粗斜</strong>", "<em>"],
  }),
  e({
    id: "underline",
    title: "下划线保留为内嵌 HTML",
    ubb: "[u]下[/u]",
    markdown: "<u>下</u>",
    html: ["<u>下</u>"],
  }),
  e({
    id: "strike-s",
    title: "删除线 [s]",
    ubb: "[s]删[/s]",
    markdown: "~~删~~",
    html: ["<del>删</del>"],
    notInHtml: ["~~"],
  }),
  e({
    id: "strike-del",
    title: "删除线 [del]",
    ubb: "[del]删[/del]",
    markdown: "~~删~~",
    html: ["<del>删</del>"],
  }),
  e({
    id: "sup",
    title: "上标",
    ubb: "[sup]上[/sup]",
    markdown: "<sup>上</sup>",
    html: ["<sup>上</sup>"],
  }),
  e({
    id: "sub",
    title: "下标",
    ubb: "[sub]下[/sub]",
    markdown: "<sub>下</sub>",
    html: ["<sub>下</sub>"],
  }),
  e({
    id: "bold-cjk-after",
    title: "加粗紧贴中文：前后都是汉字",
    ubb: "前文[b]粗[/b]后文",
    markdown: "前文**粗**后文",
    html: ["前文<strong>粗</strong>后文"],
  }),
  e({
    id: "bold-cjk-punct",
    title: "加粗内容以全角标点结尾、后面紧跟汉字（CommonMark 的 CJK 边界规则会让它失效）",
    ubb: "[b]“引号”[/b]后文",
    markdown: "**“引号”**后文",
    html: ["<strong>“引号”</strong>后文"],
    notInHtml: ["**"],
  }),
  e({
    id: "color-degraded",
    title: "颜色 / 字号 / 对齐等样式降级为纯文本",
    ubb: "[color=red]红[/color]",
    markdown: "红",
    html: ["<p>红</p>"],
  }),

  // ---------- 链接、图片、附件 ----------
  e({
    id: "url-labeled",
    title: "带文字的链接",
    ubb: "[url=https://example.com]站点[/url]",
    markdown: "[站点](https://example.com)",
    html: ['href="https://example.com"', ">站点</a>"],
  }),
  e({
    id: "url-bare",
    title: "裸网址链接",
    ubb: "[url]https://example.com/a[/url]",
    markdown: "[https://example.com/a](https://example.com/a)",
    html: ['href="https://example.com/a"'],
  }),
  e({
    id: "email",
    title: "邮箱链接",
    ubb: "[email]a@example.com[/email]",
    markdown: "[a@example.com](mailto:a@example.com)",
    html: ['href="mailto:a@example.com"'],
  }),
  e({
    id: "img-external",
    title: "外链图片",
    ubb: "[img]https://example.com/a.png[/img]",
    markdown: "![img](https://example.com/a.png)",
    html: ['<img src="https://example.com/a.png"'],
  }),
  e({
    id: "img-upload",
    title: "旧站上传图改写为 /files 地址",
    ubb: "[img]attachment/photo/Mon_1003/3_abc.jpg[/img]",
    markdown: "![img](/files/aa/bb/aabb-3.jpg)",
    html: ['<img src="/files/aa/bb/aabb-3.jpg"'],
  }),
  e({
    id: "attachment-image",
    title: "图片附件内联",
    ubb: "[attachment=8]",
    markdown: "![截图.png](/files/11/22/1122.png)",
    html: ['<img src="/files/11/22/1122.png"'],
  }),
  e({
    id: "attachment-file",
    title: "文件附件为下载链接",
    ubb: "[attachment=7]",
    markdown: "[📎 字幕.zip](/files/ee/ff/eeff.zip)",
    html: ['href="/files/ee/ff/eeff.zip"', "📎 字幕.zip"],
  }),
  e({
    id: "attachment-missing",
    title: "文件缺失的附件保留占位文字",
    ubb: "[attachment=99]",
    markdown: "[附件 #99]",
    html: ["[附件 #99]"],
    notInHtml: ["<a "],
  }),
  e({
    id: "emoji",
    title: "历史表情展开为静态图",
    ubb: "[s:130]",
    markdown: "![表情](/emoji/130.gif)",
    html: ['<img src="/emoji/130.gif"'],
  }),
  e({
    id: "media-link",
    title: "媒体标签降级为链接",
    ubb: "[flash]https://example.com/a.swf[/flash]",
    markdown: "[🎬 媒体](https://example.com/a.swf)",
    html: ['href="https://example.com/a.swf"'],
  }),

  // ---------- 块：单独出现 ----------
  e({
    id: "hr",
    title: "分割线",
    ubb: "前[hr]后",
    markdown: "前\n\n---\n\n后",
    html: ["<p>前</p>", "<hr>", "<p>后</p>"],
  }),
  e({
    id: "code-block",
    title: "代码块",
    ubb: "[code]x < y[/code]",
    markdown: "```\nx < y\n```",
    html: ["<pre><code>"],
    notInHtml: ["<p>"],
  }),
  e({
    id: "quote",
    title: "引用",
    ubb: "[quote]引用[/quote]",
    markdown: "> 引用",
    html: ["<blockquote>", "<p>引用</p>"],
  }),
  e({
    id: "quote-multiline",
    title: "多行引用：行内换行在引用里也要保留",
    ubb: "[quote]一\n二[/quote]",
    markdown: "> 一\n> 二",
    html: ["<blockquote>", "一<br>", "二"],
  }),
  e({
    id: "list",
    title: "列表",
    ubb: "[list]\n[*]一\n[*]二\n[/list]",
    markdown: "- 一\n- 二",
    html: ["<ul>", "<li>一</li>", "<li>二</li>"],
  }),
  e({
    id: "table",
    title: "表格（首行为表头）",
    ubb: "[table][tr][td]甲[/td][td]乙[/td][/tr][tr][td]1[/td][td]2[/td][/tr][/table]",
    markdown: "| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |",
    html: ["<table>", "<th>甲</th>", "<td>1</td>"],
    notInHtml: ["| ---"],
  }),
  e({
    id: "table-pipe",
    title: "单元格里的竖线转义",
    ubb: "[table][tr][td]a|b[/td][/tr][tr][td]c[/td][/tr][/table]",
    markdown: "| a\\|b |\n| --- |\n| c |",
    html: ["<th>a|b</th>"],
  }),

  // ---------- 块与相邻文字：必须有空行，否则后文被吞进块里（懒续行） ----------
  e({
    id: "quote-then-text",
    title: "引用后紧跟文字：文字必须在引用之外（旧帖里 2168 篇受影响）",
    ubb: "[quote]引用[/quote]后文",
    markdown: "> 引用\n\n后文",
    html: ["<blockquote>", "<p>后文</p>"],
    notInHtml: ["引用\n后文", "引用<br>\n后文"],
  }),
  e({
    id: "text-then-quote",
    title: "文字后紧跟引用",
    ubb: "前文[quote]引用[/quote]",
    markdown: "前文\n\n> 引用",
    html: ["<p>前文</p>", "<blockquote>"],
  }),
  e({
    id: "quote-nested-continuation",
    title: "嵌套引用里，内层之后的文字属于外层而不是内层",
    ubb: "[quote]外[quote]内[/quote]外续[/quote]",
    markdown: "> 外\n>\n> > 内\n>\n> 外续",
    html: ["<p>外续</p>"],
    notInHtml: ["内\n外续", "内<br>\n外续"],
  }),
  e({
    id: "list-then-text",
    title: "列表后换行再接文字",
    ubb: "[list]\n[*]一\n[*]二\n[/list]\n后文",
    markdown: "- 一\n- 二\n\n后文",
    html: ["<li>二</li>", "<p>后文</p>"],
  }),
  e({
    id: "list-then-text-inline",
    title: "列表后紧跟文字（同一行）：文字不得吞进最后一个列表项",
    ubb: "[list]\n[*]一\n[/list]后文",
    markdown: "- 一\n\n后文",
    html: ["<li>一</li>", "<p>后文</p>"],
    notInHtml: ["一\n后文"],
  }),
  e({
    id: "table-then-text",
    title: "表格后紧跟文字：文字不得变成表格的一行（旧帖里 15 篇受影响）",
    ubb: "[table][tr][td]a[/td][/tr][/table]后文",
    markdown: "| a |\n| --- |\n\n后文",
    html: ["<table>", "<p>后文</p>"],
    notInHtml: ["<td>后文</td>"],
  }),
  e({
    id: "text-then-table",
    title: "文字后紧跟表格",
    ubb: "前文[table][tr][td]a[/td][/tr][/table]",
    markdown: "前文\n\n| a |\n| --- |",
    html: ["<p>前文</p>", "<table>"],
  }),
  e({
    id: "code-in-text",
    title: "代码块夹在文字中",
    ubb: "前[code]x[/code]后",
    markdown: "前\n```\nx\n```\n后",
    html: ["<p>前</p>", "<pre><code>", "<p>后</p>"],
  }),

  // ---------- 换行：旧站里换行就是换行 ----------
  e({
    id: "newline-soft",
    title: "段内单个换行必须显示为换行（旧帖里 8664 篇受影响）",
    ubb: "第一行\n第二行\n\n第二段",
    markdown: "第一行\n第二行\n\n第二段",
    html: ["第一行<br>", "第二行", "<p>第二段</p>"],
  }),
  e({
    id: "br-tag",
    title: "[br] 标签",
    ubb: "甲[br]乙",
    markdown: "甲\n乙",
    html: ["甲<br>", "乙"],
  }),
  e({
    id: "trailing-spaces",
    title: "行尾空格被去掉，换行照常显示",
    ubb: "行尾空格   \n下一行",
    markdown: "行尾空格\n下一行",
    html: ["行尾空格<br>", "下一行"],
  }),

  // ---------- 普通文本里的 Markdown 特殊字符必须按字面显示（≥2043 篇受影响） ----------
  e({
    id: "text-asterisk",
    title: "普通文本里的 *：数学式不得变斜体",
    ubb: "5*3=15 和 2*4=8",
    markdown: "5\\*3=15 和 2\\*4=8",
    html: ["5*3=15 和 2*4=8"],
    notInHtml: ["<em>"],
  }),
  e({
    id: "text-underscore",
    title: "普通文本里的 _",
    ubb: "a_b_c 与 _斜体_",
    markdown: "a\\_b\\_c 与 \\_斜体\\_",
    html: ["a_b_c 与 _斜体_"],
    notInHtml: ["<em>"],
  }),
  e({
    id: "text-tilde-pair",
    title: "用户自己打的 ~~语气符号~~ 不是删除线（S1 启用删除线后 1256 篇被误伤）",
    ubb: "好呀~~我也去~~哈",
    markdown: "好呀\\~\\~我也去\\~\\~哈",
    html: ["好呀~~我也去~~哈"],
    notInHtml: ["<del>"],
  }),
  e({
    id: "text-tilde-single",
    title: "单个 ~ 原样保留（语气词、集数区间），不加转义",
    ubb: "第1~12集，好~",
    markdown: "第1~12集，好~",
    html: ["第1~12集，好~"],
    notInHtml: ["<del>", "\\"],
  }),
  e({
    id: "text-tilde-run",
    title: "连续多个 ~ 的装饰线",
    ubb: "开工了~~~~~",
    markdown: "开工了\\~\\~\\~\\~\\~",
    html: ["开工了~~~~~"],
    notInHtml: ["<del>"],
  }),
  e({
    id: "text-backslash",
    title: "颜文字里的反斜杠",
    ubb: "\\(≧▽≦)/",
    markdown: "\\\\(≧▽≦)/",
    html: ["\\(≧▽≦)/"],
  }),
  e({
    id: "text-backtick",
    title: "普通文本里的反引号",
    ubb: "反引号 `x`",
    markdown: "反引号 \\`x\\`",
    html: ["反引号 `x`"],
    notInHtml: ["<code>"],
  }),
  e({
    id: "text-line-start-markers",
    title: "行首的 # - > 1. + 不得变成标题 / 列表 / 引用",
    ubb: "# 不是标题\n- 不是列表\n> 不是引用\n1. 不是列表\n+ 加号",
    markdown: "\\# 不是标题\n\\- 不是列表\n\\> 不是引用\n1\\. 不是列表\n\\+ 加号",
    html: ["# 不是标题", "- 不是列表", "> 不是引用", "1. 不是列表", "+ 加号"],
    notInHtml: ["<h1", "<ul>", "<ol>", "<blockquote>"],
  }),
  e({
    id: "text-setext-lines",
    title: "单独成行的 --- / === 不得把上一行变成标题或画分割线",
    ubb: "标题行\n---\n===",
    markdown: "标题行\n\\---\n\\===",
    html: ["标题行", "---", "==="],
    notInHtml: ["<h1", "<h2", "<hr"],
  }),
  e({
    id: "text-link-like",
    title: "普通文本里长得像 Markdown 链接 / 图片的方括号",
    ubb: "[链接](http://a.b) ![图](x.png)",
    markdown: "\\[链接\\](http://a.b) !\\[图\\](x.png)",
    html: ["[链接](http://a.b) ![图](x.png)"],
    notInHtml: ["<a ", "<img"],
  }),
  e({
    id: "text-leading-indent",
    title: "行首缩进（4 个以上空格或制表符）不得变成代码块；旧站 HTML 里行首空白本来就会被折叠",
    ubb: "    缩进四格\n\t制表符",
    markdown: "缩进四格\n制表符",
    html: ["缩进四格", "制表符"],
    notInHtml: ["<pre"],
  }),
  e({
    id: "text-fake-gate",
    title: "用户文本里的 :::gate 不得被当成门控（保存时 splitSource 会认它）",
    ubb: ':::gate{unlock="points" price="1"}\n假的\n:::',
    markdown: '\\:::gate{unlock="points" price="1"}\n假的\n\\:::',
    html: [":::gate{unlock=", "假的"],
    noGates: true,
  }),
  e({
    id: "text-entities",
    title: "旧站按 HTML 转义存储的 &lt; &amp; 照旧显示为字符，不会变成标签",
    ubb: "&lt;b&gt;不是加粗&lt;/b&gt; &amp; 符号",
    markdown: "&lt;b&gt;不是加粗&lt;/b&gt; &amp; 符号",
    html: ["不是加粗", "符号"],
    notInHtml: ["<b>"],
  }),
];
