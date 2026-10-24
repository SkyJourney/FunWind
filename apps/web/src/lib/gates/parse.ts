import type { GateCondition } from "@funwind/content";

/** conditions 列是 JSON：只接受「带字符串 type 的对象」数组，其余按空处理（空条件在判定里封闭） */
export function parseConditions(raw: unknown): GateCondition[] {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is GateCondition =>
      typeof c === "object" && c !== null && typeof (c as { type?: unknown }).type === "string",
  );
}
