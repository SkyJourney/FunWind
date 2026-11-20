import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { manageThemeEnabledInput, toggleManageTheme } from "@/lib/manage/system-writes";

import { THEME_PACK_ID_RE } from "@/lib/theme/packs";

export const dynamic = "force-dynamic";

/** 路径 packId 形态判定（varchar32）：不符按不存在处理。 */
async function requirePackId(ctx: ManageHandlerContext): Promise<string> {
  const raw = (await ctx.params).packId;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !THEME_PACK_ID_RE.test(value)) {
    throw new ManageApiError("not_found");
  }
  return value;
}

/** POST /api/manage/themes/{packId}/enabled：启停（default 保护/容量在服务层），幂等写 */
export const POST = manageEndpoint(
  async (ctx) => {
    const packId = await requirePackId(ctx);
    // 无数字目标（packId 为路径字符串）：targetId 记 0，packId 注入请求体参与幂等指纹
    const params = await parseManageWrite(ctx, manageThemeEnabledInput);
    void params.targetId;
    return manageOk(
      await toggleManageTheme(ctx, {
        targetId: 0,
        idempotencyKey: params.idempotencyKey,
        input: { ...params.input, packId },
      }),
    );
  },
  { endpoint: "themes.enabled" },
);
