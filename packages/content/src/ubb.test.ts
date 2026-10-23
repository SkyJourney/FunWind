import { describe, expect, it } from "vitest";
import { assembleSource, splitSource } from "./gate-syntax.js";
import { ubbToMarkdown, type UbbContext } from "./ubb.js";

const EMOJI = new Set(Array.from({ length: 50 }, (_, i) => 120 + i));
const FILES = new Set(["photo/Mon_1003/3_abc.jpg", "Mon_1004/55_7_hash.jpg"]);

const ctx = (over: Partial<UbbContext> = {}): UbbContext => ({
  emojiIds: EMOJI,
  attachmentExists: (rel) => FILES.has(rel),
  resolveAttachment: (aid) => (aid === 7 ? { name: "字幕.zip", path: "1302/thread/a.zip" } : null),
  allocateGateId: (seq) => 5000 + seq,
  ...over,
});
const conv = (src: string, over?: Partial<UbbContext>) => ubbToMarkdown(src, ctx(over));

describe("基础标签", () => {
  it("空输入", () => {
    expect(ubbToMarkdown(null, ctx())).toEqual({ md: "", gates: [], warnings: [] });
    expect(conv("").md).toBe("");
  });

  it("强调 / 删除线 / 上下标 / 水平线", () => {
    expect(conv("[b]粗[/b][i]斜[/i]").md).toBe("**粗***斜*");
    expect(conv("[u]下[/u][s]删[/s][sup]2[/sup][sub]i[/sub]").md).toBe(
      "<u>下</u><s>删</s><sup>2</sup><sub>i</sub>",
    );
    expect(conv("上[hr]下").md).toBe("上\n\n---\n\n下");
  });

  it("[hr] 不吞后续内容（无闭合标签）", () => {
    expect(conv("[hr][b]x[/b]").md).toBe("---\n\n**x**");
  });

  it("颜色 / 字号 / 对齐（情怀排版），非法值被清洗", () => {
    expect(conv("[color=red]红[/color]").md).toBe('<span style="color:red">红</span>');
    expect(conv("[size=7]大[/size]").md).toBe('<span style="font-size:32px">大</span>');
    expect(conv("[color=red;x:url(a)]c[/color]").md).toBe("c"); // 含函数调用的值整体丢弃
    expect(conv("[color=rgb(10, 20,30)]c[/color]").md).toBe(
      '<span style="color:rgb(10, 20,30)">c</span>',
    );
    expect(conv("[backcolor=#fff]c[/backcolor]").md).toBe(
      '<span style="background-color:#fff">c</span>',
    );
    expect(conv("[size=99x]c[/size]").md).toBe("c");
    expect(conv("[align=center]中[/align]").md).toContain("text-align:center");
    expect(conv("[font=宋体]f[/font]").md).toBe("f");
  });

  it("引用 / 代码 / 列表", () => {
    expect(conv("[quote]a\nb[/quote]").md).toBe("> a\n> b");
    expect(conv("[code]x[s:130][/code]").md).toBe("```\nx[s:130]\n```");
    expect(conv("[list][*]一[*]二[/list]").md).toContain("- ");
  });

  it("email / 附件", () => {
    expect(conv("[email]a@b.io[/email]").md).toBe("[a@b.io](mailto:a@b.io)");
    expect(conv("[attachment=7]").md).toBe("[📎 字幕.zip](/attachment/1302/thread/a.zip)");
    expect(conv("[attachment=99]").md).toBe("[附件 #99]");
    expect(conv("[attachment=x]y[/attachment]").md).toBe("y");
  });

  it("未知标签剥壳留肉；孤立闭合标签按字面量保留", () => {
    expect(conv("[foo]留着[/foo]").md).toBe("留着");
    expect(conv("多余[/b]结尾").md).toBe("多余[/b]结尾");
  });

  it("level 标签：去壳、内容公开并记录告警", () => {
    const r = conv("[level=3]公开[/level]");
    expect(r.md).toBe("公开");
    expect(r.warnings.map((w) => w.code)).toEqual(["level-stripped"]);
  });
});

describe("表情", () => {
  it("映射内表情展开为静态资源", () => {
    expect(conv("好[s:130]").md).toBe("好![表情](/emoji/130.gif)");
    expect(conv("x[s:130]", { emojiUrl: (id) => `/e/${id}.png` }).md).toBe("x![表情](/e/130.png)");
  });

  it("映射外遗留码直接删除并记录告警", () => {
    const r = conv("好[s:171]看[s:53]");
    expect(r.md).toBe("好看");
    expect(r.warnings.filter((w) => w.code === "emoji-legacy-stripped")).toHaveLength(2);
  });

  it("缺右括号的笔误码原样保留（不误伤）", () => {
    expect(conv("[s:125 文本").md).toBe("[s:125 文本");
  });
});

