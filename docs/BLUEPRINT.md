# 青翼字幕组（QYSUB）新论坛 —— 技术蓝图

> 项目代号 FunWind。目标：抛弃 phpwind 9.0，全新开发一套现代化论坛系统；
> 旧程序与旧库只作内容源与业务逻辑参考，代码零复用。
> 本文档基于 2026-10-23 对旧库（127.0.0.1:33620/qingyisub，GBK，496 表）的实测。

## 0. 已确认决策（2026-10-23 与站长敲定）

1. **框架：Next.js + React，版本取最新**；功能插件化用「模块注册表」模式实现（见 §8）。
2. **数据库：MySQL 8.4 LTS，utf8mb4，InnoDB**。
3. **垃圾内容：标记隐藏**（is_spam=1 全量入库、默认不展示、可审计可恢复）。
4. **迁移范围：全量**（含私信/投票/勋章/积分流水等外围实体）。
5. **视觉：现代简洁为主 + 首发即带「复刻·青翼2010」情怀主题包**（三层令牌架构，主题=CSS 变量表；见 FRONTEND-DESIGN.md）。
6. **组件：shadcn/ui 模式**（源码进仓库，Radix 行为 + Tailwind，可任意深度接主题令牌）。
7. **权限：自研轻量 RBAC/ABAC**（4 表 + 评估器，继承旧 57 权限点词汇表并归一为 37 点；M5.5 修订见 AUTHZ.md §8）。
8. **注册：邀请制起步、稳定后开放**（邀请码 + 邮箱验证 + 频控两套接口骨架都留）。
9. **开发路线：先骨架后功能**——按 [LEGACY-FEATURE-MAP.md](LEGACY-FEATURE-MAP.md) 的 M01–M15 顺序，
   骨架期就落事件总线/UI 槽位/注册表边界，逐模块填充。
10. **数据层双模式**：项目必须支持**零数据部署**（Web 安装向导 + CLI bootstrap，见里程碑 M12），
    青翼 phpwind 迁移导入是可选路径而非前提。schema 单一事实源在应用侧（Drizzle 定义，M1 起），
    `migration/` 降级为「青翼专项导入器」，其 schema-init 与应用共用同一 Drizzle 管线。

### 重构决策（2026-10-23，M5.5，站长确认）

11. **重构方针**：旧系统是 20 年前的产物，按现代论坛视角裁剪无用子系统、按现代设计重做库表与功能，**最终只是把旧数据映射进新模型**；破坏性变更全部接受（重新迁移即可）。详见 [M5.5](milestones/M5.5-schema-v2.md)。
12. **未被新模型使用的旧表一律丢弃，不建归档库**（含全部 `pw_*` 311 张表、任务/银行/抽奖/草稿/日志/通知/动态流等）；旧库保持原样只读，直至 M13 签字，即事实上的归档。
13. **版块层级**：邻接表 `parent_id` + 物化路径 `path` + 启动加载的内存树 `ForumTree`；`read_policy`（inherit/public/members/restricted）作为一等属性。
14. **统一 post 模型**：首帖即 `floor 1`；`posts_reply` 丢弃；业务表去掉 `raw`/`content_raw`，正文只留 `body_md`。
15. **表情**：迁移期展开为静态图片资源，运行时无表情表，新编辑器不带表情面板。
16. **门控抽象**：内容容器 + 解锁条件（内置 `points` / `reply`，固定两种；原 `gateConditions` 模块边界已在 M6.1 删除），隐藏内容保存时拆出存独立表；首批条件 `points`（购买）、`reply`（回复可见）；价格 0 = 登录后免费解锁；旧价 ≥ 9999 一律改免费；作者获得收益，手续费默认 0。详见 [GATES.md](GATES.md)。
17. **积分抽象**：单一「用户积分」（显示名可配，默认青翼币），只做台账，获取仅发帖/回帖/签到；渠道注册 `pointChannels` 预留消费与获取的扩展；不迁旧流水，每人一条期初余额。详见 [POINTS.md](POINTS.md)。
18. **取消**：用户等级/成长、任务引擎、勋章自动颁发、银行、抽奖、多币种。

