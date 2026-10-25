"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { checkin } from "@/lib/checkin/service";

/**
 * 每日签到 Server Action（M7）。成功与「已签过」都回到首页并刷新签到条：
 * 已签过由 checkins 联合主键兜底（并发双击第二笔回滚），无需向用户展示错误文案。
 * 注意：本文件被签到模块的槽位渲染器**渲染期动态 import**（modules/checkin/index.tsx）——
 * 静态 import 会构成「模块 → defineAction → "@/modules"」的模块求值环（TDZ）。
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
