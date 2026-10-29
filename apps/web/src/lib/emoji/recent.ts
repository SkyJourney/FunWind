/**
 * 表情面板的个人偏好（M10.8 Step 7；M10.9 扩展）：最近使用与肤色，存在 localStorage。
 * 只是个人便利：读写都包在 try/catch 里（隐私窗口 / 禁用存储 / 配额满都不能影响插入表情）。
 *
 * 最近使用条目（M10.9）：Unicode 字符（`t:"c"`）与社区图片表情（`t:"i"`，值是 /emoji/{id}.{ext}）。
 * 旧格式（M10.8）存的是纯字符串数组——读取时按 Unicode 字符解释，下一次写入自然迁移成新格式。
 */
const RECENT_KEY = "funwind:emoji:recent";
const SKIN_KEY = "funwind:emoji:skin";
export const RECENT_MAX = 24;

export type RecentEntry = { t: "c" | "i"; v: string };

export function readRecent(): RecentEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    const entries: RecentEntry[] = [];
    for (const x of v) {
      // 旧格式：纯字符串 = Unicode 字符
      if (typeof x === "string") entries.push({ t: "c", v: x });
      else if (
        typeof x === "object" &&
        x !== null &&
        ((x as { t?: unknown }).t === "c" || (x as { t?: unknown }).t === "i") &&
        typeof (x as { v?: unknown }).v === "string"
      )
        entries.push(x as RecentEntry);
    }
    return entries.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** 记入最近使用（置顶、去重、截断）；返回新列表 */
export function pushRecent(entry: RecentEntry): RecentEntry[] {
  const next = [entry, ...readRecent().filter((e) => !(e.t === entry.t && e.v === entry.v))].slice(
    0,
    RECENT_MAX,
  );
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // 存储不可用：本次会话内的列表仍由调用方保存在状态里
  }
  return next;
}

export function readSkin(): number {
  try {
    const n = Number(localStorage.getItem(SKIN_KEY));
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeSkin(tone: number): void {
  try {
    localStorage.setItem(SKIN_KEY, String(tone));
  } catch {
    // 同上：只是个人便利
  }
}