describe("链接与图片改写", () => {
  it("回到原帖图标 + topost 链接 → 站内锚点", () => {
    const src =
      "[url=http://www.qingyisub.com/job.php?action=topost;tid=2;pid=20][img]p_w_picpath/back.gif[/img][/url]";
    expect(conv(src).md).toBe("[↩ 原帖](/t/2#p20)");
    const abs =
      "[url=http://www.qingyisub.com/job.php?action=topost;tid=2;pid=23][img]http://www.qingyisub.com/p_w_picpath/back.gif[/img][/url]";
    expect(conv(abs).md).toBe("[↩ 原帖](/t/2#p23)");
  });

  it("站内 read.php / thread.php 链接", () => {
    expect(conv("[url]http://www.qingyisub.top/read.php?tid=123&page=2[/url]").md).toBe(
      "[http://www.qingyisub.top/read.php?tid=123&page=2](/t/123)",
    );
    expect(conv("[url=read.php?tid=5&pid=9]x[/url]").md).toBe("[x](/t/5#p9)");
    expect(conv("[url=http://qingyisub.com/thread.php?fid=109]版块[/url]").md).toBe(
      "[版块](/f/109)",
    );
  });

  it("外站链接不改写；裸域名补协议", () => {
    expect(conv("[url=http://example.com/a?b=1]e[/url]").md).toBe("[e](http://example.com/a?b=1)");
    expect(conv("[url=example.com/x]e[/url]").md).toBe("[e](http://example.com/x)");
    expect(conv("[url=javascript:alert(1)]x[/url]").md).toBe("x");
  });

  it("p_w_upload 图片：磁盘存在 → /attachment/；不存在 → 保留原绝对地址并告警", () => {
    const hit = conv("[img]http://www.qingyisub.com/p_w_upload/photo/Mon_1003/3_abc.jpg[/img]");
    expect(hit.md).toBe("![img](/attachment/photo/Mon_1003/3_abc.jpg)");
    const miss = conv("[img]http://www.qingyisub.com/p_w_upload/photo/Mon_1003/gone.jpg[/img]");
    expect(miss.md).toBe("![img](http://www.qingyisub.com/p_w_upload/photo/Mon_1003/gone.jpg)");
    expect(miss.warnings.map((w) => w.code)).toEqual(["image-unresolved"]);
  });

  it("p_w_picpath 内置图（非 back.gif）丢弃", () => {
    const r = conv("a[img]p_w_picpath/smile.gif[/img]b");
    expect(r.md).toBe("ab");
    expect(r.warnings[0]?.code).toBe("image-dropped");
  });

  it("普通图片 / 非法协议图片", () => {
    expect(conv("[img]http://a.io/x.png[/img]").md).toBe("![img](http://a.io/x.png)");
    expect(conv("[img]javascript:alert(1)[/img]").md).toBe("javascript:alert(1)");
  });

  it("媒体标签降级为链接", () => {
    expect(conv("[wmv=1]http://a.io/v.wmv[/wmv]").md).toBe("[🎬 媒体](http://a.io/v.wmv)");
    expect(conv("[flash]not a url[/flash]").md).toBe("not a url");
  });
});

describe("表格", () => {
  it("转 Markdown 表格，首行为表头，列数补齐，| 被转义", () => {
    const src = "[table][tr][td]a|b[/td][td]c[/td][/tr][tr][td]1[/td][/tr][/table]";
    expect(conv(src).md).toBe("| a\\|b | c |\n| --- | --- |\n| 1 |  |");
  });

  it("无 tr 的畸形表格退化为内容", () => {
    expect(conv("[table]裸文字[/table]").md).toBe("裸文字");
  });
});

