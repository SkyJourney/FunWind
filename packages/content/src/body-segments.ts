/**
 * 公开正文（posts.body_md）按门控占位切分，供渲染层使用。
 * body_md 里门控处只有 `:::gate{key="…"}\n:::` 占位（隐藏内容在 post_gates，见 docs/GATES.md §2）；
 * 渲染时 md 段走净化管线，gate 段交给 GateBlock——这里只做切分，不读取、也不可能读到任何隐藏内容。
 */

export type BodySegment = { kind: "md"; text: string } | { kind: "gate"; key: string };

const PLACEHOLDER_OPEN = /^:::gate\{key="([A-Za-z0-9_-]{1,16})"\}\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 切分规则：只识别独占两行的占位（开行 + 紧随的 `:::` 闭行），且不在围栏代码块内。
 * 围栏内出现的同形文本是用户写的代码示例，必须原样当作 md，不能被当成门控。
 * 往返无损：joinBodySegments(splitByGatePlaceholders(x)) === x（含换行归一化前的原文）。
 */
export function splitByGatePlaceholders(bodyMd: string): BodySegment[] {
  const lines = bodyMd.split("\n");
  const out: BodySegment[] = [];
  let buf: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (buf.length > 0) out.push({ kind: "md", text: buf.join("\n") });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (f) {
      const ch = f[1]![0]!;
      if (fence === null) fence = ch;
      else if (fence === ch) fence = null;
    }
    if (fence === null) {
      const m = PLACEHOLDER_OPEN.exec(line);
      if (m && lines[i + 1]?.trim() === ":::") {
        flush();
        out.push({ kind: "gate", key: m[1]! });
        i++; // 吞掉闭行
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** splitByGatePlaceholders 的逆运算（测试与调试用） */
export function joinBodySegments(segments: readonly BodySegment[]): string {
  return segments
    .map((s) => (s.kind === "md" ? s.text : `:::gate{key="${s.key}"}\n:::`))
    .join("\n");
}