### 设计先行修订（2026-10-23，M5.5 R1，站长确认；与上文冲突处以本节为准）

19. **设计先行，迁移只是适配层**：先按现代论坛原则定新系统（[DESIGN-MODEL.md](DESIGN-MODEL.md)，schema v2.1 共 43 表），旧数据向它靠拢；
    运行时 schema 不出现 `legacy_*`、迁移标记、迁移用 id 公式；旧键映射只存在于 `migration/`。推翻第一轮 v2 中沿袭旧结构的部分。
20. **不迁旧库归档类数据**：spam 空壳、回收站与屏蔽内容、私信、旧通知/公告一律不迁（推翻原先「回收站 hidden 迁入」的做法）；旧库只读保留至 M13 签字。
    签到只迁每人最近的连续段；已注销作者建「已注销用户」占位账号，不加冗余列。
21. **文件注册表**：新增 `files`（SHA-256 内容寻址）；附件、头像、正文图片、徽章图统一入库，`/files/<storage_key>` 取代 `/attachment/**`；非图片附件按所属版块读权限校验。
22. **内容只有 Markdown**：不保留内联样式（`color`/`size`/`backcolor`/`align` 降级为纯文本语义），渲染白名单去掉 `style`。
23. **内容状态机与审核**：`visible|pending|rejected|hidden|deleted`；版块 `review_policy`（inherit|none|threads|all）；`pending/rejected` 仅作者与版主可见，可编辑重新提交。
24. **通知中心**：统一入口与未读数、按形态分别存储（`notifications` 逐人收件箱 + `announcements` 读取时合并 + 私信指针），分类互动/私信/审核与管理/账号与安全/公告；
    内核注册边界扩为十类（+`notificationTypes`、`notificationChannels`），当前仅实现 `in_app`，邮件/推送只留口子。详见 [NOTIFICATIONS.md](NOTIFICATIONS.md)。
25. **字段更名**：`topped → pin_level`（0无/1版块/2分区/3全站）、`digest → is_featured`；门控以帖内 `gate_key` 为稳定身份。

---

## 1. 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 前端/框架 | **Next.js（最新版，App Router, RSC）+ TypeScript** | SSR/SEO 对社区内容站关键；RSC 直接查库渲染帖子列表，交互层（编辑器、点赞）用客户端组件 |
| 样式 | **Tailwind CSS v4** | 快速做响应式 + 移动端优先布局 |
| ORM | **Drizzle ORM** | SQL-first，迁移系统可共用连接层；对存量数据（保留旧主键）控制力强 |
| 数据库 | **MySQL 8.4 LTS（utf8mb4, InnoDB）** | 已确认。旧库 GBK→utf8mb4 转换路径实测无损（含日文、EUC-JP 历史字节） |
| 缓存/会话 | Redis（后期，登录会话 + 热帖缓存） | |
| 全文检索 | 初期用 MySQL FULLTEXT（ngram）→ 后期 Meilisearch | 中文/日文分词检索是硬需求 |
| 部署 | Docker Compose（沿用 mac-mini 现有编排风格） | |

**迁移程序刻意与框架解耦**（`migration/`，只依赖 mysql2 + tsx），换框架不返工。

## 2. 源数据实测结论（2026-10-23）

### 2.1 规模与真实内容量

| 表 | 行数 | 说明 |
|----|------|------|
| nw_user | 10,701 | 其中大量 2018-11 广告注册 |
| nw_bbs_threads | 4,505 | **其中 3,010 条来自 2018-11 垃圾洪泛** |
| nw_bbs_threads_content | 1,467 | 首帖正文（仅此表有首帖正文） |
| nw_bbs_posts | 35,248 | 全部为回帖（首帖不在其中） |
| nw_bbs_forum | 43 | 8 个分类 + 版块 + 子版块 |
| nw_user_groups | 25 | 魔界主题等级组 + 制作组等特殊组 |
| nw_attachs_thread | 415 | 附件元数据 |
| nw_credit_log | 93,765 | 积分流水 |
| nw_medal_user | 3,833 | 勋章持有 |
| nw_app_poll(+option/voter/thread) | 147 | 投票 |
| nw_windid_message(+dialog) | 3,760 | 私信 |

