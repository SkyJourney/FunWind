# M7 · 积分与荣誉（积分台账 / 签到 / 荣誉徽章）

- 阶段：二·核心 ｜ 覆盖模块：M07 ｜ 依赖：M6（需要真实事件流）；积分核心由 M5.5 交付
- 状态：⬜ 未开始

## 目标

**模块注册表的第一个真实生产-消费闭环**：积分模块声明渠道（`pointChannels`）并消费发帖/回帖事件、签到模块、徽章模块，
既兑现情怀数据，又验证内核的插件化承诺。

> 范围大幅收缩（2026-10-23 站长决策）：积分抽象为「用户积分」（显示名可配，默认「青翼币」），只做台账；
> 获取途径仅**发帖、回帖、签到**；等级/成长系统、任务引擎、勋章自动颁发、银行、抽奖、积分商城整体取消。
> 抽象保留：渠道注册使将来接入新的获取/消费渠道不改核心（见 [POINTS.md](../POINTS.md)）。

> **开工拍板（2026-10-25 站长，M7 前审查后）**：
> 1. **outbox 提前到 M7**（原归 M8-1）：业务事务内写 `event_outbox`，提交后同步派发为快路径，崩溃后由巡检补派
>    （at-least-once + 消费端幂等）。本期覆盖 posting 事件族（`thread.created` / `thread.replied` / `content.submitted` /
>    `attachment.uploaded`）；gate / message 等其余事件仍归 M8-1。
> 2. **帖子页徽章走槽位** `thread.user-badge`（组件组合方案否决）；资料页徽章走 `profile.header`。
> 3. **奖励初值（旧库只读实测）**：发帖 +3（`credit.strategy.post_topic`，nw_credit_log 4,051 条 affect 全为 3）、
>    回帖 +1（`post_reply`，10,841 条全为 1）、签到随机 1–5（`punch.reward` min=1 max=5 step=1）；
>    旧站**无日上限**（limit 空）→ 新站默认不限（0），后台可设；精华 +5（`digest_topic`）不在本期获取途径内，记遗留。
> 4. 不拆 M7.x 子文档，本文件按 S1–S7 checklist 推进。

## 范围（做什么）

1. **积分模块**（`defineModule`）：声明 `earn.post` / `earn.reply` / `earn.checkin` 渠道；消费 `thread.created`、`thread.replied`
   自动发放（经 M5.5 的 `applyPoints`，幂等键 `thread:{id}`）；奖励数值与日上限放 `site_settings`（后台可配置，初值参考旧站配置）；
   积分页（余额 + 台账分页）；个人资料页积分展示；管理员手工调整（强制备注 + `audit_log`）；积分显示名配置。
2. **签到模块**：每日签到（北京时间自然日边界）+ 连签计数 + 奖励（旧站随机 1–5，规则 `punch.reward` 配置化）；
   迁移来的 `checkins` 历史驱动连签；签到入口与日历组件（消费 M2 槽位）。
3. **荣誉徽章**：`badges` / `user_badges` 展示（团队徽章：字幕制作组/技术分流组/实习组/美工组/策划组 + 25 枚旧勋章）；
   **手动授予**（后台）；资料页与帖子页佩戴展示；纯装饰、零权限语义。
4. 全部以 `defineModule` 实现：各自注册事件消费、槽位、权限点、路由、渠道。

> **槽位与内核扩展（2026-10-25 定稿）**：首页签到入口**复用** `home.after-header`；新增页面槽位
> `profile.header`（资料页徽章卡）与 `thread.user-badge`（帖子页 UserBadge 内的荣誉徽章位），`SlotContext` 扩
> `userId?`——按契约修改 `kernel/types.ts` 并在 docs/MODULES.md 说明，不是私设插入点。组件组合方案已否决（拍板 2）。
> 因此验收门禁的「零内核改动」按「**零内核机制破坏**」理解：registry / bus / slot 既有语义不变，
> 清单扩展（槽位 / 上下文 / outbox 派发路径）走既定流程并留档。

