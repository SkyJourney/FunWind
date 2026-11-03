import type { MailBrand, MailMessage } from "./types";
import {
  accountDeletionVerificationMail,
  appealResultMail,
  claimMail,
  contentApprovedMail,
  digestMail,
  emailChangedAlertMail,
  emailChangedConfirmMail,
  gateSoldMail,
  passwordChangedMail,
  pmReceivedMail,
  resetPasswordMail,
  restrictionMail,
  testMail,
  verifyEmailMail,
} from "./templates";

/**
 * 模板预览样例（后台 /admin/mail/preview 与守卫测试共用）：每个模板至少登记一条，
 * 用固定样例数据与固定时间，保证预览可重复、测试可断言。
 */
export interface MailPreview {
  id: string;
  label: string;
  group: "验证" | "安全" | "场景" | "汇总" | "系统";
  build: (brand: MailBrand) => MailMessage;
}

const AT = "2026-10-31 14:02";
const token = (b: MailBrand, path: string) => `${b.siteUrl}${path}`;

export const MAIL_PREVIEWS: readonly MailPreview[] = [
  {
    id: "verify-email",
    label: "验证邮箱（注册）",
    group: "验证",
    build: (b) => verifyEmailMail(token(b, "/verify/sample-token"), b),
  },
  {
    id: "verify-email-bind",
    label: "验证邮箱（换绑）",
    group: "验证",
    build: (b) =>
      verifyEmailMail(token(b, "/verify/sample-token"), b, { email: "sky@example.com" }),
  },
  {
    id: "reset-password",
    label: "重置密码",
    group: "验证",
    build: (b) => resetPasswordMail(token(b, "/reset/sample-token"), b),
  },
  {
    id: "claim-account",
    label: "认领老账号",
    group: "验证",
    build: (b) => claimMail(token(b, "/claim/sample-token"), b),
  },
  {
    id: "account-deletion-request",
    label: "确认注销申请",
    group: "验证",
    build: (b) =>
      accountDeletionVerificationMail(token(b, "/closure/verify?token=sample"), "request", b),
  },
  {
    id: "account-deletion-access",
    label: "查看注销状态",
    group: "验证",
    build: (b) =>
      accountDeletionVerificationMail(token(b, "/closure/verify?token=sample"), "access", b),
  },
  {
    id: "password-changed",
    label: "密码已修改",
    group: "安全",
    build: (b) => passwordChangedMail(b, { at: AT }),
  },
  {
    id: "email-changed-alert",
    label: "邮箱已更换（旧邮箱告警）",
    group: "安全",
    build: (b) => emailChangedAlertMail(b, { at: AT }),
  },
  {
    id: "email-changed-confirm",
    label: "邮箱绑定成功（新邮箱）",
    group: "安全",
    build: (b) => emailChangedConfirmMail(b),
  },
  {
    id: "restriction",
    label: "账号被禁言",
    group: "安全",
    build: (b) =>
      restrictionMail(
        {
          lifted: false,
          kind: "mute",
          reason: "多次在资源区发布无关内容，经提醒未改正。",
          endsAt: "2026-11-07 20:00",
          at: AT,
        },
        b,
      ),
  },
  {
    id: "restriction-lifted",
    label: "限制已解除",
    group: "安全",
    build: (b) =>
      restrictionMail(
        { lifted: true, kind: "mute", reason: "申诉通过，提前解除。", endsAt: null },
        b,
      ),
  },
  {
    id: "appeal-approved",
    label: "申诉已通过",
    group: "安全",
    build: (b) => appealResultMail("approved", "核实为误判，相关限制已解除。", b),
  },
  {
    id: "appeal-rejected",
    label: "申诉未通过",
    group: "安全",
    build: (b) => appealResultMail("rejected", "违规事实清楚，维持原处理。", b),
  },
  {
    id: "pm-received",
    label: "收到私信",
    group: "场景",
    build: (b) =>
      pmReceivedMail(
        {
          senderName: "夜雨",
          preview:
            "上次说的那集字幕我校对完了，你有空的时候帮忙看一眼时间轴，特别是 12 分钟后那段，有几句对白的起止我拿不准。",
          conversationId: 1842,
        },
        b,
      ),
  },
  {
    id: "gate-sold",
    label: "内容售出",
    group: "场景",
    build: (b) => gateSoldMail({ points: 20 }, b),
  },
  {
    id: "content-approved",
    label: "审核通过",
    group: "场景",
    build: (b) => contentApprovedMail({ threadId: 1024 }, b),
  },
  {
    id: "digest",
    label: "每日动态",
    group: "汇总",
    build: (b) => digestMail({ unreadPm: 2, newReplies: 5, newMentions: 1, newFollowers: 3 }, b),
  },
  {
    id: "test-mail",
    label: "测试邮件",
    group: "系统",
    build: (b) => testMail(b, { at: AT }),
  },
];

export function findMailPreview(id: string | undefined): MailPreview {
  return MAIL_PREVIEWS.find((p) => p.id === id) ?? MAIL_PREVIEWS[0]!;
}
