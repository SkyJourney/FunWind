# M7 积分与荣誉：代码审查与整改记录（2026-10-25）

> 对象：M7 全部改动，提交区间 `13666a2..c000c40`（S1–S7 共 8 个提交：outbox 机制、积分/签到/徽章三模块、内核槽位扩展、管理页、全部测试与文档）。
> 方式：5 个只读审查者并行（积分写路径；事务性 outbox；签到；徽章与内核扩展；数据层/权限底座/E2E），不带结论只看代码；主审对每条发现回到代码核实，关键项以测试实证。审查者原始发现约 40 条，合并去重后 **P1 × 1、P2 × 7、P3 × 约 25**。
> 另：站长同日签收「旧勋章迁移即达标」（不做旧站样式对照），M7 门禁全部闭合。
> 本报告不含任何口令、邮箱等敏感值。

## 0. 结论

- **无 P0**。未发现越权、数据损坏或资金（积分）凭空产生/双花的路径。
- **P1 × 1**（outbox 对「消费者异常」静默失效）与 **P2 × 7** 全部核实后修复，每项带回归测试；P3 中 15 项顺手修复，其余记录在案（§4）。
- 审查的核心价值：outbox 的可靠性承诺在四个失败象限中只覆盖了两个（基础设施失败、业务性拒绝），「消费者执行失败」象限静默丢失且不可观测——整改后 outbox 语义与文档宣称一致。
- 验证：`verify:all`（web 单测 1249 项、db 66、content 50、migration 251）、`test:e2e`（桌面与移动 162 项、生产冒烟 10 项）、`db:verify` 21 项全部通过。

## 1. 逐条发现与处置

核实状态：**已核实**＝主审读代码确认；**实测**＝另有测试/用例证明。

### 1.1 outbox（审查者 2 + 积分写路径审查者交叉）

| 编号 | 级别 | 问题 | 核实 | 处置 |
|---|---|---|---|---|
| O-1 | **P1** | 内核 `emit` 把消费者异常吞进 `EmitResult.errors` 不抛出；`dispatchOutboxRows`/`drainOutbox` 不检查该数组，emit 正常返回即标记 `dispatched`。消费者抛错（死锁重试耗尽、余额溢出、读库失败）→ 积分未入账但 outbox 行已关闭——**永不重试、奖励静默丢失**，唯一痕迹是 `event_log.errorJson`。声称的 at-least-once 只覆盖「派发基础设施失败」与「崩溃窗口」，不覆盖「消费失败」 | 已核实（bus.ts:105-112 + outbox.ts 两处派发路径）；原测试只用注入 emitter 抛错模拟，绕过了内核的错误隔离，真实路径零覆盖 | 修复：两条派发路径识别 `EmitResult.errors` 非空 → `recordDispatchError` 保持 pending 补派；新增真实内核路径回归测试（注册抛错消费者，行保持 pending、错误摘要含消费者消息） |
| O-2 | P2 | 编辑路径（`mutate.ts`）新建附件的 `attachment.uploaded` 与重新提审的 `content.submitted` 仍走提交后直发——「posting 事件族经 outbox」的宣称只在创建路径成立，S3 行「三处事务内 enqueue」与代码不符 | 已核实 | 修复：编辑事务内对两族事件 `enqueueEventInTx`（每次尝试重置收集器），提交后快路径；MODULES.md §8 措辞改为「发主题 / 回帖 / 编辑三处」 |
| O-3 | P2 | 毒行无重试上限/退避：`id ASC` 的批首被持续失败的行永久占住，更新的合法行饿死；`outbox:drain` 脚本遇毒行停止且零派发时以退出码 0「正常结束」 | 已核实 | 修复：`dispatch_error.attempts` 累计——**重复失败（≥2 次）且 10 分钟内失败过**的行退避跳过（首次失败立即重试，瞬态故障不受延迟）；脚本零派发时非零退出并提示人工介入 |
| O-4 | P3 | `checkin`/`badges` 的 `enqueued` 收集器声明在 `withDeadlockRetry` 外、不按尝试重置（posting 有显式纪律）；COMMIT 阶段死锁重试后会把已回滚的行再派发一次 | 已核实 | 修复：两处改为每次尝试重置（与 posting 同注释同纪律） |
| O-5 | P3 | `schema.ts` 的 event_outbox 注释仍写「SKIP LOCKED」「不重不丢」，与实现（无锁 at-least-once）及 MODULES.md §8 矛盾；`schema-rules` 断言 44 表未随 outbox 更新（已在 S7 更新为 45） | 已核实 | 修复：注释改写为与实现一致的语义描述 |
| O-6 | P3 | `enqueueEventInTx(tx: DbExecutor)` 在类型层无法强制传事务句柄（误传连接则原子性静默失效）；零消费者/模块停用时行照常关闭 | 已核实（现有缓解：defineAction 顶层 import "@/modules" + import-guard 静态守护 + drain 脚本显式 import） | 记录不修（§4）；M8-1 新接入方按 MODULES.md §8 对接 |
| O-7 | P3 | dispatched 行永不清理（约 2 万行/年量级）；`pendingLeft` 全表 COUNT 在正常并发下也会触发 sweep 告警（日志噪音）；drain 每行一条标记 UPDATE | 已核实，量级尚小 | 记录不修（§4）：行清理挂到 M13 前的 gc 决定；告警文案待噪音实际出现再收紧 |
| O-8 | P3 | drain 补派不重新校验载荷（手工改坏的 payload 直达消费者） | 已核实，仅人工改库可触发 | 记录不修（纵深防御，入口已校验） |

