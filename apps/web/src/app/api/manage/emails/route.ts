import { z } from "zod";
import { emailLogSummary, queryEmailLogs } from "@/lib/mail/log-query";
import { manageLogEndpoint } from "@/lib/manage/route";
import {
  managePageField,
  manageQField,
  manageSceneField,
  manageSizeField,
  manageStatusField,
} from "@/lib/manage/params";

export const dynamic = "force-dynamic";

/** 邮件日志场景键白名单（与 lib/mail/log-query 的过滤语义一致，此处 zod 严格校验：非法即 400） */
const querySchema = z.object({
  status: manageStatusField(),
  kind: z.enum(["verify", "security", "notice", "digest", "system"]).optional(),
  scene: manageSceneField(["verify", "security", "notice", "digest", "system"]),
  /** 纯数字按 userId 等值，否则收件地址包含 */
  q: manageQField(128),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/emails：邮件日志分页 + 近 24h 成败摘要（与后台邮件页同一查询层） */
export const GET = manageLogEndpoint({
  endpoint: "emails",
  schema: querySchema,
  query: (q) =>
    queryEmailLogs({
      status: q.status,
      kind: q.kind,
      scene: q.scene,
      q: q.q,
      page: q.page,
      limit: q.size,
    }),
  summary: emailLogSummary,
});
