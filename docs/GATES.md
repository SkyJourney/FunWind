# 门控（Gate）规范

> 状态：M5.5 设计定稿；实现分布于 M5.5（存储/只读渲染/解锁服务）→ M6（创作与购买交互）。
> 对应旧站：`[sell]`（付费）、`[post]`（回复可见）、`[hide=N]`（积分可见）三种 UBB 隐藏块。
> 设计要点：**门控 = 内容容器 + 可插拔的解锁条件**；隐藏内容在保存时拆出，从构造上杜绝泄露。

## 1. 语法：`:::` 容器指令

采用 remark-directive 的通用指令提案（`:::name{attrs}` … `:::`），**不使用 ``` 代码围栏**：
门控内是 Markdown，需容纳代码块、列表、图片，代码围栏会把内容当字面量。

```md
:::gate{unlock="points" price="50"}
付费可见的 **Markdown** 内容，可含代码块、图片。
:::

:::gate{unlock="reply"}
回复后可见
:::
```

- `unlock`：解锁条件类型（见 §3）；其余属性为该条件的参数，由条件注册项的 schema 校验。
- 价格 `price` 为非负整数；`0` 表示「登录后免费解锁」（旧站 `[sell=0,]` 语义，占旧购买记录的 91%）。
- **只允许顶层块**：不得嵌套，不得出现在列表/引用/表格内。编辑器同步强制，保存时再校验。
- 一个 post 可含多个门控；`seq` 按出现顺序编号。

## 2. 存储契约（核心安全决策）

保存时由 `packages/content` 把门控**拆出**：

| 位置 | 内容 |
|------|------|
| `posts.body_md` | 仅公开部分；门控处只留空占位 `:::gate{id="17"}\n:::` |
| `post_gates` | `id`, `post_id`, `seq`, `conditions`(JSON 数组), `match`(`all`\|`any`, 默认 `all`), `hidden_md`, `unlock_count`, `created_at`, `updated_at` |
| `gate_unlocks` | `(gate_id, user_id)` 主键, `price_paid`, `author_income`, `ledger_id`, `source`(`purchase`\|`migrated`), `unlocked_at` |
| `posts.has_gate` | 布尔位，无门控的帖子跳过全部门控查询 |

**效果**：搜索、RSS、OG 摘要、通知预览、导出等任何只读 `body_md` 的路径都读不到隐藏内容。
隐藏正文只通过 `getGateContent(gateId, viewer)` 一个出口读取，该出口内置全部可见性判定。

`conditions` 示例：`[{"type":"points","price":50}]`；组合条件（如回复且关注）为多元素数组 + `match`，现阶段只用单条件。

**作者编辑**：作者/版主打开编辑时，`assembleSource(body_md, gates)` 把门控按 id 合并回完整源码；保存时 `splitSource()` 再拆。
门控 id 在往返中保持稳定。有购买记录的门控**不可删除**，只能改内容；改价不退款，只影响之后的购买。

## 3. 解锁条件注册表（`gateConditions`）

模块内核第八类注册边界（`pointChannels` 为第七类）。每个条件声明：

| 字段 | 含义 |
|------|------|
| `type` | 唯一键，如 `points`、`reply` |
| `paramsSchema` | 参数校验（zod） |
| `kind` | `stateful`（需用户动作，写 `gate_unlocks`）或 `derived`（每次渲染实时判定） |
| `check(ctx)` | 返回 `satisfied` / `unsatisfied`（ctx 含 viewer、post、thread、params） |
| `prompt(ctx)` | 未满足时的 UI 提示与动作（购买按钮 / 「回复本帖」链接 / 「登录」） |
| `createPermission` | 创建该类门控所需权限点（如 `gate.points`、`gate.reply`；旧键 `thread.sell`/`thread.hide` 为 `legacy_key`） |

首批条件：

| 条件 | kind | 判定 |
|------|------|------|
| `points` | stateful | 存在 `gate_unlocks` 记录；价格 0 也写记录（登录后点击解锁） |
| `reply` | derived | viewer 在该主题下有一条可见回帖（不含首帖） |

预留（不实现，仅证明可扩展）：`login`、`follow`、`time`（定时开放）、`badge`。

**永远可见的人**：作者本人；持有 `forum.moderate`（该 post 所在版块作用域）的版主；admin。其余人按条件判定。

## 4. 渲染（SSR，用户相关内容不进缓存）

```
body_md → remark(+指令) → sanitize → 公开 HTML 片段（与用户无关，可缓存）
              ↓ 在 gate 占位处切分
        [html 段] [GateBlock] [html 段] …
