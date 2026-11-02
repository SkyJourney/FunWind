import { nowBeijingWallTime } from "@/lib/datetime";
import { FALLBACK_BRAND } from "./brand";
import { renderMail } from "./layout";
import type { MailBrand, MailMessage } from "./types";

/**
 * 邮件模板（全部纯函数，单测友好）。文案约定：第二人称「你」、按钮动词开头、不堆感叹号；
 * 主题统一「标题 · 站名」由 renderMail 生成。场景清单与分类见 docs/EMAIL-SCENARIOS.md。
 * 新增邮件必须经 renderMail 渲染并在 previews.ts 登记样例（守卫测试强制）。
 */

// ============================================================
// 验证令牌类（verify）
// ============================================================

/** 验证邮箱：注册与换绑共用；传入 email 时在正文点明被验证的地址 */
export function verifyEmailMail(
  link: string,
  brand: MailBrand = FALLBACK_BRAND,
  opts: { email?: string } = {},
): MailMessage {
  return renderMail({
    kind: "verify",
    scene: "verify-email",
    brand,
    title: "验证这个邮箱地址",
    subject: `验证邮箱 · ${brand.siteName}`,
    paragraphs: [
      opts.email
        ? `你正在把 **${opts.email}** 绑定到 ${brand.siteName} 的账号。`
        : `请验证这个邮箱地址，以开通 ${brand.siteName} 账号的完整功能。`,
      "点击下方按钮完成验证，之后找回密码等安全邮件都会发到这里。",
    ],
    action: { href: link, label: "验证邮箱" },
    note: "链接 **24 小时**内有效，仅可使用一次。",
  });
}

export function resetPasswordMail(link: string, brand: MailBrand = FALLBACK_BRAND): MailMessage {
  return renderMail({
    kind: "verify",
    scene: "reset-password",
    brand,
    title: "重置密码",
    paragraphs: [`我们收到了重置你 ${brand.siteName} 账号密码的请求。点击下方按钮设置新密码。`],
    action: { href: link, label: "设置新密码" },
    note: "链接 **1 小时**内有效，仅可使用一次。",
  });
}

/** 老账号认领（旧站迁移用户无密码）：这是唯一需要解释「旧密码无法迁移」的场景 */
export function claimMail(link: string, brand: MailBrand = FALLBACK_BRAND): MailMessage {
  return renderMail({
    kind: "verify",
    scene: "claim-account",
    brand,
    title: "认领你的老账号",
    paragraphs: [
      `我们在新站找到了你的青翼老账号。旧论坛的密码无法迁移，需要你验证邮箱并设置一个新密码，之后就能带着原有身份回到社区。`,
    ],
    action: { href: link, label: "认领账号" },
    note: "链接 **30 天**内有效，仅可使用一次。",
  });
}

export function accountDeletionVerificationMail(
  link: string,
  purpose: "request" | "access",
  brand: MailBrand = FALLBACK_BRAND,
): MailMessage {
  const isRequest = purpose === "request";
  return renderMail({
    kind: "verify",
    scene: isRequest ? "account-deletion-request" : "account-deletion-access",
    brand,
    title: isRequest ? "确认注销申请" : "查看注销申请状态",
    paragraphs: isRequest
      ? [
          `你正在申请注销 ${brand.siteName} 账号。确认后账号进入 **30 天冷静期**，期间你可以随时登录撤销；冷静期结束后账号数据将被清除且无法恢复。`,
        ]
      : ["你请求查看或撤销账号注销申请。验证后只能访问注销状态页，不会登录到账号。"],
    action: { href: link, label: isRequest ? "确认注销申请" : "查看注销状态" },
    note: "链接 **1 小时**内有效，仅可使用一次。",
  });
}

// ============================================================
// 安全强制类（security）：后台统一开关，不查用户偏好
// ============================================================

/** S1/S2a 共用骨架：发生时间字段 + 找回密码按钮 + 安全页脚 */
function securityNoticeWithRecovery(
  spec: { scene: string; title: string; subject: string; paragraph: string; footer: string },
  brand: MailBrand,
  at: string,
): MailMessage {
  return renderMail({
    kind: "security",
    brand,
    ...spec,
    paragraphs: [spec.paragraph],
    fields: [{ label: "发生时间", value: `${at}（北京时间）` }],
    action: { href: `${brand.siteUrl}/forgot`, label: "找回密码" },
  });
}

