import {
  BUILTIN_GATE_CONDITION_TYPES,
  BUILTIN_POINT_CHANNELS,
  RESERVED_NOTIFICATION_CHANNELS,
} from "./builtin";
import type {
  EventConsumer,
  EventName,
  GateConditionDef,
  ModuleDefinition,
  NotificationChannelDef,
  NotificationTypeDef,
  PointChannelDef,
  SlotName,
  SlotRenderer,
} from "./types";

/**
 * 模块注册表：进程内单例。
 * 注册只发生在 modules/index.ts 模块求值期；求值完毕封板，运行时注册一律拒绝。
 */

const modules: ModuleDefinition[] = [];
let sealed = false;

const MODULE_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const CHANNEL_KEY_RE = /^(earn|spend|adjust)\.[a-z][a-z0-9_]*$/;
const IDENT_RE = /^[a-z][a-z0-9_]*$/;
const NOTIFICATION_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const NOTIFICATION_CATEGORIES = new Set(["interaction", "message", "moderation", "account"]);

/**
 * 注册时校验四类新边界：非法声明在启动期就暴露，而不是等到运行时才发现（重名、方向与前缀不符、与内置冲突……）。
 * 唯一性是全站范围的——键冲突意味着两个模块在争同一个渠道/条件，必须在注册期失败。
 */
function validateBoundaries(m: ModuleDefinition): void {
  const fail = (msg: string): never => {
    throw new Error(`[kernel] 模块 ${m.id}: ${msg}`);
  };

  const channelKeys = new Set<string>([
    ...BUILTIN_POINT_CHANNELS.map((c) => c.key),
    ...modules.flatMap((x) => (x.pointChannels ?? []).map((c) => c.key)),
  ]);
  for (const c of m.pointChannels ?? []) {
    if (!CHANNEL_KEY_RE.test(c.key))
      fail(`积分渠道键非法（须形如 earn.xxx / spend.xxx / adjust.xxx）: ${c.key}`);
    if (c.key.split(".")[0] !== c.direction)
      fail(`积分渠道 ${c.key} 的方向 ${c.direction} 与键前缀不符`);
    if (!c.label.trim()) fail(`积分渠道 ${c.key} 缺少 label`);
    if (channelKeys.has(c.key)) fail(`积分渠道键重复或与内置冲突: ${c.key}`);
    channelKeys.add(c.key);
  }

  const conditionTypes = new Set<string>([
    ...BUILTIN_GATE_CONDITION_TYPES,
    ...modules.flatMap((x) => (x.gateConditions ?? []).map((c) => c.type)),
  ]);
  for (const c of m.gateConditions ?? []) {
    if (!IDENT_RE.test(c.type)) fail(`门控条件类型非法: ${c.type}`);
    if (c.kind !== "derived") fail(`门控条件 ${c.type} 目前只支持 kind=derived`);
    if (conditionTypes.has(c.type)) fail(`门控条件类型重复或与内置冲突: ${c.type}`);
    conditionTypes.add(c.type);
  }

  const typeKeys = new Set(modules.flatMap((x) => (x.notificationTypes ?? []).map((t) => t.key)));
  for (const t of m.notificationTypes ?? []) {
    if (!NOTIFICATION_TYPE_RE.test(t.key)) fail(`通知类型键非法（须形如 badge.awarded）: ${t.key}`);
    if (!NOTIFICATION_CATEGORIES.has(t.category))
      fail(`通知类型 ${t.key} 的分类非法: ${t.category}`);
    if (typeKeys.has(t.key)) fail(`通知类型键重复: ${t.key}`);
    typeKeys.add(t.key);
  }

  const channelNames = new Set<string>([
    ...RESERVED_NOTIFICATION_CHANNELS,
    ...modules.flatMap((x) => (x.notificationChannels ?? []).map((c) => c.key)),
  ]);
  for (const c of m.notificationChannels ?? []) {
    if (!IDENT_RE.test(c.key)) fail(`通知渠道键非法: ${c.key}`);
    if (channelNames.has(c.key)) fail(`通知渠道键重复或为保留键: ${c.key}`);
    channelNames.add(c.key);
  }
}

export function registerModule(m: ModuleDefinition): Readonly<ModuleDefinition> {
  if (sealed) throw new Error(`[kernel] 模块清单已封板，禁止运行时注册: ${m.id}`);
  if (modules.some((x) => x.id === m.id)) {
    throw new Error(`[kernel] 模块重复注册: ${m.id}`);
  }
  if (!MODULE_ID_RE.test(m.id)) {
    throw new Error(`[kernel] 模块 id 必须为 kebab-case: ${m.id}`);
  }
  validateBoundaries(m);
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

/**
 * 四类新边界的声明清单（全部已注册；启用过滤由调用方按 module_state 做——注册与启用是两件事）。
 * 带上 moduleId，方便“模块被停用则其渠道/条件失效”的判定。
 */
const declsOf = <T>(pick: (m: ModuleDefinition) => T[] | undefined) =>
  modules.flatMap((m) => (pick(m) ?? []).map((def) => ({ moduleId: m.id, def })));

export const getPointChannelDecls = (): { moduleId: string; def: PointChannelDef }[] =>
  declsOf((m) => m.pointChannels);
export const getGateConditionDecls = (): { moduleId: string; def: GateConditionDef }[] =>
  declsOf((m) => m.gateConditions);
export const getNotificationTypeDecls = (): { moduleId: string; def: NotificationTypeDef }[] =>
  declsOf((m) => m.notificationTypes);
export const getNotificationChannelDecls = (): {
  moduleId: string;
  def: NotificationChannelDef;
}[] => declsOf((m) => m.notificationChannels);

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
