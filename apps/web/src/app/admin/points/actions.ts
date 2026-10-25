"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AdminError } from "@/lib/authz/admin";
import { defineAction } from "@/lib/actions/define-action";
import { setSetting } from "@/lib/auth/settings";
import { adjustPointsByAdmin } from "@/lib/points/adjust";
import { findUserIdByName } from "@/lib/points/ledger";
import {
  InsufficientPointsError,
  InvalidDeltaError,
  PointsOverflowError,
} from "@/lib/points/errors";

/**
 * 积分管理 Server Actions（M7，`admin.points` 权限点）：规则配置（site_settings，setSetting 自带审计）
 * 与手工调整（强制备注，台账与 audit_log 同事务）。
 */

const BACK = "/admin/points";

/** 业务校验错误统一转成可展示的 AdminError 跳回 */
function toAdminError(e: unknown): never {
  if (e instanceof AdminError) throw e;
  if (
    e instanceof InvalidDeltaError ||
    e instanceof InsufficientPointsError ||
    e instanceof PointsOverflowError
  ) {
    throw new AdminError(e.message);
  }
  throw e as never;
}

const amount = z.coerce.number().int().min(0).max(1_000_000);

const saveRewardInput = z.object({
  name: z.string().trim().min(1, "显示名不能为空").max(32),
  post: amount,
  reply: amount,
  postDailyCap: amount,
  replyDailyCap: amount,
});

export const saveRewardAction = defineAction({
  name: "admin.points.save_reward",
  auth: { admin: "admin.points" },
  input: saveRewardInput,
  async run(ctx, input) {
    try {
      await setSetting(
        "points.name",
        { name: input.name },
        { userId: ctx.admin!.userId, via: "admin", ip: ctx.admin!.ip },
      );
      await setSetting(
        "points.reward",
        {
          post: input.post,
          reply: input.reply,
          postDailyCap: input.postDailyCap,
          replyDailyCap: input.replyDailyCap,
        },
        { userId: ctx.admin!.userId, via: "admin", ip: ctx.admin!.ip },
      );
    } catch (e) {
      toAdminError(e);
    }
    revalidatePath("/admin/points");
    revalidatePath("/points");
    redirect(`${BACK}?saved=1`);
  },
});

const adjustInput = z.object({
  username: z.string().trim().min(1).max(64),
  delta: z.coerce
    .number()
    .int()
    .refine((v) => v !== 0, "调整额度必须是非零整数")
    .transform((v) => Math.trunc(v)),
  note: z.string().trim().min(1, "必须填写调整备注").max(200),
});

export const adjustPointsAction = defineAction({
  name: "admin.points.adjust",
  auth: { admin: "admin.points" },
  input: adjustInput,
  async run(ctx, input) {
    try {
      const userId = await findUserIdByName(input.username);
      if (userId === null) throw new AdminError(`用户不存在或已注销：${input.username}`);
      await adjustPointsByAdmin(
        { userId: ctx.admin!.userId, via: "admin", ip: ctx.admin!.ip },
        { userId, delta: input.delta, note: input.note },
      );
    } catch (e) {
      toAdminError(e);
    }
    revalidatePath("/admin/points");
    redirect(`${BACK}?adjusted=1`);
  },
});
