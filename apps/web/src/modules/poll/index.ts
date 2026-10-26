import { defineModule } from "../kernel/types";

/**
 * 投票模块（M10）：投票交互在 lib/poll/service（vote 动作经事务性 outbox 派发 poll.voted）。
 * 本模块只做注册与语义声明（无事件消费者——投票不发打扰通知，见 M10 设计定调 5）。
 */
export const pollModule = defineModule({
  id: "poll",
  description:
    "投票：kind=poll 主题的投票块（投票/改票/截止/结果可见性），poll.voted 事件经 outbox 审计。",
});
