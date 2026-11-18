import { z } from "zod";
import { pushLogSummary, queryPushLogs } from "@/lib/push/log-query";
import { manageLogEndpoint } from "@/lib/manage/route";
import {
  managePageField,
  manageQField,
  manageSceneField,
  manageSizeField,
  manageStatusField,
} from "@/lib/manage/params";

export const dynamic = "force-dynamic";

/** 推送日志场景键白名单（M18 三类）；记录不含推送 payload 正文 */
const querySchema = z.object({
  status: manageStatusField(),
  scene: manageSceneField(["pm-received", "post-replied", "post-mentioned"]),
  /** 纯数字按 userId 等值，否则订阅 endpoint 包含 */
  q: manageQField(128),
  page: managePageField(),
  size: manageSizeField(),
});

/** GET /api/manage/push-logs：推送日志分页 + 近 24h 成败摘要（与后台推送记录页同一查询层） */
export const GET = manageLogEndpoint({
  endpoint: "push-logs",
  schema: querySchema,
  query: (q) =>
    queryPushLogs({ status: q.status, scene: q.scene, q: q.q, page: q.page, limit: q.size }),
  summary: pushLogSummary,
});
