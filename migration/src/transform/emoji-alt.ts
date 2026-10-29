/**
 * 旧帖表情 alt 回填的纯函数核心（M10.9，设计稿 §2.8）：CLI 薄壳在 backfill-emoji-alt.ts。
 *
 * 对象：`![任意alt](/emoji/{id}.{ext})` 图片语法（旧帖由转换器统一写出，语法形态唯一）。
 * 动作：alt 改写为该 id 在 `emojis` 表里的**当前名称**（渲染完全不变——alt 不参与显示，只影响无障碍语义）；
 *       id 不存在或 ext 与库内不一致的**孤儿引用只报告不改写**。
 * 幂等：alt 已等于当前名称的跳过——站长在后台改名后再跑一次即可刷新全站。
 * 保护：行内 code span（`…`）与围栏代码块（```）里的示例文本不碰——它们不是图片语法，改了反而破坏示例。
 */

export interface EmojiMeta {
  id: number;
  ext: string;
  name: string;
}

export interface AltRewriteResult {
  md: string;
  /** 实际改写的 alt 处数 */
  changed: number;
  /** 已经是当前名称、无需改写的处数（幂等命中的证明） */
  alreadyCurrent: number;
  /** 孤儿引用：id 不存在或 ext 不一致（只报告，不改写） */
  orphans: string[];
}

const EMOJI_IMG_RE = /!\[([^\]\n]*)\]\(\/emoji\/(\d+)\.(gif|png|webp)\)/g;

/** 文本中「代码区间」（行内 code span 与围栏代码块）的 [start, end) 列表：区间内的图片语法一律跳过 */
export function codeRanges(md: string): [number, number][] {
  const ranges: [number, number][] = [];
  // 围栏代码块（``` 或 ~~~，开栏与闭栏同字符）先收；行内 span 扫描跳过围栏内的位置
  for (const m of md.matchAll(/^([`~]{3,})[^\n]*$[\s\S]*?^\1[^\n]*$/gm)) {
    ranges.push([m.index!, m.index! + m[0].length]);
  }
  const inRange = (at: number) => ranges.some(([s, e]) => at >= s && at < e);
  // 行内 code span 只认单反引号（双反引号 span 极罕见；漏改的代价是 alt 不更新，不会改坏示例）。
  // 定界符必须是**非转义**的反引号：旧帖里 `\`` 渲染为字面反引号，不构成 code span（3 帖实测教训）。
  for (const m of md.matchAll(/(?<!\\)`[^`\\]*(?:\\.[^`\\]*)*(?<!\\)`/g)) {
    if (!inRange(m.index!)) ranges.push([m.index!, m.index! + m[0].length]);
  }
  return ranges;
}

function inCode(ranges: [number, number][], at: number): boolean {
  return ranges.some(([s, e]) => at >= s && at < e);
}

/** 对一段 Markdown 做 alt 回填。names 以 emoji id 为键（id → {ext, name}）。 */
export function rewriteEmojiAlt(
  md: string,
  names: ReadonlyMap<number, EmojiMeta>,
): AltRewriteResult {
  const ranges = codeRanges(md);
  let changed = 0;
  let alreadyCurrent = 0;
  const orphans: string[] = [];
  const out = md.replace(
    EMOJI_IMG_RE,
    (whole, alt: string, idStr: string, ext: string, offset: number) => {
      if (inCode(ranges, offset)) return whole;
      const meta = names.get(Number(idStr));
      if (!meta || meta.ext !== ext) {
        orphans.push(`/emoji/${idStr}.${ext}`);
        return whole;
      }
      if (alt === meta.name) {
        alreadyCurrent++;
        return whole;
      }
      changed++;
      return `![${meta.name}](/emoji/${idStr}.${ext})`;
    },
  );
  return { md: out, changed, alreadyCurrent, orphans };
}
