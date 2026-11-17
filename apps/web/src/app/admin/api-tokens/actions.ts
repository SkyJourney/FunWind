"use server";

import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { appendQueryParam } from "@/lib/admin/query";
import {
  ADMIN_API_TOKEN_DEFAULT_DAYS,
  createAdminApiToken,
  isEffectiveSiteAdminOf,
  revokeAdminApiToken,
  stashPlainForOnce,
} from "@/lib/manage/tokens";

/**
 * API 令牌页的入口（M20）：defineAction 薄壳——鉴权/频控/校验声明在此，
 * 全部业务语义（上限、审计、明文哈希）在 lib/manage/tokens.ts Service。
 * 明文一次性展示：签发后暂存（stashPlainForOnce），redirect 带 `?created=<id>`，
 * 页面取走即删——明文不进 URL/cookie/日志。
 */

const BASE = "/admin/api-tokens";

/** 页面与 API 共同的「有效站点管理员」资格口径（判定在 Service，入口零 db 直连） */
async function ensureSiteAdminInvariant(userId: number): Promise<void> {
  if (!(await isEffectiveSiteAdminOf(userId))) notFound();
}

export const createApiTokenAction = defineAction({
  name: "api_token.create",
  auth: { admin: "site.admin" },
  input: z.object({
    name: z.string().min(1).max(64),
    days: z.coerce.number().int().optional(),
  }),
  rateLimit: [
    {
      key: (ctx) => `api-token-issue:user:${ctx.userId}`,
      max: 10,
      windowMs: 60_000,
      onLimit: () => redirect(appendQueryParam(BASE, "err", "rate-limited")),
    },
  ],
  run: async (ctx, input) => {
    await ensureSiteAdminInvariant(ctx.userId);
    let created;
    try {
      created = await createAdminApiToken({
        userId: ctx.userId,
        name: input.name,
        days: input.days ?? ADMIN_API_TOKEN_DEFAULT_DAYS,
        actor: ctx.actor,
        ip: ctx.ip,
      });
    } catch (error) {
      // AdminError = 业务规则文案（上限/名称/档位），M19 err 裸文案形态直达页面；
      // redirect 不在 try 内（NEXT_REDIRECT 控制流不经本 catch）
      if (error instanceof Error && error.name === "AdminError") {
        redirect(appendQueryParam(BASE, "err", error.message));
      }
      throw error;
    }
    stashPlainForOnce(created.id, created.plain, ctx.userId);
    redirect(appendQueryParam(BASE, "created", created.id));
  },
});

export const revokeApiTokenAction = defineAction({
  name: "api_token.revoke",
  auth: { admin: "site.admin" },
  input: z.object({ tokenId: z.string().length(64) }),
  run: async (ctx, input) => {
    await ensureSiteAdminInvariant(ctx.userId);
    const revoked = await revokeAdminApiToken({
      tokenId: input.tokenId,
      userId: ctx.userId,
      actor: ctx.actor,
      ip: ctx.ip,
    });
    redirect(
      appendQueryParam(BASE, revoked ? "ok" : "err", revoked ? "revoked" : "already-revoked"),
    );
  },
});