describe("表格与门控", () => {
  it("未闭合的表格里放门控：只产生一个门控（不再被渲染两次），占位提升到表格之后", () => {
    const r = conv("[table][tr][td]下载[post]百度网盘链接[/post][/td][/tr]");
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0]).toMatchObject({ seq: 1, hiddenMd: "百度网盘链接" });
    expect(r.md).toBe('| 下载 |\n| --- |\n\n:::gate{id="5001"}\n:::');
    expect(r.md).not.toContain("百度网盘");
  });

  it("闭合的表格同样：门控内容保留并提升，表格行内不残留占位", () => {
    const r = conv("[table][tr][td]甲[sell=3,]秘密[/sell][/td][td]乙[/td][/tr][/table]后文");
    expect(r.gates.map((g) => g.hiddenMd)).toEqual(["秘密"]);
    expect(r.md).toContain("| 甲 | 乙 |");
    expect(r.md).not.toMatch(/\|[^\n]*:::gate/);
    expect(r.md.endsWith("后文")).toBe(true);
    expect(splitSource(assembleSource(r.md, r.gates).source).errors).toEqual([]);
  });

  it("引用里的表格内的门控仍按嵌套丢弃", () => {
    const r = conv("[quote][table][tr][td][post]秘[/post][/td][/tr][/table][/quote]");
    expect(r.gates).toEqual([]);
    expect(r.md).not.toContain("秘");
  });
});

describe("门控转换", () => {
  it("[sell=N,K] → 积分门控：N 为价格，K（积分类型）忽略", () => {
    const r = conv("前[sell=5,1]秘密A[/sell]后");
    expect(r.gates).toEqual([
      {
        id: 5001,
        seq: 1,
        conditions: [{ type: "points", price: 5 }],
        matchMode: "all",
        hiddenMd: "秘密A",
      },
    ]);
    expect(r.md).toBe('前\n\n:::gate{id="5001"}\n:::\n\n后');
    expect(r.md).not.toContain("秘密A");
  });

  it("价格 0 保留为免费解锁；≥ 9999 一律改免费并告警；非法价格告警为 0", () => {
    expect(conv("[sell=0,]x[/sell]").gates[0]?.conditions[0]).toEqual({ type: "points", price: 0 });
    const big = conv("[sell=9999]x[/sell]");
    expect(big.gates[0]?.conditions[0]).toEqual({ type: "points", price: 0 });
    expect(big.warnings).toEqual([{ code: "gate-price-reset", detail: "9999" }]);
    expect(conv("[sell=22]x[/sell]").gates[0]?.conditions[0]).toEqual({
      type: "points",
      price: 22,
    });
    expect(conv("[sell=abc]x[/sell]").warnings[0]?.code).toBe("gate-price-invalid");
    expect(conv("[sell]x[/sell]").gates[0]?.conditions[0]).toEqual({ type: "points", price: 0 });
  });

  it("freeAbovePrice 可调", () => {
    expect(conv("[sell=50]x[/sell]", { freeAbovePrice: 50 }).gates[0]?.conditions[0]).toEqual({
      type: "points",
      price: 0,
    });
  });

  it("[post] / [hide] → 回复可见门控；空内容丢弃", () => {
    const r = conv("[post]回帖可见[/post]\n[hide=16]HIDE[/hide]");
    expect(r.gates.map((g) => g.conditions[0]?.type)).toEqual(["reply", "reply"]);
    expect(r.gates.map((g) => g.seq)).toEqual([1, 2]);
    const empty = conv("模板[hide=9999][/hide]示例");
    expect(empty.gates).toEqual([]);
    expect(empty.md).toBe("模板示例");
    expect(empty.warnings[0]).toEqual({ code: "gate-empty-dropped", detail: "HIDE" });
  });

  it("门控内容本身被转换（表情 / 图片 / 样式）", () => {
    const r = conv("[post][b]粗[/b][s:130][/post]");
    expect(r.gates[0]?.hiddenMd).toBe("**粗**![表情](/emoji/130.gif)");
  });

  it("穿过样式包装的门控被提升为顶层块", () => {
    const r = conv("[color=red][sell=3,]x[/sell][/color]");
    expect(r.gates).toHaveLength(1);
    expect(r.md).toContain(':::gate{id="5001"}');
    expect(r.md).not.toContain(">x");
  });

  it("引用 / 列表 / 表格内的门控：内容丢弃，留提示，不进公开正文", () => {
    const r = conv("[quote][sell=5,]被引用的秘密[/sell][/quote]");
    expect(r.gates).toEqual([]);
    expect(r.md).not.toContain("被引用的秘密");
    expect(r.md).toContain("已省略");
    expect(r.warnings.map((w) => w.code)).toEqual(["gate-nested-dropped"]);
    const tbl = conv("[table][tr][td][post]表格秘密[/post][/td][/tr][/table]");
    expect(tbl.md).not.toContain("表格秘密");
  });

  it("门控内再出现门控：并入外层，不产生第二个门控", () => {
    const r = conv("[sell=5,]外[post]内[/post][/sell]");
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0]?.hiddenMd).toBe("外内");
  });

  it("未闭合的门控标签：失败即封闭——到末尾的内容都归入隐藏内容，公开正文不泄露", () => {
    const r = conv("公开前文[sell=5,]没有闭合的付费内容\n以及后面的全部文字");
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0]?.hiddenMd).toBe("没有闭合的付费内容\n以及后面的全部文字");
    expect(r.md).toBe('公开前文\n\n:::gate{id="5001"}\n:::');
    expect(r.md).not.toContain("付费内容");
    expect(r.warnings.map((w) => w.code)).toEqual(["gate-unclosed"]);
  });

  it("未闭合的 [post] / [hide] 同样封闭；位于闭合容器内的未闭合门控仍按嵌套丢弃", () => {
    expect(conv("[post]秘密").gates[0]?.conditions[0]).toEqual({ type: "reply" });
    expect(conv("[post]秘密").md).not.toContain("秘密");
    const nested = conv("[quote]引用[sell=5,]秘密[/quote]后");
    expect(nested.md).not.toContain("秘密");
  });

  it("单帖门控超过上限直接抛错（由迁移显式处理，不静默丢）", () => {
    const src = Array.from({ length: 16 }, () => "[post]x[/post]").join("\n");
    expect(() => conv(src)).toThrow(RangeError);
  });

  it("转换产物经 assemble 还原后，可被 splitSource 无损再拆（占位语法与门控语法同源）", () => {
    const r = conv("前[sell=5,]秘密[/sell]后[post]B[/post]");
    const asm = assembleSource(r.md, r.gates);
    expect(asm.errors).toEqual([]);
    const again = splitSource(asm.source);
    expect(again.errors).toEqual([]);
    expect(again.publicMd).toBe(r.md);
    expect(again.gates).toEqual(r.gates);
  });

  it("样式包装内的门控：占位提升为顶层块，两侧文本各自保留样式", () => {
    const r = conv("[color=red]前[sell=3,]x[/sell]后[/color]");
    expect(r.md).toBe(
      '<span style="color:red">前</span>\n\n:::gate{id="5001"}\n:::\n\n<span style="color:red">后</span>',
    );
    const asm = assembleSource(r.md, r.gates);
    expect(splitSource(asm.source).gates).toEqual(r.gates);
    const al = conv("[align=center][post]p[/post][/align]");
    expect(al.md).toBe(':::gate{id="5001"}\n:::');
  });
});

