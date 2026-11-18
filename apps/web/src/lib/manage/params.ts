import { z } from "zod";
import { ADMIN_PAGE_SIZES } from "@/lib/admin/query";

/**
 * 管理 REST API 的通用 query 片段（M20）：分页参数的单一事实源。
 * size 白名单与后台列表基建（ADMIN_PAGE_SIZES）同源；非法值一律 bad_request（v1 语义明确）。
 */

export const managePageField = () => z.coerce.number().int().min(1).optional();

/** 日志/列表端点通用：凭证主体过滤（纯数字 = uid 等值，否则包含/精确匹配） */
export const manageQField = (max: number) => z.string().max(max).optional();

/** 状态枚举（邮件/推送共用） */
export const manageStatusField = () => z.enum(["sent", "failed"]).optional();

export const manageSizeField = () =>
  z.coerce
    .number()
    .int()
    .refine((v) => (ADMIN_PAGE_SIZES as readonly number[]).includes(v), "size 档位非法")
    .optional();

/** 场景键枚举工厂（各日志渠道的白名单不同：邮件五类 / 推送三类） */
export const manageSceneField = (values: readonly [string, ...string[]]) =>
  z.enum(values).optional();
