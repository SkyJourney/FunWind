"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AdminError } from "@/lib/authz/admin";
import { defineAction } from "@/lib/actions/define-action";
import { setSettings } from "@/lib/auth/settings";
import { adjustPointsByAdmin } from "@/lib/points/adjust";
import { findUserIdByName } from "@/lib/queries/users";
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

/** 业务错误统一转成可读提示并跳回（与 admin/badges 同法）；其余异常照常抛出 */
function toAdminErrorBack(e: unknown): never {
  if (e instanceof AdminError) redirect(`${BACK}?error=${encodeURIComponent(e.message)}`);
  if (
    e instanceof InvalidDeltaError ||
    e instanceof InsufficientPointsError ||
    e instanceof PointsOverflowError
  ) {
    redirect(`${BACK}?error=${encodeURIComponent(e.message)}`);
  }
  throw e as never;
}

/** 数值输入：空串按缺失处理（zod 缺字段 → defineAction 404），不得 coerce 成 0 静默关闭奖励 */
const amount = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.coerce.number().int().min(0).max(1_000_000),
);

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
      await setSettings(
        [
          { key: "points.name", value: { name: input.name } },
          {
            key: "points.reward",
            value: {
              post: input.post,
              reply: input.reply,
              postDailyCap: input.postDailyCap,
              replyDailyCap: input.replyDailyCap,
            },
          },
        ],
        { userId: ctx.admin!.userId, via: "admin", ip: ctx.admin!.ip },
      );
    } catch (e) {
      toAdminErrorBack(e);
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
      toAdminErrorBack(e);
    }
    revalidatePath("/admin/points");
    redirect(`${BACK}?adjusted=1`);
  },
});