### 1.2 积分写路径（审查者 1）

| 编号 | 级别 | 问题 | 核实 | 处置 |
|---|---|---|---|---|
| P-1 | P2 | `resolveChannelOrThrow(...).catch(() => null)` 把**一切**异常（含 module_state 读库失败）归为「渠道不可用」——消费者正常返回、event_log 无错误痕迹、outbox 不补派，与 O-1 叠加时连痕迹都没有 | 已核实（earn.ts 与 checkin/service.ts 同款写法） | 修复：只捕获 `UnregisteredChannelError`，其余异常照常抛出（经 O-1 修复后的 outbox 保持 pending 补派）；两处同步 |
| P-2 | P2 | 管理员手工调整无任何防重：随机 UUID 幂等键 + 表单按钮无 pending 态 + 动作无频控——注释声称「UI 提交与频控负责」，实际两层皆空，双击/代理重试 = 两笔调整两条审计 | 已核实（defineAction 未声明 rateLimit；按钮为普通 submit） | 修复：新增 `SubmitButton`（`useFormStatus` 提交中禁用）接入 /admin/points 两个表单与 /admin/badges 授予表单。频控不加（管理动作，防抖已够；记录于 §4） |
| P-3 | P2 | `/admin/points` 四个数值输入无 `required`，空串经 `z.coerce.number()` 变 0——清空「发帖奖励」提交即**静默关闭该渠道奖励**（0 = 关闭语义），仅审计可查 | 已核实 | 修复：输入加 `required`；zod 对空串按缺失处理（`z.preprocess` → 404，与 defineAction 对畸形输入的既有口径一致） |
| P-4 | P3 | reward strict 校验失败整体回落默认 + 管理页从同一函数取值——手工写坏配置时页面显示回落后的数值且无提示 | 已核实，自愈路径存在（下次保存写回合法形状） | 记录不修（§4） |
| P-5 | P3 | `cap < amount` 的组合合法通过校验，但首笔即超限 = 渠道永久静默失效 | 已核实 | 修复：schema 加跨字段 refine（日上限 ≥ 奖励额或为 0）+ 测试 |
| P-6 | P3 | 幂等重放遇「今日已超限」返回 `daily_cap` 而非幂等既有结果（reason 标签不准，行为无碍）；日上限按入账日聚合，昨日崩溃今日补派遇满额会被拒——口径的自然推论 | 已核实 | 记录（POINTS.md 语义已写明「上限不可逾越」） |
| P-7 | P3 | `lockAccount`/`applyPoints` 不校验 userId > 0，可为幽灵用户建账户（无外键，对账查不出该方向孤儿） | 已核实，现有调用方不可能产生 | 记录不修（§4） |

### 1.3 签到（审查者 3）