/** S1：密码已被修改 */
export function passwordChangedMail(
  brand: MailBrand = FALLBACK_BRAND,
  opts: { at?: string } = {},
): MailMessage {
  return securityNoticeWithRecovery(
    {
      scene: "password-changed",
      title: "你的密码已修改",
      subject: `密码已修改 · ${brand.siteName}`,
      paragraph: `你的 ${brand.siteName} 账号密码刚刚被修改。如果是你本人操作，无需处理。`,
      footer:
        "这是账号安全通知，不受通知偏好控制。如果这不是你的操作，请立即通过「找回密码」重设密码并检查账号安全。",
    },
    brand,
    opts.at ?? nowBeijingWallTime(),
  );
}

/** S2a：邮箱被换绑——发往旧邮箱的告警 */
export function emailChangedAlertMail(
  brand: MailBrand = FALLBACK_BRAND,
  opts: { at?: string } = {},
): MailMessage {
  return securityNoticeWithRecovery(
    {
      scene: "email-changed-alert",
      title: "账号邮箱已更换",
      subject: `邮箱已更换 · ${brand.siteName}`,
      paragraph: `你的 ${brand.siteName} 账号绑定邮箱刚刚被更换为其它地址，本地址不再接收该账号的邮件。`,
      footer:
        "这是账号安全通知，不受通知偏好控制。如果这不是你的操作，请立即用本邮箱通过「找回密码」夺回账号。",
    },
    brand,
    opts.at ?? nowBeijingWallTime(),
  );
}

/** S2b：邮箱被换绑——发往新邮箱的确认 */
export function emailChangedConfirmMail(brand: MailBrand = FALLBACK_BRAND): MailMessage {
  return renderMail({
    kind: "security",
    scene: "email-changed-confirm",
    brand,
    title: "邮箱绑定成功",
    paragraphs: [
      `你的 ${brand.siteName} 账号绑定邮箱已更换为本地址。验证邮件会随后送达，完成验证后生效；之后找回密码等安全邮件都会发到这里。`,
    ],
  });
}

export const RESTRICTION_LABEL = {
  ban: "封禁",
  forum_ban: "板块禁入",
  mute: "禁言",
  no_avatar: "禁用头像",
  no_signature: "禁用签名",
} as const;

const RESTRICTION_EFFECT: Record<keyof typeof RESTRICTION_LABEL, string> = {
  ban: "期间无法登录使用。",
  forum_ban: "期间无法进入指定板块。",
  mute: "期间无法发帖、回复与发送私信。",
  no_avatar: "头像功能已被禁用。",
  no_signature: "签名功能已被禁用。",
};

/** S3：账号被限制 / 解除；reason 由后台填写，渲染前转义 */
export function restrictionMail(
  opts: {
    lifted: boolean;
    kind: keyof typeof RESTRICTION_LABEL;
    reason: string;
    endsAt: string | null;
    at?: string;
  },
  brand: MailBrand = FALLBACK_BRAND,
): MailMessage {
  const kindLabel = RESTRICTION_LABEL[opts.kind] ?? opts.kind;
  if (opts.lifted) {
    return renderMail({
      kind: "security",
      scene: "restriction-lifted",
      brand,
      title: "限制已解除",
      paragraphs: [`你账号的「${kindLabel}」限制已解除，欢迎回来。`],
      fields: opts.reason ? [{ label: "管理员说明", value: opts.reason }] : undefined,
    });
  }
  return renderMail({
    kind: "security",
    scene: "restriction",
    brand,
    title: `你的账号已被${kindLabel}`,
    subject: `账号已被${kindLabel} · ${brand.siteName}`,
    paragraphs: [`管理员对你的账号施加了限制，${RESTRICTION_EFFECT[opts.kind] ?? ""}`],
    fields: [
      { label: "限制类型", value: kindLabel },
      { label: "期限", value: opts.endsAt ? `至 ${opts.endsAt}（北京时间）` : "长期" },
      { label: "理由", value: opts.reason || "未填写" },
      { label: "生效时间", value: `${opts.at ?? nowBeijingWallTime()}（北京时间）` },
    ],
    action: { href: `${brand.siteUrl}/appeal`, label: "提交申诉" },
    footer: "这是账号安全通知，不受通知偏好控制。如对处理有异议，可通过上方入口提交申诉。",
  });
}

