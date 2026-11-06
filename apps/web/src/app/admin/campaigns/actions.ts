"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { defineAction } from "@/lib/actions/define-action";
import {
  createCampaign,
  deleteCampaign,
  setCampaignEnabled,
  updateCampaign,
} from "@/lib/campaigns/admin";
import { encodeCampaignDraft, type CampaignDraft } from "@/lib/campaigns/draft";
import { splitChoice, toWallTime, type CampaignFields } from "@/lib/campaigns/input";
import { nowBeijingWallTime } from "@/lib/datetime";

/**
 * 运营排期 Server Actions（M11.2，site.admin）。
 * 失败时把提交内容编码进 draft 参数带回表单（G-19：保存失败不清空工作成果），
 * 错误码与页面 ERR_TEXT 成对（G-15）。写操作与审计同事务，见 lib/campaigns/admin。
 */

const formFields = {
  name: z.string().max(200).default(""),
  /** M11.2 兼容格式：choice = `effect::target` */
  choice: z.string().max(120).default(""),
  /** M11.4+ 新格式：effect 与 fieldValue 分离 */
  effect: z.string().max(32).default(""),
  fieldValue: z.unknown().optional(),
  startsAt: z.string().max(32).default(""),
  endsAt: z.string().max(32).default(""),
  priority: z.string().max(8).default("0"),
};

type FormInput = {
  name: string;
  choice?: string;
  effect?: string;
  fieldValue?: unknown;
  startsAt: string;
  endsAt: string;
  priority: string;
};

/** 表单 → 服务层字段；开始时间留空 = 现在（仅新建）
 * 支持两种格式：
 *  · M11.2 旧格式：choice = `effect::target`
 *  · M11.4+ 新格式：effect + fieldValue 分离
 */
function toFields(input: FormInput, defaultStart: string): CampaignFields {
  let effect = "";
  let target: string | undefined;
  let fieldValue: unknown;

  // 尝试新格式：effect + fieldValue
  if (input.effect) {
    effect = input.effect;
    fieldValue = input.fieldValue;
  } else if (input.choice) {
    // 降级到旧格式：choice = `effect::target`
    const picked = splitChoice(input.choice);
    if (picked) {
      effect = picked.effect;
      target = picked.target;
    }
  }

  // 新格式用 fieldValue，旧格式用 target
  return {
    name: input.name,
    effect,
    ...(target !== undefined ? { target } : {}),
    ...(fieldValue !== undefined ? { fieldValue } : {}),
    startsAt: toWallTime(input.startsAt) || defaultStart,
    endsAt: toWallTime(input.endsAt) || null,
    priority: /^\d{1,5}$/.test(input.priority.trim()) ? Number(input.priority) : -1,
  };
}

/** 失败跳转：错误码 + 草稿（编辑时带 id 与旧 revision，冲突不会被悄悄换成最新值） */
function failTo(code: string, draft: CampaignDraft): never {
  redirect(`/admin/campaigns?err=${encodeURIComponent(code)}&draft=${encodeCampaignDraft(draft)}`);
}

export const createCampaignAction = defineAction({
  name: "admin.campaign.create",
  auth: { admin: "site.admin" },
  input: z.object(formFields),
  async run(ctx, input) {
    const result = await createCampaign(toFields(input, nowBeijingWallTime()), ctx.actor);
    if (!result.ok) failTo(result.code, input);
    revalidatePath("/admin/campaigns");
    redirect("/admin/campaigns?saved=created");
  },
});

/** 编辑：带打开编辑页时读到的 revision；开始时间不允许留空（编辑页已预填原值） */
export const updateCampaignAction = defineAction({
  name: "admin.campaign.update",
  auth: { admin: "site.admin" },
  input: z.object({
    ...formFields,
    id: z.coerce.number().int().min(1),
    revision: z.coerce.number().int().min(1),
  }),
  async run(ctx, input) {
    const result = await updateCampaign(input.id, input.revision, toFields(input, ""), ctx.actor);
    if (!result.ok) failTo(result.code, input);
    revalidatePath("/admin/campaigns");
    redirect("/admin/campaigns?saved=updated");
  },
});

export const toggleCampaignAction = defineAction({
  name: "admin.campaign.toggle",
  auth: { admin: "site.admin" },
  input: z.object({ id: z.coerce.number().int().min(1), enabled: z.enum(["0", "1"]) }),
  async run(ctx, input) {
    const result = await setCampaignEnabled(input.id, input.enabled === "1", ctx.actor);
    if (!result.ok) redirect(`/admin/campaigns?err=${result.code}`);
    revalidatePath("/admin/campaigns");
    redirect("/admin/campaigns?saved=toggled");
  },
});

export const deleteCampaignAction = defineAction({
  name: "admin.campaign.delete",
  auth: { admin: "site.admin" },
  input: z.object({ id: z.coerce.number().int().min(1) }),
  async run(ctx, input) {
    const result = await deleteCampaign(input.id, ctx.actor);
    if (!result.ok) redirect(`/admin/campaigns?err=${result.code}`);
    revalidatePath("/admin/campaigns");
    redirect("/admin/campaigns?saved=deleted");
  },
});
