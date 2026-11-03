import { getLogoPoolRaw, setActiveLogo } from "@/lib/brand/logo-pool";
import { applyPackLogo, type ApplyPackLogoResult } from "@/lib/brand/logo-pool-fs";
import type { ConfigActor } from "@/lib/audit";
import { getThemePack, parseThemePackAssets } from "./packs";

type LogoFailureReason = Exclude<
  Extract<ApplyPackLogoResult, { applied: false }>["reason"],
  "no-logo"
>;

export type TryApplyThemePackLogoResult =
  | { status: "applied"; imported: boolean; file: string }
  | { status: "unchanged"; reason: "no-logo" }
  | { status: "failed"; reason: LogoFailureReason | "exception" };

interface LogoApplyContext {
  stage: string;
  asset: string | null;
}

async function applyLogo(
  packId: string,
  actor: ConfigActor,
  context: LogoApplyContext,
): Promise<ApplyPackLogoResult> {
  const pack = await getThemePack(packId);
  const logo = parseThemePackAssets(pack?.assets).find((asset) => asset.kind === "logo");
  // 已有自定义包没有 LOGO 属于正常不联动，不能回退成静态注册表里的未知包。
  if (!logo && pack && !pack.isBuiltin) return { applied: false, reason: "no-logo" };

  let result: ApplyPackLogoResult;
  if (!logo) {
    context.stage = "apply-bundled-logo";
    result = await applyPackLogo(packId, actor);
  } else {
    context.stage = "read-logo-pool";
    context.asset = logo.poolFile;
    const pool = await getLogoPoolRaw();
    if (!pool.items.some((item) => item.file === logo.poolFile)) {
      return { applied: false, reason: "missing-asset" };
    }
    context.stage = "activate-logo";
    await setActiveLogo(logo.poolFile, actor);
    result = { applied: true, imported: false, file: logo.poolFile };
  }

  if (result.applied) {
    // setActive 在目标已移除时会静默保留原值，必须回读确认，内置包联动同样适用。
    context.stage = "verify-active-logo";
    context.asset = result.file;
    const activePool = await getLogoPoolRaw();
    if (
      activePool.active !== result.file ||
      !activePool.items.some((item) => item.file === result.file)
    ) {
      return { applied: false, reason: "missing-asset" };
    }
  }
  return result;
}

/** 数据包使用素材池 LOGO；仅内置包或不存在的数据包回退静态内置联动。 */
export async function applyThemePackLogo(
  packId: string,
  actor: ConfigActor,
): Promise<ApplyPackLogoResult> {
  return applyLogo(packId, actor, { stage: "read-pack", asset: null });
}

/** LOGO 是主题保存后的附带动作：异常只返回失败并记录上下文，无 LOGO 不告警。 */
export async function tryApplyThemePackLogo(
  packId: string,
  actor: ConfigActor,
): Promise<TryApplyThemePackLogoResult> {
  const context: LogoApplyContext = { stage: "read-pack", asset: null };
  try {
    const result = await applyLogo(packId, actor, context);
    if (result.applied) {
      return { status: "applied", imported: result.imported, file: result.file };
    }
    if (result.reason === "no-logo") return { status: "unchanged", reason: "no-logo" };
    console.error("[theme-pack-logo] 主题包 LOGO 联动失败", {
      packId,
      actorId: actor.userId,
      ...context,
      reason: result.reason,
    });
    return { status: "failed", reason: result.reason };
  } catch (error) {
    console.error("[theme-pack-logo] 主题包 LOGO 联动异常", {
      packId,
      actorId: actor.userId,
      ...context,
      reason: "exception",
      error,
    });
    return { status: "failed", reason: "exception" };
  }
}