**重大数据质量发现：**
- 3,033 个主题既无首帖正文也无任何回帖（空壳，绝大多数为 2018-11 广告洪泛，`disabled` 全部为 0，从未被标记）。**真实内容主题 ≈ 1,472**（1,467 有正文 + 5 无正文但有回复）。
- 用户侧同类：广告发帖账号 3 人被标记 `is_spam`；另有 uid 21220（SEO 垃圾账号，9 空壳帖）**用户行已被删、帖子仍在**——用户表存在孤儿 uid，属正常历史现象，UI 需容忍「已注销」作者。
- **用户名编码考古**：`さくら`(15590) 与 `サクラ`(14890) 的原始字节是 **EUC-JP**（当年注册时的编码事故，存进 GBK 列），MySQL 转 utf8mb4 后得到正确假名。因此 users.username 列必须用 **utf8mb4_0900_as_cs**（区分大小写与平/片假名），否则假名不敏感会碰撞吞号（首版迁移已踩过：_ai_ci 下 10,701 → 10,700）。
- **遗留表情码**：152 行正文含 `[s:62]` `[s:171]` 等映射外的旧版（pw8 时代）表情码，旧站自身也无法渲染（face.js 只覆盖 120–169）。迁移保留原文不动。
- 部分帖子正文在源库即截断（如 tid 3007 止于 `[url=http:/`）或含笔误标签（`[s:125` 少右括号），迁移原样保留，`content_raw` 可证。

### 2.2 关键结构语义（实测确认）

- **首帖正文在 `nw_bbs_threads_content`（按 tid 主键），不在 `nw_bbs_posts`**。回帖含楼层语义：`rpid`=回复目标 pid，`nw_bbs_posts_reply` 维护嵌套关系。
- **正文换行是真实 `0x0A`**（HEX 验证），GBK 字节经 utf8mb4 连接自动无损转换，日文（「みんな～～～～～」「刀剣乱舞」）验证通过。
- **UBB/BBCODE**：`[s:146]` 表情码直接对应 `nw_common_emotion.emotion_id`（120–169，50 枚，分 7 类，映射 folder/icon gif）；另有 `[url=][img][quote][size][color]` 等。
- **附件路径两代并存**：`Mon_1004/55_7_hash.jpg`（phpwind 月份目录）与数字目录 `1302/…`（2013+）。路径为**相对路径**，磁盘实测可对上（527MB，`/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/attachment/`）。⚠️ 简报中 `/Volumes/Docker/data/qinub.top/attachment/` 为笔误，实际不存在。
- **头像**：`attachment/avatar/{3位}/{2位}/` 分片（windid 算法），迁移期不解析文件，保留 `attachment/` 整目录原样由新系统静态服务。
- **积分**：`nw_user_data.credit1..8` 八列 + `nw_credit_log`（ctype/affect/descrip）；等级由 `nw_user_groups.points` 阈值驱动（LV1.魔狱原住民 150 → LV12.圣魔王 18000）。
- **勋章**：`nw_medal_user.medals` 为逗号分隔 id 串，需展开为行。
- **版块名内嵌 HTML 样式**（如 `<span style="color:#cb4042">`），迁移时剥离到独立 `style` 字段。
- **回收站**：`nw_recycle_topic(3,210)/recycle_reply(5,351)` 为已删除内容，一期不迁移，仅归档说明。

### 2.3 红线

1. 旧库 `qingyisub` **全程只读**（仅 SELECT/DESC/SHOW）。
2. 旧密码（md5+salt，phpwind 私有流程）**不迁移**：新库 `password_hash=NULL`，上线用邮件重置召回。
3. 迁移程序幂等：可重复执行（保留旧主键 + UPSERT）。
4. 新内容统一 utf8mb4。
5. **时区约定**：库内 DATETIME 一律为北京墙面时间——连接层 `timezone: "+08:00"` + `dateStrings`（packages/db/client.ts），web 侧解析必须经 `apps/web/src/lib/datetime.ts` 的 parseDbDateTime（显式 +08:00），禁止裸 new Date(字符串)。
6. **连接约定**：web 运行时用 `getWebDb()` 单例池（globalThis 守卫，基线审查 P1-1）；`withDb` 仅限一次性脚本。
7. **唯一键不含可空列**（M5.5）：MySQL 唯一索引不去重 NULL，全局作用域一律用 `scope_id = 0` 哨兵；违例曾导致权限表重复 5 倍。
8. **口令不入库**：任何文档/配置不得出现真实口令（旧库口令已于 M5.5 S1 从本文清除，改读根 `.env`）；推送前需审计 git 历史。

