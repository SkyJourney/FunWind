# M8 · 互动套件与检索

- 阶段：二·核心 ｜ 覆盖模块：M05 / M06 ｜ 依赖：M6（M5.5 已迁入点赞/关注/标签数据）
- 状态：✅ 2026-10-26 完成

> **开工拍板（2026-10-25 站长）**：
> 1. **精简 `/notifications` 页随本期交付**——铃铛「查看全部」的真实去处（合并时间线 + 游标分页 + 点击已读）；
>    分类 Tab / 批量操作 / 偏好设置仍归后续完整页（不违背「不做完整通知中心页面」的范围约定）。
> 2. **@提及本期接线**：M6 实际未建 @ 解析（只有事件契约）——本期补正文 `@用户名` 解析器（归一化键精确匹配，
>    解析失败按普通文本），发帖 / 回帖 / 编辑三处接线，事件经事务性 outbox。
> 3. **M8-1 部分落地**：`gate.unlocked` 与 adjust 的 `points.changed` 接入事务性 outbox（通知不丢单的前提）；
>    `message.sent` 归 M10。
> 4. **勘误**：可见性专项夹具为 seed 的受限版块 **904**（原写 fid 121 是旧库编号）；FULLTEXT 索引为
>    `threads.title` + `posts.body_md` **两列**（与 §6 范围一致，修正下文「索引只含 body_md」表述）；
>    12 个旧标签**已随 M5.5 迁入**（非「作种子」）；E2E 词表「字幕组」需 team 用户（seed 904 才可见）。

## 目标

社区互动的下半套：点赞、关注、标签、**通知中心（后端 + 顶栏铃铛）**，加上站内搜索。完成后论坛具备日常活跃的完整互动回路。

## 范围（做什么）

1. **点赞**（`reactions`）：主题首帖/回帖点赞 UI + 点赞列表弹层 + 通知事件；旧 1,649 条明细已于 M5.5 迁入，计数以明细为准。
2. **关注**（`follows`）：关注用户/版块；旧 4,390 条（过滤无效用户后）已迁入；关注动态聚合页只聚合新版行为（旧动态流表不迁）。
3. **标签**：主题标签（`tags`/`thread_tags`，12 个旧标签作种子）+ 版块标签云 + 按标签筛选；用户兴趣标签不做。
4. **通知中心后端**（设计见 [NOTIFICATIONS.md](../NOTIFICATIONS.md)；**旧通知/公告/私信不迁**，新表从空开始）：
   `notify()` 管线（查偏好 → 聚合 → 写库 → 分发渠道）、`notificationTypes` / `notificationChannels` 注册边界（仅实现 `in_app`）、
   互动类通知（回复 / 回复某楼 / @提及 / 点赞 / 关注 / **门控收益** `gate.sold`）、读取契约 `unreadSummary` / `list` / `markRead`
   （合并 `announcements` 与私信指针）、`notification_preferences`（强制类型不可关闭）。
   审核与管理、账号与安全两大类的**生产方**分别在 M9、M5.5/M7 接入，M8 只保证类型可注册、可渲染。
5. **顶栏铃铛**：总未读数 + 下拉面板（各分类未读数 + 最近 10 条聚合后的未读，底部「查看全部」）；面板打开/窗口聚焦时拉取，不做实时推送。
   完整通知中心页面（分类 Tab、历史、批量操作、偏好设置）留给后续独立里程碑。
6. **搜索**：MySQL FULLTEXT ngram（`threads.title`、`posts.body_md`）+ 搜索页（分页/版块过滤/时间排序）+ 空结果引导。
   **可见性硬约束**：结果经 `ForumTree` + 权限过滤；`state ≠ visible`、受限版块不可读、`is_listed=0` 不进聚合；
   索引只含 `body_md`（门控隐藏内容天然不在其中）。

## 边界（明确不做什么）

- 不做 Meilisearch（ngram 不敷使用时再立项）；不做私信（M10）。
- 不做邮件/推送渠道（只留 `notificationChannels` 口子）；不做通知实时推送；不做完整通知中心页面。
- 不做推荐流/热搜（无真实需求前不建）；不做搜索记录功能（旧记录仅可作为 E2E 测试词表）。
- 不做多种表情回应（先只做点赞）。

## 测试规则

