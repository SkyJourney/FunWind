import { defineModule } from "../kernel/types";
import { notify } from "@/lib/notifications/notify";

/**
 * 私信模块（M10）：消费 message.sent（发送事务内经 outbox 登记）→ 通知中心写 pm.received 指针。
 * 聚合键 conv:{id}:pm（data.count = 未读条数）；打开会话联动已读在 lib/pm/service.openConversation。
 * 系统消息不走私信——统一走通知中心（类型目录已注册）。
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
    },
  },
});
