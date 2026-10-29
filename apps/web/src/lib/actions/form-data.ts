/**
 * FormData → 普通对象，供 zod 校验（M6.1）。
 *  · 字符串与文件字段都保留：M10.9 起后台 Server Action 也接文件上传（z.instanceof(File)）——
 *    此前「一律忽略文件」的口径使 /admin/logo 的上传 Action 拿不到 file、safeParse 必败（上传 404 的存量缺陷）。
 *    面向公网的高流量上传仍走专门的 route handler（/api/upload），后台低频管理动作走 defineAction。
 *  · 同名多值（复选框 / 多选 / 多文件）归并为数组；单值保持标量。
 *  · 原型污染：键名为 `__proto__` / `constructor` / `prototype` 的字段直接丢弃，对象用空原型创建。
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type FormFieldValue = string | File | (string | File)[];

export function formDataToObject(formData: FormData): Record<string, FormFieldValue> {
  const out: Record<string, FormFieldValue> = Object.create(null);
  for (const [key, value] of formData.entries()) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const prev = out[key];
    if (prev === undefined) out[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[key] = [prev, value];
  }
  return out;
}
