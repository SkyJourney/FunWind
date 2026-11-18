// @vitest-environment node
import { emailLog, getWebDb, getWebPool } from "@funwind/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DeliveryTransportError } from "@/lib/net/delivery-error";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";
import { sendMail, trySendMail } from "./transport";
import type { MailMessage } from "./types";

const { smtp, sdkSend } = vi.hoisted(() => ({ smtp: { url: "" }, sdkSend: vi.fn() }));
vi.mock("nodemailer", () => ({
  default: {
    createTransport(url: string) {
      smtp.url = url;
      return { sendMail: sdkSend };
    },
  },
}));

const recipient = "recipient@example.com";
const mail: MailMessage = {
  kind: "notice",
  scene: "transport-test",
  subject: "测试邮件",
  html: "<p>不写入审计记录的正文</p>",
  text: "不写入审计记录的正文",
};

describe.skipIf(skipDb)("SMTP 安全投递边界", () => {
  let tdb: TempDb | undefined;
  beforeAll(async () => {
    tdb = await setupTempDb({ demo: false });
    vi.stubEnv(
      "SMTP_URL",
      "smtp://smtp.example.invalid:2525?logger=true&debug=true&transactionLog=true&requireTLS=true",
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    sdkSend.mockReset();
    await getWebDb().delete(emailLog);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await tdb?.teardown();
  });

  it.each([450, 550])("SMTP %d 明确拒绝，只对外抛并记录固定文案", async (responseCode) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = Object.assign(new Error(`${recipient} SMTP 密钥和服务响应`), {
      code: "EENVELOPE",
      responseCode,
      response: `${responseCode} 响应中包含 ${recipient}`,
      body: mail.text,
      cause: new Error("私密内部原因"),
    });
    sdkSend.mockRejectedValueOnce(raw);
    const error = await sendMail(recipient, mail).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliveryTransportError);
    expect(error).toMatchObject({ outcome: "failed", message: "SMTP 服务明确拒绝投递" });
    expect(error).not.toBe(raw);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("response");
    expect(error).not.toHaveProperty("body");
    const [log] = await getWebDb().select().from(emailLog);
    expect(log).toMatchObject({ status: "failed", error: "SMTP 服务明确拒绝投递" });
    expect(consoleError.mock.calls).toEqual([["[mail] SMTP 服务明确拒绝投递"]]);
  });

  it.each([
    Object.assign(new Error("超时"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("连接关闭"), { code: "ECONNECTION", responseCode: 421 }),
    Object.assign(new Error("不是 SDK 报告的数字应答码"), { responseCode: "550" }),
    "未知异常",
  ])("无法证明未接纳的 %s 归 uncertain，旧入口依旧返回 false", async (raw) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    sdkSend.mockRejectedValue(raw);
    await expect(sendMail(recipient, mail)).rejects.toMatchObject({ outcome: "uncertain" });
    await expect(trySendMail(recipient, mail)).resolves.toBe(false);
    const logs = await getWebDb().select().from(emailLog);
    expect(logs.map(({ error }) => error)).toEqual(["SMTP 投递结果未知", "SMTP 投递结果未知"]);
  });

  it("SMTP 接纳即成功，原审计字段保留且 SDK 调试日志强制关闭", async () => {
    sdkSend.mockResolvedValueOnce({ messageId: "smtp-test-id" });
    await expect(sendMail(recipient, mail)).resolves.toBeUndefined();
    const [log] = await getWebDb().select().from(emailLog);
    expect(log).toMatchObject({ status: "sent", toEmail: recipient, messageId: "smtp-test-id" });
    expect(smtp.url).toBe(
      "smtp://smtp.example.invalid:2525?logger=false&debug=false&transactionLog=false&requireTLS=true",
    );
  });

  it("审计写入失败不覆盖 SMTP 的接纳或明确拒绝，终端只输出固定诊断", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const dbError = new Error(`SQL 参数包含 ${recipient} 和 ${mail.subject}`);
    vi.spyOn(getWebPool(), "query").mockRejectedValueOnce(dbError).mockRejectedValueOnce(dbError);
    sdkSend.mockResolvedValueOnce({ messageId: "smtp-test-id" });
    sdkSend.mockRejectedValueOnce(Object.assign(new Error(recipient), { responseCode: 550 }));
    await expect(trySendMail(recipient, mail)).resolves.toBe(true);
    await expect(sendMail(recipient, mail)).rejects.toMatchObject({ outcome: "failed" });
    expect(consoleError.mock.calls).toEqual([
      ["[mail] 写入发送记录或清理历史记录失败"],
      ["[mail] 写入发送记录或清理历史记录失败"],
      ["[mail] SMTP 服务明确拒绝投递"],
    ]);
  });
});