## 边界（明确不做什么）

- 不做等级/升级引擎；不做任务系统（旧任务引擎死于 2017，「每日红包」任务从未开启）；不做勋章自动颁发。
- 不做银行、抽奖、积分转账、积分商城；不做多币种。
- 不做门控购买（属于 M5.5 服务与 M6 交互，本期仅消费其 `gate.unlocked` 事件做展示）。

## 测试规则

- 单测：发放幂等（同一事件重复派发不重复加分）、日上限（北京时间自然日边界 23:59:59 / 00:00:01）、
  并发发放（事务/幂等键）、连签中断重置；覆盖率 ≥ 90%。
- outbox：注入「事务提交后不派发」→ drain 补齐 → 幂等不重复记账；并发 drain（SKIP LOCKED）无重复派发；
  滞留 pending 有 `db:verify` 检查。
- 集成：对账——`SUM(point_ledger.delta) = SUM(point_accounts.balance)`；随机抽 50 用户，台账重放 = 余额。
- E2E：发帖→积分入账→签到→连签→徽章手动授予→展示位更新；管理员调整出审计；
  模块装卸回归（禁用积分/签到/徽章模块后相关槽位消失，主体与台账不受损）。

## 验收门禁

- [x] 三类能力全部经 `defineModule` 注册（代码评审确认零内核**机制**破坏；槽位/上下文清单扩展按 MODULES.md 既定流程留档；`pointChannels` 契约已由 M5.5 就位）
- [x] outbox：posting 事件族经 `event_outbox` 可靠派发——集成测试证明「提交后不派发」可由 drain 补齐且幂等；`db:verify` 滞留检查就位（`outbox:无滞留 pending`）
- [x] 奖励数值与日上限经 `site_settings` 后台可配置且配置变更出审计（`/admin/points`，`setting.update` 审计，config-audit 测试锚定）
- [x] 单测/对账/E2E 全绿；装卸回归通过（注册表验收的硬指标）
- [x] 签到时区边界用例全过（`todayBeijing()` 与 `nowBeijingWallTime()` 同口径单测锚定；服务器时区无关性由 `lib/datetime` 的 UTC+8 换算与连接层 `SET time_zone='+08:00'`（db:verify 4b）保证）
- [ ] 旧数据展示无回归（团队徽章/勋章抽样 20 人对照旧站）——**自动化部分已覆盖**（迁移 verify 的徽章三件套：徽章数/引用完整/团队持有人对账 + E2E badges.spec 展示断言）；**人工抽样对照旧站截图待站长验收**
- [x] `pnpm verify:all` 与 `pnpm test:e2e` 全绿；`perf:posting` p95 < 300ms（earn 消费者已入请求路径）；CHANGELOG 记录
  （实测 2026-10-25：verify:all = content 50 + db 66 + web 1244 + migration 251 全过；test:e2e = 桌面/移动 162 + 生产冒烟 10；db:verify 21 项；perf:posting p95 15.3 ms）

## 阶段推进（S1–S7，2026-10-25 开工）✅ 全部完成

