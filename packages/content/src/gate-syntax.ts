/**
 * 门控语法（docs/GATES.md）：`:::gate{unlock="points" price="50"}` 容器指令。
 *
 * 存储契约：保存时把门控内容拆出——公开部分 publicMd 只含占位 `:::gate{key="a1"}\n:::`，
 * 隐藏正文单独成为 GateDraft.hiddenMd。作者编辑时 assembleSource 再按 key 合并还原。
 * key 是门控在帖内的稳定身份（post_gates.gate_key）：编辑不改 key，已购买记录因此不丢；新门控由服务端分配。
 * 该文件是纯函数，迁移程序与线上保存共用同一套语法，不存在解析分歧。
 */
import type { Root, RootContent } from "mdast";
import type { ContainerDirective } from "mdast-util-directive";
import remarkParse from "remark-parse";
import remarkDirective from "remark-directive";
import { unified } from "unified";
import type {
  ConditionSpec,
  ConditionUi,
  GateCondition,
  GateDraft,
  GateError,
  GateKeyAllocator,
  GateMatchMode,
} from "./types.js";

/** 一个帖子最多的门控数（防滥用的合理上限） */
export const MAX_GATES_PER_POST = 15;

/** key 形态：短小的字母数字串，便于出现在正文占位里 */
const KEY_RE = /^[A-Za-z0-9_-]{1,16}$/;

/** 缺省 key 分配：g1、g2…取第一个未占用的 */
export const defaultKeyAllocator: GateKeyAllocator = (_seq, used) => {
  for (let n = 1; ; n++) if (!used.has(`g${n}`)) return `g${n}`;
};

const GATE_NAME = "gate";
/** 门控块自身的保留属性（其余属性属于解锁条件的参数） */
const RESERVED_ATTRS = new Set(["key", "unlock", "match"]);

// ---------- 解锁条件规格 ----------

/** 积分购买：price 为非负整数（0 = 登录后免费解锁） */
export const pointsSpec: ConditionSpec = {
  type: "points",
  ui: {
    label: "积分解锁",
    hint: "读者支付积分后解锁",
    fields: [
      {
        name: "price",
        label: "价格（积分）",
        kind: "integer",
        min: 0,
        max: 9_999_999,
        defaultValue: "10",
        emptyValue: "0",
      },
    ],
  },
  parse(attrs) {
    const raw = attrs.price;
    if (raw === undefined || !/^\d{1,7}$/.test(raw)) {
      return { error: "points 条件需要 price（0–9999999 的整数）" };
    }
    return { params: { price: Number(raw) } };
  },
  toAttrs: (c) => ({ price: String(c.price) }),
};

/** 回复可见：无参数 */
export const replySpec: ConditionSpec = {
  type: "reply",
  ui: { label: "回复解锁", hint: "读者在本帖回复后解锁", fields: [] },
  parse: () => ({ params: {} }),
  toAttrs: () => ({}),
};

export const DEFAULT_CONDITION_SPECS: ReadonlyMap<string, ConditionSpec> = new Map([
  [pointsSpec.type, pointsSpec],
  [replySpec.type, replySpec],
]);

/**
 * 编辑器可选的解锁方式目录（按规格表顺序）：`type` + 面向作者的描述。
 * 新增一种条件时只需注册规格（含 ui），编辑器的块视图与工具栏无需再改。
 */
export function listConditionUi(
  specs: ReadonlyMap<string, ConditionSpec> = DEFAULT_CONDITION_SPECS,
): ({ type: string } & ConditionUi)[] {
  const out: ({ type: string } & ConditionUi)[] = [];
  for (const spec of specs.values()) if (spec.ui) out.push({ type: spec.type, ...spec.ui });
  return out;
}

// ---------- 解析 ----------

const processor = unified().use(remarkParse).use(remarkDirective);

const normalizeEol = (s: string) => s.replace(/\r\n?/g, "\n");

interface ParsedGate {
  node: ContainerDirective;
  start: number;
  end: number;
  /** 开篱笆的冒号数（assemble 选择更长的篱笆时参考） */
  colons: number;
  line: number;
}

function isGate(node: RootContent): node is ContainerDirective {
  return node.type === "containerDirective" && node.name === GATE_NAME;
}

/** 递归寻找非顶层的 gate（位于引用/列表/其它指令内部） */
function findNestedGates(nodes: RootContent[], depth: number, out: ContainerDirective[]): void {
  for (const n of nodes) {
    if (isGate(n) && depth > 0) out.push(n);
    if ("children" in n && Array.isArray(n.children)) {
      findNestedGates(n.children as RootContent[], depth + 1, out);
    }
  }
}

function lineOf(node: ContainerDirective): number {
  return node.position?.start.line ?? 0;
}

