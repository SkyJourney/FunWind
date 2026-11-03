// @vitest-environment node
import "@/modules";
import { and, eq } from "drizzle-orm";
import { DEMO, eventLog, eventOutbox, getWebDb, messages, notifications } from "@funwind/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadSubject } from "@/lib/authz/subject";
import * as email from "@/lib/notifications/email";
import { sendMessage } from "@/lib/pm/service";
import { setupTempDb, skipDb, type TempDb } from "@/test/temp-db";

/** 邮件附带故障不能把已提交的站内私信通知作为失败事件重放；不宣称覆盖所有 outbox 重放窗口。 */
describe.skipIf(skipDb)("私信站内通知与邮件故障隔离", () => {
  let tdb: TempDb;
  beforeAll(async () => {
    tdb = await setupTempDb();
  });
  afterAll(async () => {
    await tdb?.teardown();
  });

  it.each(["preference", "activity", "send"] as const)(
    "%s 故障时消息与站内计数只新增一次，事件已完成且留下邮件告警",
    async (stage) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(email, "userEmailEnabled").mockResolvedValue(true);
      vi.spyOn(email, "pmEmailAllowed").mockResolvedValue(true);
      vi.spyOn(email, "userActiveRecently").mockResolvedValue(false);
      vi.spyOn(email, "sendUserEmail").mockResolvedValue(true);
      const failure = new Error(`邮件附带 ${stage} 故障`);
      if (stage === "preference") vi.mocked(email.userEmailEnabled).mockRejectedValueOnce(failure);
      if (stage === "activity") vi.mocked(email.userActiveRecently).mockRejectedValueOnce(failure);
      if (stage === "send") vi.mocked(email.sendUserEmail).mockRejectedValueOnce(failure);
      try {
        const db = getWebDb();
        const before = await db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, DEMO.team), eq(notifications.type, "pm.received")));
        const countBefore = (before.at(-1)?.data as { count?: number } | null)?.count ?? 0;
        const body = `邮件故障隔离 ${stage}`;
        const result = await sendMessage(await loadSubject(DEMO.alice), DEMO.team, body);
        expect(result.ok).toBe(true);
        const stored = await db.select().from(messages).where(eq(messages.body, body));
        expect(stored).toHaveLength(1);
        const notices = await db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, DEMO.team), eq(notifications.type, "pm.received")));
        expect((notices.at(-1)!.data as { count: number }).count).toBe(countBefore + 1);
        const outboxRows = await db
          .select()
          .from(eventOutbox)
          .where(eq(eventOutbox.eventName, "message.sent"));
        const current = outboxRows.filter(
          (row) => (row.payload as { messageId: number }).messageId === stored[0].id,
        );
        expect(current).toHaveLength(1);
        expect(current[0].dispatchedAt).not.toBeNull();
        const logs = await db.select().from(eventLog).where(eq(eventLog.eventName, "message.sent"));
        const currentLogs = logs.filter(
          (row) => (row.payload as { messageId: number }).messageId === stored[0].id,
        );
        expect(currentLogs).toHaveLength(1);
        expect(currentLogs[0].errorJson).toBeNull();
        expect(error).toHaveBeenCalledWith(
          "[pm] 私信已通知站内收件箱，但邮件附带渠道失败:",
          expect.objectContaining({ messageId: stored[0].id, recipientId: DEMO.team }),
          failure,
        );
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});