| 编号 | 级别 | 问题 | 核实 | 处置 |
|---|---|---|---|---|
| C-1 | **P2** | `datesOf` 单页 `limit(1000)` 截断——连签超 1000 天时 streak 恒报 1000。老站 punch 数据 2010 年起迁移，三年全勤即 1095 天，是本功能宣称服务的现实场景 | 已核实 | 修复：keyset 翻页直至连续链断开（护栏 10 万行 ≈ 274 年）；真实 DB 行的跨页行为由既有 int 测试覆盖（纯函数测试已锚定跨月/跨年） |
| C-2 | P3 | `IdempotencyConflictError` 降级为 already：异常数据（签到行被删台账还在）下用户当天永久签不上且每次静默 already | 已核实（正常路径不可达，PK 先兜底） | 记录不修（§4；console.warn 已在） |
| C-3 | P3 | `getMonthCheckins` 用 `-31` 作上界，短月非法 DATE 使谓词为 NULL 返回空集（当前零调用方） | 已核实 | 修复：上界改次月 1 日 |
| C-4 | P3 | 签到条 today 高亮依赖宿主 force-dynamic（现两宿主均满足），模块侧无留痕；`checkinAction` 丢弃 `channel_unavailable` 结果且无频控 | 已核实 | 记录不修（§4）；无频控的实害被 PK 幂等兜底 |
| C-5 | P3 | int 测试的 punch.reward 恢复不在 finally（中途失败连锁污染）；跨午夜运行脆弱（`opts.today` 注入存在但零使用）；e2e 库的 earn.checkin 台账残留会破坏 SUM=SUM 恒等式 | 已核实 | 修复：恢复挪入用例内保证（断言失败即红，见整改后实测）；points.spec 的 beforeAll 清理补入 `earn.checkin`；跨午夜脆弱记录不修（§4） |

### 1.4 徽章与内核扩展（审查者 4）

| 编号 | 级别 | 问题 | 核实 | 处置 |
|---|---|---|---|---|
| B-1 | P3 | `grantBadgeByAdmin` 不校验目标用户存在且未注销（service 层不变量依赖调用方把关） | 已核实（无外键表，新调用方可绕过） | 修复：事务内补用户存在性检查 |
| B-2 | P3 | `/admin/badges?uid=abc` → `Number("abc")=NaN` 进查询 → 500 | 已核实（资料页有 parseUid 防御，此处没有） | 修复：纯数字守卫 |
| B-3 | P3 | 展示查询的**过期过滤**零测试（expiresAt 只能由迁移数据触达，恰是最缺保护的死代码分支）；badge.awarded 的 event_log 断言无排序限定（偶发脆弱） | 已核实 | 修复：补过期/未过期双向断言（夹具自清理）；断言改按 source 过滤 + 降序取最新 |
| B-4 | P3 | `isDuplicateKey` 只穿透一层 cause——当前 drizzle mysql2 不二次包装（已核实 0.45.4 源码），升级时可能静默退化 | 已核实 | 记录不修（升级检查项） |
| B-5 | P3 | `Slot` 组件的 ctx 透传/异常隔离无单测（只有纯函数 selectSlotRenderers 有）；e2e 夹具一处硬编码 90001 | 已核实 | 修复夹具硬编码（→ `USERS.alice`）；Slot 单测记录不修（slot.tsx 在覆盖率豁免清单内） |

### 1.5 管理页与 E2E（审查者 5）

| 编号 | 级别 | 问题 | 核实 | 处置 |
|---|---|---|---|---|
| A-1 | P2 | `/admin/points` 的错误路径整体失效：`toAdminError` 只转换不跳转，`?error=` 展示是死代码——输错用户名得 500 而非可读提示（badges 同批实现是对的） | 已核实 | 修复：`toAdminErrorBack` 直接 redirect（与 admin/badges、admin/actions 同法） |
| A-2 | P3 | saveRewardAction 两次 setSetting 不在同一事务（部分保存可自愈）；成功文案「变更已记入审计」在值未变化时不成立 | 已核实 | 文案已修（「值有变化时记入审计日志」）；非原子性记录不修（§4） |
| A-3 | P3 | events.spec 测试名声称「outbox 全部标记」，实际附件事件断言被 title 过滤永久排除 | 已核实 | 修复：补按 uploaderId 过滤的 attachment.uploaded 已派发断言 |
| A-4 | P3 | 装卸 E2E 两条路径（直改 module_state vs dev API）保真度不一致；points 模块停用无专门 E2E；checkin spec 串行链重跑脆弱 | 已核实 | 记录不修（§4） |
| A-5 | P3 | 后台导航不按 admin.points/badges 过滤（与既有「角色与授权」同待遇） | 已核实（既有模式） | 记录不修（M9 后台 shell 统一按权限点过滤菜单） |
| A-6 | P3 | M7 文档残留三处与实现不符：测试规则行「并发 drain（SKIP LOCKED）」（同文件复验发现 9 已声明无锁）；「config-audit 测试锚定」措辞超出实际（通用路径锚定）；e2e 对账恒等式会被 checkin 残留破坏 | 已核实 | 前两处已改写；第三处见 C-5 修复 |

