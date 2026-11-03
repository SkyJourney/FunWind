import type { MailBrand, MailKind, MailMessage } from "./types";

/**
 * 统一邮件渲染（纯函数）：一个 layout 产出 HTML 与纯文本双版本。
 *
 * 结构：品牌条（站名 + 标语，不用图片——邮件客户端默认拦截远程图）
 *      → 白卡片（主题色顶边 / 标题 / 正文段落 / 字段表 / 引用块 / 列表 / 主按钮 + 备用链接 / 提示框）
 *      → 分类页脚（按 kind 选措辞；场景与汇总类自动追加「设置 → 通知」管理入口）。
 *
 * 所有动态文本在拼接前转义；正文支持 `**粗体**` 轻标记（先转义再加标签，无注入面）。
 */

export interface MailField {
  label: string;
  value: string;
}

export interface MailAction {
  href: string;
  label: string;
}

export interface MailSpec {
  kind: MailKind;
  scene: string;
  brand: MailBrand;
  /** 卡片标题；主题缺省为 `${title} · ${siteName}` */
  title: string;
  subject?: string;
  /** 正文段落（纯文本，可含 **粗体**） */
  paragraphs: string[];
  /** 结构化字段表（限制类型 / 期限 / 理由 …） */
  fields?: MailField[];
  /** 引用块（私信预览） */
  quote?: string;
  quoteCaption?: string;
  /** 列表（每日汇总） */
  list?: string[];
  action?: MailAction;
  /** 提示框：有效期 / 一次性等需要醒目的约束 */
  note?: string;
  /** 页脚首句，覆盖类别缺省（场景类应说明触发原因与频控） */
  footer?: string;
}