/** 解析出顶层 gate 与解析期错误 */
function scan(source: string): { tree: Root; gates: ParsedGate[]; errors: GateError[] } {
  const tree = processor.parse(source) as Root;
  const errors: GateError[] = [];
  const gates: ParsedGate[] = [];

  const nested: ContainerDirective[] = [];
  findNestedGates(tree.children, 0, nested);
  for (const n of nested) {
    errors.push({
      code: "gate-not-top-level",
      message: "锁定内容必须是顶层块，不能放在引用、列表或其它块内部",
      line: lineOf(n),
    });
  }

  for (const child of tree.children) {
    if (!isGate(child) || !child.position) continue;
    const start = child.position.start.offset ?? 0;
    const end = child.position.end.offset ?? source.length;
    const slice = source.slice(start, end);
    const colons = /^:+/.exec(slice)?.[0].length ?? 3;
    // remark-directive 对未闭合的容器会一直吞到文末：必须以不短于开篱笆的 ::: 行收尾才算闭合
    const lastLine = slice.slice(slice.lastIndexOf("\n") + 1);
    const closed =
      slice.includes("\n") &&
      new RegExp(`^:{${colons},}[ \\t]*$`).test(lastLine) &&
      lastLine !== slice;
    if (!closed) {
      errors.push({
        code: "gate-unclosed",
        message: "锁定内容缺少结束的 ::: 行",
        line: child.position.start.line,
      });
      continue;
    }
    gates.push({ node: child, start, end, colons, line: child.position.start.line });
  }
  return { tree, gates, errors };
}

/** 门控内部不允许再出现 gate（任意深度） */
function innerGateErrors(g: ParsedGate): GateError[] {
  const found: ContainerDirective[] = [];
  findNestedGates(g.node.children as RootContent[], 1, found);
  return found.map((n) => ({
    code: "gate-nested" as const,
    message: "锁定内容不能嵌套",
    line: lineOf(n),
  }));
}

function parseConditionFromAttrs(
  attrs: Record<string, string | null | undefined>,
  specs: ReadonlyMap<string, ConditionSpec>,
  line: number,
): { condition: GateCondition; matchMode: GateMatchMode; key: string | null } | GateError {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) clean[k] = v ?? "";

  const unlock = clean.unlock ?? "";
  const spec = specs.get(unlock);
  if (!spec) {
    return { code: "gate-unknown-unlock", message: `未知的解锁条件: ${unlock || "(缺失)"}`, line };
  }
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(clean)) {
    if (!RESERVED_ATTRS.has(k)) params[k] = v;
  }
  const parsed = spec.parse(params);
  if ("error" in parsed) return { code: "gate-invalid-params", message: parsed.error, line };
  // 解析后仍出现规格不认识的属性 → 拒绝（挡住 onclick 之类的注入）
  const known = new Set(Object.keys(spec.toAttrs({ type: spec.type, ...parsed.params })));
  for (const k of Object.keys(params)) {
    if (!known.has(k)) {
      return { code: "gate-unknown-attribute", message: `锁定内容含未知属性: ${k}`, line };
    }
  }
  const matchRaw = clean.match;
  if (matchRaw !== undefined && matchRaw !== "all" && matchRaw !== "any") {
    return { code: "gate-invalid-params", message: "match 只能是 all 或 any", line };
  }
  const keyRaw = clean.key;
  if (keyRaw !== undefined && !KEY_RE.test(keyRaw)) {
    return {
      code: "gate-invalid-key",
      message: "key 只能是 1–16 位字母、数字、下划线或连字符",
      line,
    };
  }
  return {
    condition: { type: spec.type, ...parsed.params },
    matchMode: matchRaw === "any" ? "any" : "all",
    key: keyRaw ?? null,
  };
}

// ---------- 拆分 ----------

export interface SplitOptions {
  /** 条件规格表；默认 points / reply。纯函数的注入点，主要供测试验证“未知类型被拒绝 / 新规格可接入”，站点本身不扩展 */
  specs?: ReadonlyMap<string, ConditionSpec>;
  /** 为没有 key 的新门控分配 key；缺省取第一个未占用的 g{n} */
  allocateKey?: GateKeyAllocator;
}

export interface SplitResult {
  /** 只含公开内容的 Markdown，门控处为 `:::gate{key="…"}\n:::` 占位 */
  publicMd: string;
  gates: GateDraft[];
  errors: GateError[];
}

const placeholder = (key: string) => `:::gate{key="${key}"}\n:::`;

/**
 * 把含门控的完整源码拆为「公开正文 + 门控草稿」。
 * 有任何错误时 gates 与 publicMd 仍尽力返回，但调用方必须检查 errors 为空才允许保存。
 */