```

- `fw-gate` 作为唯一新增的白名单元素，仅允许 `data-id` 属性；其余沿用既有 sanitize 保证。
- 切分结果交给服务端组件渲染：HTML 段直出，`GateBlock` 按状态渲染。
- 一个页面的全部门控**一次批量查询**（元数据 + 当前用户解锁态 + 回复态），无 N+1。
- `GateBlock` 状态：

| 状态 | 展示 |
|------|------|
| 未登录 | 条件说明 + 登录入口 |
| 未满足 | 锁卡片：「付费内容 · 50 积分」+ 购买按钮 / 「回复后可见」+ 跳转回复框 |
| 已购买（或已满足） | 隐藏内容（同一套净化）+ **「已购买」标签**（购买时间可选） |
| 作者 | 「你的付费内容 · N 人购买 · 收益 X」+ 内容 |
| 版主/admin | 「管理员可见」标签 + 内容 |

- 购买后通过 Server Action 重新渲染；**不提供任何会返回隐藏内容的 JSON 接口**。
- 页面已为动态渲染（含会话），无额外缓存失效负担。

## 5. 解锁事务（`unlockGate`）

stateful 条件（`points`）的购买在**单个数据库事务**内完成：

1. 锁读者 `point_accounts` 行（`SELECT … FOR UPDATE`）。
2. 校验：门控存在且未被删除；读者非作者/版主；未解锁（`gate_unlocks` 主键保证幂等）；余额 ≥ 价格。
3. 写 `gate_unlocks`；台账 `spend.gate_unlock`（读者 −price）；台账 `earn.gate_sale`（作者 +price−手续费）。
4. 更新两个账户余额；`unlock_count++`；提交后派发事件 `gate.unlocked`（`{gateId, userId, authorId, price}`）。

- 幂等键：`gate_unlock:{gateId}:{userId}`（读者）、`gate_sale:{gateId}:{userId}`（作者）。
- 价格 0：只写解锁记录，不动台账。
- 手续费：`points.gate_fee_rate`，默认 0（作者收全额）。
- 作者账号已不存在（历史孤儿作者）：收益直接销毁，不写台账。
- 并发双击只扣一次（单测与集成测试覆盖）。

## 6. 权限点

| 权限点 | 含义 | 旧键 |
|--------|------|------|
| `gate.points` | 创建积分购买型门控 | `allow_thread_extend`(sell) |
| `gate.reply` | 创建回复可见型门控 | `allow_thread_extend`(hide) |
| `forum.moderate` | 免购查看（作用域内） | — |

## 7. 旧数据迁移映射

| 旧 | 新 | 备注 |
|----|----|------|
| `[sell=N,…]`（309 帖） | `unlock="points"` price N | **N ≥ 9999（43 次）一律改为 0**，原价入对账报告；第二参数（如 `[sell=0,1]`）S3 考古后定 |
| `[post]…[/post]`（306 帖） | `unlock="reply"` | — |
| `[hide=N]`（5 帖） | `unlock="reply"` | 「积分可见」语义 S3 核对 |
| `threads_buy`（6,984 行，91% 价格为 0，总花费 2,142 积分） | `gate_unlocks`（`source=migrated`） | 旧购买按帖子计，一帖多门控时展开为多条；不写台账 |

迁移期即完成拆分（`hidden_md` 入 `post_gates`，`body_md` 只留占位），上线第一天不存在泄露窗口。
对账项：任一 `hidden_md` 的特征片段不得出现在同 post 的 `body_md`。

### 7.1 实现要点与真实数据验证（M5.5 S3-A）

`packages/content`（`@funwind/content`）已实现：`splitSource` / `assembleSource` / `validateGates`（门控语法）与 `ubbToMarkdown`（转换器 v2）。

- **迁移用确定性门控 id**：`gate_id = post_id × 16 + seq`（单帖门控上限 15，超限抛 `RangeError` 由迁移显式处理）。同一帖重跑得到同一 id，`gate_unlocks` 的迁移展开因此幂等。
- **位置规则**：门控只在文档顶层生效。包在样式标签（`[color]`/`[align]` 等）、未知标签或**未闭合**标签里的门控被提升为顶层块，两侧文本各自保留样式；
  位于**真正闭合**的 `[quote]`/`[list]`/`[table]` 内的门控内容**丢弃并留提示**（那是别人对原文的引用，宁可丢也不放进公开正文）。
- **失败即封闭**：门控标签缺少闭合（`[sell=5,]` 之后没有 `[/sell]`）时，从该标签到所在容器末尾的内容都归入隐藏内容，
  **绝不把子节点渲染进公开输出**。旧库实证：tid 2023 的未闭合 `[sell]` 有 22 条购买记录，说明旧站确实把它当付费帖处理；仍记 `gate-unclosed` 告警供站长复核。
- **泄露不变量**（性质测试，400 组随机嵌套，约四分之一的门控故意不写闭合标签）：被拆出的隐藏内容绝不出现在公开 `md` 中。
- **真实旧库验证**（36,715 条正文，只读）：零异常；门控共 674 个（积分 309 = 旧 `[sell]` 帖数，回复可见 365）；
  汉字/假名保留率 101.41%，疑似丢失 ≥10% 的文档 0；仅 4 处嵌套门控被丢弃，均为发帖模板里的空示例；
  遗留表情码删除 197 处（与此前统计吻合）；价格 ≥ 9999 重置为免费 49 处。
- **v1 转换器的数据丢失缺陷（已在 v2 修复）**：`[attachment=N]` 等无闭合标签会把其后全部正文吞成子节点并丢弃
  （`"[attachment=7] 后文"` 只剩附件链接）。当前开发库（v1 迁移）的 `content_md` 因此存在截断，**S3-B 全量重导后消除**。

## 8. 事件

`gate.unlocked`（新增，需同步 `modules/kernel/types.ts` 与 MODULES.md）。M8 通知中心据此向作者发「收益」通知。

## 9. 编辑器契约（M6 选型）

选型与调研推迟到 M6 开工时。M5.5 只固定三样契约：**围栏语法、存储拆分、`packages/content` 接口**。
M6 评审维度：能否把 gate 渲染为可视块（价格输入、锁图标）、Markdown 往返是否无损、移动端体验；
候选方向：Milkdown（remark 生态，与渲染端同源）、Tiptap（需自写 Markdown 序列化）、CodeMirror 源码 + 预览（兜底）。
无论选哪个，序列化一律经 `packages/content`，保证线上保存与迁移同一套语法。
