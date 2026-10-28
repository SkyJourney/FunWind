/**
 * 表情面板的个人偏好（M10.8 Step 7）：最近使用与肤色，存在 localStorage。
 * 只是个人便利：读写都包在 try/catch 里（隐私窗口 / 禁用存储 / 配额满都不能影响插入表情）。
 */
const RECENT_KEY = "funwind:emoji:recent";
const SKIN_KEY = "funwind:emoji:skin";
export const RECENT_MAX = 24;

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

/** 记入最近使用（置顶、去重、截断）；返回新列表 */
export function pushRecent(emoji: string): string[] {
  const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(0, RECENT_MAX);
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
