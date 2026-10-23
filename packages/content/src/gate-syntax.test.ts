import { describe, expect, it } from "vitest";
import {
  assembleSource,
  DEFAULT_CONDITION_SPECS,
  MAX_GATES_PER_POST,
  pointsSpec,
  replySpec,
  serializeGate,
  splitSource,
  validateGates,
} from "./gate-syntax.js";
import type { ConditionSpec } from "./types.js";

const alloc = (seq: number, existing: number | null) => existing ?? 1000 + seq;

describe("splitSource · 基本拆分", () => {
  it("拆出积分门控：正文只留占位，隐藏内容进 GateDraft", () => {
    const src = 'a\n\n:::gate{unlock="points" price="50"}\n付费 **内容**\n:::\n\nz';
    const r = splitSource(src, { allocateId: alloc });
    expect(r.errors).toEqual([]);
    expect(r.publicMd).toBe('a\n\n:::gate{id="1001"}\n:::\n\nz');
    expect(r.gates).toEqual([
      {
        id: 1001,
        seq: 1,
        conditions: [{ type: "points", price: 50 }],
        matchMode: "all",
        hiddenMd: "付费 **内容**",
      },
    ]);
    expect(r.publicMd).not.toContain("付费");
  });

  it("多个门控按出现顺序编号；回复可见无参数；match=any", () => {
    const src =
      ':::gate{unlock="reply"}\nA\n:::\n\n中间\n\n:::gate{unlock="points" price="0" match="any"}\nB\n:::';
    const r = splitSource(src, { allocateId: alloc });
    expect(r.errors).toEqual([]);
    expect(r.gates.map((g) => [g.seq, g.id, g.conditions[0]?.type, g.matchMode])).toEqual([
      [1, 1001, "reply", "all"],
      [2, 1002, "points", "any"],
    ]);
    expect(r.gates[1]?.conditions[0]).toEqual({ type: "points", price: 0 });
  });

  it("价格 0 合法（登录后免费解锁）", () => {
    const r = splitSource(':::gate{unlock="points" price="0"}\nx\n:::', { allocateId: alloc });
    expect(r.errors).toEqual([]);
  });

  it("已有 id 的门控原样保留 id（编辑已存在的门控）", () => {
    const r = splitSource(':::gate{id="42" unlock="reply"}\nx\n:::', {
      allocateId: (_seq, existing) => existing ?? 999,
    });
    expect(r.gates[0]?.id).toBe(42);
    expect(r.publicMd).toBe(':::gate{id="42"}\n:::');
  });

  it("CRLF 输入与 LF 等价", () => {
    const a = splitSource('a\r\n\r\n:::gate{unlock="reply"}\r\nh\r\n:::\r\n', {
      allocateId: alloc,
    });
    const b = splitSource('a\n\n:::gate{unlock="reply"}\nh\n:::\n', { allocateId: alloc });
    expect(a).toEqual(b);
  });

  it("空门控（隐藏内容为空）合法", () => {
    const r = splitSource(':::gate{unlock="reply"}\n:::', { allocateId: alloc });
    expect(r.errors).toEqual([]);
    expect(r.gates[0]?.hiddenMd).toBe("");
  });

  it("代码围栏内的 :::gate 是普通文本，不构成门控", () => {
    const src = '```\n:::gate{unlock="reply"}\nx\n:::\n```';
    const r = splitSource(src, { allocateId: alloc });
    expect(r.gates).toEqual([]);
    expect(r.publicMd).toBe(src);
  });

  it("没有门控的普通 Markdown 原样返回", () => {
    const src = "# 标题\n\n- a\n- b\n\n> 引用";
    expect(splitSource(src)).toEqual({ publicMd: src, gates: [], errors: [] });
  });

  it("隐藏内容可含其它容器指令与代码块（外层篱笆加长）", () => {
    const src = '::::gate{unlock="reply"}\n:::poll\ninner\n:::\n\n```js\nx\n```\n::::';
    const r = splitSource(src, { allocateId: alloc });
    expect(r.errors).toEqual([]);
    expect(r.gates[0]?.hiddenMd).toContain(":::poll");
    expect(r.gates[0]?.hiddenMd).toContain("```js");
  });
});

describe("splitSource · 非法输入必须报错", () => {
  const codes = (src: string) => splitSource(src, { allocateId: alloc }).errors.map((e) => e.code);

  it("未闭合：不得把后续正文吞进门控", () => {
    expect(codes('a\n\n:::gate{unlock="reply"}\n隐藏\n\n后面还有正文')).toContain("gate-unclosed");
  });

  it("嵌套门控", () => {
    const src = ':::::gate{unlock="reply"}\n::::gate{unlock="reply"}\nx\n::::\n:::::';
    expect(codes(src)).toContain("gate-nested");
  });

  it("位于引用 / 列表内的门控（非顶层）", () => {
    expect(codes('> :::gate{unlock="reply"}\n> x\n> :::')).toContain("gate-not-top-level");
    expect(codes('- 项\n\n  :::gate{unlock="reply"}\n  x\n  :::')).toContain("gate-not-top-level");
  });

  it("未知解锁条件 / 缺失 unlock", () => {
    expect(codes(':::gate{unlock="follow"}\nx\n:::')).toContain("gate-unknown-unlock");
    expect(codes(":::gate\nx\n:::")).toContain("gate-unknown-unlock");
  });

  it("积分价格非法：缺失、负数、小数、非数字、过长", () => {
    for (const price of ["", ' price="-1"', ' price="1.5"', ' price="abc"', ' price="123456789"']) {
      expect(codes(`:::gate{unlock="points"${price}}\nx\n:::`), price).toContain(
        "gate-invalid-params",
      );
    }
  });

  it("未知属性被拒绝（挡住 onclick 之类注入）", () => {
    expect(codes(':::gate{unlock="reply" onclick="alert(1)"}\nx\n:::')).toContain(
      "gate-unknown-attribute",
    );
    expect(codes(':::gate{unlock="points" price="5" class="x"}\nx\n:::')).toContain(
      "gate-unknown-attribute",
    );
  });

  it("match 只能是 all / any", () => {
    expect(codes(':::gate{unlock="reply" match="none"}\nx\n:::')).toContain("gate-invalid-params");
  });

  it("新门控缺少 id 分配器", () => {
    const r = splitSource(':::gate{unlock="reply"}\nx\n:::');
    expect(r.errors.map((e) => e.code)).toContain("gate-missing-id");
  });

  it("超过单帖门控上限", () => {
    const one = ':::gate{unlock="reply"}\nx\n:::';
    const src = Array.from({ length: MAX_GATES_PER_POST + 1 }, () => one).join("\n\n");
    expect(codes(src)).toContain("gate-too-many");
  });

  it("错误携带行号，便于编辑器提示", () => {
    const r = splitSource('a\n\nb\n\n:::gate{unlock="nope"}\nx\n:::', { allocateId: alloc });
    expect(r.errors[0]?.line).toBe(5);
  });
});

