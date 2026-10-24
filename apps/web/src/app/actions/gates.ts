"use server";

// 使用内核的 Server Action 须自行求值模块注册表（硬约定 9）：事件消费者与积分渠道声明都依赖它
import "@/modules";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { rateLimit } from "@/lib/auth/ratelimit";
import { getCurrentSubject } from "@/lib/authz/subject";
import { locateGate, type GateLocation } from "@/lib/gates/service";
import { unlockGate } from "@/lib/gates/unlock";
import { pageOfFloor } from "@/lib/queries/posts";

/**
 * 门控购买 Server Action。购买后重定向回原帖原页并带锚点；失败时只带固定的提示码（?gate=insufficient 等），
 * 重定向地址完全由服务端按「门控 → 帖子 → 主题 → 页码」算出，不接受表单传来的返回地址（无开放重定向），
 * URL 里也不带任何用户可控文本。
 */

/** 返回地址：回帖按楼层算页码；首帖在每一页都显示，沿用表单带来的当前页（只接受 1–100000 的整数） */
function backUrl(t: GateLocation, formPage: number, notice?: string): string {
  const page = t.floor > 1 ? pageOfFloor(t.floor) : formPage;
  const q = new URLSearchParams();
  if (page > 1) q.set("page", String(page));
  if (notice) q.set("gate", notice);
  const qs = q.toString();
  return `/t/${t.threadId}${qs ? `?${qs}` : ""}#p${t.postId}`;
}

/** 买家确认的价格：非负整数且不超过门控语法允许的上限（9999999）；缺失 / 畸形一律视为「价格不符」 */
function parseExpectedPrice(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string" || !/^\d{1,7}$/.test(raw)) return null;
  return Number(raw);
}

export async function unlockGateAction(formData: FormData): Promise<void> {
  const gateId = Number(formData.get("gateId"));
  if (!Number.isInteger(gateId) || gateId <= 0) notFound();
  const pageRaw = Number(formData.get("page"));
  const formPage = Number.isInteger(pageRaw) && pageRaw >= 1 && pageRaw <= 100_000 ? pageRaw : 1;

  const viewer = await getCurrentSubject();
  if (viewer.userId === null) redirect("/login");

  // 操作级频控（按账号）：购买本身有幂等保护，这里只防脚本狂点
  if (!rateLimit(`unlock:${viewer.userId}`, 30, 60_000).allowed) {
    const t = await locateGate(viewer, gateId);
    if (!t) notFound();
    redirect(backUrl(t, formPage, "rate"));
  }

  // 没带价格的请求（旧页面缓存 / 手工构造）不能按「当前价」扣款，回到原帖让买家重新确认
  const expectedPrice = parseExpectedPrice(formData.get("expectedPrice"));
  if (expectedPrice === null) {
    const t = await locateGate(viewer, gateId);
    if (!t) notFound();
    redirect(backUrl(t, formPage, "price_changed"));
  }

  const r = await unlockGate(viewer, gateId, { expectedPrice });
  if (!r.ok) {
    if (r.code === "login") redirect("/login");
    if (r.code === "not_found" || !r.target) notFound();
    redirect(backUrl(r.target, formPage, r.code));
  }
  revalidatePath(`/t/${r.target.threadId}`);
  redirect(backUrl(r.target, formPage));
}
