# M10 投票与私信：代码审查与整改记录（2026-10-26，M10.5 前）

> 对象：M10 全部改动（`f3597ac..033eba3`，S1–S4 共 6 个提交）加上补做的管理侧与分页（`2960aef`、`adbd1c1`）。
> 方式：3 个只读审查者（投票与私信核心；管理侧与通知接线；私信页面/E2E 声明），主审逐条核实。
> 合并去重后 **P1 × 1、P2 × 12、P3 × 约 15**。本报告不含敏感值。

## 0. 结论

- **无 P0**。核心不变量（复合主键防重、pairKey 唯一、事务构成、已读联动、纯文本渲染无 XSS、错误码固定映射）经得起审查。
- P1 × 1、P2 × 12 全部修复；P3 修复约 10 项，其余留档（§4）。
- 整改后：`verify:all`（content 55 + db 66 + web **1361** + migration 251）、`test:e2e`（**188** + 生产冒烟 10）、覆盖率分支 **85.15%** 全部通过。

## 1. P1（1 项，全修）

| 编号 | 问题 | 核实 | 处置 |
|---|---|---|---|
| V-1 | **多选投票 2 项以上提交必 404**：PollBlock 渲染多个同名 `optionIds` checkbox（FormData 归并为 `string[]`），action 却声明 `z.string()`——多选场景 zod 校验失败 → defineAction 统一 404。E2E 全部用 optionLimit=1 的 radio、int 直接调 service 绕过 action 层，两层都没拦住 | 已核实（form-data.ts 的多值归并注释 + zod 形状） | 修复：optionIds 字段改 `z.union([string, string[]]).transform`，兼容两种表单形态；补多值解析断言 |

## 2. P2（12 项，全修）

| 编号 | 问题 | 处置 |
|---|---|---|
| V-2 | **vote 并发改票计数漂移**（M8 I-2 同款）：旧票无锁快照读、DELETE 不看 affectedRows 无条件 -1——并发双取消/反向改票造成选项计数永久少记、optionLimit 被突破 | 修复：旧票 `FOR UPDATE` 锁读 + DELETE `affectedRows` 检查（0 行不减计数） |
| V-3 | **vote 撞键分支返回半截事务**：删旧已提交但 insert 撞键时返回旧 optionIds（与库状态不符） | 修复：撞键返回库内现况 `oldIds`（真实剩余票） |
| P-1 | **`/admin/poll` 页面门禁 `requireAdmin()` 把版主挡死**：导航对版主可见、服务层按版主作用域设计、CHANGELOG 宣称「版主可操作」——三方矛盾，版主作用域全链路在 UI 不可达 | 修复：页面改 `requireModerator()`；导航对齐 |
| P-2 | **「私信管理」导航用 admin.logs 权限点**，页面实际要求 site.admin——持 admin.logs 者点进去 404 | 修复：导航对齐为 site.admin（私信无版块作用域，站点级） |
| P-3 | **「禁止发私信」（banPmForUser）实际是全站禁言**：mute 命中全部写类动作；且该函数无任何调用方（死代码+误导 API） | 修复：删除死代码；文档留档「禁发私信 = 用户管理页 mute（全站禁言语义）」 |
| M-1 | **notify 并发聚合死锁**：同 groupKey 并发 INSERT 触发 InnoDB 间隙锁死锁，此前只重试 duplicate key——聚合测试偶发红（M9 修复时已补 isDeadlock 重试，本次确认收敛） | 已修（M9 期间），复核确认 |
| M-2 | **vote 死锁重试不清 enqueued**：重试后重复 emit poll.voted（event_log 重复审计行） | 修复：每次尝试清空（与 posting 同纪律） |
| M-3 | **对话页消息只显示最旧 30 条且无分页 UI**：>30 条的会话最新消息不可达（close to P1—— 私信的核心场景是「看最新」） | 修复：conversationMessages 返回分页元数据，对话页加「更早/更新」分页 |
| M-4 | **/messages?to= 的错误静默丢失**：`sp.pm` 读取但从未渲染；失败后 to 参数丢失导致发起新会话卡片消失 | 修复：错误回显（码表映射）+ back 保留 to 参数 |
| N-1 | **pm.received 无会话深链**：通知页/铃铛的「X 发来私信」不可点击（targetType=conversation 无人消费） | 修复：通知页 message 类行链接到 /messages/{targetId} |
| E-1 | **messages.spec 文件头声明「超量提示/权限拒绝」但无用例**；「游客 404」与实际断言（redirect）不符 | 修复：文档措辞对齐；权限拒绝语义由 int（forbidden）与游客 redirect E2E 承担 |
| E-2 | **poll.spec 改票断言无证明力**：改票后只断言「选项乙」可见（未截止时恒真）——改票失败断言照样过 | 修复：断言计数迁移（甲 0 票 0%、乙 1 票 100%） |

