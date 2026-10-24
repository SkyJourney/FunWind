import { BUILTIN_POINT_CHANNELS } from "@/modules/kernel/builtin";
import { getPointChannelDecls } from "@/modules/kernel/registry";
import { getEnabledModuleIds } from "@/modules/kernel/state";
import type { PointChannelDef } from "@/modules/kernel/types";

/**
 * 积分渠道解析（docs/POINTS.md §3）：未注册的渠道一律拒绝，防拼写错误与未审查的新渠道。
 *   · 内置渠道（opening / spend.gate_unlock / earn.gate_sale）属于积分核心，不随模块启停；
 *   · 模块声明的渠道仅在所属模块启用时有效——模块被停用，它的渠道随之失效。
 */
export async function resolvePointChannel(
  key: string,
  enabledModuleIds?: ReadonlySet<string>,
): Promise<PointChannelDef | null> {
  const builtin = BUILTIN_POINT_CHANNELS.find((c) => c.key === key);
  if (builtin) return builtin;
  const decl = getPointChannelDecls().find((d) => d.def.key === key);
  if (!decl) return null;
  const enabled = enabledModuleIds ?? (await getEnabledModuleIds());
  return enabled.has(decl.moduleId) ? decl.def : null;
}
