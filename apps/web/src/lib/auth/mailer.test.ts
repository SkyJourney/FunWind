import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildLegacyStorage,
  hashPassword,
  legacyHashHex,
  verifyLegacyPassword,
  verifyPassword,
} from "./password";
import {
  contentApprovedMail,
  digestMail,
  emailChangedAlertMail,
  emailChangedConfirmMail,
  gateSoldMail,
  passwordChangedMail,
  pmReceivedMail,
  restrictionMail,
  testMail,
} from "./mailer";

describe("password (argon2id)", () => {
  it("哈希往返正确", async () => {
    const h = await hashPassword("青翼密码Pass1!");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "青翼密码Pass1!")).toBe(true);
  });

  it("错误密码拒绝", async () => {
    const h = await hashPassword("correct");
    expect(await verifyPassword(h, "wrong")).toBe(false);
  });

  it("同密码两次哈希不同盐", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("损坏哈希串返回 false 而非抛错", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});

describe("双轨旧哈希（phpwind 口径 md5(md5(pwd)+salt)）", () => {
  const pw = "旧密码Pass1";
  const salt = "YcNESh"; // 旧库 SkyJourney 同款 6 位盐格式
  // 独立于 legacyHashHex 直接重算，避免实现互相印证的循环论证
  const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

  it("口径向量：与旧站 WindidUtility::buildPassword 一致", () => {
    expect(legacyHashHex(pw, salt)).toBe(md5(md5(pw) + salt));
    expect(legacyHashHex("中文密码", "Ab3dEf")).toBe(md5(md5("中文密码") + "Ab3dEf"));
  });

  it("存储格式往返：buildLegacyStorage → verifyLegacyPassword", () => {
    const stored = buildLegacyStorage(legacyHashHex(pw, salt), salt);
    expect(stored).toBe(`md5$${md5(md5(pw) + salt)}$${salt}`);
    expect(verifyLegacyPassword(stored, pw)).toBe(true);
    expect(verifyLegacyPassword(stored, pw + "x")).toBe(false);
    expect(verifyLegacyPassword(stored, "")).toBe(false);
  });

  it("坏材料一律 false（格式/标签/哈希长度/空盐）", () => {
    expect(verifyLegacyPassword("md5$abc$Yc", pw)).toBe(false);
    expect(verifyLegacyPassword("argon2$xxxx$YcNESh", pw)).toBe(false);
    expect(verifyLegacyPassword(`md5$${"0".repeat(32)}$`, pw)).toBe(false);
    expect(verifyLegacyPassword("garbage", pw)).toBe(false);
  });
});

describe("邮件模板（基础 + 收尾切片场景）", () => {
  it("测试邮件与验证邮件带站点名", () => {
    expect(testMail("测试站").subject).toBe("测试邮件 · 测试站");
  });

  it("S1/S2 安全类：主题含站点名，正文含安全指引", () => {
    const pw = passwordChangedMail("测试站");
    expect(pw.subject).toBe("密码已修改 · 测试站");
    expect(pw.html).toContain("找回密码");
    const alert = emailChangedAlertMail("测试站");
    expect(alert.subject).toBe("邮箱已更换 · 测试站");
    expect(alert.html).toContain("夺回账号");
    const confirm = emailChangedConfirmMail("测试站");
    expect(confirm.html).toContain("验证态已重置");
  });

  it("S3 限制类：applied/lifted 两态、理由转义、长期/限期", () => {
    const applied = restrictionMail(
      { lifted: false, kind: "ban", reason: "<script>x</script>", endsAt: null },
      "测试站",
    );
    expect(applied.subject).toBe("账号已被封禁 · 测试站");
    expect(applied.html).toContain("（长期）");
    expect(applied.html).not.toContain("<script>");
    expect(applied.html).toContain("&lt;script&gt;");
    const lifted = restrictionMail(
      { lifted: true, kind: "mute", reason: "", endsAt: "2026-11-01 10:00:00" },
      "测试站",
    );
    expect(lifted.subject).toBe("限制已解除 · 测试站");
  });

  it("S4/S5/S6 场景：私信摘要截断、售出收益、审核通过链接", () => {
    const pm = pmReceivedMail(
      {
        senderName: "纸巾君",
        preview: "你好呀".repeat(40),
        conversationId: 7,
        siteUrl: "http://x",
      },
      "测试站",
    );
    expect(pm.subject).toContain("纸巾君");
    expect(pm.html).toContain("/messages?conv=7");
    expect(pm.html).toContain("…");
    const sold = gateSoldMail({ points: 12, siteUrl: "http://x" }, "测试站");
    expect(sold.subject).toContain("+12");
    const ok = contentApprovedMail({ threadId: 9, siteUrl: "http://x" }, "测试站");
    expect(ok.html).toContain("/t/9");
  });

  it("S7 digest：各计数渲染、零场景无列表项", () => {
    const d = digestMail(
      { siteUrl: "http://x", unreadPm: 3, newReplies: 5, newMentions: 1, newFollowers: 2 },
      "测试站",
    );
    expect(d.html).toContain("未读私信 3 条");
    expect(d.html).toContain("新回复 5 条");
    expect(d.html).toContain("被 @ 提及 1 次");
    expect(d.html).toContain("新关注者 2 人");
    const empty = digestMail(
      { siteUrl: "http://x", unreadPm: 0, newReplies: 0, newMentions: 0, newFollowers: 0 },
      "测试站",
    );
    expect(empty.html).not.toContain("<li>");
  });
});
