import { DEFAULT_POINT_REWARD, DEFAULT_PUNCH_REWARD } from "@funwind/db";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POINT_REWARD_CONFIG,
  DEFAULT_PUNCH_REWARD_CONFIG,
  parsePointReward,
  parsePunchReward,
  randomPunchReward,
} from "./reward-config";

describe("积分奖励配置（points.reward）", () => {
  it("默认值（旧站实测初值）能通过校验", () => {
    expect(DEFAULT_POINT_REWARD_CONFIG).toEqual({
      post: 3,
      reply: 1,
      postDailyCap: 0,
      replyDailyCap: 0,
    });
  });

  it("缺失 → 默认；无效 → 默认并带错误说明", () => {
    expect(parsePointReward(undefined).config).toEqual(DEFAULT_POINT_REWARD_CONFIG);
    expect(parsePointReward(null).error).toBeUndefined();

    const bad = parsePointReward({ post: 3, reply: 1, postDailyCap: -1, replyDailyCap: 0 });
    expect(bad.config).toEqual(DEFAULT_POINT_REWARD_CONFIG);
    expect(bad.error).toContain("postDailyCap");

    const extra = parsePointReward({ ...DEFAULT_POINT_REWARD, steal: 1 });
    expect(extra.error).toBeDefined();
  });

  it("0 奖励与 0 日上限（不限）都是合法配置", () => {
    const zero = parsePointReward({ post: 0, reply: 0, postDailyCap: 0, replyDailyCap: 0 });
    expect(zero.error).toBeUndefined();
    expect(zero.config.post).toBe(0);
  });

  it("上限小于奖励额的组合整体无效（渠道会静默失效）", () => {
    const bad = parsePointReward({ post: 5, reply: 1, postDailyCap: 3, replyDailyCap: 0 });
    expect(bad.config).toEqual(DEFAULT_POINT_REWARD_CONFIG);
    expect(bad.error).toContain("发帖日上限");
    const ok = parsePointReward({ post: 5, reply: 1, postDailyCap: 5, replyDailyCap: 0 });
    expect(ok.error).toBeUndefined();
  });
});

describe("签到奖励配置（punch.reward）", () => {
  it("默认值（旧站随机 1–5）能通过校验", () => {
    expect(DEFAULT_PUNCH_REWARD_CONFIG).toEqual({ min: 1, max: 5 });
    expect(DEFAULT_PUNCH_REWARD).toEqual({ min: 1, max: 5 });
  });

  it("min > max 整体无效", () => {
    const bad = parsePunchReward({ min: 5, max: 1 });
    expect(bad.config).toEqual(DEFAULT_PUNCH_REWARD_CONFIG);
    expect(bad.error).toBeDefined();
  });

  it("min = max = 0 合法（关闭签到奖励）", () => {
    expect(parsePunchReward({ min: 0, max: 0 }).config).toEqual({ min: 0, max: 0 });
  });

  it("无效配置读取时告警（reward-load 的回落分支由集成测试覆盖；此处验语义）", () => {
    // reward-load.ts 的告警分支（console.warn）在 int 测试中覆盖；这里锚定回落语义的输出形状
    const bad = parsePointReward("not-an-object");
    expect(bad.config).toEqual(DEFAULT_POINT_REWARD_CONFIG);
    expect(bad.error).toBeDefined();
    const badPunch = parsePunchReward(12345);
    expect(badPunch.config).toEqual(DEFAULT_PUNCH_REWARD_CONFIG);
  });

  it("随机奖励落在 [min, max] 且含两端", () => {
    const reward = { min: 1, max: 5 };
    for (let i = 0; i < 200; i++) {
      const n = randomPunchReward(reward);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(5);
    }
    expect(randomPunchReward({ min: 3, max: 3 })).toBe(3);
    expect(randomPunchReward({ min: 0, max: 0 })).toBe(0);
  });
});
