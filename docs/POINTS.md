# 积分（Points）规范

> 状态：M5.5 设计定稿；核心（台账/账户/`applyPoints`/渠道注册）在 M5.5，奖励规则与签到在 M7。
> 方针（站长 2026-10-23）：积分抽象为「用户积分」，**显示名可配置**（默认「青翼币」）；功能弱化为**台账**，不扩展钱包/多币种；
> 积分主要通过**发帖、回帖、签到**获取，其他获取方式砍掉；但**消费与获取的抽象必须预留**，以便将来接入新渠道。

## 1. 数据模型

| 表 | 关键列 |
|----|--------|
| `point_accounts` | `user_id` PK, `balance`(≥0), `lifetime_earned`, `lifetime_spent`, `updated_at` |
| `point_ledger` | `id`, `user_id`, `delta`(非 0), `balance_after`, `channel`(varchar 48), `ref_type`, `ref_id`, `idempotency_key`(**唯一**), `note`, `created_at` |

- 台账只增不改不删；余额快照 = 台账之和（对账断言）。
- `channel` 用命名空间字符串而非 enum，新增渠道不需要改表。
- 显示名等配置放 `site_settings`：`points.name`（默认「青翼币」）、`points.gate_fee_rate`（默认 0）、各渠道奖励规则（M7）。

## 2. 单一入口 `applyPoints`

```ts
applyPoints({ userId, channel, delta, ref?, idempotencyKey, note? })
```

在一个事务内：锁账户行 → 校验（支出时余额不得为负）→ 写台账（`idempotency_key` 唯一，重复调用返回既有结果）→
更新余额快照 → 提交后派发事件 `points.changed`（`{ userId, channel, delta }`）。

**任何积分变动不得绕过此函数**（代码评审与 lint 规则约束）；管理员手工调整同样走它（`channel = adjust.admin`，并写 `audit_log`）。

## 3. 渠道注册（`pointChannels`）

模块内核第七类注册边界。模块在 `defineModule` 中声明：

```ts
pointChannels: [
  { key: "earn.post",    direction: "earn",  label: "发帖奖励",   dailyCap: true },
  { key: "earn.reply",   direction: "earn",  label: "回帖奖励",   dailyCap: true },
  { key: "earn.checkin", direction: "earn",  label: "签到奖励" },
  { key: "earn.gate_sale",   direction: "earn",  label: "门控收益" },
  { key: "spend.gate_unlock", direction: "spend", label: "解锁内容" },
]
```

- 未注册的渠道调用 `applyPoints` 直接拒绝（防拼写错误与未审查的新渠道）。
- 渠道规则（奖励数值、日上限）读 `site_settings`，M7 提供配置界面；`dailyCap` 的计数基于台账（按北京时间自然日聚合）。
- 将来的打赏、商城、活动奖励 = 新模块声明新渠道，积分核心零改动。

## 4. 首批渠道

| 渠道 | 方向 | 落地里程碑 | 说明 |
|------|------|-----------|------|
| `opening` | earn | M5.5 迁移 | 迁移期初余额（每人一条，备注「迁移期初」） |
| `spend.gate_unlock` | spend | M5.5 服务 / M6 交互 | 门控购买，见 [GATES.md](GATES.md) §5 |
| `earn.gate_sale` | earn | 同上 | 作者收益；手续费 `points.gate_fee_rate` 默认 0 |
| `earn.post` / `earn.reply` | earn | M7 | 发帖/回帖奖励（消费 `thread.created`/`thread.replied` 事件），含日上限 |
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
