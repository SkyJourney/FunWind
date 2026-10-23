import type { ReactNode } from "react";
import { getEnabledModuleIds } from "./state.js";
import { getSlotRenderers } from "./registry.js";
import type { SlotContext, SlotName } from "./types.js";

/**
 * 槽位选择（纯函数，可单测）：按注册序收集启用模块的渲染器。
 * 渲染失败的模块跳过，不影响同槽位其他模块，更不拖垮宿主页。
 */
export function selectSlotRenderers(
  name: SlotName,
  enabledIds: ReadonlySet<string>,
): { moduleId: string; render: (ctx: SlotContext) => Promise<ReactNode> | ReactNode }[] {
  return getSlotRenderers(name).filter((r) => enabledIds.has(r.moduleId));
}

/**
 * <Slot name="…" /> —— 槽位宿主（服务端组件）。
 * 用法：<Slot name="home.footer-notice" />；无内容时渲染 null。
 */
export async function Slot({
  name,
  ctx = {},
}: {
  name: SlotName;
  ctx?: SlotContext;
}): Promise<ReactNode> {
  let enabled: ReadonlySet<string>;
  try {
    enabled = await getEnabledModuleIds();
  } catch (e) {
    console.error(`[kernel] slot:${name} 启用状态读取失败，按空槽位降级`, e);
    return null;
  }

  const renderers = selectSlotRenderers(name, enabled);
  const rendered: { moduleId: string; node: ReactNode }[] = [];
  for (const { moduleId, render } of renderers) {
    try {
      const node = await render(ctx);
      if (node !== null && node !== undefined && node !== false) {
        rendered.push({ moduleId, node });
      }
    } catch (e) {
      console.error(`[kernel] slot:${name} 模块 ${moduleId} 渲染失败（已跳过）`, e);
    }
  }

  if (rendered.length === 0) return null;
  return (
    <div data-slot={name}>
      {rendered.map(({ moduleId, node }) => (
        <div data-slot-module={moduleId} key={moduleId}>
          {node}
        </div>
      ))}
    </div>
  );
}
