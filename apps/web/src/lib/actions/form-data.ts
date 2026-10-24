/**
 * FormData → 普通对象，供 zod 校验（M6.1）。
 *  · 只收字符串值；文件字段（File）一律忽略——上传走专门的 route handler（M6.4），Server Action 不接文件。
 *  · 同名多值（复选框 / 多选）归并为字符串数组；单值保持字符串。
 *  · 原型污染：键名为 `__proto__` / `constructor` / `prototype` 的字段直接丢弃，对象用空原型创建。
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function formDataToObject(formData: FormData): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string" || FORBIDDEN_KEYS.has(key)) continue;
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[key] = [prev, value];
  }
  return out;
}
