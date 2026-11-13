import { desc, eq } from "drizzle-orm";
import { defineModule } from "../kernel/types";
import { notify } from "@/lib/notifications/notify";
import {
  pmEmailAllowed,
  sendUserEmail,
  userActiveRecently,
  userEmailEnabled,
} from "@/lib/notifications/email";
import { pmReceivedMail } from "@/lib/mail";
import { trySendUserPush } from "@/lib/push";
import { getWebDb, messages, users } from "@funwind/db";

/**
 * 私信模块（M10）：消费 message.sent（发送事务内经 outbox 登记）→ 通知中心写 pm.received 指针。
 * 聚合键 conv:{id}:pm（data.count = 未读条数）；打开会话联动已读在 lib/pm/service.openConversation。
 * 系统消息不走私信——统一走通知中心（类型目录已注册）。
 * S4 邮件（M10.6 收尾切片）：收件人开了 pm.received 邮件偏好 → 频控（每会话每小时 1 封）且
 * 30 分钟未活跃才发（活跃用户看铃铛即可）。
 */
export const pmModule = defineModule({
  id: "pm",
  description:
    "私信：会话模型（conversations/members/messages）、pm.received 通知指针聚合、打开会话联动已读。",
  events: {
    "message.sent": async (p) => {
      await notify({
        type: "pm.received",
        recipients: [p.recipientId],
        actorId: p.senderId,
        targetType: "conversation",
        targetId: p.conversationId,
        groupKey: `conv:${p.conversationId}:pm`,
        data: { conversationId: p.conversationId },
      });

      // 附带渠道共享快照（邮件 + 推送，M18）：查询失败降级为默认值，不阻断渠道、不重放站内通知事件。
      let senderName = "用户";
      let preview = "";
      try {
        const [sender] = await getWebDb()
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, p.senderId))
          .limit(1);
        const [latest] = await getWebDb()
          .select({ body: messages.body })
          .from(messages)
          .where(eq(messages.conversationId, p.conversationId))
          .orderBy(desc(messages.id))
          .limit(1);
        senderName = sender?.username ?? "用户";
        preview = latest?.body ?? "";
      } catch {
        // 快照查询失败：用默认值，渠道仍尝试发送
      }

      // 邮件是站内通知的附带渠道；它的偏好/活跃查询故障不能让已提交的站内通知事件重放。
      try {
        // S4（docs/EMAIL-SCENARIOS.md）：偏好 + 会话频控 + 未活跃三关全过才发
        if (
          (await userEmailEnabled(p.recipientId, "pm.received")) &&
          (await pmEmailAllowed(p.recipientId, p.conversationId)) &&
          !(await userActiveRecently(p.recipientId))
        ) {
          await sendUserEmail(p.recipientId, ({ brand }) =>
            pmReceivedMail({ senderName, preview, conversationId: p.conversationId }, brand),
          );
        }
      } catch (error) {
        console.error(
          "[pm] 私信已通知站内收件箱，但邮件附带渠道失败:",
          {
            conversationId: p.conversationId,
            messageId: p.messageId,
            recipientId: p.recipientId,
          },
          error,
        );
      }

      // 推送附带渠道（M18 Step 6）：独立于邮件，trySendUserPush 内部三关 + try/catch 永不抛出。
      await trySendUserPush(
        p.recipientId,
        "pm.received",
        () => ({
          kind: "notice",
          scene: "pm-received",
          title: "新私信",
          body: `${senderName}：${preview.replace(/\s+/g, " ").slice(0, 80)}`,
          url: `/messages?conv=${p.conversationId}`,
        }),
        p.conversationId,
      );
    },
  },
});