## 3. 新库 schema（qysub_next）

设计原则：**保留旧主键**（uid/tid/pid/fid/aid）→ 历史 URL 可 301、附件路径天然可用；每表带 `raw JSON` 归档旧行，永不丢信息。
schema 演进：P0 期的 `migration/schema/schema.sql` 为基线底稿；**M1 起以应用侧 Drizzle 定义为单一事实源**（决策 #10），
零数据 bootstrap 与迁移导入共用同一建表管线。

> ⚠️ **本节下表为 v1（P0–M5）的「忠实搬运」映射，仅作历史对照。** M5.5 起目标态为 schema v2.1（见下方 §3.2 与
> [DESIGN-MODEL.md](DESIGN-MODEL.md)）：统一 post、`forums` 重做、`user_restrictions`、`post_gates`、`files`、`notifications`、`point_*`、
> 会话模型等；`groups`、`emoticon*`、`credit_logs`、`private_messages`、`message_dialogs`、`migration_state` 及所有 `raw`/`content_raw`/`legacy_*` 列退出。

| 新表 | 来源 | 要点 |
|------|------|------|
| `users` | nw_user + nw_user_info + nw_user_data + nw_windid_user | password_hash NULL；is_spam；credits JSON(8列)；签名 bbs_sign 转 md |
| `groups` | nw_user_groups | points 阈值保留（等级引擎用） |
| `forums` | nw_bbs_forum + forum_extra/statistics | name_style 从 HTML 剥离；manager 解析为 uid 列表 |
| `threads` | nw_bbs_threads + threads_content | **首帖正文挂 threads 上**（content_md/content_raw），与 pw9 数据模型一致；is_spam；digest/topped/special 保留 |
| `posts` | nw_bbs_posts | 仅回帖；floor 按时间序计算；reply_to_pid=rpid |
| `attachments` | nw_attachs_thread | path 原样保留（相对 attachment/） |
| `emoticon_categories` / `emoticons` | nw_common_emotion_category / nw_common_emotion | `[s:N]` 渲染映射 |
| `medals` / `user_medals` | nw_medal_info / nw_medal_user | medals CSV 展开成行 |
| `credit_logs` | nw_credit_log | ctype 保留 |
| `polls` / `poll_options` / `poll_voters` | nw_app_poll* | tid 关联 |
| `private_messages` / `message_dialogs` | nw_windid_message / _dialog | 一期迁移，UI 后做 |
| `migration_state` | — | 迁移清单/水位/行数校验 |

完整 DDL（v1 历史基线）：`migration/schema/schema.sql`；v2 以 `packages/db/src/schema.ts` 为准。

### 3.2 schema v2.1 目标态（M5.5，设计依据见 [DESIGN-MODEL.md](DESIGN-MODEL.md)）

