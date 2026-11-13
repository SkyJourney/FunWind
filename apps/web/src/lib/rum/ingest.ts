import "server-only";

import { getWebDb, rumSamples } from "@funwind/db";
import { nowBeijingWallTime } from "@/lib/datetime";

/**
 * RUM 样本落库（M17 Step 4）。只负责写库——**脱敏与校验在路由层完成**，
 * 传进来的行必须已经是脱敏后的（route 经 redactUri、detail 去控制字符并截断）。
 *
 * 为什么脱敏不放这里：redactUri 现在导出自 app/api/csp-report/route.ts，
 * 从 lib 反向 import app 会把依赖方向搞反；路由层做脱敏、lib 层做落库，职责与依赖都干净。
 */

/** 一行待落库样本（已脱敏） */
export interface RumRow {
  kind: "vital" | "error";
  name: string;
  value: number;
  route: string;
  detail: string | null;
}

/**
 * 批量写入样本，返回写入行数。整批一次 insert（样本量 ≤20，无需分批）。
 * 时间戳统一取一次北京墙面时间，同批样本落在同一时刻便于按批排查。
 */
export async function recordRumSamples(rows: readonly RumRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const createdAt = nowBeijingWallTime();
  await getWebDb()
    .insert(rumSamples)
    .values(rows.map((r) => ({ ...r, createdAt })));
  return rows.length;
}
