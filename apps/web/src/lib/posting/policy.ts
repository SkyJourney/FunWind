/**
 * 发帖的纯判断（M6.1 任务 4，无 IO）：审核分流、发帖间隔、每日配额。
 * 服务层取到事实后调用这里，规则本身可穷举测试。
 */

export type ReviewPolicyValue = "none" | "threads" | "all";
export type NewContentKind = "thread" | "reply";
export type InitialState = "visible" | "pending";

/**
 * 新内容的初始状态（docs/AUTHZ.md §8.3）：
 *  · 版主（持有 forum.moderate）免审，直接可见；
 *  · review_policy=all：所有新内容待审；threads：只有新主题待审，回帖直接可见；none：全部直接可见。
 */
export function initialState(
  policy: ReviewPolicyValue,
  kind: NewContentKind,
  isModerator: boolean,
): InitialState {
  if (isModerator) return "visible";
  if (policy === "all") return "pending";
  if (policy === "threads" && kind === "thread") return "pending";
  return "visible";
}

/**
 * 发帖间隔：距离该用户上一条帖子（任何状态，含待审与已删除——防刷不能靠删帖绕过）的秒数 < 间隔则违规。
 * ageSec 为 null（从未发过帖）或 intervalSec 为 0（不限）时放行。边界：恰好等于间隔放行。
 */
export function intervalViolated(ageSec: number | null, intervalSec: number): boolean {
  if (intervalSec <= 0 || ageSec === null) return false;
  return ageSec < intervalSec;
}

/**
 * 每日主题配额：今天已创建的主题数（含已删除，否则"发完删、删完再发"可以无限刷）达到上限则违规。
 * max 为 0 = 不限。
 */
export function dailyQuotaExceeded(createdToday: number, max: number): boolean {
  return max > 0 && createdToday >= max;
}

/** 幂等窗口：同一作者、同一位置、同一正文在此秒数内重复提交，视为双击 / 刷新，返回已有的帖子 */
export const IDEMPOTENCY_WINDOW_SEC = 60;