## 2. 审查者说法在核实后的修正

- 同一问题（消费者异常静默关闭 outbox 行），outbox 审查者标 P2、积分写路径审查者标 P1。主审采纳 **P1**：它使里程碑的核心承诺（at-least-once + 补派）在最常见的失败象限不成立，且用户可感知（发帖成功奖励消失）。
- 「三处事务内 enqueue」：S3 文档行在整改前只对上了两处（service.ts 两函数），审查者指出后补齐 mutate.ts 而非改文档——编辑路径的附件事件同样值得可靠派发。
- 签到审查者对 `datesOf` 截断的量级判断（迁移长连签是现实场景）经查成立，采纳为 P2 而非审查者建议等级对应的保守值。

## 3. 测试与门禁（整改后）

- `verify:all` 通过：web 单测 1249 项（净增 5：outbox 消费失败/退避、earn reply 日上限与渠道停用、reward-config 跨字段校验）、db 66、content 50、migration 251。
- `test:e2e` 通过：桌面与移动 162 项（edit.spec M7-4、points/checkin/badges 全量回归）、生产冒烟 10 项。
- `db:verify` 21 项通过（含 `points:对账` 与 `outbox:无滞留`）。

## 4. 设计取舍与残留项（不修，留档）

| 项 | 说明 |
|---|---|
| outbox dispatched 行不清理 | 每帖 1–2 行、量级万行/年；清理策略挂 M13 前的 gc 决定（与孤儿文件同一批次） |
| 零消费者/模块停用即关闭 outbox 行 | 与「渠道随模块启停」语义一致；模块漏求值的风险由 modules-import-guard 静态守护 + defineAction 顶层求值防守 |
| `DbExecutor` 类型不强制事务 | M8-1 新接入方按 MODULES.md §8 对接；误传连接的防护靠参数名与评审 |
| 幂等重放遇日上限返回 daily_cap | 两种路径都不重复入账；reason 标签语义已文档化 |
| adjust 无 rateLimit、checkin 无频控 | 双击已由 SubmitButton 挡；脚本刷接口的实害被 PK/幂等键兜底 |
| saveReward 两次 setSetting 非原子 | 可重试自愈；合并事务需新 helper，收益低 |
| 配置无效回落时管理页无提示 | 自愈路径存在；服务端有 warn 日志 |
| 签到 e2e 跨午夜/重跑脆弱 | 编排每次全新重置库；`opts.today` 注入保留给未来需要时使用 |
| 装卸 E2E 直改 module_state | 功能等价；M9 后台接管启停时统一走生产写入口 |
| points 模块停用无专门 E2E | 停用语义（渠道拒绝）有 int 测试；装卸回归由 checkin/badges 承担 |
| Slot 组件单测、后台导航按权限过滤 | 分别随 kernel 覆盖率策略与 M9 后台 shell 处理 |

## 5. 提交索引

| 提交 | 内容 |
|---|---|
| `c5e99c9` / `dc4be89` | M7 前审查落地与 S1 开工定稿（文档） |
| `7c57240` | S2 权限与配置底座 |
| `e664b1e` | S3 outbox 可靠派发 |
| `6ee0f11` | S4 积分模块 |
| `7617f28` | S5 签到模块 |
| `badfc52` | S6 徽章模块与展示 |
| `c000c40` | S7 退役与收尾 |
| 本次整改提交 | P1×1、P2×7、P3×15 的全部修复与回归测试（见 §1 处置列） |
