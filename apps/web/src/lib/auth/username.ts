import { normalizeKey } from "@funwind/db";

/**
 * 注册用户名校验（M6.1）。只作用于**新注册**，不动已迁移的用户（旧站用户名千奇百怪，不能追溯拒绝）。
 *
 * 格式：2–20 位，中文 / 字母 / 数字 / 下划线。这个字符集本身已经挡住了控制字符、零宽字符、RTL 控制符、
 * 西里尔 / 希腊等同形字符与全角字符，所以不需要再做 Unicode 归一化——格式检查是第一道防线，下面的保留名是第二道。
 *
 * 保留名（防冒充）：论坛里“冒充管理员”是现实威胁。
 *  · ASCII 词精确匹配，且**忽略夹带的数字与下划线**（admin2、_root_、ad_min 都算 admin）；比较前先 normalizeKey（小写），
 *    与登录 / 唯一键用的是同一个函数，所以大小写变体天然覆盖；
 *  · 中文词按“包含”拦截（青翼官方客服、我是管理员）。代价是个别正常昵称会被误拦（比如含“系统”二字），改个名即可；
 *    站长可以在后台直接改用户名或人工创建，所以不设申诉流程。
 */

export const USERNAME_RE = /^[a-zA-Z0-9_一-龥]{2,20}$/;
export const USERNAME_FORMAT_MESSAGE = "用户名需 2-20 位（中文/字母/数字/下划线）";
export const USERNAME_RESERVED_MESSAGE = "该用户名不可用，请换一个";

/** 保留的 ASCII 词（已小写） */
export const RESERVED_ASCII: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "sysadmin",
  "root",
  "system",
  "moderator",
  "mod",
  "support",
  "service",
  "official",
  "staff",
  "webmaster",
  "owner",
  "null",
  "undefined",
  "anonymous",
  "guest",
  "everyone",
  "qysub",
  "qingyi",
  "qingyisub",
  "funwind",
]);

/** 保留的中文词（出现在用户名任意位置即拦截） */
export const RESERVED_CJK: readonly string[] = [
  "管理员",
  "版主",
  "站长",
  "客服",
  "官方",
  "系统",
  "已注销用户", // 迁移期占位账号的名字（已注销用户#id）；'#' 不能注册，但 “已注销用户5” 可以，一并拦住
];

export type UsernameCheck =
  { ok: true } | { ok: false; reason: "format" | "reserved"; message: string };

export function checkUsername(raw: string): UsernameCheck {
  const name = raw.trim();
  if (!USERNAME_RE.test(name)) {
    return { ok: false, reason: "format", message: USERNAME_FORMAT_MESSAGE };
  }
  const key = normalizeKey(name);
  // 夹带的数字与下划线不改变“它看起来像谁”：admin2、_root_、ad_min
  const squashed = key.replace(/[0-9_]/g, "");
  if (RESERVED_ASCII.has(key) || RESERVED_ASCII.has(squashed)) {
    return { ok: false, reason: "reserved", message: USERNAME_RESERVED_MESSAGE };
  }
  if (RESERVED_CJK.some((w) => key.includes(w))) {
    return { ok: false, reason: "reserved", message: USERNAME_RESERVED_MESSAGE };
  }
  return { ok: true };
}