| 域 | 表（共 43） | 要点 |
|----|----|------|
| 身份（8） | `users`、`user_profiles`、`user_stats`、`user_restrictions`、`sessions`、`email_tokens`、`invite_codes`、`site_settings` | 保留 uid；`state(active\|deleted)`；邮箱/用户名归一化列唯一；限制统一（封禁/禁言/禁头像/禁签名） |
| 版块（2） | `forums`、`forum_prefixes` | `parent_id` + `path` + `depth` + `kind`；`read_policy`/`write_policy`/`review_policy`；内存树 `ForumTree` |
| 内容（9） | `threads`、`posts`、`post_gates`、`gate_unlocks`、`content_reviews`、`files`、`attachments`、`tags`、`thread_tags` | 首帖 = floor 1；`body_md`；`pin_level`/`is_featured`；门控 `gate_key`；文件内容寻址 |
| 互动（8） | `reactions`、`follows`、`polls`、`poll_options`、`poll_votes`、`conversations`、`conversation_members`、`messages` | 迁移只带关注/点赞/投票，私信不迁；交互层归 M8/M10 |
| 通知（4） | `notifications`、`notification_preferences`、`announcements`、`announcement_reads` | 见 NOTIFICATIONS.md；新表从空开始 |
| 积分/荣誉（5） | `point_accounts`、`point_ledger`、`checkins`、`badges`、`user_badges` | 渠道注册；期初余额分录；签到仅最近连续段 |
| 权限（4） | `roles`、`permissions`、`role_grants`、`user_roles` | `scope_id` 哨兵；内置角色 guest/member/admin，团队角色为站点数据 |
| 平台（3） | `event_log`、`module_state`、`audit_log` | 管理动作统一审计；不含迁移状态表 |

旧表 → 新表的适配规则见 [M5.5 迁移适配](milestones/M5.5-schema-v2.md)。

## 4. 内容转换（UBB → Markdown）

`migration/src/ubb.ts` 单遍状态机：

- `[b][i][u][s]` → Markdown 强调；`[color=]`/`[size=]` → 内联 HTML span（Markdown 允许内联 HTML）
- `[quote]` → 递归转 blockquote；`[code]` → 围栏代码块；`[url=]`/`[img]` → MD 链接/图片
- ~~`[s:N]` → `![表情](/attachment/emotion/{folder}/{icon})`~~（v1 做法，已被下文取代：表情展开为 `/emoji/{id}.gif` 静态图）
- `[attach]` 类 → 附件链接；`[hide]/[buy]` → 折叠提示块（购买记录 threads_buy 保留）
- 未知标签：剥壳留肉；`usehtml=1` 的极少数行原文保留走净化渲染
- **双写**：`content_raw`（原始 UBB，永远可回滚）+ `content_md`

## 4.2 内容转换 v2（M5.5，覆盖上文冲突项）

- 转换器迁入 `packages/content`，与线上保存共用同一套门控语法（`:::gate{…}` 容器指令，见 [GATES.md](GATES.md)）。
- `[sell]`/`[post]`/`[hide]` → 门控：隐藏内容拆入 `post_gates.hidden_md`，`body_md` 只留占位。
- `[s:N]` 表情 → 静态图片引用（`/emoji/…`，gif 随迁移拷入 `apps/web/public/emoji/`；原文档的 `/attachment/emotion/…` 以代码实际 `/emotion/…` 为准且在 v2 退役）；映射外遗留码尽力对应旧目录 `03`，对不上降级为文本。
- 旧站内部链接 `job.php?action=topost&tid&pid` → `#p{pid}`；`p_w_picpath/`、`p_w_upload/` 相对图片 → 迁移期改写为 `/files/<storage_key>`（文件入内容寻址注册表，决策 #21）。
- 样式标签（`color`/`size`/`backcolor`）按实测使用量（color 1,245 帖、size 915 帖）保留为受限 HTML；`font` 剥壳；`table` 转 Markdown 表格；`hr` → `---`；媒体标签（wmv/rmvb/flash 共约 120 帖）降级为文本链接。
- `content_raw` 不再留在业务表；正文保真靠迁移对账（源库正文 md5 抽样）而非在线双写。
- 实测依据（2026-10-23，旧库只读）：`[sell=N,K]` 的 N 与该帖购买记录的 `cost` 完全吻合（K 为积分类型，忽略）；
  `[hide=N]` 的 5 个实例全是发帖模板里的空示例；遗留表情码 170–180 无法还原（编号与图片文件不按序对应，03 目录对应分类已关闭，旧站自己也渲染不出）→ **直接删除**；
  `p_w_picpath/back.gif` 是旧站引用头里的「回到原帖」图标（包在 `job.php?action=topost;tid;pid` 链接中）→ `[↩ 原帖](/t/{tid}#p{pid})`；
  `http://www.qingyisub.com/p_w_upload/photo/Mon_xxxx/…` 的文件实际位于 `attachment/photo/Mon_xxxx/…` → 按磁盘存在性改写为 `/files/<storage_key>`（磁盘上不存在的保留原地址并在报告中计数）。
