/** 门控解锁条件（存入 post_gates.conditions 的元素）：type + 该条件的参数 */
export interface GateCondition {
  type: string;
  [param: string]: unknown;
}

export type GateMatchMode = "all" | "any";

/** 门控草稿：拆分/转换的产物，由调用方负责落库 */
export interface GateDraft {
  /** 门控 id；迁移用确定性公式，线上保存由调用方分配 */
  id: number;
  /** 在帖内的出现顺序，从 1 开始 */
  seq: number;
  conditions: GateCondition[];
  matchMode: GateMatchMode;
  /** 隐藏正文（Markdown） */
  hiddenMd: string;
}

/** 解锁条件的内容层规格：只负责参数的解析与校验，运行时判定由模块内核的 gateConditions 注册表负责 */
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
  | "gate-missing-id"
  | "gate-too-many"
  | "gate-unknown-placeholder";

export interface GateError {
  code: GateErrorCode;
  message: string;
  /** 源码中的行号（从 1 起），可用于编辑器提示 */
  line?: number;
}

export type GateIdAllocator = (seq: number, existingId: number | null) => number;
