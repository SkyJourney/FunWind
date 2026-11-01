import { expect } from "@playwright/test";

/**
 * Mailpit 测试助手（M11.1）：邮件到达断言一律用「ID 快照差集」而非宿主机时钟时间窗。
 * 背景：Mailpit 跑在 Docker VM 里，容器时钟与宿主机会漂移（实测 9 天 uptime 漂 ~39 秒），
 * `Date.parse(Created) >= Date.now()-1s` 这类跨时钟过滤会把新邮件判成旧邮件（S1 用例曾因此恒假）。
 * Mailpit 的 ID 随插入单调生成，快照差集与任何时钟偏移无关。
 */

export interface MailSummary {
  ID: string;
  Created: string;
  To: { Address: string }[];
  Subject: string;
}

const MAIL_API = "http://127.0.0.1:8025/api/v1";

const matches = (mail: MailSummary, email: string, subjectPart: string): boolean =>
  mail.To.some((to) => to.Address === email) && mail.Subject.includes(subjectPart);

/** 快照当前匹配（收件人+主题）的邮件 ID 集合；动作前调用。 */
export async function snapshotMailIds(email: string, subjectPart: string): Promise<Set<string>> {
  const res = await fetch(`${MAIL_API}/messages?limit=50`);
  const data = (await res.json()) as { messages?: MailSummary[] };
  return new Set(
    (data.messages ?? [])
      .filter((mail) => matches(mail, email, subjectPart))
      .map((mail) => mail.ID),
  );
}

/** 轮询等待一封不在快照里的新邮件；超时抛错。 */
export async function waitForNewMail(
  email: string,
  subjectPart: string,
  knownIds: ReadonlySet<string>,
  timeoutMs = 30_000,
): Promise<MailSummary> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${MAIL_API}/messages?limit=50`);
    const data = (await res.json()) as { messages?: MailSummary[] };
    const mail = (data.messages ?? []).find(
      (m) => matches(m, email, subjectPart) && !knownIds.has(m.ID),
    );
    if (mail) return mail;
    if (Date.now() > deadline) {
      throw new Error(`未等到新邮件: ${email} / ${subjectPart}（${timeoutMs}ms）`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 断言动作后一段时间内没有新邮件（如后台关闭通知后的停发验证）。 */
export async function expectNoNewMail(
  email: string,
  subjectPart: string,
  knownIds: ReadonlySet<string>,
  holdMs = 1_500,
): Promise<void> {
  await new Promise((r) => setTimeout(r, holdMs));
  const res = await fetch(`${MAIL_API}/messages?limit=50`);
  const data = (await res.json()) as { messages?: MailSummary[] };
  const leaked = (data.messages ?? []).filter(
    (m) => matches(m, email, subjectPart) && !knownIds.has(m.ID),
  );
  expect(leaked).toEqual([]);
}
