/**
 * 门控 key 的分配（M6.3 §4）。门控 key 在同一帖内唯一；新插入的门控取第一个未占用的 `g{n}`。
 * 纯函数：输入是 ProseMirror 文档的 JSON（编辑器的 getJSON()），不依赖编辑器实例，便于单测。
 */

interface JsonNode {
  type?: string;
  attrs?: { key?: unknown };
  content?: JsonNode[];
}

/** 收集文档里所有门控的 key（深度优先） */
export function collectGateKeys(
  node: JsonNode | undefined,
  out: Set<string> = new Set(),
): Set<string> {
  if (!node) return out;
  if (node.type === "gate" && typeof node.attrs?.key === "string" && node.attrs.key !== "") {
    out.add(node.attrs.key);
  }
  for (const child of node.content ?? []) collectGateKeys(child, out);
  return out;
}

/** 第一个未占用的 `g1`、`g2`…… */
export function nextGateKey(doc: JsonNode | undefined): string {
  const used = collectGateKeys(doc);
  for (let n = 1; ; n++) {
    const candidate = `g${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * 源码中显式写出 key 的门控（M6.4d2）。附件归属下拉只列这些：未写 key 的新门控保存时才会分配 key，
 * 此时界面上还没有可供选择的稳定身份。
 */
export function explicitGateKeys(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(/:::gate\{[^}\n]*?\bkey="([A-Za-z0-9_-]{1,16})"/g)) {
    const key = m[1]!;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}
