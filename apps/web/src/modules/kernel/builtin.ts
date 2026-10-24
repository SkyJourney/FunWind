import type { PointChannelDef } from "./types";

/**
 * 内核保留的内置项：模块声明不得与之重名。
 * 内置项由对应核心实现（积分核心 / 门控核心 / 通知核心），不属于任何模块，因此不随模块启停。
 */

/** 内置积分渠道（docs/POINTS.md §4）：期初余额与门控购买的两侧分录 */
export const BUILTIN_POINT_CHANNELS: readonly PointChannelDef[] = [
  { key: "opening", direction: "earn", label: "期初余额" },
  { key: "spend.gate_unlock", direction: "spend", label: "解锁内容" },
  { key: "earn.gate_sale", direction: "earn", label: "内容收益" },
];

/** 内置门控条件类型（实现在 lib/gates） */
export const BUILTIN_GATE_CONDITION_TYPES: readonly string[] = ["points", "reply"];

/** 保留的通知渠道键 */
export const RESERVED_NOTIFICATION_CHANNELS: readonly string[] = ["in_app"];
