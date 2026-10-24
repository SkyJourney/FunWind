/**
 * 个人信息脱敏：入库的报告里只允许出现脱敏后的值。
 * 需要站长处理的完整清单写入 migration/reports/（已被 .gitignore），不入库。
 */

/** 邮箱 → 首字符 + *** + @域名（域名保留，便于判断是否 QQ/163 等小号批量注册） */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}
