import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import type { Processor } from "unified";

/**
 * 精简版 GFM：只启用**表格**与**删除线**（remark 插件）。
 *
 * 为什么不直接用 remark-gfm（M5.6 S1，用迁移库全部 31825 份正文 / 门控隐藏正文实测）：
 *  · 迁移转换器把 UBB 的 [table] / [s] 产出为 Markdown 表格与 `~~`，渲染端此前不解析：
 *    22 个表格显示成竖线原文；删除线（真实的 UBB `[s]` 只有 37 篇，其余是用户打的 `~~心情~~`，由转换器转义，见 S1b-3）同样显示成 `~~…~~`。
 *  · 删除线必须 `singleTilde: false`：GFM 默认把单个 `~x~` 也当删除线，而中文论坛习惯用单个 `~` 表语气
 *    （「握爪~我也是今年5月份~好在图书馆」），默认配置会多误伤 1328 篇。
 *  · 不启用自动链接：remark-gfm 的自动链接遇到中文不会停（实测百度网盘链接把后面的「啊哦，你来…」吞进了 URL），
 *    而 remark-gfm 无法单独关掉它，所以直接组合下面两个扩展。
 *  · 任务列表：迁移数据里为 0，且 <input> 不在净化白名单内，不启用。
 * 净化仍由 sanitize.ts 的白名单负责（表格标签与 align 已在白名单内）。
 */
export function remarkGfmLite(this: Processor): void {
  const data = this.data() as {
    micromarkExtensions?: unknown[];
    fromMarkdownExtensions?: unknown[];
  };
  (data.micromarkExtensions ??= []).push(gfmTable(), gfmStrikethrough({ singleTilde: false }));
  (data.fromMarkdownExtensions ??= []).push(gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown());
}