describe("assembleSource · 还原", () => {
  it("拆分后立即还原：再拆一次结果完全一致（往返无损）", () => {
    const src =
      '前言\n\n:::gate{unlock="points" price="30"}\n**付费** `code`\n\n- 列表\n:::\n\n中段\n\n:::gate{unlock="reply" match="any"}\n回复可见\n:::\n\n尾';
    const first = splitSource(src, { allocateId: alloc });
    const asm = assembleSource(first.publicMd, first.gates);
    expect(asm.errors).toEqual([]);
    const second = splitSource(asm.source);
    expect(second.errors).toEqual([]);
    expect(second.publicMd).toBe(first.publicMd);
    expect(second.gates).toEqual(first.gates);
  });

  it("隐藏内容含 ::: 行时篱笆自动加长，仍可往返", () => {
    const g = {
      id: 7,
      conditions: [{ type: "reply" }],
      matchMode: "all" as const,
      hiddenMd: ":::note\n提示\n:::\n正文",
    };
    const block = serializeGate(g);
    expect(block.startsWith("::::gate{")).toBe(true);
    const r = splitSource(block);
    expect(r.errors).toEqual([]);
    expect(r.gates[0]?.hiddenMd).toBe(g.hiddenMd);
  });

  it("占位引用不存在的门控 → 报错而不是静默吞掉", () => {
    const r = assembleSource(':::gate{id="99"}\n:::', []);
    expect(r.errors.map((e) => e.code)).toContain("gate-unknown-placeholder");
  });

  it("有门控没有对应占位 → 报错（防止丢失隐藏内容）", () => {
    const r = assembleSource("只有公开文字", [
      { id: 5, conditions: [{ type: "reply" }], matchMode: "all", hiddenMd: "秘密" },
    ]);
    expect(r.errors.map((e) => e.code)).toContain("gate-unknown-placeholder");
  });

  it("占位缺 id 同样报错", () => {
    expect(assembleSource(":::gate\n:::", []).errors.length).toBeGreaterThan(0);
  });
});

describe("serializeGate / 条件规格", () => {
  it("未知条件抛错；缺条件抛错", () => {
    expect(() =>
      serializeGate({ id: 1, conditions: [{ type: "nope" }], matchMode: "all", hiddenMd: "" }),
    ).toThrow();
    expect(() =>
      serializeGate({ id: 1, conditions: [], matchMode: "all", hiddenMd: "" }),
    ).toThrow();
  });

  it("属性值里的引号与反斜杠被剔除，无法逃出属性", () => {
    const spec: ConditionSpec = {
      type: "tag",
      parse: (a) => ({ params: { name: a.name ?? "" } }),
      toAttrs: (c) => ({ name: String(c.name) }),
    };
    const specs = new Map([...DEFAULT_CONDITION_SPECS, [spec.type, spec]]);
    const out = serializeGate(
      {
        id: 1,
        conditions: [{ type: "tag", name: 'a" onclick="x' }],
        matchMode: "all",
        hiddenMd: "h",
      },
      specs,
    );
    expect(out).toBe(':::gate{id="1" unlock="tag" name="a onclick=x"}\nh\n:::');
  });

  it("可注入新的条件规格（模块内核 gateConditions 的扩展点）", () => {
    const login: ConditionSpec = {
      type: "login",
      parse: () => ({ params: {} }),
      toAttrs: () => ({}),
    };
    const specs = new Map([...DEFAULT_CONDITION_SPECS, [login.type, login]]);
    const r = splitSource(':::gate{unlock="login"}\nx\n:::', { specs, allocateId: alloc });
    expect(r.errors).toEqual([]);
    expect(r.gates[0]?.conditions).toEqual([{ type: "login" }]);
  });

  it("内置规格", () => {
    expect(pointsSpec.parse({ price: "10" })).toEqual({ params: { price: 10 } });
    expect(pointsSpec.toAttrs({ type: "points", price: 10 })).toEqual({ price: "10" });
    expect(replySpec.parse({})).toEqual({ params: {} });
    expect(replySpec.toAttrs({ type: "reply" })).toEqual({});
  });

  it("validateGates：无需分配 id 即可校验", () => {
    expect(validateGates(':::gate{unlock="reply"}\nx\n:::')).toEqual([]);
    expect(validateGates(':::gate{unlock="zzz"}\nx\n:::').length).toBe(1);
  });
});
