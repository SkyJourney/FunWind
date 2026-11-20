import "@/modules";
import { ManageApiError } from "@/lib/manage/errors";
import { manageEndpoint, manageOk } from "@/lib/manage/route";
import type { ManageHandlerContext } from "@/lib/manage/route";
import { parseManageWrite } from "@/lib/manage/write-request";
import { editManageTheme, manageThemeEditInput } from "@/lib/manage/system-writes";
import { getThemePack, THEME_PACK_ID_RE } from "@/lib/theme/packs";

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

/** GET /api/manage/themes/{packId}：单包详情（含 definition 与 revision） */
export const GET = manageEndpoint(
  async (ctx) => {
    const packId = await requirePackId(ctx);
    const pack = await getThemePack(packId);
    if (!pack) throw new ManageApiError("not_found");
    return manageOk(pack);
  },
  { endpoint: "themes.detail" },
);

/** PATCH /api/manage/themes/{packId}：编辑名称/描述（expectedRevision 409），幂等写 */
export const PATCH = manageEndpoint(
  async (ctx) => {
    const packId = await requirePackId(ctx);
    // 无数字目标（packId 为路径字符串）：targetId 记 0，packId 注入请求体参与幂等指纹
    const params = await parseManageWrite(ctx, manageThemeEditInput);
    void params.targetId;
    return manageOk(
      await editManageTheme(ctx, {
        targetId: 0,
        idempotencyKey: params.idempotencyKey,
        packId,
        editInput: params.input,
      }),
    );
  },
  { endpoint: "themes.edit" },
);