const FONT = "system-ui,-apple-system,'PingFang SC','Microsoft YaHei',sans-serif";
/** 安全强制类顶边用琥珀色与常规邮件区分 */
const SECURITY_ACCENT = "#b45309";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 转义后再把 **x** 变成 <b>x</b> */
function rich(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

/** 纯文本版去掉轻标记 */
function plain(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1");
}

/** 类别缺省页脚首句 */
export function defaultFooter(kind: MailKind): string {
  switch (kind) {
    case "verify":
      return "如果这不是你发起的操作，可以放心忽略这封邮件，账号不会有任何变化。";
    case "security":
      return "这是账号安全通知，不受通知偏好控制。";
    case "notice":
      return "你收到这封邮件是因为开启了相应的邮件提醒。";
    case "digest":
      return "每天最多一封，24 小时内登录过则不发。";
    case "system":
      return "由站点后台触发。";
  }
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function renderMail(spec: MailSpec): MailMessage {
  const { brand } = spec;
  const accent = spec.kind === "security" ? SECURITY_ACCENT : brand.accent;
  const subject = spec.subject ?? `${spec.title} · ${brand.siteName}`;
  const footer = spec.footer ?? defaultFooter(spec.kind);
  const manageUrl = `${brand.siteUrl}/settings/notifications`;
  const showManage = spec.kind === "notice" || spec.kind === "digest";
  const host = hostOf(brand.siteUrl);

  const bodyParts: string[] = [];
  for (const p of spec.paragraphs) {
    bodyParts.push(`<p style="margin:0 0 12px;font-size:15px;line-height:1.75">${rich(p)}</p>`);
  }
  if (spec.fields && spec.fields.length > 0) {
    const rows = spec.fields
      .map(
        (f, i) =>
          `<tr><td style="padding:8px 0;border-top:1px solid #f1f5f9;${i === spec.fields!.length - 1 ? "border-bottom:1px solid #f1f5f9;" : ""}color:#64748b;width:88px;vertical-align:top">${esc(f.label)}</td><td style="padding:8px 0;border-top:1px solid #f1f5f9;${i === spec.fields!.length - 1 ? "border-bottom:1px solid #f1f5f9;" : ""}">${rich(f.value)}</td></tr>`,
      )
      .join("");
    bodyParts.push(
      `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px;line-height:1.7;border-collapse:collapse;margin:4px 0 6px">${rows}</table>`,
    );
  }
  if (spec.quote) {
    bodyParts.push(
      `<div style="background:#f8fafc;border-radius:10px;padding:14px 16px;margin:0 0 6px;font-size:15px;line-height:1.7;color:#334155">“${esc(spec.quote)}”</div>`,
    );
    if (spec.quoteCaption) {
      bodyParts.push(
        `<p style="margin:0;font-size:12px;color:#94a3b8">${esc(spec.quoteCaption)}</p>`,
      );
    }
  }
  if (spec.list && spec.list.length > 0) {
    bodyParts.push(
      `<ul style="margin:0 0 6px;padding-left:20px;font-size:15px;line-height:1.9">${spec.list.map((i) => `<li>${rich(i)}</li>`).join("")}</ul>`,
    );
  }
  if (spec.action) {
    const href = esc(spec.action.href);
    bodyParts.push(
      `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px 0 10px"><tr><td style="background:${brand.accent};border-radius:8px"><a href="${href}" style="display:inline-block;padding:12px 26px;color:#ffffff;font-weight:600;text-decoration:none;font-size:15px">${esc(spec.action.label)}</a></td></tr></table>`,
      `<p style="margin:0 0 ${spec.note ? "18px" : "0"};font-size:12px;color:#64748b;line-height:1.6;word-break:break-all">按钮无法点击时，复制此链接到浏览器打开：<br /><a href="${href}" style="color:${brand.accent}">${href}</a></p>`,
    );
  }
  if (spec.note) {
    bodyParts.push(
      `<div style="background:#f8fafc;border-left:3px solid ${accent};padding:10px 14px;border-radius:0 8px 8px 0;font-size:13px;color:#475569;line-height:1.6">${rich(spec.note)}</div>`,
    );
  }

  const footerHtml = [
    rich(footer),
    showManage
      ? ` 可在 <a href="${esc(manageUrl)}" style="color:#94a3b8;text-decoration:underline">设置 → 通知</a> 中管理邮件提醒。`
      : "",
  ].join("");

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:32px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px">
<tr><td style="padding:0 6px 12px;font-family:${FONT}">
<span style="font-size:17px;font-weight:700;color:${brand.accent};letter-spacing:.3px">${esc(brand.siteName)}</span>${
    brand.tagline
      ? `<span style="font-size:12px;color:#64748b;margin-left:8px">${esc(brand.tagline)}</span>`
      : ""
  }
</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e2e8f0;border-top:4px solid ${accent};border-radius:12px;padding:26px 28px 22px;font-family:${FONT};color:#1e293b">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.4;font-weight:700">${esc(spec.title)}</h1>
${bodyParts.join("\n")}
</td></tr>
<tr><td style="padding:14px 6px 0;font-family:${FONT};font-size:12px;color:#94a3b8;line-height:1.7">
${footerHtml}<br />
${esc(brand.siteName)} · <a href="${esc(brand.siteUrl)}" style="color:#94a3b8">${esc(host)}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = renderText(spec, { subject, footer, manageUrl: showManage ? manageUrl : null });
  return { kind: spec.kind, scene: spec.scene, subject, html, text };
}

function renderText(
  spec: MailSpec,
  ctx: { subject: string; footer: string; manageUrl: string | null },
): string {
  const lines: string[] = [spec.title, ""];
  for (const p of spec.paragraphs) lines.push(plain(p), "");
  if (spec.fields && spec.fields.length > 0) {
    for (const f of spec.fields) lines.push(`${f.label}：${plain(f.value)}`);
    lines.push("");
  }
  if (spec.quote) {
    lines.push(`「${spec.quote}」`);
    if (spec.quoteCaption) lines.push(spec.quoteCaption);
    lines.push("");
  }
  if (spec.list && spec.list.length > 0) {
    for (const i of spec.list) lines.push(`· ${plain(i)}`);
    lines.push("");
  }
  if (spec.action) lines.push(`${spec.action.label}：${spec.action.href}`, "");
  if (spec.note) lines.push(plain(spec.note), "");
  lines.push("——", plain(ctx.footer));
  if (ctx.manageUrl) lines.push(`管理邮件提醒：${ctx.manageUrl}`);
  lines.push(`${spec.brand.siteName} · ${spec.brand.siteUrl}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