- [x] **S1 开工文档定稿**：本文件拍板与阶段化；ROADMAP 🚧；POINTS.md（dailyCap 语义、奖励配置 key、初值）；旧库只读查初值（`credit.strategy`：post_topic=3 / post_reply=1；`punch.reward` 1–5）
- [x] **S2 权限与配置底座**：`admin.points` / `admin.badges` 权限点 + 基线授权（含存量库增量迁移 upsert）；`points.reward` / `punch.reward` settings key（zod 回落）；`point_ledger (user_id, channel, created_at)` 索引；`event_outbox` 表
- [x] **S3 outbox 可靠派发**：enqueue/drain/emit 捎带巡检/`outbox:drain` 脚本/`db:verify` 滞留检查；posting 三处事务内 enqueue + 快路径；崩溃注入与并发 drain 集成测试
- [x] **S4 积分模块**：`lib/points/earn.ts`（事件消费+锁内日上限）；模块注册（earn.post/earn.reply/adjust.admin）；`/points` 页 + 顶栏入口；`/admin/points`（配置+调整+显示名，审计）；earn 测试/并发/对账；points.spec
- [x] **S5 签到模块**：`lib/checkin`（自然日/连签/随机奖励/`checkin.done`）；模块注册（earn.checkin）；`home.after-header` 签到条+迷你日历（不显示他人活动）；时区与并发测试；checkin.spec
- [x] **S6 徽章模块与展示**：内核 SlotName/SlotContext 扩展；`lib/badges`（授予+审计+`badge.awarded`）；`profile.header` 徽章卡；UserBadge 头像（M7-3）+`thread.user-badge` 槽位；`/admin/badges`；重复发放并发用例；badges.spec + 装卸回归
- [x] **S7 退役与收尾**：demo-checkin 退役（清单见「开工前审查要点」3）；M7-1 双真连接并发；M7-4 附件恢复 E2E；`db:verify` 积分对账项；perf:posting 重测；verify:all+test:e2e 全绿；门禁勾选/CHANGELOG/ROADMAP/carryover 清账

## 遗留事项

- 将来新增积分渠道（打赏、活动奖励等）= 新模块声明渠道，不在本期范围。
- 旧站「精华 +5」（`digest_strategy.digest_topic`）与邀请注册奖励不在本期获取途径内——将来若做 = 新渠道（POINTS.md §3 已记）。
- **人工验收**：团队徽章/勋章抽样 20 人对照旧站截图（自动化对账已过，见门禁第 6 项）。
- 签到日历的独立页化、积分页的图表化 → 归 M10.5 视觉打磨统一处理。
- M8-1 剩余事件（`gate.unlocked` / `message.sent` 等）的 outbox 接入（机制零改动，业务事务内 enqueue 即可）。

## 复验发现（2026-10-25 收尾实测记录）

实施期间被测试或审查抓到并当场修正的项（每项带回归测试或用例）：

1. **迁移授权插入 vs bootstrap 基线语义的相互作用**（S2）：迁移先行插入 `admin.points/badges` 授权会让
   「角色尚无授权行才整批写基线」在全新库上跳过全部基线。处置：迁移改为 **EXISTS 守卫插入**（仅对
   admin 已有其它授权行的存量库补授），bootstrap 语义与测试锚点保持不变。
2. **日上限语义缺陷**（S4）：初版「已发放 ≥ 上限才跳过」允许超限一档；并发测试 10 路放行 2 笔。改为
   「已发放 + 本次 > 上限即跳过」，并发恰 1 笔成为确定性断言。
3. **username 查询口径**（S4）：`findUserIdByName` 初版裸查 `username` 列（_ai_ci），与登录的归一化键
   身份口径不一致；改走 `username_key` 并加断言（大小写同身份）。测试夹具用例同步修正。
4. **outbox actorId 未透传**（S6）：补派/快路径没把入队时的 actor 传给 emit，`badge.awarded` 的
   event_log actor 回退成接收者；修正为透传 + payload 映射兜底。
5. **签到幂等冲突 500**（S5/E2E）：「签到行不在而台账在」的异常数据下随机奖励金额不匹配会抛
   IdempotencyConflictError；降级为按已签处理并告警（正常路径由联合主键先兜住，理论不可达）。
6. **附件空列表不可恢复**（S7/M7-4，**M6 审查 F-5 修复的真实缺口**）：`commit` 清空列表时删除草稿键，
   「移除全部附件」的修改无法进入暂存，冲突后恢复提示永不出现；空列表改为照常持久化，M7-4 E2E 覆盖。
