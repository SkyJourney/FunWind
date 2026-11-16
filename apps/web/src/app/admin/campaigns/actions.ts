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
import { updateOpsTask } from "@/lib/ops/tasks";

/**
 * 运营排期 Server Actions（M11.2，site.admin）。
 * 失败时把提交内容编码进 draft 参数带回表单（G-19：保存失败不清空工作成果），
 * 错误码与页面 ERR_TEXT 成对（G-15）。写操作与审计同事务，见 lib/campaigns/admin。
 * 节日装扮规则（M14 引入）于 M19 Q4 自运维页归位本域：写 campaign.holiday 任务的 params。
 */

const formFields = {
  name: z.string().max(200).default(""),
  choice: z.string().max(120).default(""),
  startsAt: z.string().max(32).default(""),
  endsAt: z.string().max(32).default(""),
  priority: z.string().max(8).default("0"),
};

type FormInput = {
  name: string;
  choice: string;
  startsAt: string;
  endsAt: string;
  priority: string;
};

/** 表单 → 服务层字段；开始时间留空 = 现在（仅新建），选项无法拆分时交给校验报 bad-effect */
function toFields(input: FormInput, defaultStart: string): CampaignFields {
  const picked = splitChoice(input.choice);
  return {
    name: input.name,
    effect: picked?.effect ?? "",
    target: picked?.target ?? "",
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

// ── 节日装扮规则（M14 Step 4；M19 Q4 自运维页归位排期页） ────────────────

const HOLIDAY_DRAFT_MAX = 2400;

/** 节日规则表单提交失败（G-19）：整份表单编码进 holidayDraft 参数带回，不清空工作成果
 *  （与排期表单的 draft 参数区分，两套草稿互不干扰） */
function holidayFail(query: string, draft: Record<string, unknown>): never {
  redirect(
    `/admin/campaigns?${query}&holidayDraft=${encodeURIComponent(JSON.stringify(draft).slice(0, HOLIDAY_DRAFT_MAX))}`,
  );
}

const holidayFormInput = z.object({
  id: z.coerce.number().int().positive(),
  revision: z.coerce.number().int().nonnegative(),
  calendar: z.enum(["solar", "lunar"]),
  month: z.coerce.number().int().min(1).max(12),
  day: z.coerce.number().int().min(0).max(31),
  beforeDays: z.coerce.number().int().min(0).max(30),
  durationDays: z.coerce.number().int().min(1).max(90),
  /** 固定 3 行的同名多值字段（formDataToObject 归并为数组；单值兼容字符串） */
  itemEffect: z.union([z.array(z.string()), z.string()]).default(""),
  itemTarget: z.union([z.array(z.string()), z.string()]).default(""),
});

function asStringArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** 保存节日装扮规则（写 campaign.holiday 任务的 params，带审计 + 热加载通知）。 */
export const saveHolidayRuleAction = defineAction({
  name: "admin.campaign.holiday_rule",
  auth: { admin: "site.admin" },
  input: holidayFormInput,
  async run(ctx, input) {
    const effects = asStringArray(input.itemEffect);
    const targets = asStringArray(input.itemTarget);
    // 固定 3 行：effect 留空 = 该行不使用；同名下标一一对应
    const items = effects
      .map((effect, index) => ({ effect, target: targets[index] ?? "" }))
      .filter((item) => item.effect !== "");
    const draft: Record<string, unknown> = {
      id: String(input.id),
      revision: String(input.revision),
      calendar: input.calendar,
      month: String(input.month),
      day: String(input.day),
      beforeDays: String(input.beforeDays),
      durationDays: String(input.durationDays),
      effects,
      targets,
    };
    const result = await updateOpsTask(
      input.id,
      input.revision,
      {
        params: {
          calendar: input.calendar,
          month: input.month,
          day: input.day,
          beforeDays: input.beforeDays,
          durationDays: input.durationDays,
          items,
        },
      },
      ctx.actor,
    );
    revalidatePath("/admin/campaigns");
    if (result.ok) redirect("/admin/campaigns?saved=holiday");
    if (result.code === "conflict") {
      // G-19：版本冲突 → 带草稿回表单，不静默换用最新版本
      holidayFail("holidayErr=conflict", draft);
    }
    holidayFail(
      `holidayErr=${encodeURIComponent(result.message ?? "规则保存失败，请重试")}`,
      draft,
    );
  },
});