describe("未闭合标签不吞内容（v1 的数据丢失缺陷）", () => {
  it("[attachment=N] 无闭合标签：后面的正文必须保留", () => {
    expect(conv("[attachment=7] 附件后面的正文不能丢").md).toBe(
      "[📎 字幕.zip](/attachment/1302/thread/a.zip) 附件后面的正文不能丢",
    );
    expect(conv("前[attachment=7]中[attachment=99]后").md).toBe(
      "前[📎 字幕.zip](/attachment/1302/thread/a.zip)中[附件 #99]后",
    );
  });

  it("闭合的 [attachment=N]内容[/attachment] 保留内容", () => {
    expect(conv("[attachment=7]说明[/attachment]").md).toBe(
      "[📎 字幕.zip](/attachment/1302/thread/a.zip)说明",
    );
  });

  it("[attachment=N] 之后的门控仍被正确提取（不再被当作嵌套丢弃）", () => {
    const r = conv("前[attachment=7]中[post]秘密[/post]后");
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0]?.hiddenMd).toBe("秘密");
    expect(r.warnings.map((w) => w.code)).not.toContain("gate-nested-dropped");
    expect(r.md).toContain("后");
  });

  it("未知标签对门控位置透明：包着门控的自定义标签不丢内容", () => {
    const r = conv("[qysub]x[post]p[/post][/qysub]后");
    expect(r.gates.map((g) => g.hiddenMd)).toEqual(["p"]);
    expect(r.md).toContain("x");
    expect(r.md).toContain("后");
  });

  it("未闭合的 [li] / 媒体标签不吞后文", () => {
    expect(conv("[li]一[li]二").md).toBe("一二");
    expect(conv("[rmvb=1]后面的文字").md).toBe("后面的文字");
  });

  it("未闭合的 [quote]：门控提升为顶层，引用只包裹两侧文本", () => {
    const r = conv("[quote]前[post]秘[/post]后");
    expect(r.gates).toHaveLength(1);
    expect(r.md).toBe('> 前\n\n:::gate{id="5001"}\n:::\n\n> 后');
  });

  it("真正闭合的 [quote] 内的门控仍然丢弃（那是别人对原文的引用）", () => {
    const r = conv("[quote]前[post]秘[/post]后[/quote]");
    expect(r.gates).toEqual([]);
    expect(r.md).not.toContain("秘");
    expect(r.warnings[0]).toEqual({ code: "gate-nested-dropped", detail: "POST in QUOTE" });
  });
});