- 表情 50 枚（`emotion_id` 120–169）静态化为 `apps/web/public/emoji/{emotion_id}.gif`（约 1.4MB，入库提交），渲染白名单随 S4 增加 `/emoji/` 前缀与 `<sup>`/`<sub>`。
- 门控标签**优先于其它标签**：交叉嵌套（`[color][sell]…[/color]…[/sell]`）时门控边界不变；孤立的门控闭合标签丢弃；表格单元格内的门控占位提升到表格之后。
- 门控标签未闭合时**失败即封闭**（到容器末尾都归入隐藏内容，不进公开正文）；旧库 tid 2023 的未闭合 `[sell]` 有 22 条购买记录，证明旧站按付费帖处理。
- **v2.1 修订**：`color`/`size`/`backcolor`/`align` 不再保留为 HTML，降级为纯 Markdown（只留文本）；`[attach]`/`[attachment=N]` 与正文内图片改写为 `/files/<storage_key>`（见 DESIGN-MODEL §5）；
  `/attachment/**` 在运行时退役，仅在迁移期作为读取旧文件的来源。
- 未闭合标签规则：`[attachment=N]`、`[li]`、媒体标签及未知标签未闭合时**不包裹**后文（v1 会吞掉其后全部正文）。

## 4.5 URL 结构（M3 冻结，301 依赖）

| 新 URL | 含义 | 旧站 301 源（M12 实施） |
|--------|------|------------------------|
| `/f/{fid}` | 版块（`?page=N`、`?type={type_id}`） | `thread.php?fid=N`、`simple/?f=N` |
| `/t/{tid}` | 帖子（`?page=N`、锚点 `#p{pid}`） | `read.php?tid=N`、`simple/?t=N` |
| `/attachment/**`、`/emotion/**` | **已退役**（S4-4）：附件/头像/正文图片走 `/files/<storage_key>`（迁移已改写正文链接），表情走 `/emoji/{id}.gif` | 旧路径返回 404；旧外链的 301 表归 M13 评估 |

旧站未启用伪静态（nginx conf 实证），301 源即原生 query string。**新格式自 M3 起冻结**：改动必须先迁移 301 表。

## 4.6 认证与账号（M4 行为冻结）

- **注册**：`register.mode` = invite（默认，站点语义）/ open（邮箱验证令牌）；模式存 `site_settings`。
- **会话**：不透明令牌 cookie（HttpOnly+Lax，Secure 随站点协议），库内仅存 SHA-256；登录轮换、改密/重置吊销全部；封禁/过期即时失效。
- **找回/认领**：同一邮件令牌管线（purpose 区分）；找回=已设密账户、认领=`password_hash IS NULL` 老账户（服务端强校验）；频控与统一话术防枚举。
- **封禁**：v2 起统一为 `user_restrictions(kind=ban)`（`scope_id=0` 全局；`ends_at` 空 = 永久）；登录拦截+理由展示；全局封禁 → 站内只读横幅；版块级封禁由 authz 消费；设置/解除时发 `account.restricted` 通知。
- **头像**：旧站算法 `avatar/{pad3(⌊uid/1e6⌋)}/{pad2(⌊uid/1e4⌋)}/{pad2(⌊uid/100⌋)}/{uid}[_middle|_small].jpg`，迁移期入库为 `files`（`user_profiles.avatar_file_id`），运行时经 `/files/<storage_key>` 公开访问。
- **E2E**：独立库 `qysub_next_e2e` + 3200 端口 + MailPit（8025 API 抓信）；一键 `pnpm test:e2e`。

## 5. 附件策略（v2.1 修订）

不再直指旧站目录。迁移时把附件、头像、正文图片、徽章图计算 SHA-256 后复制进新存储（`STORAGE_DIR`，布局 `ab/cd/<sha256>.<ext>`），
登记 `files` 并写 `attachments`；运行时统一经 `/files/<storage_key>` 提供。图片类公开；非图片附件按所属帖子的版块读权限校验并累加下载数。
将来换对象存储只需替换存储适配层，路径语义不变。详见 [DESIGN-MODEL.md](DESIGN-MODEL.md) §5。

