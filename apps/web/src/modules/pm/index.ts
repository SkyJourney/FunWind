import { desc, eq } from "drizzle-orm";
import { defineModule } from "../kernel/types";
import { notify } from "@/lib/notifications/notify";
import {
  pmEmailAllowed,
  sendUserEmail,
  userActiveRecently,
  userEmailEnabled,
} from "@/lib/notifications/email";
import { pmReceivedMail } from "@/lib/auth/mailer";
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

      // S4（docs/EMAIL-SCENARIOS.md）：偏好 + 会话频控 + 未活跃三关全过才发
      if (
        (await userEmailEnabled(p.recipientId, "pm.received")) &&
        (await pmEmailAllowed(p.recipientId, p.conversationId)) &&
        !(await userActiveRecently(p.recipientId))
      ) {
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
        await sendUserEmail(p.recipientId, ({ siteName, siteUrl }) =>
          pmReceivedMail(
            {
              senderName: sender?.username ?? "用户",
              preview: latest?.body ?? "",
              conversationId: p.conversationId,
              siteUrl,
            },
            siteName,
          ),
        );
      }
    },
  },
});
