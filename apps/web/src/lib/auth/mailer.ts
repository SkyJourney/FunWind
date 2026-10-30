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

// ============================================================
// 通知邮件模板（M10.6 收尾切片，docs/EMAIL-SCENARIOS.md；全部纯函数）
// ============================================================

/** S1：密码已被修改（安全强制类，发账号邮箱） */
export function passwordChangedMail(siteName: string = SITE_NAME): MailMessage {
  return {
    subject: `密码已修改 · ${siteName}`,
    html: layout(
      "密码已修改",
      "<p>你的账号密码刚刚被修改。如果这不是你的操作，请立即通过「找回密码」夺回账号。",
      undefined,
      siteName,
    ),
  };
}

/** S2a：邮箱被换绑——发往**旧邮箱**的知情/告警 */
export function emailChangedAlertMail(siteName: string = SITE_NAME): MailMessage {
  return {
    subject: `邮箱已更换 · ${siteName}`,
    html: layout(
      "邮箱已更换",
      "<p>你的账号绑定邮箱刚刚被更换为其它地址，本地址不再接收该账号的邮件。如果这不是你的操作，请立即通过「找回密码」用本邮箱夺回账号。",
      undefined,
      siteName,
    ),
  };
}

/** S2b：邮箱被换绑——发往**新邮箱**的确认 */
export function emailChangedConfirmMail(siteName: string = SITE_NAME): MailMessage {
  return {
    subject: `邮箱绑定成功 · ${siteName}`,
    html: layout(
      "邮箱绑定成功",
      "<p>你的账号绑定邮箱已更换为本地址（验证态已重置）。找回密码 / 认领邮件今后将发往这里。</p>",
      undefined,
      siteName,
    ),
  };
}

const RESTRICTION_LABEL = {
  ban: "封禁",
  forum_ban: "板块禁入",
  mute: "禁言",
  no_avatar: "禁用头像",
  no_signature: "禁用签名",
} as const;

/** S3：账号被限制 / 解除（安全强制类；reason 由后台填写，站点转义职责在渲染端——此处纯文本拼接进 HTML 前过一遍转义） */
export function restrictionMail(
  opts: {
    lifted: boolean;
    kind: keyof typeof RESTRICTION_LABEL;
    reason: string;
    endsAt: string | null;
  },
  siteName: string = SITE_NAME,
): MailMessage {
  const kindLabel = RESTRICTION_LABEL[opts.kind] ?? opts.kind;
  const until = opts.endsAt ? `，至 ${esc(opts.endsAt)}` : "（长期）";
  const title = opts.lifted ? "限制已解除" : `账号已被${kindLabel}`;
  const body = opts.lifted
    ? `<p>你账号的「${kindLabel}」限制已解除，欢迎回来。</p>${
        opts.reason ? `<p>管理员说明：${esc(opts.reason)}</p>` : ""
      }`
    : `<p>你账号已被${kindLabel}${until}。</p>${
        opts.reason ? `<p>理由：${esc(opts.reason)}</p>` : "<p>（未填写理由）</p>"
      }<p>如有疑问请联系站点管理。</p>`;
  return {
    subject: `${title} · ${siteName}`,
    html: layout(title, body, undefined, siteName),
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** S4：收到私信（频控后；摘要 = 最新一条的截断） */
export function pmReceivedMail(
  opts: { senderName: string; preview: string; conversationId: number; siteUrl: string },
  siteName: string = SITE_NAME,
): MailMessage {
  const preview = opts.preview.slice(0, 80);
  return {
    subject: `${opts.senderName} 给你发来了私信 · ${siteName}`,
    html: layout(
      "新私信",
      `<p><b>${esc(opts.senderName)}</b>：${esc(preview)}${opts.preview.length > 80 ? "…" : ""}</p>`,
      { href: `${opts.siteUrl}/messages?conv=${opts.conversationId}`, label: "查看与回复" },
      siteName,
    ),
  };
}

/** S5：付费内容被购买（含收益积分数） */
export function gateSoldMail(
  opts: { points: number; siteUrl: string },
  siteName: string = SITE_NAME,
): MailMessage {
  return {
    subject: `你的内容被购买（+${opts.points}）· ${siteName}`,
    html: layout(
      "内容售出",
      `<p>你的付费内容刚刚被购买，收益 <b>+${opts.points}</b> 已入账。</p>`,
      { href: `${opts.siteUrl}/points`, label: "查看收益" },
      siteName,
    ),
  };
}

/** S6：提交的内容审核通过 */
export function contentApprovedMail(
  opts: { threadId: number; siteUrl: string },
  siteName: string = SITE_NAME,
): MailMessage {
  return {
    subject: `内容审核通过 · ${siteName}`,
    html: layout(
      "审核通过",
      "<p>你提交的内容已审核通过并发布。</p>",
      { href: `${opts.siteUrl}/t/${opts.threadId}`, label: "查看发布" },
      siteName,
    ),
  };
}

/** S7：每日汇总（召回主力） */
export function digestMail(
  opts: {
    siteUrl: string;
    unreadPm: number;
    newReplies: number;
    newMentions: number;
    newFollowers: number;
  },
  siteName: string = SITE_NAME,
): MailMessage {
  const parts = [
    opts.unreadPm > 0 ? `<li>未读私信 ${opts.unreadPm} 条</li>` : "",
    opts.newReplies > 0 ? `<li>新回复 ${opts.newReplies} 条</li>` : "",
    opts.newMentions > 0 ? `<li>被 @ 提及 ${opts.newMentions} 次</li>` : "",
    opts.newFollowers > 0 ? `<li>新关注者 ${opts.newFollowers} 人</li>` : "",
  ].filter(Boolean);
  return {
    subject: `你的社区动态 · ${siteName}`,
    html: layout(
      "你的社区动态",
      `<p>最近一天你错过了：</p><ul style="padding-left:20px;margin:12px 0">${parts.join("")}</ul>`,
      { href: `${opts.siteUrl}/notifications`, label: "去查看" },
      siteName,
    ),
  };
}

export async function sendMail(to: string, message: MailMessage): Promise<void> {
  await getTransporter().sendMail({ from: FROM, to, subject: message.subject, html: message.html });
}
