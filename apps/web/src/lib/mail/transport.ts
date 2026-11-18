import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { sql } from "drizzle-orm";
import { emailLog, getWebDb } from "@funwind/db";
import { DeliveryTransportError } from "@/lib/net/delivery-error";
import type { MailMessage } from "./types";

/**
 * 邮件发送（SMTP_URL 驱动，dev = Mailpit smtp://127.0.0.1:1025）+ 发送记录。
 *
 * 每次发送成败都写一行 email_log（邮件通道的审计日志，后台 /admin/mail 可查）；
 * 记录只含收件人 / 主题 / 场景 / 结果，不含正文。记录落库失败只打日志，绝不反噬发送。
 *
 * 两个入口：
 *  · sendMail    失败时先记 failed 再抛出——调用方自行决定是否阻断主流程（验证邮件需让用户知道没发出去）
 *  · trySendMail 尽力而为，失败返回 false——通知镜像类邮件用它
 */

const FROM = process.env.MAIL_FROM ?? "青翼字幕组 <noreply@qingyisub.top>";
/** 发送记录保留天数；超期行由发送侧概率触发清理 */
const RETENTION_DAYS = 90;
const SWEEP_PROBABILITY = 0.01;

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (!transporter) {
    const url = new URL(process.env.SMTP_URL ?? "smtp://127.0.0.1:1025");
    // SDK 的协议调试日志会带地址、应答甚至正文，不允许连接串打开。
    for (const option of ["logger", "debug", "transactionLog"]) {
      url.searchParams.set(option, "false");
    }
    transporter = nodemailer.createTransport(url.href);
  }
  return transporter;
}

export interface SendMeta {
  /** 收件用户 id（能解析到时传入，后台可按用户追查） */
  userId?: number | null;
}

export async function sendMail(
  to: string,
  message: MailMessage,
  meta: SendMeta = {},
): Promise<void> {
  const started = Date.now();
  const base = {
    kind: message.kind,
    scene: message.scene,
    toEmail: to.slice(0, 255),
    userId: meta.userId ?? null,
    subject: message.subject.slice(0, 255),
  };
  let info: { messageId?: unknown } | undefined;
  try {
    info = await getTransporter().sendMail({
      from: FROM,
      to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } catch (cause) {
    const error = classifyFailure(cause);
    await record({
      ...base,
      status: "failed",
      error: error.message,
      durationMs: Date.now() - started,
    });
    console.error(`[mail] ${error.message}`);
    throw error;
  }
  await record({
    ...base,
    status: "sent",
    messageId: typeof info?.messageId === "string" ? info.messageId.slice(0, 255) : null,
    durationMs: Date.now() - started,
  });
}

/** 只认 SDK 提供的 SMTP 否定应答码；连接关闭期间的应答不能作为投递事务的结论。 */
function classifyFailure(cause: unknown): DeliveryTransportError {
  if (cause instanceof Error) {
    const responseCode: unknown = Object.getOwnPropertyDescriptor(cause, "responseCode")?.value;
    const code: unknown = Object.getOwnPropertyDescriptor(cause, "code")?.value;
    if (
      code !== "ECONNECTION" &&
      code !== "ETIMEDOUT" &&
      code !== "ECONNRESET" &&
      code !== "ESOCKET" &&
      typeof responseCode === "number" &&
      Number.isInteger(responseCode) &&
      responseCode >= 400 &&
      responseCode < 600
    ) {
      return new DeliveryTransportError("smtpRejected");
    }
  }
  return new DeliveryTransportError("smtpUncertain");
}

export async function trySendMail(
  to: string,
  message: MailMessage,
  meta: SendMeta = {},
): Promise<boolean> {
  try {
    await sendMail(to, message, meta);
    return true;
  } catch {
    return false;
  }
}

type EmailLogInsert = Omit<typeof emailLog.$inferInsert, "createdAt" | "id">;

async function record(row: EmailLogInsert): Promise<void> {
  try {
    await getWebDb()
      .insert(emailLog)
      .values({ ...row, createdAt: sql`NOW()` });
    if (Math.random() < SWEEP_PROBABILITY) await sweepExpired();
  } catch {
    console.error("[mail] 写入发送记录或清理历史记录失败");
  }
}

/** 清理超过保留期的记录；小批量 LIMIT 避免长事务 */
async function sweepExpired(): Promise<void> {
  await getWebDb().execute(
    sql`DELETE FROM email_log WHERE created_at < NOW() - INTERVAL ${sql.raw(String(RETENTION_DAYS))} DAY LIMIT 1000`,
  );
}
