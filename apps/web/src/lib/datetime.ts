/**
 * 时间工具（基线审查 P1-2）：
 * 库内 DATETIME 一律为北京墙面时间（连接层 timezone:""+08:00 + dateStrings 原样返回）。
 * 任何 DB 时间字符串解析必须经由本工具——禁止直接 new Date(string)（会按进程时区解释）。
 */

const BEIJING_OFFSET = "+08:00";

/** "2026-10-23 09:00:00" / ISO 字符串 → Date（墙面值按 +08:00 解释） */
export function parseDbDateTime(s: string): Date {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso);
  return new Date(hasZone ? iso : `${iso}${BEIJING_OFFSET}`);
}

/** 严格校验秒级北京墙面时间格式与日历合法性（拒绝 2 月 30 日等溢出），不比较先后。 */
export function isValidBeijingDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const wall = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return (
    wall.getUTCFullYear() === year &&
    wall.getUTCMonth() === month! - 1 &&
    wall.getUTCDate() === day &&
    wall.getUTCHours() === hour &&
    wall.getUTCMinutes() === minute &&
    wall.getUTCSeconds() === second
  );
}

/** 严格校验秒级北京墙面时间，拒绝日期溢出；只有晚于 nowMs 的有效时间才返回 true。 */
export function isFutureBeijingDateTime(value: string, nowMs?: number): boolean {
  if (!isValidBeijingDateTime(value)) return false;
  const instant = parseDbDateTime(value).getTime();
  return Number.isFinite(instant) && instant > (nowMs ?? Date.now());
}

/** 北京墙面时间的 DATETIME 字面量（与库内写入/比较语义一致）；atMs 缺省为当前时刻 */
export function nowBeijingWallTime(atMs: number = Date.now()): string {
  const t = new Date(atMs + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ` +
    `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`
  );
}
