/**
 * PHP serialize 值的解析器（只覆盖 phpwind 权限表里出现的类型）。
 *
 * 取代 v1 的字符串匹配（`includes('s:1:"1"')`）——那种写法对数组里的任何位置、任何值都会误判，
 * 是权限表里出现 `p1`/`p2`/`y` 脏键的根因。
 *
 * 注意：旧库是 GBK 转 UTF-8 的，`s:N:"…"` 里的 N 是原始 GBK 字节数，非 ASCII 内容的长度会对不上。
 * 解析时先按 UTF-8 字节数取，对不上再回退到「找下一个 `";`」，保证不会因长度失配整体解析失败。
 */

export class PhpSerializeError extends Error {}

export type PhpValue = null | boolean | number | string | { [key: string]: PhpValue };

export function phpUnserialize(src: string): PhpValue {
  let i = 0;

  const fail = (msg: string): never => {
    throw new PhpSerializeError(`${msg}（位置 ${i}）`);
  };

  const expect = (s: string) => {
    if (src.slice(i, i + s.length) !== s) fail(`期望 "${s}"`);
    i += s.length;
  };

  const readUntil = (ch: string): string => {
    const end = src.indexOf(ch, i);
    if (end === -1) fail(`缺少 "${ch}"`);
    const out = src.slice(i, end);
    i = end + 1;
    return out;
  };

  /** 读 `LEN:"…"`：先按 UTF-8 字节数，对不上再回退找 `"` 结尾 */
  const readString = (): string => {
    const len = Number(readUntil(":"));
    if (!Number.isInteger(len) || len < 0) fail("字符串长度非法");
    expect('"');
    let consumed = 0;
    let j = i;
    while (j < src.length && consumed < len) {
      const cp = src.codePointAt(j)!;
      consumed += Buffer.byteLength(String.fromCodePoint(cp), "utf8");
      j += cp > 0xffff ? 2 : 1;
    }
    if (consumed === len && src[j] === '"') {
      const out = src.slice(i, j);
      i = j + 1;
      return out;
    }
    const end = src.indexOf('";', i);
    if (end === -1) fail("字符串未闭合");
    const out = src.slice(i, end);
    i = end + 1;
    return out;
  };

  const readValue = (): PhpValue => {
    const t = src[i];
    i += 1;
    switch (t) {
      case "N":
        expect(";");
        return null;
      case "b": {
        expect(":");
        const v = readUntil(";");
        return v === "1";
      }
      case "i": {
        expect(":");
        return Number(readUntil(";"));
      }
      case "d": {
        expect(":");
        return Number(readUntil(";"));
      }
      case "s": {
        expect(":");
        const s = readString();
        expect(";");
        return s;
      }
      case "a": {
        expect(":");
        const count = Number(readUntil(":"));
        expect("{");
        const out: { [key: string]: PhpValue } = {};
        for (let n = 0; n < count; n++) {
          const k = readValue();
          const v = readValue();
          out[String(k)] = v;
        }
        expect("}");
        return out;
      }
      default:
        return fail(`不支持的类型 "${t ?? "EOF"}"`);
    }
  };

  const value = readValue();
  if (i !== src.length) fail("末尾有多余内容");
  return value;
}

/** PHP 风格的真值：数组任一元素为真即为真；字符串 "" 与 "0" 为假 */
export function isTruthy(v: PhpValue): boolean {
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0";
  return Object.values(v).some(isTruthy);
}

/**
 * 解析权限表的 rvalue：纯标量（'1' / '0'）直接按字符串处理，`a:` 开头按序列化数组解析。
 * 解析失败时抛 PhpSerializeError——调用方必须显式处理（计入报告），不得猜测。
 */
export function parsePermissionValue(rvalue: string | null | undefined): PhpValue {
  const s = (rvalue ?? "").trim();
  if (s.startsWith("a:") || s.startsWith("s:") || s.startsWith("b:") || s.startsWith("i:")) {
    return phpUnserialize(s);
  }
  return s;
}
