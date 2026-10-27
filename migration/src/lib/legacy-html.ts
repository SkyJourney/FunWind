/**
 * D5 迁移清洗（站长定稿）：旧站描述类字段里的裸 HTML 不原样迁移——
 * <br> 转空格、其余标签（img/a/font/b…）整体剥离、常见实体解码、空白收敛；
 * 图片链接与颜色字体按「看效果取舍」原则统一丢弃（正文图片走附件化管线，不经此通道）。
 * 纯文本输出；空串/全空白归一为 null（与 forums 变换的空值口径一致）。
 */
export function sanitizeLegacyHtml(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const raw = String(input);
  if (raw === "") return null;
  const cleaned = raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}
