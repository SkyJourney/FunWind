import { z } from "zod";
import { ADMIN_PAGE_SIZES } from "@/lib/admin/query";

/**
 * 管理 REST API 的通用 query 片段（M20）：分页参数的单一事实源。
 * size 白名单与后台列表基建（ADMIN_PAGE_SIZES）同源；非法值一律 bad_request（v1 语义明确）。
 */

export const managePageField = () => z.coerce.number().int().min(1).optional();

export const manageSizeField = () =>
  z.coerce
    .number()
    .int()
    .refine((v) => (ADMIN_PAGE_SIZES as readonly number[]).includes(v), "size 档位非法")
    .optional();
