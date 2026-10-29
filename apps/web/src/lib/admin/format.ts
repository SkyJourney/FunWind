/**
 * 后台时间格式化统一口径（M9.5）：DB 存的是北京墙面时间字符串（"YYYY-MM-DD HH:mm:ss"），
 * `new Date(d.replace(" ", "T"))` 按本地时区解析后 Intl 输出——与 invites 页原 fmtDate 一致，
 * 上移到 lib 供全后台复用（announcements 原样输出 DB 字符串的页面在此统一）。
 */
export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(d.replace(" ", "T")),
  );
}

/** 日期（不带时分），用于列表主时间列想省宽度的场景 */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short" }).format(
    new Date(d.replace(" ", "T")),
  );
}
