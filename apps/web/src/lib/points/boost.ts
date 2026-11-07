/**
 * 活动加成的纯计算（M11.4 Step 3，docs/POINTS.md §3「活动加成」）：
 * 排期 `points.boost` 在时间窗内把发帖 / 回帖 / 签到的本次奖励额乘整数倍率（站长 D2：×2 / ×3），
 * 日上限同比放大（站长 Q3；上限 0 = 不限，保持不限），幂等键与台账结构不变，
 * 台账 note 注明「活动加成 ×N：方案名」使发放可追溯（M11.4 §3 第 4 点）。
 * 读不到方案时的回落（Q4：按无加成发放 + 告警）在消费点（earn.ts / checkin/service.ts）做——
 * 只有那里知道用户、渠道与幂等键，告警才带得上上下文。
 */

/** 单个方案名 ≤ 60 字（CAMPAIGN_NAME_MAX 按码点计），最长 note（「签到奖励（连签 99 天，活动加成 ×3：」+60+「）」）≈ 78 字符，
 * 远小于 point_ledger.note 的 varchar(255)，无需截断逻辑。 */

/** 本次奖励额乘倍率（向下取整兜底，当前倍率恒为整数） */
export function boostedAmount(amount: number, ratio: number): number {
  return Math.floor(amount * ratio);
}

/** 日上限同比放大；0 = 不限，保持 0（不参与上限判定） */
export function boostedCap(cap: number, ratio: number): number {
  return cap > 0 ? Math.floor(cap * ratio) : 0;
}

/** 发帖 / 回帖奖励的台账 note：无加成保持原文（M7 语义不变），有加成追加方案上下文 */
export function earnNote(
  base: "发帖奖励" | "回帖奖励",
  boost: { ratio: number; name: string } | null,
): string {
  return boost ? `${base}（活动加成 ×${boost.ratio}：${boost.name}）` : base;
}

/** 签到奖励的台账 note：连签天数与加成上下文并列 */
export function checkinNote(streak: number, boost: { ratio: number; name: string } | null): string {
  return boost
    ? `签到奖励（连签 ${streak} 天，活动加成 ×${boost.ratio}：${boost.name}）`
    : `签到奖励（连签 ${streak} 天）`;
}
