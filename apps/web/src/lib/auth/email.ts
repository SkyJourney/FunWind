/**
 * 邮箱格式校验（注册用）。
 * 旧正则 `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` 只排除空白与 @，逗号、分号、引号、括号、尖括号都放行，
 * 本地部分带逗号、或写成「名字 <地址>」形态的输入都会入库，之后发信（用逗号拆收件人）会出岔子。
 * 这里收紧为 ASCII 的 dot-atom 本地部分 + 标准域名标签；刻意不支持国际化邮箱（EAI）与引号本地部分。
 */
const LOCAL = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const EMAIL_RE = new RegExp(`^${LOCAL}@${LABEL}(?:\\.${LABEL})+$`);

export const MAX_EMAIL_LENGTH = 254;

export function isValidEmail(email: string): boolean {
  return (
    email.length <= MAX_EMAIL_LENGTH && email.split("@")[0]!.length <= 64 && EMAIL_RE.test(email)
  );
}
