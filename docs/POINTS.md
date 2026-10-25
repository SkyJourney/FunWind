# 积分（Points）规范

> 状态：M5.5 设计定稿；核心（台账/账户/`applyPoints`/渠道注册）已在 M5.5 S4-5 落地（`apps/web/src/lib/points/`），奖励规则与签到在 M7。
> 方针（站长 2026-10-23）：积分抽象为「用户积分」，**显示名可配置**（零数据部署默认「积分」；青翼导入把它设为「青翼币」，见 `migration/src/steps.ts`）；功能弱化为**台账**，不扩展钱包/多币种；
> 积分主要通过**发帖、回帖、签到**获取，其他获取方式砍掉；但**消费与获取的抽象必须预留**，以便将来接入新渠道。

## 1. 数据模型

| 表 | 关键列 |
|----|--------|
| `point_accounts` | `user_id` PK, `balance`(≥0), `lifetime_earned`, `lifetime_spent`, `updated_at` |
| `point_ledger` | `id`, `user_id`, `delta`(非 0), `balance_after`, `channel`(varchar 48), `ref_type`, `ref_id`, `idempotency_key`(**唯一**), `note`, `created_at` |

- 台账只增不改不删；余额快照 = 台账之和（对账断言）。
- `channel` 用命名空间字符串而非 enum，新增渠道不需要改表。
- 显示名等配置放 `site_settings`：`points.name`（默认「积分」，定义在 `packages/db/src/authz-vocab.ts` 的 `DEFAULT_SITE_SETTINGS`；青翼导入覆盖为「青翼币」）、`points.gate_fee_rate`（默认 0）、各渠道奖励规则（M7）。

## 2. 单一入口 `applyPoints`

```ts
applyPoints({ userId, channel, delta, ref?, idempotencyKey, note? })
```

在一个事务内：锁账户行 → 校验（支出时余额不得为负）→ 写台账（`idempotency_key` 唯一，重复调用返回既有结果）→
更新余额快照 → 提交后派发事件 `points.changed`（`{ userId, channel, delta }`）。

**任何积分变动不得绕过此函数**（代码评审与 lint 规则约束）；管理员手工调整同样走它（`channel = adjust.admin`，并写 `audit_log`）。

### 2.1 实现要点（M5.5 S4-5）

- 两个入口：`applyPoints(req)` 自己开事务、提交后派发 `points.changed`；`applyPointsInTx(tx, req, channel)` 供多步原子操作（如 `unlockGate`）在调用方事务内记账，
  不提交、不派发，把待派发事件交还最外层。**渠道由调用方在事务外解析好传入**（`resolveChannelOrThrow` / `builtinChannel`），事务内不再借用第二条连接。
- 锁内顺序：锁账户行（`lockAccount`）→ 幂等判定（`FOR UPDATE` 当前读）→ 余额判定 → 写台账 → 更新余额与累计收支。同一幂等键重放返回既有结果；
  同键却用于不同用户/渠道/金额报 `IdempotencyConflictError`。
- **守卫测试** `no-direct-points-write.test.ts`：`lib/points/` 之外的运行时代码不得 insert/update/delete `point_ledger` / `point_accounts`（含手写 SQL）。
- 模块声明的渠道随模块启停（停用即拒绝）；内置渠道 `opening` / `spend.gate_unlock` / `earn.gate_sale` 属于核心。
- **日上限执行（M7）**：仅对声明 `dailyCap: true` 的渠道生效——发放事务内（账户行锁后、插台账前）按
  `(user_id, channel, 北京自然日)` 聚合当日已发放额，「已发放额 + 本次金额」**超过上限则跳过**（上限不可逾越）。
  依赖 `point_ledger` 增量索引 `(user_id, channel, created_at)`。

## 3. 渠道注册（`pointChannels`）

模块内核第七类注册边界。模块在 `defineModule` 中声明：

```ts
pointChannels: [
  { key: "earn.post",    direction: "earn",   label: "发帖奖励",   dailyCap: true },
  { key: "earn.reply",   direction: "earn",   label: "回帖奖励",   dailyCap: true },
  { key: "earn.checkin", direction: "earn",   label: "签到奖励" },
  { key: "adjust.admin", direction: "adjust", label: "管理员调整" },
]
```

- 门控两侧（`spend.gate_unlock` / `earn.gate_sale`）与期初 `opening` 是**内置渠道**（`kernel/builtin.ts`，
  随积分核心、不随模块启停），模块**不得**重复声明——注册期重名校验直接失败（2026-10-25 修正：本示例此前误列了这两个渠道）。
- 未注册的渠道调用 `applyPoints` 直接拒绝（防拼写错误与未审查的新渠道）。
- 渠道规则读 `site_settings`（读取带校验、失败回落默认值，仿 `limits`），M7 提供配置界面（`/admin/points`）：
  - `points.reward`：`{ post: 3, reply: 1, postDailyCap: 0, replyDailyCap: 0 }`——数值为旧站实测
    （`credit.strategy`：`post_topic` = 3、`post_reply` = 1）；日上限 0 = 不限（旧站即无上限），后台可设。
  - `punch.reward`：`{ min: 1, max: 5 }`——旧站 `punch.reward`（随机，min=1 max=5）原样。
- 将来的打赏、商城、活动奖励 = 新模块声明新渠道，积分核心零改动。
  （旧站「精华 +5」`digest_topic` 与「邀请注册奖励」不在本期获取途径内——将来若做 = 新渠道，见 [M7 遗留](milestones/M7-gamification.md)。）

## 4. 首批渠道

| 渠道 | 方向 | 落地里程碑 | 说明 |
|------|------|-----------|------|
| `opening` | earn | M5.5 迁移 | 迁移期初余额（每人一条，备注「迁移期初」） |
| `spend.gate_unlock` | spend | M5.5 服务 / M6 交互 | 门控购买，见 [GATES.md](GATES.md) §5 |
| `earn.gate_sale` | earn | 同上 | 作者收益；手续费 `points.gate_fee_rate` 默认 0 |
| `earn.post` / `earn.reply` | earn | M7 | 发帖/回帖奖励（消费 `thread.created`/`thread.replied` 事件），含日上限；初值 +3 / +1（旧站实测） |
| `earn.checkin` | earn | M7 | 签到奖励（旧站随机 1–5） |
| `adjust.admin` | 双向 | M7 | 管理员手工调整，强制备注 + 审计 |

## 5. 旧数据迁移

| 来源 | 处理 |
|------|------|
| `nw_user_data.credit1`（8,350 人非零，合计 459,556；3 人为负） | 每人一条 `opening` 分录，负数按 0 并入报告 |
| 银行（`nw_app_bank`，30 户；活期 3,468 + 定期 93,182） | 结算计入余额，备注「银行结算」 |
| `credit2` 羽毛（66 人）、`credit3` 入住资格证（11 人）、`credit4–8` | 丢弃 |
| `nw_credit_log`（93,765）、`pw_creditlog`（77,106） | **不迁流水**（起点 2013-02、与余额对不上） |
| `credit_log.logtype='punch'`（约 72,992 条） | 仅提取签到日期 → `checkins` |

对账：`SUM(point_ledger.delta) = SUM(point_accounts.balance) = 旧 credit1 非负求和 + 银行结算`。

## 6. 取消的旧机制

任务奖励、勋章奖励、被赞奖励、抽奖、银行利息、积分转账、积分商城、多币种、等级升级——全部不实现。
旧站这些获取途径在 2019 年后均已无活动，且与「积分只靠发帖/回帖/签到」的方针冲突。
