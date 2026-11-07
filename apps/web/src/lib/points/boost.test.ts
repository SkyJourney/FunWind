import { describe, expect, it } from "vitest";
import { boostedAmount, boostedCap, checkinNote, earnNote } from "./boost";

/** 方案名上限：CAMPAIGN_NAME_MAX（60 码点） */
const LONG_NAME = "活".repeat(60);

describe("活动加成的纯计算（M11.4 Step 3）", () => {
  it("金额乘倍率；倍率恒为整数，向下取整只作兜底", () => {
    expect(boostedAmount(3, 2)).toBe(6);
    expect(boostedAmount(1, 3)).toBe(3);
    expect(boostedAmount(0, 2)).toBe(0);
    expect(boostedAmount(5, 1)).toBe(5);
  });

  it("日上限同比放大；0 = 不限，保持 0 不参与判定", () => {
    expect(boostedCap(5, 2)).toBe(10);
    expect(boostedCap(100, 3)).toBe(300);
    expect(boostedCap(0, 2)).toBe(0);
    expect(boostedCap(0, 3)).toBe(0);
  });

  it("发帖 / 回帖 note：无加成保持原文（M7 语义不变），有加成追加方案上下文", () => {
    expect(earnNote("发帖奖励", null)).toBe("发帖奖励");
    expect(earnNote("回帖奖励", null)).toBe("回帖奖励");
    expect(earnNote("发帖奖励", { ratio: 2, name: "国庆活动" })).toBe(
      "发帖奖励（活动加成 ×2：国庆活动）",
    );
    expect(earnNote("回帖奖励", { ratio: 3, name: "国庆活动" })).toBe(
      "回帖奖励（活动加成 ×3：国庆活动）",
    );
  });

  it("签到 note：连签天数与加成上下文并列；无加成为 M7 原文", () => {
    expect(checkinNote(7, null)).toBe("签到奖励（连签 7 天）");
    expect(checkinNote(1, { ratio: 3, name: "国庆活动" })).toBe(
      "签到奖励（连签 1 天，活动加成 ×3：国庆活动）",
    );
  });

  it("最长 note（60 字方案名 + 连签两位数）远小于 note 列 varchar(255)，无需截断", () => {
    const longest = checkinNote(99, { ratio: 3, name: LONG_NAME });
    expect([...longest].length).toBeLessThanOrEqual(255);
    expect([...earnNote("发帖奖励", { ratio: 3, name: LONG_NAME })].length).toBeLessThanOrEqual(
      255,
    );
  });
});