describe("标签交叉嵌套：门控优先（失败即封闭）", () => {
  it("[color][sell]A[/color]B[/sell]C：A、B 都在隐藏内容里，C 是公开的", () => {
    const r = conv("[color=red][sell=5,]秘密甲[/color]秘密乙[/sell]公开丙");
    expect(r.gates).toHaveLength(1);
    expect(r.gates[0]?.hiddenMd).toContain("秘密甲");
    expect(r.gates[0]?.hiddenMd).toContain("秘密乙");
    expect(r.md).not.toContain("秘密");
    expect(r.md).toContain("公开丙");
  });

  it("没有对应开标签的门控闭合标签被丢弃，不在正文里露出", () => {
    const r = conv("前[/sell]后[/post]");
    expect(r.md).toBe("前后");
    expect(r.warnings.filter((w) => w.code === "gate-stray-close")).toHaveLength(2);
  });

  it("门控内被交叉的非门控闭合标签留作隐藏内容里的字面量，不影响门控边界", () => {
    const r = conv("[b][post]甲[/b]乙[/post]丙");
    expect(r.gates[0]?.hiddenMd).toContain("甲");
    expect(r.gates[0]?.hiddenMd).toContain("乙");
    expect(r.md).toContain("丙");
    expect(r.md).not.toMatch(/[甲乙]/);
  });

  it("门控与门控交叉：外层闭合时内层随之结束，后续闭合标签丢弃", () => {
    const r = conv("[sell=1,]甲[post]乙[/sell]丙[/post]丁");
    expect(r.gates).toHaveLength(1);
    expect(r.md).toContain("丙");
    expect(r.md).toContain("丁");
    expect(r.md).not.toMatch(/[甲乙]/);
  });
});

describe("性质测试 · 泄露不变量", () => {
  /** 确定性伪随机，避免引入依赖且结果可复现 */
  function rng(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  const WRAPPERS = [
    "",
    "b",
    "color=red",
    "size=3",
    "align=center",
    "quote",
    "list",
    "url=http://a.io",
  ];
  const GATES = ["sell=5,", "sell=0,1", "sell=9999", "post", "hide=16"];

  it("无论怎样嵌套，任何秘密令牌都不会出现在公开 md 中", () => {
    const rand = rng(20261023);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    let secrets = 0;
    let topGates = 0;

    for (let i = 0; i < 400; i++) {
      const parts: string[] = [];
      const tokens: string[] = [];
      const n = 1 + Math.floor(rand() * 4);
      for (let j = 0; j < n; j++) {
        const token = `SECRET_${i}_${j}`;
        tokens.push(token);
        const gate = pick(GATES);
        const gateTag = gate.split("=")[0]!;
        // 约四分之一的门控故意不写闭合标签：失败即封闭，秘密同样不得进入公开正文
        const closeTag = rand() < 0.25 ? "" : `[/${gateTag}]`;
        let piece = `[${gate}]${token}${closeTag}`;
        // 约五分之一的门控与样式标签交叉嵌套（旧帖里真实存在的写法）：秘密同样不得进入公开正文
        if (rand() < 0.2) piece = `[color=red][${gate}]${token}[/color]${token}x${closeTag}`;
        const depth = Math.floor(rand() * 3);
        for (let d = 0; d < depth; d++) {
          const w = pick(WRAPPERS);
          if (w) piece = `[${w}]${piece}[/${w.split("=")[0]}]`;
        }
        parts.push(`公开文字${j}`, piece);
      }
      const r = ubbToMarkdown(parts.join("\n"), ctx());
      const hiddenAll = r.gates.map((g) => g.hiddenMd).join("\n");
      for (const t of tokens) {
        secrets++;
        expect(r.md, `第 ${i} 组：${t} 泄露到公开正文`).not.toContain(t);
        void hiddenAll;
      }
      topGates += r.gates.length;
      // 公开正文必须能被门控语法无错解析
      expect(splitSource(r.md).errors.map((e) => e.code)).not.toContain("gate-unclosed");
    }
    expect(secrets).toBeGreaterThan(400);
    expect(topGates).toBeGreaterThan(0); // 保证用例确实覆盖到了「成功提升为门控」的路径
  });
});
