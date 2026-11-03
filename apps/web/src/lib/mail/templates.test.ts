import { describe, expect, it } from "vitest";
import type { MailKind } from "./types";
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

/** 逐模板断言主题、关键文案与链接（审查批次 0 拍板的文案表）；换文案须同步改这里 */
describe("模板 · 验证令牌类", () => {
  it("verifyEmailMail：24 小时提示；带 email 时正文点明地址", () => {
    const m = verifyEmailMail("https://s.test/verify/tok");
    expect(m.subject).toBe("验证邮箱 · 青翼字幕组");
    expect(m.kind).toBe("verify");
    expect(m.scene).toBe("verify-email");
    expect(m.html).toContain("24 小时");
    expect(m.html).toContain("https://s.test/verify/tok");
    const bound = verifyEmailMail("https://s.test/verify/tok", undefined, {
      email: "sky@example.com",
    });
    expect(bound.html).toContain("sky@example.com");
  });

  it("resetPasswordMail：1 小时；不再携带认领场景的「旧密码」话术", () => {
    const m = resetPasswordMail("https://s.test/reset/tok");
    expect(m.subject).toBe("重置密码 · 青翼字幕组");
    expect(m.html).toContain("1 小时");
    expect(m.html).not.toContain("旧论坛");
  });

  it("claimMail：30 天；「旧密码无法迁移」只出现在认领邮件", () => {
    const m = claimMail("https://s.test/claim/tok");
    expect(m.subject).toBe("认领你的老账号 · 青翼字幕组");
    expect(m.html).toContain("旧论坛的密码无法迁移");
    expect(m.html).toContain("30 天");
  });

  it("accountDeletionVerificationMail：request 讲冷静期可撤销；access 讲只访问状态页", () => {
    const req = accountDeletionVerificationMail("https://s.test/c/1", "request");
    expect(req.subject).toBe("确认注销申请 · 青翼字幕组");
    expect(req.html).toContain("30 天冷静期");
    expect(req.html).toContain("随时登录撤销");
    const acc = accountDeletionVerificationMail("https://s.test/c/2", "access");
    expect(acc.subject).toBe("查看注销申请状态 · 青翼字幕组");
    expect(acc.html).toContain("不会登录到账号");
    expect(acc.html).toContain("1 小时");
  });
});

describe("模板 · 安全强制类", () => {
  it("passwordChangedMail：发生时间 + 找回密码按钮", () => {
    const m = passwordChangedMail(undefined, { at: "2026-10-31 14:02" });
    expect(m.subject).toBe("密码已修改 · 青翼字幕组");
    expect(m.html).toContain("2026-10-31 14:02");
    expect(m.html).toContain("/forgot");
    expect(m.html).toContain("找回密码");
  });

  it("emailChangedAlertMail：旧邮箱仅告警，提供仍可执行的安全路径，不承诺已失效的邮箱找回", () => {
    const m = emailChangedAlertMail();
    expect(m.subject).toBe("邮箱已更换 · 青翼字幕组");
    expect(m.html).toContain("本地址不再接收");
    expect(m.text).toContain("旧邮箱已无法通过「找回密码」定位该账号");
    expect(m.text).toContain("若你仍能登录");
    expect(m.text).toContain("联系站点管理");
    expect(m.text).toContain("/settings/password");
    expect(m.text).not.toContain("夺回账号");
    expect(m.text).not.toContain("/forgot");
  });

  it("emailChangedConfirmMail：验证邮件随后送达（不暴露内部术语）", () => {
    const m = emailChangedConfirmMail();
    expect(m.html).toContain("验证邮件会随后送达");
    expect(m.html).not.toContain("验证态");
  });

  it("restrictionMail：字段表 + 申诉入口 + 理由转义；解除态另一话术", () => {
    const m = restrictionMail({
      lifted: false,
      kind: "mute",
      reason: "<b>违规</b>",
      endsAt: "2026-11-07 20:00",
      at: "2026-10-31 14:02",
    });
    expect(m.subject).toBe("账号已被禁言 · 青翼字幕组");
    expect(m.html).toContain("至 2026-11-07 20:00");
    expect(m.html).toContain("&lt;b&gt;违规&lt;/b&gt;");
    expect(m.html).toContain("/appeal");
    expect(m.html).toContain("提交申诉");
    const lifted = restrictionMail({ lifted: true, kind: "mute", reason: "", endsAt: null });
    expect(lifted.subject).toBe("限制已解除 · 青翼字幕组");
    expect(lifted.html).toContain("欢迎回来");
  });

  it("appealResultMail：驳回明确写「申诉未通过」", () => {
    expect(appealResultMail("approved", "ok").subject).toBe("申诉已通过 · 青翼字幕组");
    const rejected = appealResultMail("rejected", "违规事实清楚");
    expect(rejected.subject).toBe("申诉未通过 · 青翼字幕组");
    expect(rejected.html).toContain("违规事实清楚");
  });
});

describe("模板 · 场景通知与汇总", () => {
  it("pmReceivedMail：预览截断 80 字 + 每小时频控页脚", () => {
    const m = pmReceivedMail({
      senderName: "夜雨",
      preview: "长".repeat(100),
      conversationId: 1842,
    });
    expect(m.subject).toBe("夜雨 给你发来了私信 · 青翼字幕组");
    expect(m.html).not.toContain("长".repeat(81));
    expect(m.html).toContain("…");
    expect(m.html).toContain("/messages?conv=1842");
    expect(m.html).toContain("每小时最多提醒一次");
  });

  it("gateSoldMail / contentApprovedMail：积分与帖子链接", () => {
    const sold = gateSoldMail({ points: 20 });
    expect(sold.subject).toBe("内容售出（+20）· 青翼字幕组");
    expect(sold.html).toContain("+20 积分");
    const approved = contentApprovedMail({ threadId: 1024 });
    expect(approved.html).toContain("/t/1024");
  });

  it("digestMail：仅含非零项；纯文本去掉轻标记", () => {
    const m = digestMail({ unreadPm: 2, newReplies: 0, newMentions: 1, newFollowers: 0 });
    expect(m.html).toContain("未读私信");
    expect(m.html).not.toContain("新回复");
    expect(m.text).toContain("· 未读私信 2 条");
    expect(m.text).not.toContain("**");
  });

  it("testMail：系统类", () => {
    const m = testMail(undefined, { at: "2026-10-31 14:02" });
    expect(m.kind).toBe("system");
    expect(m.subject).toBe("测试邮件 · 青翼字幕组");
    expect(m.html).toContain("SMTP 发信链路正常");
  });
});

describe("kind 全覆盖", () => {
  it("五类 kind 都有代表模板（发送记录按此筛选）", () => {
    const kinds = new Set<MailKind>([
      verifyEmailMail("x").kind,
      passwordChangedMail().kind,
      pmReceivedMail({ senderName: "a", preview: "b", conversationId: 1 }).kind,
      digestMail({ unreadPm: 1, newReplies: 0, newMentions: 0, newFollowers: 0 }).kind,
      testMail().kind,
    ]);
    expect([...kinds].sort()).toEqual(["digest", "notice", "security", "system", "verify"]);
  });
});
