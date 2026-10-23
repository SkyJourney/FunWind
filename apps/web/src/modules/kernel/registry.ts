import type {
  EventConsumer,
  EventName,
  ModuleDefinition,
  SlotName,
  SlotRenderer,
} from "./types.js";

/**
 * 模块注册表：进程内单例。
 * 注册只发生在 modules/index.ts 模块求值期；求值完毕封板，运行时注册一律拒绝。
 */

const modules: ModuleDefinition[] = [];
let sealed = false;

const MODULE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function registerModule(m: ModuleDefinition): Readonly<ModuleDefinition> {
  if (sealed) throw new Error(`[kernel] 模块清单已封板，禁止运行时注册: ${m.id}`);
  if (modules.some((x) => x.id === m.id)) {
    throw new Error(`[kernel] 模块重复注册: ${m.id}`);
  }
  if (!MODULE_ID_RE.test(m.id)) {
    throw new Error(`[kernel] 模块 id 必须为 kebab-case: ${m.id}`);
  }
  modules.push(m);
  return m;
}

/** modules/index.ts 末尾调用：此后只读 */
export function sealRegistry(): void {
  sealed = true;
}

export function getModules(): readonly ModuleDefinition[] {
  return modules;
}

export function getModule(id: string): Readonly<ModuleDefinition> | undefined {
  return modules.find((m) => m.id === id);
}

/** 事件消费者（全部已注册，启用过滤在 bus 层做——注册与启用是两件事） */
export function getEventConsumers<K extends EventName>(
  name: K,
): { moduleId: string; consume: EventConsumer<K> }[] {
  const out: { moduleId: string; consume: EventConsumer<K> }[] = [];
  for (const m of modules) {
    const consume = m.events?.[name] as EventConsumer<K> | undefined;
    if (consume) out.push({ moduleId: m.id, consume });
  }
  return out;
}

/** 槽位渲染器（全部已注册，启用过滤在 Slot 层做） */
export function getSlotRenderers(name: SlotName): { moduleId: string; render: SlotRenderer }[] {
  const out: { moduleId: string; render: SlotRenderer }[] = [];
  for (const m of modules) {
    const render = m.slots?.[name];
    if (render) out.push({ moduleId: m.id, render });
  }
  return out;
}

/** 收集全站注册边界（供 M5 权限点/M10 导航/M13 cron 汇聚） */
export function collectBoundary<K extends keyof ModuleDefinition>(
  key: K,
): NonNullable<ModuleDefinition[K]>[] {
  return modules.filter((m) => m[key] != null).map((m) => m[key]!) as NonNullable<
    ModuleDefinition[K]
  >[];
}

/** 仅测试使用：清空注册表并解封 */
export function resetRegistryForTests(): void {
  modules.length = 0;
  sealed = false;
}