- 单测：通知聚合（仅合并未读、已读后新开）、偏好与强制类型、公告读取时合并与已读、关注计数一致性、ngram 查询构造器、搜索可见性过滤器。
- E2E：点赞→对方收到通知；关注版块→动态页出现新帖；打标签→标签页筛选命中（`e2e/interact.spec.ts`，审查整改时补齐）；
  搜索「刀剣乱舞」「青翼」命中与「字幕分工」受限词可见性（`e2e/search.spec.ts`，词表取自旧搜索记录）；
  门控收益通知到达作者（int 覆盖：gate 不丢单链路）。
- 数据边界：**软删/受限版块/不上目录/未解锁隐藏内容**不出现在任何搜索与动态结果（int 专项四类 + deleted 态）；
  spam 为**结构性排除**（新库无 spam 状态，旧空壳主题在迁移期整体丢弃——无需测试保障）。

## 验收门禁

- [x] 互动类通知端到端不丢单（压力脚本 `notify:storm`：1,000 事件、聚合 count 与非聚合行数全对账，实测均值 1.8ms/事件）；聚合与未读数口径与 NOTIFICATIONS.md 一致（含实现决定 1–5）
- [x] 铃铛面板：未读数、最近 10 条聚合、标记已读 E2E 通过（notifications.spec 4 例：游客无铃铛/真实回帖→未读/单条与全部已读/公告合并）
- [x] 搜索中日文用例集全过（search.spec 3 例：青翼=标题命中、刀剣乱舞=正文命中、字幕分工=受限词零命中/团队命中）；可见性排除专项通过（search.int：受限 904/隐藏/is_listed=0/门控隐藏正文 4 类不可见）
- [x] 互动计数与列表页展示一致性抽查（随机 20 帖 like_count↔reactions、全库 follower_count↔follows，interact.int）
- [x] `pnpm verify:all` 与 `pnpm test:e2e` 全绿；CHANGELOG 记录
  （实测 2026-10-26：verify:all = content 55 + db 66 + web 1291 + migration 251；test:e2e = 桌面/移动 172 + 生产冒烟 10（整改后）；perf:lcp 含 /search 32ms 全达标）

## 阶段推进（S1–S8）✅ 全部完成（2026-10-26）

- [x] S1 开工文档定稿（拍板三条 + 勘误四处 + NOTIFICATIONS 实现决定）
- [x] S2 互动写路径与 UI（点赞/关注 toggle + 计数同步 + outbox、标签 composer/云/筛选、/follows 动态页）
- [x] S3 @提及（content 包解析器 + 三处接线 + 编辑差集）
- [x] S4 通知核心（notify 管线、27 类型全注册、7 事件消费者、读取契约）
- [x] S5 gate/adjust 事件入事务性 outbox（M8-1 部分；收益通知不丢单测试）
- [x] S6 顶栏铃铛与精简 /notifications 页（bell/read API、聚焦刷新、点击已读）
- [x] S7 站内搜索（迁移 0006 FULLTEXT ngram、可见性硬约束、/search 页）
- [x] S8 收尾（notify:storm、计数抽查、verify:all/test:e2e/perf:lcp 全绿、文档）

> 收尾代码审查与整改记录见 [reviews/2026-10-26-m8-code-review.md](../reviews/2026-10-26-m8-code-review.md)
> （P1 × 3、P2 × 11 全修——含聚合并发唯一索引迁移 0007、interact E2E 补齐；P3 修复 12 项，取舍清单在其 §4）。

## 复验发现（实施期实测记录）

1. **markRead(all) 只清公告不清通知**（S8，E2E 抓到）：`all` 分支被 `category !== undefined` 守卫跳过——
   「全部已读」后账号类通知仍挂未读。修正为 all 时全分类 UPDATE，int 断言 total=0（此前只断言公告）。
2. **E2E 库缺 0006 迁移导致搜索 500**（S7）：notifications 一轮重置发生在创建迁移之前——单独 bootstrap 即复，
   完整编排天然包含；记录提醒「对已重置库跑新迁移后需 bootstrap」。
3. **hidden-md 唯一读取点守卫抓到注释字面量**（S7）：search.ts 注释里写了 `post_gates.hidden_md`——
   改写为不引用列名（守卫按字面量扫描，含注释）。
4. **React hooks lint：effect 内直呼 refresh 触发 setState-in-effect**（S6）：首拉延后到宏任务（setTimeout 0）。
5. **modules-import-guard 自检锚点过期**（S5）：unlock.ts 改走 outbox 后不再触内核——锚点换成 outbox.ts
   （守卫本身工作正常，这正是它该抓的变化）。

## 遗留事项

（无）
