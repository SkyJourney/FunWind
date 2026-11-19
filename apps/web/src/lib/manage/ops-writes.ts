import "server-only";

import { z } from "zod";
import {
  ANNOUNCEMENTS_DENIAL_HTTP,
  prepareApiAnnouncementCreate,
  prepareApiAnnouncementEdit,
  prepareApiAnnouncementEnd,
  type AnnouncementFields,
} from "@/lib/announcements/service";
import {
  CAMPAIGNS_DENIAL_HTTP,
  prepareApiCampaignCreate,
  prepareApiCampaignEnabled,
  prepareApiCampaignUpdate,
} from "@/lib/campaigns/admin";
import type { CampaignFields } from "@/lib/campaigns/input";
import {
  INVITES_DENIAL_HTTP,
  prepareApiInviteGenerate,
  prepareApiInviteRevoke,
  prepareApiInviteRevokeByBatch,
} from "@/lib/admin/invites";
import { isValidBeijingDateTime } from "@/lib/datetime";
import { commitWrite, type DenialHttpMap } from "@/lib/manage/content-writes";
import type { ManageHandlerContext } from "@/lib/manage/route";

/**
 * 运营日常域适配层（M20.3 Step 3）：公告 / 活动 / 邀请码三域的写端点接入。
 * 三域现状只有 site.admin 总门（无细分权限点），端点 permission 留空；
 * 合并码表 OPERATIONS_DENIAL_HTTP 供 commitWrite 统一转信封。
 */

export const OPERATIONS_DENIAL_HTTP: DenialHttpMap = {
  ...ANNOUNCEMENTS_DENIAL_HTTP,
  ...CAMPAIGNS_DENIAL_HTTP,
  ...INVITES_DENIAL_HTTP,
};

/** API 操作者恒为令牌持有人；审计 trace 携带 requestId 与令牌尾号。 */
function apiAudit(ctx: ManageHandlerContext) {
  return {
    admin: { userId: ctx.token.userId, ip: ctx.ip, via: "api" as const },
    trace: { requestId: ctx.requestId, tokenSuffix: ctx.token.suffix },
  };
}

type WriteInput<T> = { targetId: number; idempotencyKey: string; input: T };

// ---------- 公告 ----------

/** 公告请求体公共字段：startsAt/endsAt 为北京 DATETIME 或 null（创建 null=立即开始，编辑 null=保留原值）。 */
export const manageAnnouncementInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  bodyMd: z.string().max(20_000).default(""),
  level: z.enum(["info", "important"]).default("info"),
  audience: z.enum(["all", "members"]).default("all"),
  showBanner: z.boolean().default(false),
  startsAt: z.string().refine(isValidBeijingDateTime).nullable(),
  endsAt: z.string().refine(isValidBeijingDateTime).nullable(),
});

const toAnnouncementFields = (
  input: z.infer<typeof manageAnnouncementInput>,
): AnnouncementFields => ({
  title: input.title,
  bodyMd: input.bodyMd,
  level: input.level,
  audience: input.audience,
  showBanner: input.showBanner,
  startsAt: input.startsAt,
  endsAt: input.endsAt,
});

/** 创建公告（无行锁目标，幂等由缓存回放承担；published 事件 afterCommit 快派）。 */
export function createManageAnnouncement(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageAnnouncementInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "announcements.create",
    params,
    prepareApiAnnouncementCreate(admin, toAnnouncementFields(params.input), trace),
    OPERATIONS_DENIAL_HTTP,
  );
}

/** 编辑公告：startsAt 留空保留原值；值未变不写审计（条件审计契约）。 */
export function editManageAnnouncement(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageAnnouncementInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "announcements.edit",
    params,
    prepareApiAnnouncementEdit(admin, params.targetId, toAnnouncementFields(params.input), trace),
    OPERATIONS_DENIAL_HTTP,
  );
}

/** 下线公告：ends_at 置当前时刻。 */
export function endManageAnnouncement(
  ctx: ManageHandlerContext,
  params: WriteInput<Record<string, never>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "announcements.end",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: {} },
    prepareApiAnnouncementEnd(admin, params.targetId, trace),
    OPERATIONS_DENIAL_HTTP,
  );
}

