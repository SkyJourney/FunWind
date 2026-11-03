/**
 * 邮件域统一出口：模板（纯函数）、品牌解析、发送与记录。
 * 业务代码只从这里导入；nodemailer 与 email_log 的细节封在 transport.ts。
 */
export type { MailBrand, MailKind, MailMessage } from "./types";
export { DEFAULT_ACCENT, FALLBACK_BRAND, getMailBrand } from "./brand";
export { renderMail, type MailSpec } from "./layout";
export * from "./templates";
export { sendMail, trySendMail, type SendMeta } from "./transport";