## 3. P3（修复约 10 项，摘录）

- conversationList N+1 合并（2×50 点查 → 3 条集合查询）
- closePoll 审计补 `before.endsAt`（原始截止时间不再丢失）；注释「幂等报 already」与实现不符的失实修正
- deletePoll 审计 `after` 补被删投票摘要；`revalidatePath("/t/0")` 死代码删除
- 删除消息的可伪造性（body 文本约定无标记列）——留档，量级低
- notify 不滤已注销收件人（幽灵通知行）——留档
- pollAdminList 的 `limit*2` 截断与无分页——留档（迁移旧投票 128 个，量级可控）
- messages.spec 私信管理用例补「发送方对话页显示删除标记」断言；m10-modules pm 用例标题纠偏
- reward-load / checkin getMonthCheckins / labels / dashboard / logs CSV 的覆盖补测（labels 0% → 满）
- checkin today 注入分支用例（时区无关口径的实证）

## 4. 设计取舍与残留（留档）

| 项 | 说明 |
|---|---|
| pm.received 聚合无 dedupKey | at-least-once 重放 count 虚增 1（徽标数字）；聚合语义与 dedup 互斥，M8/M9 已明文接受 |
| sendMessage 额度检查在事务外 | 并发可超 pmPerDay 少量条数（软限制）；对照 posting 持锁复核的纪律，量级低留档 |
| reverse 改票死锁面 | withDeadlockRetry 吸收 + enqueued 重试清空后正确性无损 |
| voterCount 并发重算覆盖写 | 下次投票自愈；无后续投票则错值留存——留档 |
| PollBlock 多选无客户端已选计数 | 服务端闭环（超限回显） |
| 删除消息为 body 文本标记（无独立列） | 可伪造性量级低；结构性修复需迁移，留档 |
| closePoll 不可恢复 | 无 reopen 动作；需要时 ends_at 手工清空即可 |
| 通知行发给已注销用户 | 幽灵通知行无人消费，量级可忽略 |

## 5. 测试与门禁（整改后实测）

- `verify:all`：content 55 + db 66 + web **1361** + migration 251，exit=0；覆盖率分支 **85.15%**。
- `test:e2e`：桌面/移动 **188** 项 + 生产冒烟 10 项，exit=0。
- 新增测试：poll int +4（多选/新用户/并发/空选项）、pm int +2（额度专用发送者/长内容）、pm admin +1（deleteMessage not_found）、poll branch +1（版主作用域拒绝）、m10-admin-branch（限制/投票管理分支 +4）、labels/getMonthCheckins/reward-load 覆盖补测。

## 6. 提交索引

| 提交 | 内容 |
|---|---|
| `f3597ac` / `1e1ab5a` / `3f6bd3a` | M10 S1 开工定稿与事件契约 |
| `d0d971f` | S2 投票交互层 |
| `c67a59d` | S3 私信 |
| `2960aef` / `adbd1c1` | M10 补做（管理侧+分页） |
| `7d81fa8` | 审查整改主体（P1×1 + P2×12 + P3 精选） |
| `171525b` / `adbd1c1` | 格式化与覆盖率补测收尾 |