export function appealResultMail(
  status: "approved" | "rejected",
  result: string,
  brand: MailBrand = FALLBACK_BRAND,
): MailMessage {
  const approved = status === "approved";
  return renderMail({
    kind: "security",
    scene: approved ? "appeal-approved" : "appeal-rejected",
    brand,
    title: approved ? "申诉已通过" : "申诉未通过",
    paragraphs: [approved ? "管理员已通过你的申诉。" : "管理员已审阅你的申诉，未予通过。"],
    fields: [{ label: "处理说明", value: result || "无" }],
  });
}

// ============================================================
// 场景通知类（notice）：用户偏好开启邮件渠道才发
// ============================================================

/** S4：收到私信（频控后；摘要 = 最新一条的前 80 字） */
export function pmReceivedMail(
  opts: { senderName: string; preview: string; conversationId: number },
  brand: MailBrand = FALLBACK_BRAND,
): MailMessage {
  const preview = opts.preview.slice(0, 80) + (opts.preview.length > 80 ? "…" : "");
  return renderMail({
    kind: "notice",
    scene: "pm-received",
    brand,
    title: `${opts.senderName} 给你发来了私信`,
    paragraphs: [],
    quote: preview,
    quoteCaption: "仅显示最新一条的前 80 字",
    action: { href: `${brand.siteUrl}/messages?conv=${opts.conversationId}`, label: "查看并回复" },
    footer: "你收到这封邮件是因为开启了「收到私信」的邮件提醒；同一会话每小时最多提醒一次。",
  });
}

/** S5：付费内容被购买 */
export function gateSoldMail(
  opts: { points: number },
  brand: MailBrand = FALLBACK_BRAND,
): MailMessage {
  return renderMail({
    kind: "notice",
    scene: "gate-sold",
    brand,
    title: "你的付费内容被购买了",
    subject: `内容售出（+${opts.points}）· ${brand.siteName}`,
    paragraphs: [`刚刚有人购买了你的付费内容，收益 **+${opts.points} 积分**已入账。`],
    action: { href: `${brand.siteUrl}/points`, label: "查看积分记录" },
    footer: "你收到这封邮件是因为开启了「内容售出」的邮件提醒。",
  });
}

/** S6：提交的内容审核通过 */
export function contentApprovedMail(
  opts: { threadId: number },
  brand: MailBrand = FALLBACK_BRAND,
): MailMessage {
  return renderMail({
    kind: "notice",
    scene: "content-approved",
    brand,
    title: "内容审核通过",
    paragraphs: ["你提交的内容已通过审核并公开发布。"],
    action: { href: `${brand.siteUrl}/t/${opts.threadId}`, label: "查看帖子" },
    footer: "你收到这封邮件是因为开启了「审核结果」的邮件提醒。",
  });
}

// ============================================================
// 每日汇总（digest）
// ============================================================

/** S7：每日汇总（召回主力） */
export function digestMail(
  opts: { unreadPm: number; newReplies: number; newMentions: number; newFollowers: number },
  brand: MailBrand = FALLBACK_BRAND,
): MailMessage {
  const list = [
    opts.unreadPm > 0 ? `未读私信 **${opts.unreadPm}** 条` : "",
    opts.newReplies > 0 ? `新回复 **${opts.newReplies}** 条` : "",
    opts.newMentions > 0 ? `被 @ 提及 **${opts.newMentions}** 次` : "",
    opts.newFollowers > 0 ? `新关注者 **${opts.newFollowers}** 人` : "",
  ].filter(Boolean);
  return renderMail({
    kind: "digest",
    scene: "digest",
    brand,
    title: "你的社区动态",
    paragraphs: ["过去一天里，这些动态在等你："],
    list,
    action: { href: `${brand.siteUrl}/notifications`, label: "查看通知" },
  });
}

// ============================================================
// 系统类（system）
// ============================================================

/** 后台「发送测试邮件」：验证 SMTP 发信链路；收件人 = 当前管理员 */
export function testMail(
  brand: MailBrand = FALLBACK_BRAND,
  opts: { at?: string } = {},
): MailMessage {
  return renderMail({
    kind: "system",
    scene: "test-mail",
    brand,
    title: "测试邮件",
    paragraphs: [`这是一封从 ${brand.siteName} 后台发出的测试邮件，收到即代表 SMTP 发信链路正常。`],
    fields: [{ label: "发送时间", value: `${opts.at ?? nowBeijingWallTime()}（北京时间）` }],
  });
}
