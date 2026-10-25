import { DEFAULT_POINT_REWARD, DEFAULT_PUNCH_REWARD } from "@funwind/db";
import { z } from "zod";

/**
 * 积分奖励与签到奖励配置（M7，设计见 docs/POINTS.md §3）。纯逻辑，无 IO；读库在 reward-load.ts。
 *
 * 配置存在 site_settings 的 `points.reward` / `punch.reward` 键，zod 校验。**校验失败整体回落默认值**
 * （并告警）——一份写坏的配置不应该让发帖/签到不可用，也不应该意外变成别的数值：
 * 字段必须写全（缺省不补默认），数值含义与旧站实测初值见 packages/db 的 DEFAULT_POINT_REWARD / DEFAULT_PUNCH_REWARD。
 * 日上限 0 = 不限（旧站即无上限）。
 */

const amount = z.number().int().min(0).max(1_000_000);

export const pointRewardSchema = z
  .object({
    /** 发帖奖励（earn.post） */
    post: amount,
    /** 回帖奖励（earn.reply） */
    reply: amount,
    /** 发帖奖励北京时间自然日上限；0 = 不限 */
    postDailyCap: amount,
    /** 回帖奖励北京时间自然日上限；0 = 不限 */
    replyDailyCap: amount,
  })
  .strict();

export type PointReward = z.infer<typeof pointRewardSchema>;

export const DEFAULT_POINT_REWARD_CONFIG: PointReward =
  pointRewardSchema.parse(DEFAULT_POINT_REWARD);

export function parsePointReward(raw: unknown): { config: PointReward; error?: string } {
  if (raw === undefined || raw === null) return { config: DEFAULT_POINT_REWARD_CONFIG };
  const r = pointRewardSchema.safeParse(raw);
  if (r.success) return { config: r.data };
  const first = r.error.issues[0];
  const where = first ? first.path.join(".") || "(根)" : "?";
  return { config: DEFAULT_POINT_REWARD_CONFIG, error: `${where}: ${first?.message ?? "无效"}` };
}

export const punchRewardSchema = z
  .object({
    /** 单次签到奖励下限（含 0 = 可关掉签到奖励） */
    min: amount,
    /** 单次签到奖励上限；须 ≥ min */
    max: amount,
  })
  .strict()
  .refine((v) => v.min <= v.max, { message: "max 必须 ≥ min" });

export type PunchReward = z.infer<typeof punchRewardSchema>;

export const DEFAULT_PUNCH_REWARD_CONFIG: PunchReward =
  punchRewardSchema.parse(DEFAULT_PUNCH_REWARD);

export function parsePunchReward(raw: unknown): { config: PunchReward; error?: string } {
  if (raw === undefined || raw === null) return { config: DEFAULT_PUNCH_REWARD_CONFIG };
  const r = punchRewardSchema.safeParse(raw);
  if (r.success) return { config: r.data };
  const first = r.error.issues[0];
  const where = first ? first.path.join(".") || "(根)" : "?";
  return { config: DEFAULT_PUNCH_REWARD_CONFIG, error: `${where}: ${first?.message ?? "无效"}` };
}

/** 在 [min, max] 内取随机整数奖励（含两端；min = max 时恒定） */
export function randomPunchReward(reward: PunchReward): number {
  if (reward.max <= reward.min) return reward.min;
  return reward.min + Math.floor(Math.random() * (reward.max - reward.min + 1));
}
