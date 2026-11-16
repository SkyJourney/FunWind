/**
 * 后台回执参数统一约定（M19 Q5/S5）：成功 `?ok=<key>`、失败 `?err=<code|文案>`、警示 `?warn=<code>`。
 * 键名全后台统一；文案由各页 FLASH/ERR_TEXT 表承载（新增回执漏补文案即类型检查报错，G-15 纪律）。
 * err 值允许两种形态：注册表里的码（查表得文案）或已编码的裸文案（AdminError 消息直达）——
 * 查表未命中时按原文渲染，两种形态不混用键名。
 */

/** 查表取文案：只认表内自有键（`toString` 等原型属性名不当文案，防原型污染） */
export function flashText(
  table: Readonly<Record<string, string>>,
  code: string | undefined,
  fallback?: string,
): string | undefined {
  if (code === undefined) return undefined;
  return Object.hasOwn(table, code) ? table[code] : fallback;
}
