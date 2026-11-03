"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { checkin } from "@/lib/checkin/service";

/**
 * 每日签到 Server Action（M7）。成功与「已签过」都回到首页并刷新签到条：
 * 已签过由 checkins 联合主键兜底（并发双击第二笔回滚），无需向用户展示错误文案。
 * 首页与设计页宿主经 SlotContext 显式注入本 Action；签到模块只消费依赖，不引用 app 层，
 * 避免「模块 → defineAction → 模块注册表」的求值环，并让缺少 Action 的槽位安全降级。
 */
export const checkinAction = defineAction({
  name: "checkin.do",
  auth: "user",
  input: z.object({}),
  async run(ctx) {
    await checkin(ctx.userId!);
    revalidatePath("/");
  },
});
