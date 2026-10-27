"use server";

import { defineAction } from "@/lib/actions/define-action";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setSetting } from "@/lib/auth/settings";
import { getLimitsConfig } from "@/lib/limits/load";
import { limitsConfigSchema } from "@/lib/limits/config";
import { invalidateSiteChrome } from "@/lib/site-chrome";

/**
 * 站点配置动作（M10.6b，docs/milestones/M10.6-feature-completion.md 批次 b）：
 * 身份/注册模式/频控三组。写入全走 setSetting（自带前后值审计）；身份保存失效 chrome 缓存。
 * 频控编辑器只 merge 它认识的字段（member/admin 两角色 + 站点级两项），其余角色原值保留，
 * 保存前整体过 limitsConfigSchema 校验——写坏配置会整体回落默认值（load.ts 口径），必须在这里拦住。
 */

const done = (key: string): never => redirect(`/admin/settings?saved=${key}`);

export const saveIdentityAction = defineAction({
  name: "admin.settings.identity",
  auth: { admin: "site.admin" },
  input: z.object({
    name: z.string().trim().min(1, "站点名不能为空").max(40),
    tagline: z.string().trim().max(80).default(""),
  }),
  async run(ctx, input) {
    await setSetting(
      "site.identity",
      { name: input.name, tagline: input.tagline },
      {
        userId: ctx.userId ?? null,
        via: "admin",
        ip: ctx.ip,
      },
    );
    invalidateSiteChrome();
    revalidatePath("/", "layout");
    done("identity");
  },
});

export const saveRegisterModeAction = defineAction({
  name: "admin.settings.register",
  auth: { admin: "site.admin" },
  input: z.object({ mode: z.enum(["invite", "open"]) }),
  async run(ctx, input) {
    await setSetting(
      "register.mode",
      { mode: input.mode },
      {
        userId: ctx.userId ?? null,
        via: "admin",
        ip: ctx.ip,
      },
    );
    revalidatePath("/admin/settings");
    revalidatePath("/register");
    done("register");
  },
});

const nonNeg = (max: number) => z.coerce.number().int().min(0).max(max);

export const saveLimitsAction = defineAction({
  name: "admin.settings.limits",
  auth: { admin: "site.admin" },
  input: z.object({
    titleMax: z.coerce.number().int().min(1).max(255),
    bodyMax: z.coerce.number().int().min(1).max(1_000_000),
    // 只暴露 member / admin 两个内置角色（DEFAULT_LIMITS 的角色集）；其他角色由 merge 保留
    memberPostIntervalSec: nonNeg(3600),
    memberThreadsPerDay: nonNeg(100_000),
    memberUploadsPerDay: nonNeg(100_000),
    memberPmPerDay: nonNeg(100_000),
    memberEditWindowSec: nonNeg(31_536_000),
    adminPostIntervalSec: nonNeg(3600),
    adminThreadsPerDay: nonNeg(100_000),
    adminUploadsPerDay: nonNeg(100_000),
    adminPmPerDay: nonNeg(100_000),
    adminEditWindowSec: nonNeg(31_536_000),
  }),
  async run(ctx, input) {
    const current = await getLimitsConfig();
    const merged = limitsConfigSchema.safeParse({
      titleMax: input.titleMax,
      bodyMax: input.bodyMax,
      roles: {
        ...current.roles,
        member: {
          postIntervalSec: input.memberPostIntervalSec,
          threadsPerDay: input.memberThreadsPerDay,
          uploadsPerDay: input.memberUploadsPerDay,
          pmPerDay: input.memberPmPerDay,
          editWindowSec: input.memberEditWindowSec,
        },
        admin: {
          postIntervalSec: input.adminPostIntervalSec,
          threadsPerDay: input.adminThreadsPerDay,
          uploadsPerDay: input.adminUploadsPerDay,
          pmPerDay: input.adminPmPerDay,
          editWindowSec: input.adminEditWindowSec,
        },
      },
    });
    if (!merged.success) redirect("/admin/settings?err=limits");
    await setSetting("limits", merged.data, {
      userId: ctx.userId ?? null,
      via: "admin",
      ip: ctx.ip,
    });
    revalidatePath("/admin/settings");
    done("limits");
  },
});
