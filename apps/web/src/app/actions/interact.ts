"use server";

import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { defineAction, type RateLimitPolicy } from "@/lib/actions/define-action";
import { toggleLike } from "@/lib/interact/reactions";
import { toggleFollow } from "@/lib/interact/follows";

/** 互动动作共用每用户每分钟 30 次的限额；超限回到安全站内路径并交给 QueryToast 提示。 */

/** 拒绝外站、反斜杠与控制字符；URL 规范化后再复核路径，避免点段变出协议相对地址。 */
const safeBack = (raw: unknown): string => {
  if (
    typeof raw !== "string" ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\") ||
    [...raw].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f)
  ) {
    return "/";
  }
  const url = new URL(raw, "http://localhost");
  if (url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
};

const backInput = z.unknown().optional().transform(safeBack);

const rateLimitBack = (back: string): string => {
  const url = new URL(back, "http://localhost");
  url.searchParams.set("notice", "interact-rate");
  return `${url.pathname}${url.search}${url.hash}`;
};

const interactRateLimit: RateLimitPolicy<{ back: string }>[] = [
  {
    key: (ctx) => `interact:${ctx.userId}`,
    max: 30,
    windowMs: 60_000,
    onLimit: (_ctx, input) => redirect(rateLimitBack(input.back)),
  },
];

const likeInput = z.object({ postId: z.coerce.number().int().positive(), back: backInput });
export const likeAction = defineAction({
  name: "interact.like",
  auth: "user",
  input: likeInput,
  rateLimit: interactRateLimit,
  async run(ctx, input) {
    const r = await toggleLike(ctx.userId!, input.postId);
    if (!r.ok) notFound();
    revalidatePath(new URL(input.back, "http://localhost").pathname);
  },
});

const followInput = z.object({
  targetType: z.enum(["user", "forum"]),
  targetId: z.coerce.number().int().positive(),
  back: backInput,
});
export const followAction = defineAction({
  name: "interact.follow",
  auth: "user",
  input: followInput,
  rateLimit: interactRateLimit,
  async run(ctx, input) {
    const r = await toggleFollow(ctx.userId!, input.targetType, input.targetId);
    if (!r.ok) notFound();
    revalidatePath(new URL(input.back, "http://localhost").pathname);
  },
});
