import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { nowBeijingWallTime } from "@/lib/datetime";
import { SITE_NAME } from "@/lib/site";

/**
 * 邮件发送（M4）：SMTP_URL 驱动（dev = MailPit smtp://127.0.0.1:1025）。
 * 模板为纯函数（单测友好）；siteName 可选注入（M10.6b 站点身份可配，缺省回退默认站名）；
 * 发送失败抛错由调用方决定降级策略（注册流程不因邮件失败中断的语义在 action 层）。
 */

export interface MailMessage {
  subject: string;
  html: string;
}

const FROM = process.env.MAIL_FROM ?? "青翼字幕组 <noreply@qingyisub.top>";

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport(process.env.SMTP_URL ?? "smtp://127.0.0.1:1025");
  }
  return transporter;
}

function layout(
  title: string,
  bodyHtml: string,
  action: { href: string; label: string } | undefined,
  siteName: string = SITE_NAME,
): string {
  return [
    "<div style=\"font-family:system-ui,-apple-system,'PingFang SC',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1e293b\">",
    `<h2 style="margin:0 0 16px">${title}</h2>`,
    bodyHtml,
    action
      ? `<p style="margin:24px 0"><a href="${action.href}" style="display:inline-block;background:#0891b2;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">${action.label}</a></p>`
      : "",
    '<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0" />',
    `<p style="color:#94a3b8;font-size:12px;margin:0">${siteName} · ${nowBeijingWallTime()}<br />若非本人操作请忽略本邮件。</p>`,
    "</div>",
  ].join("\n");
}

export function resetPasswordMail(link: string, siteName: string = SITE_NAME): MailMessage {
  return {
    subject: `重置密码 · ${siteName}`,
    html: layout(
      "重置密码",
      "<p>请点击下方按钮设置新密码。链接 1 小时内有效，仅可使用一次。</p><p>旧论坛密码无法迁移，重置即完成账号认领。</p>",
      { href: link, label: "设置新密码" },
      siteName,
    ),
  };
}

export function claimMail(link: string, siteName: string = SITE_NAME): MailMessage {
  return {
    subject: `认领你的老账号 · ${siteName}`,
    html: layout(
      "认领老账号",
      "<p>我们找到了你的青翼老账号（旧密码无法迁移）。点击下方按钮验证邮箱并设置新密码，即可回到社区。</p>",
      { href: link, label: "认领账号" },
      siteName,
    ),
  };
}

export function verifyEmailMail(link: string, siteName: string = SITE_NAME): MailMessage {
  return {
    subject: `验证邮箱 · ${siteName}`,
    html: layout(
      "验证邮箱",
      "<p>感谢注册！点击下方按钮完成邮箱验证（24 小时内有效）。</p>",
      {
        href: link,
        label: "验证邮箱",
      },
      siteName,
    ),
  };
}

/** 后台「发送测试邮件」（M10.6 收尾）：验证 SMTP 发信链路；收件人 = 当前管理员。 */
export function testMail(siteName: string = SITE_NAME): MailMessage {
  return {
    subject: `测试邮件 · ${siteName}`,
    html: layout(
      "测试邮件",
      "<p>这是一封从站点后台发出的测试邮件——收到即代表 SMTP 发信链路正常。</p>",
      undefined,
      siteName,
    ),
  };
}

export async function sendMail(to: string, message: MailMessage): Promise<void> {
  await getTransporter().sendMail({ from: FROM, to, subject: message.subject, html: message.html });
}