export function splitSource(source: string, options: SplitOptions = {}): SplitResult {
  const specs = options.specs ?? DEFAULT_CONDITION_SPECS;
  const src = normalizeEol(source);
  const { gates: parsed, errors } = scan(src);

  const gates: GateDraft[] = [];
  let out = "";
  let cursor = 0;
  const allocateKey = options.allocateKey ?? defaultKeyAllocator;

  // 先收集源码里显式写出的 key：分配新 key 时避让，重复的 key 直接报错
  const usedKeys = new Set<string>();
  for (const g of parsed) {
    const k = g.node.attributes?.key;
    if (k === undefined || k === null) continue;
    if (usedKeys.has(k)) {
      errors.push({
        code: "gate-duplicate-key",
        message: `同一帖子内锁定内容 key 重复: ${k}`,
        line: g.line,
      });
    }
    usedKeys.add(k);
  }

  for (const [index, g] of parsed.entries()) {
    errors.push(...innerGateErrors(g));
    const seq = index + 1;
    if (seq > MAX_GATES_PER_POST) {
      errors.push({
        code: "gate-too-many",
        message: `一个帖子最多 ${MAX_GATES_PER_POST} 个锁定内容`,
        line: g.line,
      });
      continue;
    }
    const parsedAttrs = parseConditionFromAttrs(g.node.attributes ?? {}, specs, g.line);
    if ("code" in parsedAttrs) {
      errors.push(parsedAttrs);
      continue;
    }
    const slice = src.slice(g.start, g.end);
    const inner = slice.slice(slice.indexOf("\n") + 1, slice.lastIndexOf("\n"));

    let key = parsedAttrs.key;
    if (key === null) {
      key = allocateKey(seq, usedKeys);
      if (!KEY_RE.test(key) || usedKeys.has(key)) {
        errors.push({
          code: "gate-invalid-key",
          message: `分配到的 key 非法或已被占用: ${key}`,
          line: g.line,
        });
        continue;
      }
      usedKeys.add(key);
    }

    gates.push({
      key,
      seq,
      conditions: [parsedAttrs.condition],
      matchMode: parsedAttrs.matchMode,
      hiddenMd: inner,
    });
    out += src.slice(cursor, g.start) + placeholder(key);
    cursor = g.end;
  }
  out += src.slice(cursor);
  return { publicMd: out, gates, errors };
}

// ---------- 还原 ----------

/** 序列化单个门控为完整源码块；篱笆冒号数自动加长，避免隐藏内容里的 ::: 行提前闭合 */
export function serializeGate(
  g: Pick<GateDraft, "key" | "conditions" | "matchMode" | "hiddenMd">,
  specs = DEFAULT_CONDITION_SPECS,
): string {
  const cond = g.conditions[0];
  if (!cond) throw new Error("锁定内容至少需要一个解锁条件");
  const spec = specs.get(cond.type);
  if (!spec) throw new Error(`未知的解锁条件: ${cond.type}`);
  const attrs: Record<string, string> = {
    key: g.key,
    unlock: cond.type,
    ...(g.matchMode === "any" ? { match: "any" } : {}),
    ...spec.toAttrs(cond),
  };
  const attrText = Object.entries(attrs)
    .map(([k, v]) => `${k}="${v.replace(/["\\]/g, "")}"`)
    .join(" ");
  let longest = 2;
  for (const m of g.hiddenMd.matchAll(/^[ \t]{0,3}(:{3,})/gm)) {
    longest = Math.max(longest, m[1]?.length ?? 0);
  }
  const fence = ":".repeat(longest + 1);
  const body = g.hiddenMd === "" ? "" : `${g.hiddenMd}\n`;
  return `${fence}gate{${attrText}}\n${body}${fence}`;
}

export interface AssembleResult {
  source: string;
  errors: GateError[];
}

/**
 * 把公开正文里的占位按 key 替换回完整门控块（作者/版主编辑入口）。
 * 占位找不到对应门控、或门控未被引用，都会报错，避免静默丢失隐藏内容。
 */
export function assembleSource(
  publicMd: string,
  gates: readonly Pick<GateDraft, "key" | "conditions" | "matchMode" | "hiddenMd">[],
  specs = DEFAULT_CONDITION_SPECS,
): AssembleResult {
  const src = normalizeEol(publicMd);
  const { gates: parsed, errors } = scan(src);
  const byKey = new Map(gates.map((g) => [g.key, g]));
  const used = new Set<string>();

  let out = "";
  let cursor = 0;
  for (const g of parsed) {
    const keyRaw = g.node.attributes?.key ?? undefined;
    const gate = keyRaw === undefined ? undefined : byKey.get(keyRaw);
    if (keyRaw === undefined || !gate) {
      errors.push({
        code: "gate-unknown-placeholder",
        message: `正文占位引用了不存在的锁定内容: ${keyRaw ?? "(无 key)"}`,
        line: g.line,
      });
      continue;
    }
    used.add(keyRaw);
    out += src.slice(cursor, g.start) + serializeGate(gate, specs);
    cursor = g.end;
  }
  out += src.slice(cursor);

  for (const gate of gates) {
    if (!used.has(gate.key)) {
      errors.push({
        code: "gate-unknown-placeholder",
        message: `锁定内容 ${gate.key} 没有对应的正文占位（继续还原会丢失隐藏内容）`,
      });
    }
  }
  return { source: out, errors };
}

/** 仅校验：源码里的门控语法是否合法（编辑器实时提示用）；不需要分配 id */
export function validateGates(source: string, specs = DEFAULT_CONDITION_SPECS): GateError[] {
  return splitSource(source, { specs }).errors;
}