7. **模块槽位渲染器 × defineAction 求值环**（S5）：签到模块静态引入 Server Action 会构成
   「模块 → defineAction → "@/modules"」循环（TDZ）。处置：渲染期动态 import；`use-server` 导出守卫
   抓住中间态的手写 action 后恢复 defineAction 版本——守卫有效性的实证。
8. **演示横幅的登录链接子串冲突**（S7）：签到条「登录后签到」使 auth.spec 的 `name: "登录"` 断言命中
   双元素；选择器加 `exact: true`。
9. **设计偏离留档**：outbox 巡检**未用**计划里的 `FOR UPDATE SKIP LOCKED` 行锁——持锁跨消费者派发会
   久借连接（与 applyPoints 纪律冲突）；改为「无锁 + 并发重复派发由消费端幂等吸收」的 at-least-once
   语义（MODULES.md §8 写明），并发 drain 测试断言「每行 ≥1 次、重复有界、最终全标记」。

## 承接的 M6 遗留（随 M7 一起处理）

完整清单（含其它里程碑的事项与已接受项）见 [M6 未完成事项](M6-carryover.md)。与 M7 直接相关的四项：

- **M7-1 解锁事务的真实并发测试**：两条真实连接并发「购买」与「版主隐藏」，断言不出现扣费而未解锁，也不出现隐藏后仍能购买。与 M7-2 的积分并发测试放在一起写。
- **M7-2 积分相关并发测试的统一口径**：所有写积分的事务都以 `POINTS_TX_OPTIONS`（READ COMMITTED）开启；新增「同一用户同一天重复签到」「同一荣誉重复发放」的并发用例。
- **M7-3 帖子页的用户徽章与头像**：帖子页的 `UserBadge` 目前只有首字母；荣誉徽章上线后，帖子页显示头像（无则首字母）与荣誉徽章。
- **M7-4 附件冲突恢复的 E2E**：编辑冲突 → 提示恢复附件 → 保存成功，附件与提交版本一致。

## 开工前审查要点（2026-10-25 M7 前代码审查）

M7 前健康审查（模块内核、积分核心、门控事务、schema、门禁体系逐项核对）未发现 P0/P1 缺陷；
以下三点是开工设计时要先定的事：

1. **积分发放继承「提交后派发」的丢失窗口**：`thread.created` / `thread.replied` 在发帖事务提交后同步派发，
   进程崩溃即丢（即 [M6-carryover](M6-carryover.md) M8-1 的 outbox 议题）。earn.post / earn.reply 消费这些事件，
   等于入账有同样的窗口。**✅ 已拍板（2026-10-25，见「开工拍板」1）：outbox 提前到 M7**，posting 事件族经
   `event_outbox` 可靠派发；M8-1 剩余 gate/message 等事件。
   伴生两点：消费者内 `applyPoints` 给发帖请求增加一个事务的延迟，M7 须重测 `perf:posting` 基线；
   日上限按「用户×渠道×北京自然日」聚合台账，现有索引 `(user_id, id)` / `(channel, created_at)` 不覆盖，
   随 M7 增量迁移加 `(user_id, channel, created_at)`。
2. **最小后台入口与 M9 的边界**：完整后台控制台在 M9，但本期 E2E 要求「管理员手工调整积分（强制备注 + 审计）」
   与「徽章手动授予」。M7 自建最小管理动作/页面（自带 `requireAdmin` 与 `audit_log`），M9 整合进 `/admin` shell
   时迁移之——在 M7 文档记一笔，避免开工后才发现要跨界做管理界面。
3. **demo-checkin 的退役面**：真实签到模块替换 demo 模块时，同步处理 `modules/index.ts` 清单、
   demo 自身单测、`e2e/modules.spec.ts` 断言，以及 M6.5c 建立的「业务事件演示计数」验收
   （`attachment-events` 集成测试依赖 demo 计数）——事件消费链路的验收改为挂在真实积分模块上。

