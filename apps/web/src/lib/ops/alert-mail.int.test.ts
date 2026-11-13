// @vitest-environment node
/**
 * 运维告警邮件的防重与发送（M17 Step 2）· 真实临时库。
 *
 * 两个要点：
 * 1. **发送替身成功时按 transport 的真实行为写 email_log**——防重查询依赖这张表，
 *    若把防重也 mock 掉，「重扫不重发」就成了空转断言。这里只替掉「真的发信」这一步。
 *    （本机 .env 指向真实 SMTP 中继，不替掉会真发邮件。）
 * 2. **主题锚点的子串撞车**：`%运行 #1%` 会命中 `#10`，把不同运行误判为已发。
 *    这是本模块最容易写错、且错了不会报错只会静默漏告警的地方，必须显式钉住。
 */
import { eq, sql } from "drizzle-orm";
import { emailLog, getWebDb, siteSettings } from "@funwind/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

const sendMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/email")>()),
  sendUserEmail: sendMock,
}));

const { OPS_ALERT_SCENE, opsAlertMailSent, sendOpsAlertMails } = await import("./alert-mail");
const { opsRunFailedMail } = await import("@/lib/mail/templates");

let tdb: TempDb;
const db = () => getWebDb();
const UID = 98101;
const OTHER_UID = 98102;
const BRAND = {
  siteName: "青翼字幕组",
  siteUrl: "https://example.com",
  tagline: "日语·ACG 情怀社区",
  accent: "#0e7490",
};

/** 替身：调用真实模板生成主题，并像 transport 那样落 email_log(status=sent) */
const mockSendSuccess = () =>
  sendMock.mockImplementation(async (userId: number, build: (ctx: unknown) => unknown) => {
    const msg = build({ email: "ops-alert@example.com", brand: BRAND }) as {
      kind: string;
      scene: string;
      subject: string;
    };
    await db()
      .insert(emailLog)
      .values({
        kind: msg.kind as "system",
        scene: msg.scene,
        toEmail: "ops-alert@example.com",
        userId,
        subject: msg.subject,
        status: "sent",
        createdAt: sql`NOW()`,
      });
    return true;
  });

/** 直接造一条发送记录（用于纯查询侧的防重断言） */
const seedLog = async (opts: {
  userId?: number;
  runId: number;
  scene?: string;
  status?: "sent" | "failed";
}) => {
  const msg = opsRunFailedMail(
    { task: "backup.db", runId: opts.runId, error: "注入", at: "2026-11-13 10:00" },
    BRAND,
  );
  await db()
    .insert(emailLog)
    .values({
      kind: "system",
      scene: opts.scene ?? OPS_ALERT_SCENE,
      toEmail: "ops-alert@example.com",
      userId: opts.userId ?? UID,
      subject: msg.subject,
      status: opts.status ?? "sent",
      createdAt: sql`NOW()`,
    });
};

const setOpsSwitch = (enabled: boolean) =>
  db().execute(
    sql`INSERT INTO site_settings (\`key\`, \`value\`, updated_at)
        VALUES ('email.ops', ${JSON.stringify({ enabled })}, NOW())
        ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`), updated_at = NOW()`,
  );

const FAILURE = [{ task: "backup.db", runId: 7001, error: "磁盘不可写" }];

beforeAll(async () => {
  tdb = await setupTempDb();
});
afterAll(async () => {
  await tdb?.teardown();
});
beforeEach(() => {
  sendMock.mockReset();
  mockSendSuccess();
});
afterEach(async () => {
  await db().delete(emailLog).where(eq(emailLog.scene, OPS_ALERT_SCENE));
  await db().delete(siteSettings).where(eq(siteSettings.key, "email.ops"));
});

describe.skipIf(skipDb)("防重查询：主题锚点必须精确到运行 id", () => {
  it("runId 10 已发 ≠ runId 1 已发（子串撞车防护，错了会静默漏告警）", async () => {
    await seedLog({ runId: 10 });
    expect(await opsAlertMailSent(UID, 10)).toBe(true);
    expect(await opsAlertMailSent(UID, 1)).toBe(false);
    expect(await opsAlertMailSent(UID, 100)).toBe(false);
  });

  it("runId 1 已发 ≠ runId 10 / 11 已发（反向同样成立）", async () => {
    await seedLog({ runId: 1 });
    expect(await opsAlertMailSent(UID, 1)).toBe(true);
    expect(await opsAlertMailSent(UID, 10)).toBe(false);
    expect(await opsAlertMailSent(UID, 11)).toBe(false);
  });

  it("发送失败不算已发（下一轮可重试）", async () => {
    await seedLog({ runId: 7001, status: "failed" });
    expect(await opsAlertMailSent(UID, 7001)).toBe(false);
  });

  it("别的场景 / 别的用户不算已发", async () => {
    await seedLog({ runId: 7001, scene: "test-mail" });
    expect(await opsAlertMailSent(UID, 7001)).toBe(false);
    await seedLog({ runId: 7002, userId: OTHER_UID });
    expect(await opsAlertMailSent(UID, 7002)).toBe(false);
    expect(await opsAlertMailSent(OTHER_UID, 7002)).toBe(true);
  });
});

describe.skipIf(skipDb)("发送与重扫防重", () => {
  it("首发 sent=1；同一运行重扫 skipped=1、不再发信", async () => {
    const first = await sendOpsAlertMails([UID], FAILURE);
    expect(first).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const second = await sendOpsAlertMails([UID], FAILURE);
    expect(second).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(sendMock).toHaveBeenCalledTimes(1); // 关键：没有第二次发送
  });

  it("多管理员各发一封，且各自独立防重", async () => {
    const r = await sendOpsAlertMails([UID, OTHER_UID], FAILURE);
    expect(r.sent).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
    const again = await sendOpsAlertMails([UID, OTHER_UID], FAILURE);
    expect(again).toEqual({ sent: 0, skipped: 2, failed: 0 });
  });

  it("不同运行互不影响（各自发一封）", async () => {
    const r = await sendOpsAlertMails(
      [UID],
      [
        { task: "backup.db", runId: 1, error: "a" },
        { task: "backup.db", runId: 10, error: "b" },
      ],
    );
    expect(r.sent).toBe(2);
  });

  it("站点开关关闭：整体跳过，不调用发送", async () => {
    await setOpsSwitch(false);
    const r = await sendOpsAlertMails([UID], FAILURE);
    expect(r).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("站点开关默认开（无配置行时也发）", async () => {
    const r = await sendOpsAlertMails([UID], FAILURE);
    expect(r.sent).toBe(1);
  });

  it("发送失败计入 failed，且不写成功记录（下轮仍会重试）", async () => {
    sendMock.mockReset().mockResolvedValue(false);
    const r = await sendOpsAlertMails([UID], FAILURE);
    expect(r).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(await opsAlertMailSent(UID, 7001)).toBe(false);
  });

  it("空管理员 / 空失败清单：直接返回全零，不查开关也不发信", async () => {
    expect(await sendOpsAlertMails([], FAILURE)).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(await sendOpsAlertMails([UID], [])).toEqual({ sent: 0, skipped: 0, failed: 0 });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("失败原因超长被截断到 200 字（与站内通知同口径）", async () => {
    const long = "x".repeat(500);
    await sendOpsAlertMails([UID], [{ task: "backup.db", runId: 7003, error: long }]);
    const ctx = sendMock.mock.calls[0]![1] as (c: unknown) => { html: string };
    const msg = ctx({ email: "ops-alert@example.com", brand: BRAND });
    expect(msg.html).not.toContain("x".repeat(201));
  });
});
