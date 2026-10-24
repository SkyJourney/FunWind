/** 积分核心的业务错误：都是可预期的拒绝，调用方按类型处理（不是系统故障） */

export class PointsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** 渠道未注册，或所属模块已被停用 */
export class UnregisteredChannelError extends PointsError {
  constructor(public readonly channel: string) {
    super(`积分渠道未注册或所属模块已停用: ${channel}`);
  }
}

/** delta 不是非零整数，或符号与渠道方向不符（earn 必须为正，spend 必须为负） */
export class InvalidDeltaError extends PointsError {}

/** 支出后余额会为负 */
export class InsufficientPointsError extends PointsError {
  constructor(
    public readonly userId: number,
    public readonly balance: number,
    public readonly needed: number,
  ) {
    super(`积分不足: 用户 ${userId} 余额 ${balance}，需要 ${needed}`);
  }
}

/** 入账后余额会超过账户列的上限（INT UNSIGNED）：业务上几乎不会发生，但必须是可识别的拒绝而不是 MySQL 原始错误 */
export class PointsOverflowError extends PointsError {
  constructor(
    public readonly userId: number,
    public readonly balance: number,
    public readonly delta: number,
  ) {
    super(`积分余额会超过上限: 用户 ${userId} 余额 ${balance}，变动 ${delta}`);
  }
}

/** 同一幂等键被用于不同的用户/渠道/金额——调用方键构造有误，宁可报错也不静默忽略 */
export class IdempotencyConflictError extends PointsError {
  constructor(public readonly key: string) {
    super(`幂等键冲突: ${key} 已被用于另一笔不同的积分变动`);
  }
}
