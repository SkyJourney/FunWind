import type { MotionPagePreset } from "./types";

export interface MotionConfig {
  readonly enabled: boolean;
  readonly pagePreset: MotionPagePreset;
  readonly safetyTimeoutMs: number;
  readonly maxStaggerItems: number;
}

export const MOTION_DEFAULTS: MotionConfig = Object.freeze({
  enabled: true,
  pagePreset: "list",
  safetyTimeoutMs: 15_000,
  maxStaggerItems: 10,
});

export function createMotionConfig(overrides: Partial<MotionConfig> = {}): MotionConfig {
  const config = { ...MOTION_DEFAULTS, ...overrides };
  if (!Number.isFinite(config.safetyTimeoutMs) || config.safetyTimeoutMs <= 0) {
    throw new RangeError("动效安全超时必须为正数");
  }
  if (!Number.isInteger(config.maxStaggerItems) || config.maxStaggerItems < 0) {
    throw new RangeError("错落进场上限必须为非负整数");
  }
  return Object.freeze(config);
}