/** 下线路由的请求体：空对象（幂等键承担重放语义）。 */
export const manageAnnouncementEndInput = z.strictObject({});

// ---------- 活动 ----------

/** 活动请求体公共字段：effect/target 拆分自后台表单的 choice；窗口为北京 DATETIME。 */
export const manageCampaignInput = z.strictObject({
  name: z.string().trim().min(1).max(60),
  effect: z.string().min(1).max(32),
  target: z.string().min(1).max(255),
  startsAt: z.string().refine(isValidBeijingDateTime),
  endsAt: z.string().refine(isValidBeijingDateTime).nullable(),
  priority: z.number().int().min(0).max(1000).default(0),
});

const toCampaignFields = (input: z.infer<typeof manageCampaignInput>): CampaignFields => ({
  name: input.name,
  effect: input.effect,
  target: input.target,
  startsAt: input.startsAt,
  endsAt: input.endsAt,
  priority: input.priority,
});

/** 创建活动（enabled 恒 true、revision=1；overlap 裁决在 execute）。 */
export function createManageCampaign(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageCampaignInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "campaigns.create",
    params,
    prepareApiCampaignCreate(toCampaignFields(params.input), admin, trace),
    OPERATIONS_DENIAL_HTTP,
  );
}

/** 编辑活动：expectedRevision 不一致 → 409（不覆盖他人改动）。 */
export const manageCampaignEditInput = manageCampaignInput.extend({
  expectedRevision: z.number().int().min(1),
});

export function editManageCampaign(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageCampaignEditInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  const { expectedRevision, ...rest } = params.input;
  return commitWrite(
    ctx,
    "campaigns.edit",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: rest },
    prepareApiCampaignUpdate(
      params.targetId,
      expectedRevision,
      toCampaignFields(rest),
      admin,
      trace,
    ),
    OPERATIONS_DENIAL_HTTP,
  );
}

/** 启停活动：同值幂等返回 changed:false；旁路写仍 revision+1（G-20）。 */
export const manageCampaignEnabledInput = z.strictObject({ enabled: z.boolean() });

export function toggleManageCampaign(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageCampaignEnabledInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "campaigns.enabled",
    params,
    prepareApiCampaignEnabled(params.targetId, params.input.enabled, admin, trace),
    OPERATIONS_DENIAL_HTTP,
  );
}

// ---------- 邀请码 ----------

/** 批量生成邀请码：与后台表单同规则（≤20/次、days ≤3650、batch ≤64；days 0 = 永不过期）。 */
export const manageInviteGenerateInput = z.strictObject({
  count: z.number().int().min(1).max(20),
  days: z.number().int().min(0).max(3650).default(0),
  batch: z.string().trim().max(64).default(""),
});

export function generateManageInvites(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageInviteGenerateInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "invites.generate",
    params,
    prepareApiInviteGenerate(admin, params.input, trace),
    OPERATIONS_DENIAL_HTTP,
  );
}

/** 吊销单条邀请码：路径 code 形态由路由判定（非法形态按不存在处理），注入请求体参与指纹。 */
export function revokeManageInvite(
  ctx: ManageHandlerContext,
  params: {
    targetId: number;
    idempotencyKey: string;
    input: { code: string };
  },
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "invites.revoke",
    { targetId: params.targetId, idempotencyKey: params.idempotencyKey, input: params.input },
    prepareApiInviteRevoke(admin, params.input.code, trace),
    OPERATIONS_DENIAL_HTTP,
  );
}

/** 批次吊销请求体：batch 由路径注入参与指纹（后台与 REST 同规则 ≤64）。 */
export const manageInviteRevokeBatchInput = z.strictObject({
  batch: z.string().min(1).max(64),
});

export function revokeManageInviteBatch(
  ctx: ManageHandlerContext,
  params: WriteInput<z.infer<typeof manageInviteRevokeBatchInput>>,
): Promise<unknown> {
  const { admin, trace } = apiAudit(ctx);
  return commitWrite(
    ctx,
    "invites.revoke-batch",
    params,
    prepareApiInviteRevokeByBatch(admin, params.input.batch, trace),
    OPERATIONS_DENIAL_HTTP,
  );
}
