/** 门控解锁条件（存入 post_gates.conditions 的元素）：type + 该条件的参数 */
export interface GateCondition {
  type: string;
  [param: string]: unknown;
}

export type GateMatchMode = "all" | "any";

/** 门控草稿：拆分/转换的产物，由调用方负责落库 */
export interface GateDraft {
  /** 门控在帖内的稳定身份（post_gates.gate_key）；作者编辑时不变，解锁记录因此不丢 */
  key: string;
  /** 在帖内的出现顺序，从 1 开始（仅用于展示排序，不是身份） */
  seq: number;
  conditions: GateCondition[];
  matchMode: GateMatchMode;
  /** 隐藏正文（Markdown） */
  hiddenMd: string;
}

/** 解锁条件的内容层规格：只负责参数的解析与校验；运行时判定在 apps/web 的 lib/gates/evaluate.ts（条件固定为内置 points / reply） */
export interface ConditionSpec {
  type: string;
  /** 从属性字典解析并校验参数；返回错误信息表示非法 */
  parse(attrs: Record<string, string>): { params: Record<string, unknown> } | { error: string };
  /** 把参数还原成属性字典（assemble 用） */
  toAttrs(condition: GateCondition): Record<string, string>;
}

export type GateErrorCode =
  | "gate-not-top-level"
  | "gate-nested"
  | "gate-unclosed"
  | "gate-unknown-unlock"
  | "gate-invalid-params"
  | "gate-unknown-attribute"
  | "gate-invalid-key"
  | "gate-duplicate-key"
  | "gate-too-many"
  | "gate-unknown-placeholder";

export interface GateError {
  code: GateErrorCode;
  message: string;
  /** 源码中的行号（从 1 起），可用于编辑器提示 */
  line?: number;
}

/**
 * 为没有 key 的新门控分配帖内唯一的 key。usedKeys 含本帖源码里已出现的全部 key（含本次已分配的）。
 * 缺省策略：从 g1 起取第一个未占用的 g{n}。
 */
export type GateKeyAllocator = (seq: number, usedKeys: ReadonlySet<string>) => string;