## 6. 里程碑（沿用四阶段，细化）

1. **P0 数据迁移** ✅（2026-10-23 完成）：`migration/` 幂等迁移程序 + 23 项验证全部通过
   - 新库：`qysub-next-mysql`（MySQL 8.4 LTS）@ 127.0.0.1:33621 / `qysub_next`
   - 重跑：`pnpm migrate`（UPSERT 幂等，AS new 语法）· 验证：`pnpm verify:migration`
2. **P1 论坛 MVP**：Next.js 骨架、版块/主题/回帖只读渲染 → 编辑器（MD）→ 登录（密码重置注册流）→ 管理侧
3. **P2 功能补全**：等级/勋章/积分流水、投票、私信、点赞关注、签到（按 §8 模块化实现）
4. **P3 移动端 PWA**：manifest + 离线壳 + 推送
5. **P4 社区重启**：域名切换、旧 URL 301（tid/pid 保留所以可精确映射）、老用户邮件召回

## 7. 风险与对策

| 风险 | 对策 |
|------|------|
| GBK 生僻字/日文假名丢失 | utf8mb4 连接实测无损（含 EUC-JP 历史字节）；验证程序 600 行抽样 MD5 全对 |
| 假名同形用户名碰撞 | username 列 utf8mb4_0900_as_cs（区分大小写与平/片假名） |
| 垃圾内容误伤真实帖 | 规则保守（无正文且无回帖才判 spam），且只标记不删除 |
| 密码不可迁移导致召回流失 | 召回邮件直达重置页；老帖页面常驻「认领账号」入口 |
| 孤儿 uid（用户已删、帖还在） | UI 统一渲染「已注销」；不阻塞迁移 |
| 旧附件热链失效 | 站内正文已在迁移期改写为 `/files/…`；站外热链旧路径 404，是否做 301 表归 M13 评估（415 附件仅 1 个源盘即缺失） |
| 遗留表情码/截断正文 | 原样保留，content_raw 永久可考古 |

## 8. 功能插件化设计（模块注册表模式）

phpwind 的插件/钩子是运行时注入；Next.js 没有这类机制，也不需要——我们用**编译期模块注册表**达到同样的即插即用效果，且类型安全：

```
src/modules/
  registry.ts        # 内核：defineModule() + 注册表 + 事件总线 + UI 槽位
  checkin/           # 每个功能一个自足模块（如签到）
    index.ts         #   defineModule({ id, hooks, slots, migrations })
    api/ routes
    components/
  credits/  medals/  poll/  pm/ ...
```

- `defineModule()` 声明：需要的数据表（Drizzle schema 片段）、监听的领域事件（如 `post.created` → 加积分）、注册的 UI 槽位（如帖子页侧栏「签到」入口）、路由前缀。
- 核心内核只认识 registry 与事件总线；**增删一个功能 = 增删一个模块目录 + registry 一行**，互不渗透。
- 签到、积分、勋章、投票、私信全部按此模式实现，替代旧系统的 hack/插件目录。

## 9. 本地环境速查

| 资源 | 地址/路径 |
|------|-----------|
| 旧库（只读！） | `127.0.0.1:33620/qingyisub`（GBK，root；口令见根 `.env`） |
| 新库 | `127.0.0.1:33621/qysub_next`（MySQL 8.4，root；本地开发口令见根 `.env` / `docker/qysub-next/compose.yaml`） |
| 旧站本地还原 | http://127.0.0.1:8080（qingyisub-nginx） |
| 附件目录 | `/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/attachment/`（527MB） |
| 表情目录 | 同上 `res/images/emotion/{folder}/`（新站路由 `/emotion/**`） |
| 迁移程序 | `FunWind/migration/`（环境见仓库根 `.env`；`pnpm migrate` / `pnpm verify:migration`） |
| 新库容器 | `FunWind/docker/qysub-next/compose.yaml` |
