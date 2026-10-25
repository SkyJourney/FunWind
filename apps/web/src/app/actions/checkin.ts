"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCurrentSubject } from "@/lib/authz/subject";
import { checkin } from "@/lib/checkin/service";
// 模块注册表求值（内核硬约定 9）。不经过 defineAction：签到条由签到模块的槽位渲染，
// 模块 → 本动作 → defineAction → "@/modules" 会构成模块求值环（defineAction 在环上是 TDZ），
// 因此这里手写等价管线：鉴权（user）→ 业务 → revalidate。
import "@/modules";

/** 每日签到。已签过由 checkins 联合主键兜底（并发第二笔回滚），成功/已签都刷新首页签到条 */
export async function checkinAction(): Promise<void> {
  const subject = await getCurrentSubject();
  if (subject.userId === null) redirect("/login");
  await checkin(subject.userId);
  revalidatePath("/");
}
