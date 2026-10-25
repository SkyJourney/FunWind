import { defineModule } from "../kernel/types";
import { awardForThreadCreated, awardForThreadReplied } from "@/lib/points/earn";

/**
 * 积分模块（M7，docs/POINTS.md）：第一个真实的生产-消费闭环。
 * 声明渠道 `earn.post` / `earn.reply`（含日上限）与 `adjust.admin`；消费发帖/回帖事件自动发放
 * （事件经 outbox 可靠派发，发放幂等键 thread:{id} / reply:{postId}）。业务实现全部在 lib/points/。
 */
export const pointsModule = defineModule({
  id: "points",
  description:
    "积分模块：发帖/回帖自动发放（earn.post / earn.reply，日上限按北京自然日）、管理员手工调整（adjust.admin，强制备注+审计）。",
  pointChannels: [
    { key: "earn.post", direction: "earn", label: "发帖奖励", dailyCap: true },
    { key: "earn.reply", direction: "earn", label: "回帖奖励", dailyCap: true },
    { key: "adjust.admin", direction: "adjust", label: "管理员调整" },
  ],
  events: {
    "thread.created": async (p) => {
      await awardForThreadCreated(p);
    },
    "thread.replied": async (p) => {
      await awardForThreadReplied(p);
    },
  },
  routePrefix: "points",
});
