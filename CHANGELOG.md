# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式；
版本号采用语义化版本（SemVer）。里程碑交付在条目中标注（M1–M13，见 docs/ROADMAP.md）。

## [Unreleased]

### Added（M8：互动套件、通知中心后端与顶栏铃铛、站内搜索）

完整记录见 [docs/milestones/M8-interact-search.md](docs/milestones/M8-interact-search.md)。

- **点赞**：帖子页首帖与楼层点赞按钮 + 点赞者弹层（`<details>`，无客户端 JS）；`reactions` 主键天然防重，toggle 在一个事务内完成「明细 ± 计数同步」（口径与 recount 一致）；`reaction.added` 经事务性 outbox。迁移的 1,623 条旧点赞明细直接生效。
- **关注**：用户（资料页）与版块（版块页）关注按钮；`user_stats.follower_count` 同事务同步（版块无计数列，实时聚合）；`/follows` 动态页聚合关注版块新帖与关注用户发帖（可见性与目录口径同首页；旧 fresh 流不迁）。迁移的 3,827 条旧关注直接生效。
- **标签**：发帖/编辑表单标签输入（逗号分隔 ≤5，新建需 `tag.add`）；帖子页标签 chips、版块页标签云与 `?tag=` 筛选（实时聚合，`tags.thread_count` 缓存列仅对账）；12 个旧标签与关联已随 M5.5 在库。
- **@提及**（站长拍板本期接线）：content 包 `@用户名` 解析器（行首/空白后边界、全角标点截断、email 不误伤）；发帖/回帖/编辑三处接线（编辑只对**新增**提及发事件），归一化键精确匹配活跃用户、自提及排除；`post.mentioned` 经 outbox。
- **通知中心后端**：`notify()` 管线（查偏好 → mandatory 短路 → 聚合 → 写库；写库失败抛错吃 outbox 补派）；类型目录 **27 个全注册**（互动 6 / 私信 1 / 审核 15 / 账号 5——审核/私信类本期只注册可渲染，生产方在 M9/M10）；7 个事件消费者（回复/被回复/提及/点赞/关注/门控收益/积分调整/徽章）；聚合语义=同 groupKey 未读行原位更新（count SQL 递增、已读后新开）；偏好无记录=站内开、强制类型不可关。
- **gate/adjust 事件入事务性 outbox**（M8-1 部分，站长拍板）：购买双分录 + `gate.unlocked` 与 `adjust.admin` 的 `points.changed` 在业务事务内登记——收益通知不丢单（快路径失败 → drain 补派测试锚定）。
- **顶栏铃铛**：客户端岛（挂载 + 窗口聚焦刷新 `/api/notifications/bell`，无实时推送）；总未读徽标 + 下拉面板（各分类未读 + 最近 10 条聚合未读 + 全部已读）。
- **精简 `/notifications` 页**（站长拍板：铃铛「查看全部」的去处）：通知+公告合并时间线、游标分页、单条/全部已读、分类筛选；完整通知中心页面（批量操作/偏好设置）留后续。
- **站内搜索**：迁移 0006 手写 FULLTEXT ngram 双列索引（`threads.title` + `posts.body_md`；drizzle DSL 不支持 FULLTEXT）；`/search` 页（相关度/时间排序、分页、空结果引导、顶栏入口）。可见性硬约束：visiblePredicate + ForumTree is_listed + 正文命中仅 `state='visible'`；门控隐藏内容天然不可搜（不存于 posts）。

### Fixed（M8 期间发现并修复；收尾审查的完整清单见 docs/reviews/2026-10-26-m8-code-review.md）

- **markRead(all) 只清公告不清通知**（E2E 抓到）：「全部已读」后账号类通知仍挂未读——`all` 分支被 category 守卫跳过；修正为全分类 UPDATE。
- **收尾审查整改（P1×3）**：编辑回帖不再清空主题标签（action 默认值 × service 缺 kind 守卫）；公告 Tab 不再混入全分类通知；搜索查询剥除 BOOLEAN 操作符（裸 `@`/`"`/`(` 曾可让 /search 500）。
- **收尾审查整改（P2×11）**：并发取消点赞/取关不再双扣计数；聚合并发加唯一索引防护（迁移 0007 生成列 open_group_key + 撞键重试）且 actorIds 截断到 5；公告未读数联表有效性（过期公告读行不再吞掉新公告未读）；通知模板占位符对齐（{floor} 补数据、{price} 对齐）；待审内容不再发提及（与 thread.replied 同口径）；提及上限 10 人；搜索结果带出作者名（此前全显「已注销」）；纯标签筛选分页修复；canAddTags 按作者判定；互动三闭环 E2E 补齐（interact.spec）。

### Tests（M8）

- 单测/集成：@解析器边界（全角标点/email/去重/32 截断）；点赞 toggle/不可见帖/并发撞键；关注同步与自关注拒绝；标签解析/上限/权限；提及三路径与编辑差集；notify 聚合（count/actorIds/已读新开）、偏好与强制短路、未注册类型抛错；事件→通知真实链路（回复/被回复/提及/点赞/关注/收益/调整/徽章）；读取契约（分类未读/公告合并/游标不重复/三形态已读）；搜索可见性四类排除与排序分页；计数一致性抽查（随机 20 帖 + 全库粉丝数）。
- E2E：notifications（真实回帖→铃铛→页面→已读清零）、search（中日词表+受限可见性）、点赞/关注/标签走帖子页真实交互。
- 压力：`notify:storm`（1,000 事件抽样对账不丢单，均值 1.8ms/事件）；`perf:lcp` 增 `/search` 页（32ms）。

### Added（M7：积分与荣誉——积分台账 / 每日签到 / 荣誉徽章，含事务性 outbox）

完整记录见 [docs/milestones/M7-gamification.md](docs/milestones/M7-gamification.md)。

- **事务性 outbox**（站长拍板提前，原 M8-1 的一部分）：posting 事件族（`thread.created` / `thread.replied` / `content.submitted` / `attachment.uploaded`）在业务事务内登记 `event_outbox`（迁移 0005），提交后同步派发为快路径，失败/崩溃由巡检补派（`pnpm outbox:drain`；`db:verify` 滞留检查）。at-least-once 投递 + 消费端幂等；补派 event_log `source="outbox"`。语义见 `docs/MODULES.md` §8。
- **积分模块**（`defineModule` 首个真实生产-消费闭环）：消费发帖/回帖事件自动发放 `earn.post`（+3）/ `earn.reply`（+1，均为旧站实测初值），幂等键 `thread:{id}` / `reply:{postId}`；日上限在账户行锁内按「已发放额+本次不得超过上限」判定（北京时间自然日，0=不限）；管理员手工调整 `adjust.admin`（强制备注，台账与 `audit_log` 同事务）。
- **积分页 `/points`**（余额+累计+台账分页）与**后台 `/admin/points`**（`admin.points` 权限点：显示名、奖励数值与日上限配置——变更经 `setting.update` 审计；手工调整）。
- **签到模块**：北京时间自然日签到 + 连签（迁移历史 4,004 行驱动）+ 随机奖励 `earn.checkin`（`punch.reward` 1–5，旧站语义；min=max=0 可关闭）；重复签到由 `checkins` 联合主键兜底；`checkin.done` 经 outbox。首页 `home.after-header` 签到条 + 本月迷你日历（只显示本人状态，不显示他人活动——继承 post-m5.5 审查教训）。
- **荣誉徽章模块**：`/admin/badges`（`admin.badges` 权限点）按用户名手动授予（审计同事务，`badge.awarded` 经 outbox；重复发放由联合主键兜底）；资料页 `profile.header` 徽章卡与帖子页作者行 `thread.user-badge` 图标位（内核槽位清单扩展 + `SlotContext.userId`，均留档 MODULES.md）；旧勋章与团队徽章展示（图标缺失的 4 枚首字占位）。
- **帖子页头像**（M7-3）：`UserBadge` 升级为异步服务端组件——有头像显示图片、无则首字母；荣誉徽章经槽位挂作者行。
- **权限词汇表 +2**：`admin.points` / `admin.badges`（存量库由迁移 0005 的 EXISTS 守卫插入补授，基线授权语义不变）。
- **demo-checkin 退役**：演示模块由真实积分/签到/徽章模块替换；装卸与事件验收迁移到 `modules.spec` / `events.spec` / 各模块 E2E。

### Fixed（M7 期间发现并修复）

- **附件空列表不可恢复（M6 审查 F-5 的缺口）**：清空全部附件时草稿键被删除，冲突后「恢复附件」永远不出现；现空列表也持久化，E2E M7-4（两窗口冲突→恢复→保存→列表一致）覆盖。
- **签到幂等冲突降级**：「签到行不在而台账在」的异常数据不再以 500 暴露，按已签处理并告警。
- **outbox 行 actorId 透传**：补派/快路径把入队时的动作发起者传给 emit，事件审计的 actor 不再回退到 payload 字段映射。

### Tests（M7）

- 单测/集成：发放幂等与重放、日上限边界（昨日 23:59:59 不计入今日）与并发（cap 内恰 N 笔）、`POINTS_TX_OPTIONS` 口径统一；outbox 崩溃注入补派、并发 drain 不丢行、载荷逐字一致；签到连签/中断/闰年/20 路并发恰 1 成功；徽章并发重复发放恰 1 路成功且失败侧审计不落行；M7-1 双真连接「购买 vs 隐藏」15 轮随机交错（成功⟹先买后藏且扣款完整；not_found⟹不扣费）。
- E2E：`points.spec`（发帖入账/台账/规则配置驱动/管理调整审计）、`checkin.spec`（签到/连签/装卸）、`badges.spec`（授予/展示位/重复授予/装卸）、`edit.spec` 附件冲突恢复（M7-4）；`modules.spec` / `events.spec` 改挂真实模块与 outbox 留痕。
- 对账：`db:verify` 新增 `points:对账`（余额=台账之和、无负余额，现 21 项）。
- 性能：`perf:posting` 复测 p95 15.3 ms（outbox+积分消费者在请求路径上；通过线 300 ms）。

### Security / Fixed（M6 代码审查整改，2026-10-25）

完整记录见 [docs/reviews/2026-10-25-m6-code-review.md](docs/reviews/2026-10-25-m6-code-review.md)。无 P0；P1 3 项、P2 27 项、安全中危 1 项，全部核实后整改。

- **浏览量刷量（安全）**：拿不到可信 IP 时不再回退到 User-Agent（换 UA 即可无限刷量）；拿不到 IP 的请求共用限额桶；登录用户增加按账号限额；信标请求体上限 1 KB，限流先于读体。
- **幂等与频控**：双击或重试的第二次提交返回已创建的主题 / 回复，而不是「发帖太频繁」；重复检查只认可见与待审记录。
- **门控与附件**：登记与拆分使用同一份规范化源码；附件开放判定关联不上即锁定；版主替作者编辑时，新增门控与附件的权限归作者（与 GATES.md 一致）；`/files` 的 404 不被共享缓存；「内容更新于」比较改为二进制（只改大小写也算变化）。
- **解锁**：持锁前复核主题与帖子状态，不可见不扣费（锁序：主题 → 门控 → 账户）。
- **上传**：**版块参数改为查询参数 `forumId`**（接口变化：表单里的 `forumId` 不再接受），权限在读取请求体之前判定；同一账号并发上限 3；配额预检前移；BMP 入口即 415；GIF 去除注释与非动画扩展块；缩略图同一目标并发生成共享一次。
- **草稿与编辑冲突**：编辑冲突时，正文与附件的提交版本以提示交给作者选择恢复或丢弃；成功发布后的暂存草稿不再残留；草稿提示不因输入而弹出，输入不覆盖已有草稿；上传完成时编辑器未就绪则排队补插；编辑器起点改用 `useSyncExternalStore`。
- **巡检**：去重命中的旧文件不再被报告为孤儿；签名中的 `/files` 引用纳入巡检；`db:gc-files` 增加磁盘孤儿报告（只读）；完整性检查覆盖所有附件行。
- **性能**：去重满载时一次淘汰到九成；孤儿巡检的正文引用一次收集。

### Added（M6.5：门控创作收尾、浏览量、业务事件、频控与性能验收）

- **门控「内容更新于」**（迁移 0004，`post_gates.content_updated_at`）：只在隐藏正文真的变化时推进，改价与改条件不推进；从未变过不回填。显示规则见 `lib/gates/update-note.ts`（作者与版主不显示；已解锁且解锁不早于更新的读者不显示；其它情况显示，包括回复类条件的读者，保守地显示）。文案只有时间，不含新旧正文。
- **改价提示**：编辑页对已有购买记录的门控显示解锁人数与「改价只影响之后的购买，已购买者不退差价」。解锁人数只读计数（`unlockCountsByGateKey`）。
- **「回复可见」去回复引导**：锁卡片的「回复本帖后可见 · 去回复」链接到 `#reply`，只是导航，判定不变。
- **浏览量** `POST /api/views`（204 对外一律；跨站 403、格式错 400、超限 429）：客户端信标（`components/content/view-beacon.tsx`，主题页挂载后发送一次）；同一访客 30 分钟计一次（登录用户按 userId，游客按 IP 哈希）；作者本人与不可见的主题不计；进程内累加，每 10 秒批量 `UPDATE`。按 IP 每分钟 120 次、全局每分钟 6000 次。浏览量是估计值，不参与任何权限或账目。
- **`attachment.uploaded` 派发**：保存事务提交后，为每条新建的下载附件各派发一次（载荷 `{attachmentId, fileId, uploaderId}`，无文件名与正文）。发主题 / 回帖 / 编辑三处接入（`lib/posting/service.ts`、`lib/posting/mutate.ts`）。
- **演示消费方**：`demo-checkin` 另订阅 `thread.created`、`thread.replied`、`attachment.uploaded`，进程内计数显示在首页页脚（纯演示，不改业务数据）。

### Changed（M6.5）

- `registerPostFiles` 返回每条新建附件的 id（`uploaded`），供派发使用；更新已有附件的原始文件名时一并更新。
- `demo-checkin` 的页脚文案由单一横幅扩展为「横幅 + 业务事件计数」。

### Tests（M6.5）

- 单测：浏览量去重窗口、作者本人不计、隐藏主题不计；「内容更新于」的时间比较；改价提示的解锁人数；演示模块的计数。
- 集成：`content_updated_at` 只在隐藏正文变化时推进（改价不推进）；`attachment.uploaded` 派发与 `event_log` 载荷（不含文件名）；浏览量 30 路并发记录与两次并发刷入后恰好计数 30。
- E2E：门控改价提示、「内容更新于」（解锁后的读者视角）、「去回复」跳转；浏览量信标计数；发主题带附件后演示页计数变化；频控三条提示（发帖间隔、每日主题、每日上传，`e2e/limits.spec.ts`）；泄露专项补充「修改隐藏正文后」两项（五视角 HTML / RSC / 编辑页，以及事件与审计日志）。
- 性能：`pnpm --filter @funwind/web perf:posting`（服务层顺序 `createReply`，N=200，仅允许 `qysub_next_e2e`），实测 p95 10.0 ms（两次运行一致），失败线 300 ms，记录见 `docs/milestones/M6.5-gates-polish.md` §14。
- 门禁（真实输出）：`verify:all` 通过（web 单测 1185 项，db 65，content 50，migration 251）；`test:e2e` 通过（桌面 + 移动 148 项，生产冒烟 10 项）；`db:verify` 19 项；`verify:migration` 110 项（含 fidelity）；`check:secrets` 与格式检查通过。

### Added（M6.4：上传、图片与裁剪）

- **上传接口** `POST /api/upload?purpose=inline|attachment|avatar`（Route Handler）：同源 → 登录 → 限流（用户桶 30/分钟、全局桶 600/分钟，被用户桶拒绝的不占全局额度）→ 按用途的字节上限（413）→ 版块权限（越权 404；头像另查 `no_avatar` 与封禁 / 禁言）→ 嗅探与准入（415）→ 图片处理（400 / 413）→ 配额与落盘登记（429）。
- **嗅探与准入**：魔数判定（不信扩展名）；扩展名白名单（旧站 7 种 ∪ jpeg / webp / bmp / 7z，不含 svg / html / js）；扩展名与真实类型必须一致（伪装拦截）；用途限制（内联图与头像只收图片）。
- **图片处理**（sharp 0.35.5，精确版本）：EXIF 自动定向（先 rotate 再 extract）；去除 EXIF / GPS；同格式重编码（jpeg 质量 90）；GIF 不重编码；像素上限 40 MP（解压炸弹）；裁剪参数严格校验（整数、非负、最小边 32、不越界、头像 1:1）。BMP 当前构建无法解码，以 `undecodable` 拒绝。
- **存储**：内容寻址 `ab/cd/<sha256>.<ext>`，临时文件再原子 rename；`files` 按哈希去重；`file_uploads` 记录每次上传（含去重命中，配额口径不随去重改变）；头像同事务写 `user_profiles.avatar_file_id`。
- **数据库**（迁移 0003）：新表 `file_uploads`；`attachments.kind`（`download` / `inline`，默认 `download`）。`db:verify` 新增「内联附件与上传」检查，现为 19 项。
- **可见性**（`/files/<key>`，修正旧泄露）：图片公开当且仅当没有任何附件行，或存在一条未绑门控、所在帖子对**游客**可见的引用；否则经附件行鉴权放行，响应 `private, no-store`。此前「存在一条未绑门控的引用即公开」不看帖子可见性，受限帖与待审帖的图片因此对游客公开。
- **缩略图** `/files/<key>?w=320|800|1600`：同格式、只缩小不放大；先鉴权再看缓存；缓存在 `STORAGE_DIR/.cache/thumbs/`；ETag 带宽度。GIF 与 BMP 返回原图。
- **保存时登记**（事务内）：正文引用（公开部分与门控隐藏正文，经 `@funwind/content` 的 `extractFileRefs`）登记为 `inline` 行；归属须为作者本人上传（或该文件已被本帖引用，且不属于别人的帖子）；新增归属需要 `attachment.upload`（错误码 `upload_forbidden`）；附件的门控 key 须是本帖现存门控；门控删除只被下载附件阻止（内联行随门控清理）。
- **编辑器界面**：插入图片（富文本与源码两种模式，输入法组合中延后插入）、粘贴截图、「裁剪后插入」（`react-image-crop` 11.1.2，经 `next/dynamic` 按需加载）、附件面板（上传、移除、门控归属下拉，草稿与提交暂存）、上传中禁用提交按钮。工具栏图片占位按钮移除。
- **头像设置** `/settings/avatar`：选图、强制 1:1 裁剪（GIF 直传并取首帧居中裁切）、保存后刷新；导航栏新增「头像」入口。
- **孤儿文件巡检** `pnpm db:gc-files --dry-run`：只报告（宽限期 24 小时）；无附件行、无头像、无徽章图标，且公开正文中也没有 `/files` 链接的文件。开发库当前 0 个。
- **同源判定**（`lib/net/same-origin.ts`）：按 Host 头（协议取 X-Forwarded-Proto）比较，与 Server Action 一致；Next 的 `request.url` 在本地为 localhost，原判定会误拒所有浏览器上传。预览与上传共用。

### Fixed（M6.4 实施中发现，未发布）

- 预览限流顺序：先用户桶、后全局桶（安全审查复查）。
- 旧引用例外过宽：购买者可借旧正文登记别人门控图为公开（安全审查指出）。
- 新增归属缺少 `attachment.upload` 判定；头像分支缺少写类权限判定（封禁用户可设置头像，安全审查指出）。
- 附件字段缺失与空列表不再等同（旧版本表单编辑会清空附件）。
- 同源判定误拒浏览器上传（E2E 实测发现）。
- 评估器：`attachment.upload` 不经版块读判定，普通会员可向受限版块上传（越权，已修正并补单测）。

### Tests（M6.4）

- **单测**：上传客户端、裁剪换算（含性质测试）、附件面板、图片按钮、编辑外壳插图（富文本与源码）与裁剪确认 / 取消、粘贴、提交禁用、输入法延后、两种编辑器的插入能力、头像组件、同源判定、嗅探 / 准入 / 裁剪校验 / 图片处理（真实 sharp 夹具）、缩略图与可见性矩阵。
- **集成**：存储与配额并发（5 路并发限额 2 恰好 2 成功）、去重计数、头像写入、登记的归属与门控映射、附件对账、孤儿巡检。
- **E2E**：正文插图并发布；门控附件的泄露检查（游客只见锁定提示）；裁剪后插入；头像设置；375px 版式（编辑器与头像页）；受限内联图的缩略图鉴权。
- **覆盖率**：`src/components/upload/**` 纳入统计（阈值与编辑器相同）；裁剪工具本体（`crop-body.tsx`、`crop-dialog.tsx`）为第三方交互壳，排除并由 E2E 覆盖。

### Changed（M6.4）

- E2E 存储隔离：`test:e2e` 设置 `STORAGE_DIR=<仓库根>/storage-e2e`（每次运行前清空），与开发目录 `storage/` 分开；CI 经同一脚本生效。`.gitignore` 忽略 `/storage-e2e/`。
- 授权文档（`docs/AUTHZ.md`）：写类权限 `attachment.upload` 先过版块读判定。
- 附件门控文档（`docs/ATTACHMENT-GATES.md`）新增 §12（M6.4 修订）。

### Added / Changed（M6.3：编辑器——所见即所得、源码模式、门控块、预览、草稿）

- **编辑器栈**（依据 E0 选型，精确版本）：Tiptap `3.31.4`（`@tiptap/react` / `core` / `pm` / `starter-kit` / `markdown` / `extension-table` / `extension-image` / `extension-hard-break`）、`marked` `17.0.6`（与 `@tiptap/markdown` 同版本）、CodeMirror `@codemirror/state 6.7.6` / `view 6.43.14` / `commands 6.11.1` / `language 6.13.1` / `lang-markdown 6.5.2`。**偏离两周发布规则**：E0 选用的 Tiptap `3.32.0` 与 CodeMirror view `6.43.15` 发布不足两周，改用上一个稳定版本。
- **Markdown 纯层**（`components/editor/markdown/`）：自定义 `del`（只认 `~~x~~`，与渲染端的 `singleTilde: false` 一致）、软换行 `br` 规则（软换行在往返中保留为换行，不变成硬换行）、`inlineText` 截断到换行；`roundtripMarkdown` 供服务端与单测复用。
- **门控节点视图**（`markdown/gate.ts`）：`:::gate{key unlock price}` 渲染为带下拉（付费可见 / 回复可见）与价格输入的块；价格只对付费门控显示；正文区交给 ProseMirror，头部控件自己处理事件；节点类型不同时拒绝原地更新。
- **组件**：`RichEditor`（所见即所得）、`SourceEditor`（CodeMirror，`next/dynamic` 按需加载，只在切到源码时下载）、`EditorToolbar`（加粗 / 斜体 / 删除线 / 列表 / 引用 / 代码块 / 表格 / 分隔线 / 换行 / 插入门控块 / 撤销重做；图片按钮占位，M6.4 接入）、`EditorShell`（组合两种模式、预览、草稿与隐藏字段）。
- **隐藏字段与表单**：`EditorShell` 通过 `HiddenSource`（`memo` 包裹的 `<input type=hidden>`）把 Markdown 交给表单，避免外壳重渲染时 React 把值写回原文。
- **预览**：`POST /api/preview`（Route Handler，偏离原设计的 Server Action，因为 `defineAction` 返回 void）。同源检查、**必须登录**（游客 401）、每用户 60 次 / 分钟加全局 600 次 / 分钟的限流（不依赖可信 IP）、流式字节上限 900 KB（超出 413）、零库访问；渲染不进共享缓存（`renderMarkdown(md, { cache: false })`）；`previewHtml` 把门控正文替换为占位，结果经净化管线输出。
- **往返保护**（`lib/posting/roundtrip-check.ts`）：判定标准是**渲染等价**（服务端 `renderMarkdown(原文) === renderMarkdown(编辑后源码)`）。未编辑的旧帖保留原文，绝不重新序列化；往返不等价的帖强制源码模式，并在界面说明原因（`SOURCE_ONLY_REASON`）。实测语料：文本逐字一致 62.7%、渲染等价 86.6%。
- **草稿**（`components/editor/draft.ts`）：`localStorage`，键 `funwind:draft:<userId>:<kind>:<id>`，每次变化即写入（不做防抖）。载入时存在与原文不同的草稿则提示「恢复 / 丢弃」，不静默覆盖；草稿经 `useSyncExternalStore` 在挂载后读取。**提交即暂存**：表单 submit 时草稿移到 `…:sent`、主键清空，服务端校验失败跳回时从暂存键恢复，成功后不残留提示。**登出清除全部草稿**（`LogoutForm`，提交前同步清理）。存储不可用时静默降级。
- **接入**：发主题（`/f/[fid]/new`）、快速回复（`/t/[tid]`）、编辑（`/p/[pid]/edit`）全部换成编辑器；编辑页的 `forceSource` 由 `richEditReason` 决定。
- **移动端**：工具栏按钮移动端触控目标 44px，桌面 36px。

### Fixed（M6.3 实施中发现并修复，未发布过）

- **水合失败**：草稿提示最初在 `useState` 初始化函数里读 `localStorage`，服务端无提示、客户端有提示，E2E 日志出现 `Hydration failed`。改为 `useSyncExternalStore`（服务端快照为空）。
- **HiddenSource 值被重置**：外壳状态变化时 React 会把 `defaultValue` 写回隐藏字段，覆盖刚同步的正文。以 `memo` 隔离。
- **成功回帖后草稿残留**：提交后草稿仍在主键，再次进入会误弹「发现未发送的草稿」。改为提交即暂存（见上）。
- **未编辑的旧帖被改写**：编辑器创建时的序列化可能与原文细微不同，原先会把未编辑的正文改写成编辑器格式。现在只在起点不是原文时同步。

### Tests（M6.3）

- **单测**：编辑器目录 67 项（`components/editor/**`，含 jsdom 真实 Tiptap / CodeMirror 实例）；门控节点视图的事件归属与更新分支；工具栏命令逐个点击；预览成功 / 进行中 / HTTP 错误 / 网络异常 / 再次预览清错误；草稿读写清理与存储异常降级；提交暂存。`src/lib/posting/preview.test.ts`（含 `SECRET-PREVIEW` 泄露回归）、`roundtrip-check.test.ts`、`app/api/preview/route.test.ts`。
- **覆盖率**（`vitest.config.ts`）：统计范围扩到 `src/components/editor/**`，阈值 行 90 / 分支 85 / 函数 90 / 语句 90；实测 语句 94.76 / 分支 90 / 函数 91.07 / 行 96.45。
- **E2E**：`e2e/support/editor.ts`（`bodyEditor` / `fillBody` / `fillSource`，按可访问名称定位，不依赖具体 DOM）；`edit.spec` 增加门控可视块、源码模式、往返不等价旧帖的说明与禁用切换；`reply.spec` 增加草稿恢复（含水合错误断言）与成功后不残留；`leak-sweep.spec` 增加五种视角的 `/api/preview` 扫描（带公开前言的正向对照）。
- **验证**：`pnpm verify:all` 通过（web 单测 1023 项，包 251 项，lint / 格式 / 类型 / 构建）；`pnpm test:e2e` 通过（桌面 + 移动 131 项，生产冒烟 10 项，水合错误 0）；`pnpm check:secrets` 通过。
- **未完成**：真机清单（iOS / Android 的拼音、手写、语音输入）尚待站长签字后勾选验收；M6.4 的图片上传与裁剪。

### Added / Changed（M6.1 第 4 步：写路径底座——重算、对账、预言机并发测试）

- **共享重算 `recountAll`**（`packages/db/src/recount.ts`）：计数列（`threads` 回复数与最后回复指针、`forums` 计数与最后发表、`user_stats`、`posts.like_count`、`tags.thread_count`）由明细整体推导，口径与写路径预言机逐条一致。单事务，按 `user_stats → threads → posts → tags → forums` 的加锁顺序执行；每组先建临时快照，执行后比对，给出每表、每列的修正行数。干跑时比对后回滚。迁移的 `countersStep` 改为调用它；对已迁移的开发库做干跑，全部表、全部列零漂移，说明新口径与迁移产出一致。
- **`db:recount`**（`packages/db/scripts/recount.ts`）：默认直接修正（幂等，第二次零修正）；`--check` 只读，有漂移时非零退出，供巡检或 CI 使用。
- **`db:verify` 由 13 项扩到 18 项**（`packages/db/src/integrity.ts` 的 `findStructuralAnomalies`）：孤儿引用（帖→主题、主题→版块、门控→帖、附件→帖）；楼层唯一（`uq_posts_thread_floor` 为 `(thread_id, floor)` 唯一索引且无重复）；首帖指针指向本主题楼层 1；主题状态与首帖状态一致；缓存计数与明细一致（复用 `recountAll` 干跑，零漂移才过）。
- **演示数据的计数改为统一重算**：`seedDemoData` 与 `seedE2eFixtures` 末尾调用 `recountAll`，不再手工设值。原先的手工版块计数同步只覆盖 3 个版块，且用 `MAX(first_post_id)` 作最后回复，口径有误，已删除。新增 `client.ts` 的 `poolOf(db)` 收口 drizzle 的连接池类型。
- **随机操作序列的预言机测试**（`apps/web/src/lib/posting/oracle-random.int.test.ts`）：发主题、回帖、编辑、删除、恢复、隐藏、驳回、审核通过，三个版块（不审 / 审主题 / 全审）、三位作者加版主，固定种子。单线程 300 步，每 20 步设一个检查点；另有 6 轮并发，每轮 8 路，其中偶数路的回帖全部打到同一热点主题。每个检查点做三重核对：全库 `recountAll` 干跑零漂移、结构完整性为零、预言机逐版块 / 主题 / 作者比对。测试还断言每类操作至少成功一次（防空转），以及并发阶段的楼层撞键重试为零。耗时约 10 秒。
- **`postingRetryStats`**（`lib/posting/service.ts`，仅供测试观测）：`withPostingRetry` 每次重试时累加死锁与撞键次数。正确的加锁与隔离下，楼层撞键重试本不应发生；它一旦出现，说明楼层分配依赖重试兜底。
- **变异验证 5 项各自变红**：去掉主题与版块行锁（随机测试与 `service.int` 并发楼层用例抓到）；隔离级别改为 REPEATABLE READ（随机测试的撞键重试断言抓到）；楼层 `MAX` 只统计可见帖（随机测试与 `mutate.int` 抓到）；回帖隐藏少减一次（8 项抓到）；去掉 60 秒幂等（幂等与并发双击用例抓到）。
- **测试期望修正**：`queries.int.test.ts` 中首页目录合计的期望，原先假定其他版块计数为 0；种子重算后版块 902 有 2 个可见主题，期望改为显式常量并注明来源。

### 测试与门禁（M6.1 第 4 步）

- `pnpm verify:all` 通过：脚本测试 40 项、db 包 63 项、web 包 902 项（覆盖率：语句 96.26% / 分支 91.40% / 函数 97.16% / 行 97.89%，门槛 90 / 85 / 90 / 90 满足）、content / migration 251 项、构建与秘密扫描通过。
- `pnpm verify:migration` 通过：110 项对账、渲染硬门禁、保真硬门禁。
- `pnpm test:e2e` 通过：dev 89 项、生产冒烟 10 项。
- 开发库 `qysub_next` 的 `db:verify` 18/18；演示库 `qysub_next_e2e` 按编排重建后 18/18。

### Added / Fixed（M6.1 第 3 步·任务 6：`locatePost` 与 `/p/{pid}`）

- **`lib/queries/locate-post.ts`**：`locatePost(viewer, postId)` 按**观众**可见的回帖数算页码（楼层 ≤ 目标、对该观众可见），不再假定楼层连续。隐藏 / 待审 / 已删的中间楼层不计入，不同观众看到的页码可以不同。目标帖或所在主题对观众不可见返回 `null`。`postPath` 拼出 `/t/{tid}?page=N#p{pid}`（第一页不写 page）。
- **`/p/[pid]` 路由**：302 到帖子所在的页与锚点；不存在、非法或不可见一律 404（不暴露存在性）。Location 用相对地址。
- **替换旧的楼层公式**：`pageOfFloor` 已删除，守卫测试禁止重新引入。主题页的父帖链接与门控购买后的返回地址改用 `locatePost`。
- **修复一处信息泄露**：主题页的父帖链接原先用 `getParentFloors` 取楼层，不做可见性过滤，因此会暴露被隐藏父帖的楼层。现在不可见的父帖不渲染链接。`getParentFloors` 已删除。
- **测试**：纯函数 7 项（页码边界、与旧公式在无空洞时一致、有空洞时旧公式错、地址形态、守卫）；集成 9 项（隐藏中间楼层、不同观众页码不同、隐藏帖与待审帖的可见性、隐藏主题、受限版块、不存在、父帖批量定位）；E2E 2 项（302 地址、404、版主看到隐藏帖的跳转）。
- **变异验证 3 项各自变红**：去掉计数的可见性过滤、改回旧的楼层公式、目标帖不做可见性检查。

### Docs（M6.1 遗留：编辑绕审）

- 自动安全审查指出：作者编辑已通过审核的帖子不会重新送审（`review_policy=all` 的版块里可以绕过审核）。这是 2026-10-24 确认的取舍（与旧站一致），此前没有写进遗留事项，现已补上（见 M6.1 设计稿 §11），由 M9 审核队列统一处理。

### Added（M6.1 第 3 步·任务 5：编辑 / 删除 / 恢复 + 事件契约 + 编辑时限）

- **事件契约**（设计稿 §7.2，`kernel/types.ts` / `event-names.ts` / `bus.ts` / `MODULES.md` 同步）：载荷只放 id 与标题，绝不放正文。`thread.created` / `thread.replied` / `thread.edited` / `thread.deleted` 补齐 `postId`、`forumId`、`authorId` 等字段；新增 `post.edited`、`post.deleted`；`content.submitted` 去掉 `pending`，改为 `threadId` + `isThread`（待审内容只发它）。清单由 21 个变为 23 个。发帖路径已改用新载荷，事件派发失败只记日志。
- **编辑时限**：`limits` 角色项新增可选的 `editWindowSec`（0 = 不限，默认 0）。它的缺省值就是设计的默认，所以旧库里不含该字段的配置仍然有效；另外三个字段仍必须写全。版主不受时限限制。
- **`lib/posting/mutate.ts`**：
  - `editPost`：编辑表单必须提交渲染时看到的 `expectedEditedAt`，不一致返回 `conflict`，不静默覆盖。作者改自己的（时限内）；版主改别人的必须填理由并写 `post.edit` 审计。主题的标题与首帖一起改。门控经 `applyGateDrafts` 对账。驳回的帖子编辑后转为待审，派发 `content.submitted`。
  - `deletePost`：作者只能删自己的回帖，或"没有别人回复"的主题（自己的回复不算）；版主删除任何内容必须填理由，写 `post.state.deleted` 审计。走 `transitionContent`，计数与指针由它负责。
  - `restorePost`：只有版主能恢复，必须填理由，作者不能自己恢复。派发 `content.moderated`（action=restore）。
- **规则**（`rules.ts`）：`canEdit` 新增编辑时限判定（`edit_window_closed`）；作者编辑已删除内容返回 `already_deleted`（比泛泛的 `bad_state` 更清楚）。
- **锁与一致性**：编辑、删除、恢复与发帖使用同一加锁顺序（作者统计行 → 主题 → 帖子 → 版块），锁后重读帖子与主题，版块与探测时不一致则返回 `conflict`。
- **自动安全审查的发现（第 4 步提交后）**：回帖的事务内检查依据事务外探测到的版块，锁后的主题版块可能不同。现在锁后发现版块不一致直接返回 `conflict`（目前没有"移动主题"的操作，M9 才有，所以暂时走不到，但检查依据必须一致）。
- **测试**：规则单测 +3 项（编辑时限）；集成 13 项，覆盖编辑（回帖、冲突、标题、驳回后重提交、时限、版主理由与审计、门控对账、并发编辑）、删除（作者删回帖、删主题的"有别人回复"规则、版主删除与审计）、恢复（作者不能恢复、理由、计数与指针）、已删除内容不能编辑。
- **变异验证 9 项各自变红**：去掉编辑冲突检查、去掉编辑时限、版主编辑不要理由、删主题不检查别人的回复、作者可以恢复、驳回后编辑不转待审、编辑不对账门控、版主编辑不写审计、删除绕过迁移。

### Added（M6.1 第 3 步·任务 4：发主题与回帖）

- **`lib/posting/service.ts`**：`createThread` / `createReply`。事务外做权限（快照 + 评估器）、限制与文本、门控语法；事务内按 `user_stats` → 主题 → 版块加锁，持锁检查发帖间隔与每日主题配额（含已删除的主题），主题锁定与可见性在锁后重读；`MAX(floor)+1` 分配楼层；60 秒幂等（同作者、同位置、同正文）；门控经 `applyGateDrafts` 落库；计数经 `applyCounterDelta`（与状态迁移共用同一口径）。提交后派发事件，失败只记日志。
- **`lib/posting/policy.ts`**（纯函数）：审核分流（版主免审；`all` 全部待审；`threads` 只审主题）、发帖间隔、每日配额、幂等窗口常量。
- **重试**：死锁与唯一键撞车（`uq_posts_thread_floor`）各重试一次，设计稿 §4 的兜底。
- **测试**：纯函数 8 项；集成 15 项，覆盖发主题（免审 / 审核版块，通过审核后计数才加上）、回帖楼层与指针、引用回复的校验、锁定主题、隐藏主题、封禁用户、文本校验、门控写入与语法错误、发帖间隔、每日配额（删除不释放名额）、幂等（含双击并发）、并发配额（5 路并发上限 2）、并发楼层（12 路，4 个作者）。每次写入后用预言机（`src/test/posting-oracle.ts`，与迁移 countersStep 同口径）核对计数与指针。
- **变异验证**：去掉作者锁（并发配额变红）、去掉幂等（变红）、审核分流失效（变红）、间隔检查失效（变红）、门控不落库（变红）；去掉回帖主题锁与版块锁同时去掉（并发楼层变红：唯一键撞车）。
- **已知局限（如实记录）**：
  - 去掉回帖的主题锁单独看，测试仍通过：版块锁同样串行化同一版块的回帖，楼层安全由两把锁共同保证，目前测试不能区分它们。
  - 事务内的锁定复查（`threadLocked` 锁后重读）没有被测试覆盖：事务外的探测已先挡住已锁定的主题，只有"探测之后、加锁之前"被并发锁定的竞争才会走到锁后复查，顺序测试构造不出来。
  - 唯一键加一次重试不是并发楼层的充分保证：去掉两把锁后，12 路并发会连续撞键，一次重试不够。加锁仍是主要保证，唯一键只是兜底。
- **事件载荷**：沿用现有类型（`thread.created` / `thread.replied` / `content.submitted`），本步没有改 `kernel/types.ts`；契约调整是任务 6 的内容。

### Added / Fixed（M6.1 第 2 步：评估器 / 门控条件 / 用户名 / limits / schema）

设计见 [`docs/milestones/M6.1-write-path.md`](docs/milestones/M6.1-write-path.md)。

- **评估器**：`EvalContext` 新增 `threadLocked`。`forum.write` 的目标是分区，或自身 / 祖先已归档 → 一律拒绝（**含 admin**，判定在 admin 短路之前）；回帖且主题已锁定 → 通过版块层后还须持有 `thread.replyLocked`。`forum.read` / `forum.moderate` 等不受影响，版主仍能处理归档版块里的内容。新增 13 项穷举测试（独立小树），变异验证 6 项各自变红。`AUTHZ.md` §8.3 同步。
- **删除 `gateConditions` 内核边界**：类型、注册校验、`BUILTIN_GATE_CONDITION_TYPES`、测试全部移除，注册边界由十类变九类（`MODULES.md` / `BLUEPRINT.md` / `NOTIFICATIONS.md` 同步）；`GATES.md` §3 重写为"内置 `points` / `reply`，未知类型 fail-closed"。**顺带修复一个真问题**：`unlockGate` 只找第一个 `points` 条件就扣款，`all` 模式下 `[积分, 未知类型]` 的门控会让买家付了钱却永远看不到内容。现在含未知条件的 `all` 门控返回 `unavailable` 且不扣费；`any` 模式下积分条件足以开门，照常可购买。读取侧新增单门控出口 `getGateContent` 与附件放行 `openGateIds` 对未知类型的端到端回归（与正文链路一致）。变异验证 2 项。
- **用户名保留名**（`lib/auth/username.ts`）：ASCII 保留词精确匹配（比较前 `normalizeKey`，并忽略夹带的数字与下划线：`admin2`、`_root_`、`ad_min` 都算 `admin`），中文词（`管理员` `版主` `站长` `客服` `官方` `系统` `已注销用户`）按"包含"拦截。只作用于新注册，不烧邀请码（E2E 直接查库验证）。已知取舍：含"系统"二字的正常昵称会被误拦。变异验证 6 项。
- **`limits` 配置**（`lib/limits/`）：默认值 `DEFAULT_LIMITS` 放 `packages/db`（bootstrap 写入缺失的键），web 侧 zod 校验，无效整体回落默认并告警；角色项必须写全三个字段（缺一个整体无效，因为缺省补 0 会悄悄变成"不限"）。`resolveLimits` 每项取最宽松：间隔取最小，额度取最大且 **0（不限）胜过任何正数**；没有任何角色匹配（游客）回落到 member 项，绝不变成不限；版块作用域的角色绑定只在该版块子树内参与取值。纯逻辑 15 项 + 真实 MySQL 8 项，变异验证 8 项（含"额度直接 `Math.max`"会把 0 误吞）。
- **schema**：`threads` / `posts` 的单列作者索引换成 `(author_id, created_at)`（迁移 `0002_author_created_index.sql`，开发库已用 `db:bootstrap` 应用；`db:verify` 13 项与 `verify:migration` 110 项仍全过）；`registerUser` 在同一事务里建 `user_stats` 行（失败回滚时无孤儿行）。变异验证 4 项。
- 验证过程中的几处自我纠错：新增的"成功购买"用例曾改动共享库的余额而牵连老用例（已挪到文件末尾并改成前后对比断言）；一个旧用例会把首帖留在 `hidden`，我的读取侧用例因此测的是"帖子不可见"而非"条件类型未知"（已先恢复可见）；多次变异的替换因 prettier 把代码拆成多行而没命中，改成断言命中后重做。

### Added（M6.1 第 1 步：`zod` + `defineAction`）

设计见 [`docs/milestones/M6.1-write-path.md`](docs/milestones/M6.1-write-path.md)（站长 2026-10-24 确认）。

- **`lib/actions/define-action.ts`**：Server Action 的统一骨架，产物恒为 `(formData) => Promise<void>`，可直接作 `<form action>`。统一做：求值模块注册表（硬约定 9）、鉴权（`guest` / `user` 未登录跳登录页 / `{ admin: 权限点 }` **先于读表单与取数**调用 `requireAdmin`）、取主体与可信 IP、声明式频控（`onLimit` 必填，写错也 fail-closed 为 404）、zod 结构校验（失败一律 404，不泄露细节；业务文案仍在 `run` 里）、`unstable_rethrow` 重新抛出 Next 控制流。依赖可注入（`createDefineAction`），单测不碰数据库与 cookie。`zod ^4.6.7` 提升为直接依赖。
- **`lib/actions/form-data.ts`**：`FormData` → 对象，只收字符串、文件字段忽略、同名多值归并为数组、丢弃 `__proto__` / `constructor` / `prototype` 键并用空原型对象。
- **迁移 14 个 Action**：`gates.ts`（1）、`auth.ts`（9）、`admin/actions.ts`（4），业务逻辑与跳转行为逐字保留，只换外壳；缺失字段仍按空串处理（`.default("")`），另给文本加长度上限（密码 1024、令牌 256…），超长按 404。登录 / 找回 / 邀请码的专用频控（先占后退、兜底桶）行为已固定且带变异验证，所以留在 `run` 里，不挪进声明式策略表。
- **可行性**：真实 `next build` 接受 `"use server"` 文件导出工厂返回的函数；开发服务器 86 项 + 生产冒烟 10 项 E2E（含购买、登录、找回、认领、验证、后台授权）全过。
- **守卫改造**：`modules-import-guard`——入口或其传递依赖里有 `import "@/modules"` 即合规（经 `defineAction` 的入口天然满足），并**先剥注释再分析**（此前文档注释里写着这串字就能让守卫被偶然满足，变异验证时发现）；`admin-entry-guard`——`/admin/**` 里的 `defineAction` 必须声明 `auth: { admin }`，且"找不到任何入口"本身算违规（否则 `actions.ts` 改写法后会悄悄通过）；新增 `lib/actions/use-server-exports-guard.test.ts`——`"use server"` 文件的运行时导出必须全是 `defineAction(...)`，防止有人手写一个绕开骨架的 Action。
- 测试：`define-action.test.ts` 20 项、`form-data.test.ts` 5 项、`use-server-exports-guard` 5 项、两个守卫共新增 5 项合成样例。变异验证 7 项各自变红（去掉 `import "@/modules"`、admin 鉴权挪到取主体之后、去掉 `unstable_rethrow`、不做 zod 校验失败处理、不检查频控、admin 动作改成 `auth: "user"`、手写导出）。验证过程中发现并修正了两处我自己的问题：zsh 下未加引号的变量不会按空格拆分，第一版变异脚本其实什么都没跑；"admin 改 user" 的替换命中了注释里的示例而非真正的 Action——都重做了。

### Docs（M5.6 S5：文档漂移清账）

- 新增 [`docs/milestones/M5.6-prelaunch-hardening.md`](docs/milestones/M5.6-prelaunch-hardening.md)：S1–S5 范围、提交、DoD 与遗留事项；ROADMAP 补 M5.6 行与依赖图；`CLAUDE.md` 更新进度。
- `POINTS.md`：积分显示名默认值写成「积分」（`DEFAULT_SITE_SETTINGS`），「青翼币」是青翼导入覆盖的值（此前写反）。
- `GATES.md` §7.1：UBB 转换器在 `migration/src/transform/ubb.ts` 而不是 `packages/content`（文档与包描述都写错了位置）；「开发库 `content_md` 存在截断」已过期；补 M5.6 S1b-3 对转换器的补充。
- `packages/content/package.json` 的 `description` 同上更正；`CLAUDE.md` 里 content 包的测试说明与 `verify:migration` 的说明同步。
- `AUTHZ.md`：§6 与 `permissions` 表行标注为 v1（`legacy_key` / `condition_params` 在 v2.1 已删，当前规则以 §8.4 为准）；§8.3 补「`forum.moderate` 与 `forum.read` 是独立权限点，`moderatedForumIds` 不是 `readableForumIds` 的子集，查询层靠求交保证安全」。
- **`post_modify_time` 语义**（`M6-posting.md`、`AUTHZ.md` §7）：此前文档写成「编辑时限」，此次核对旧库与旧源码——旧库 24 个用户组的 `post_modify_time` 全为空、`thread_edit_time` 为 0 或空，即旧站从没设过时限；旧源码里搜不到这些键的字面量，**无法确认其原始语义**，所以文档只记录已证实的事实，并注明「不要凭键名推断」。新站编辑时限做成可配置项，默认不限。**注意**：M6 规划阶段曾记过一个「本义是超时后编辑留痕」的说法，本次无法复核，不采用。
- 发现但未处理（只记录）：`loginAction` 不销毁旧会话，而 `CLAUDE.md` 曾写「登录轮换会话」——文字已改准确，行为留作遗留事项。

### Security（M5.6 S4 补丁：CSP 报告端点，自动安全审查指出）

- 提交 S4 后，自动安全审查指出 `/api/csp-report` 的两处问题，核实后都成立并已修复（各自带对照组与变异验证）：
  - **日志泄露令牌（较严重）**：违规报告里的 `document-uri` 带页面完整地址，包括 `/reset/<令牌>`、`/claim/<令牌>`、`/verify/<令牌>`（单次使用的重置 / 认领 / 验证令牌）和查询串，原样写进日志。现在 `redactUri` 只保留「源 + 规范化路径」：去掉查询串与片段，路径里 ≥20 个 URL-safe 字符的不透明段（令牌、sha256 存储键）换成 `:token`，`data:` / `blob:` 只留协议，既非 URL 也非 CSP 关键字的值记为 `[other]`。
  - **体积上限可被绕过**：只检查了 `Content-Length`，分块传输或不带该头的请求会被 `req.text()` 整个读进内存。现在流式读取，超过 16KB 立即 `reader.cancel()`；测试用 1000 个 8KB 分块的无长度请求，证明只拉取了不到 10 块。
- 变异验证 3 项（URI 不脱敏 2 项红、回到 `req.text()` 1 项红、路径令牌段不替换 3 项红）。
- 附注：反向代理的访问日志同样会记下 `/reset/<令牌>` 这类请求路径，那一层不在应用控制内，部署时应避免把访问日志发往不受信的地方（令牌单次使用且 1 小时 / 24 小时 / 30 天过期，但仍应注意）。

### Security（M5.6 S4：安全响应头 + `/files` 路径穿越矩阵，审查 C4）

- **全站安全响应头**（`lib/security-headers.ts` 纯函数，`next.config.ts` 的 `headers()` 接入，单测直接断言）：`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`X-Frame-Options: DENY`、`Permissions-Policy`（关摄像头 / 麦克风 / 定位 / 支付 / USB）；`poweredByHeader: false`；HSTS 只在「生产 + `APP_URL` 为 https」时下发（http 下浏览器忽略它，开发环境下发会污染 localhost 的 HSTS 缓存）。`/files/**` 一律排除，它自带更严的 `default-src 'none'; sandbox`，不能被叠加。
- **CSP 只以 Report-Only 下发**（不拦截任何东西）：`default-src 'self'`、`object-src 'none'`、`base-uri 'self'`、`form-action 'self'`、`frame-ancestors 'none'`，`script-src 'self' 'unsafe-inline'`（Next App Router 用内联脚本带 RSC 载荷，nonce 需要中间件，留作后续）；`style-src` 含 `'unsafe-inline'`（ProseMirror 编辑器需要）；`img-src` 放行 http/https（正文允许外站图片）；开发环境才加 `'unsafe-eval'` 与 `ws:`。**这版防的是外部脚本源、`<object>` / `<base>` 劫持、表单外投、被嵌入，不是内联脚本注入**——后者仍靠 sanitize 白名单。
- **违规报告收集** `POST /api/csp-report`：体积上限 16KB、字段截断到 200 字符并剔除控制字符（防日志注入）、每来源每分钟 30 份、永远 204；兼容旧格式与 Reporting API 格式；只记一行 `[csp-report]` 日志，不落库。
- **实测各页面零违规**（这是以后转强制的前提）：开发服务器上 12 个游客页面 + 4 个管理员页面，以及**真实 `next build`** 上 8 个页面，用浏览器的 `securitypolicyviolation` 事件收集，全部为零；另有对照用例证明检测本身是灵的（注入外部脚本源会被记录，且浏览器确实把报告 POST 到了 `/api/csp-report`）。
- **`/files` 路径穿越矩阵（C4）**：原始 HTTP（Playwright 的 request 会先把 `%2e%2e` 在客户端规范化掉，发不出真正的变体）测 28 种形态：`%2e%2e` 的各种大小写 / 混合、双重 / 三重编码、反斜杠（编码与字面）、超长 UTF-8（`%c0%ae`、`%c0%af`）、全角点、结尾 `/..`、`%00` 截断、空格 / 换行、哈希不匹配、扩展名异常等，一律 404，也不带出系统文件内容；HTTP 层规范化后落回规范路径的形态（`/./`、`//`、`/files/../files/…`）仍是同一个已授权文件，内容与规范路径一致。
- **发现并修复一处真问题**：`%2f` 编码的斜杠被 Next 解码进路径段后，`/files/49%2f77/<sha>.png` 拼接起来仍能通过 `parseFileKey` 的正则，同一个文件有了多个 URL 形态（缓存键分裂，按路径写的前置 ACL / WAF 规则可被绕过）。`parseFileKey` 现在要求恰好 3 段且段内无 `/`。变异验证：去掉检查，单测与 E2E 变红。
- 变异验证（E2E）：`script-src` 去掉 `'unsafe-inline'` → 真实页面上的零违规用例变红；不排除 `/files` → `/files` 用例变红；`next.config` 不接入 `headers()` → 响应头用例变红。
- 测试：`security-headers.test.ts` 8 项、`csp-report/route.test.ts` 7 项、`parseFileKey` 别名 1 项；E2E 新增 13 项（响应头 5 + `/files` 1 + 报告端点 1 + 零违规 3 + 穿越矩阵 3），生产冒烟新增 3 项。
- **以后转强制 CSP 的路径**：先观察生产的 `[csp-report]` 日志一段时间 → 把 `Content-Security-Policy-Report-Only` 改名为 `Content-Security-Policy`（`security-headers.test.ts` 里有一条断言「不含强制 CSP」，转强制时同步改）→ 再评估用 nonce 去掉 `script-src 'unsafe-inline'`。

### Security（M5.6 S3 补丁：无可信 IP 时的全局桶，自动安全审查指出）

- 提交 S3 后，自动安全审查指出两处「无可信 IP 时的全局共享桶可被一个客户端占满」。采纳并核实：`clientIpFrom` 在 `TRUSTED_PROXY_HOPS=0`（直连）时**恒为 null**，所以这不只是异常情形，直连部署的常态就是只剩全局桶。
- **`forgot`**：全局桶改到「查到真实账号并通过账号级冷却 / 小时额度之后」才计数。随机邮箱查不到账号就返回，烧不掉它；对同一邮箱反复请求先被账号冷却挡住。要占满得知道 60 个互不相同的真实注册邮箱。新增 2 项测试（500 个随机邮箱不影响真实用户；真实账号累计到上限后才不再发，重复请求不多占名额），变异（桶放回查库之前）变红。
- **邀请码**：保留全局桶并**明确记录取舍**，不放开——邀请码的熵无保证，放开等于无限猜测；被占满的代价只是等一小时。生产必须设置 `TRUSTED_PROXY_HOPS ≥ 1` 让 IP 桶生效。

### Fixed / Security（M5.6 S3：认证杂项加固）

每项都按「复现 → 修 → 带对照组的回归 → 变异验证」；变异验证共 9 项，去掉修复各自变红。

- **`forgot` 时序枚举与全局兜底桶**（审查 #10 的后半、#12）：旧实现对存在的邮箱 await 签发令牌 + 发信，响应更慢，能枚举注册邮箱；取不到可信 IP 时没有任何全局限额。现在判定抽到 `lib/auth/forgot.ts`，响应前只做一次查库，签发令牌与发信交给 `after()`，响应时间与邮箱是否存在无关；无可信 IP 时退回全局兜底桶（60 次 / 15 分钟）。测试用注入的 `defer` 证明「返回时还没有发信、没有写令牌」，并有「慢速投递不拖慢响应」的计时用例。
- **邀请码猜测限速**（审查 #12）：邀请制下新增独立限速（有 IP 10 次 / 小时，无 IP 全局 100 次 / 小时），「先占后退」，只有邀请码无效 / 已用 / 过期才留下计数（新增 `InviteCodeError` 区分于「用户名被占用」）。
- **找回令牌共存**：旧实现每次签发先删光旧令牌，任何人替你请求一次找回，你邮箱里已有的链接就失效，冷却一过还能再来。现在未过期的旧令牌继续有效，只清理过期 / 已用的；某个令牌被成功使用后，同用户同用途的其余令牌一并作废。同用户同用途最多保留 **6** 个（**与评审时定的 3 不同**：3 个的话别人连发 3 封找回邮件、约 4～6 分钟就能挤掉你最早那封；6 等于每小时发信上限，reset 令牌 1 小时有效，有效期内永远不会被上限挤掉，上限只用来拦住 30 天有效的 claim 令牌堆积。常量 `MAX_LIVE_TOKENS`，可改）。
- **`/verify/{token}` 改为确认页**：以前 GET 直接消费令牌，邮件安全扫描器 / 链接预览预取就会把令牌用掉。现在 GET 只渲染页面（不查库、不消费、`noindex`、`no-referrer`），点按钮 POST 才消费；邮件里的链接不变。E2E 用反复 GET 模拟扫描器，断言令牌仍未被使用。
- **`EMAIL_RE`**：旧正则放过逗号、分号、引号、括号、尖括号（本地部分带逗号的输入可入库，之后可借发信把邮件发到第三方）。新增 `lib/auth/email.ts`：ASCII dot-atom 本地部分 + 标准域名标签，整体 ≤254、本地部分 ≤64，刻意不支持引号本地部分与国际化邮箱；有病态输入耗时上限。
- **`isDevEnv` 改为 fail-closed**：只有 `NODE_ENV` 是 `development` / `test` 才放行；变量缺失、空串、`prod`、`Production`、`staging` 都视为生产。此前 `!== "production"`，漏设环境变量或拼错就会把 `/api/dev/*` 与 `/design` 暴露到线上。
- **会话有效期口径**：注释写「滑动续期」，实际只更新 `last_seen_at`，`expires_at` 与 cookie `maxAge` 固定，是 **30 天绝对过期**。保持该行为，改注释与测试名并新增断言（活跃使用不延长 `expires_at`）；真正的滑动续期要在中间件里刷新 cookie，暂不做。
- **登录页死链**：「认领老账号」指向不存在的 `/claim`（只有 `/claim/[token]`）。合并为「忘记密码 / 认领老账号」，指向 `/forgot`（认领邮件本来就从那里发）。
- E2E 的 `latestLinkFor` 改为轮询（邮件现在在响应之后才发）；新增 2 项 E2E（验证确认页、登录页链接可达）。

### Fixed / Security（M5.6 S2：登录时序枚举与频控滥用，审查 C1 / C2）

- **C1 时序枚举**：旧登录对「用户不存在」和「密码哈希为 NULL」（迁移账号全是）直接返回，不做 argon2，比有密码的账号快约 8.5 ms，远程取平均就能分辨。现在新增 `lib/auth/login.ts` 的 `attemptLogin()`：任何分支都**恰好一次**校验，没有可校验的真哈希就校验一个参数相同的假哈希（进程内只生成一次）；假哈希恰好匹配也不会放行。
- **C2 频控**：三层桶，全部**先占后退**（成功登录退还，只有失败累计；并发的猜测也严格受限，「先检查、失败后记」的写法会被并发绕过）：IP 桶 20 次 / 10 分钟；(IP, 标识符) 桶 5 次 / 10 分钟——别的 IP 刷不满它，攻击者锁不住受害者，且对存在与不存在的标识符一视同仁，「尝试过于频繁」不再泄露账号是否存在；用户 id 总桶 30 次 / 小时，用户名与邮箱归并到同一个 id，超限时校验完照常返回「用户名或密码错误」（不给「频繁」提示，否则只有存在的账号会出现）。标识符超过 254 字符不进桶键，攻击者无法撑大桶表。
- `ratelimit.ts` 新增 `rateLimitRefund`；登录 Server Action 改为只调 `attemptLogin`。无可信 IP 时 IP 桶不参与，(IP, 标识符) 桶退化为只按标识符分桶（旧行为，已写入 M4 文档）。
- 测试：`login.int.test.ts` 19 项（真实 MySQL，每条性质带对照组：8 个分支各校验一次、假哈希与真哈希参数一致、成功 40 次不被锁、别的 IP 锁不住受害者、存在 / 不存在 / 无密码账号 invalid→throttled 的时机一致、IP 桶、用户总桶含用户名 + 邮箱合并、限长、20 并发恰好 5 个 invalid、无 IP 退化）+ `ratelimit` 4 项 + E2E 1 项。变异验证 6 项（去假哈希 6 项红、不退还 1、总桶按文本 1、不限长 1、桶不含 IP 2、不占额度 6）。
- **未做**：`forgot` 对存在邮箱 await 发信造成的响应时间差（S3）；HTTP 层真实时序没做统计检验。

### Fixed（M5.6 S1b-3：转换器修复 + 重新导入）

S1b-1 度量出的转换侧缺陷全部修掉，`verify:render` 与 `verify:fidelity` 的棘轮上限全部降到 **0**（修前：引用吞字 2168、表格吞字 4、列表吞字 1、特殊字符被吃 1901 篇）。

- **纯文本转义**（`escapeText`，只作用于普通文本节点，代码块内不动）：`\ * _ \` [ ] |` 一律转义；`~` 只转义连续 ≥2 个（单个是语气词）；`<` 默认转义；行首的 `# > - + 1.`、整行只由 `- = :` 与空白组成的行（`---`、`- - -`、`:-:`，会变标题 / 分割线 / 单列表格）、`:::` 转义。随机压测多次发现的形态都固定成了回归用例。
- **`<` 的策略**：旧站对 `<embed>`、`<<pp>>`、用户贴的错误页源码都是字面显示，所以默认转义；只有整篇以 `<标签` 开头的帖子（管理员贴的原生 HTML 页面，迁移库 7 篇）才放行白名单 HTML 标签。
- **地址与显示文字分离**：`[url]` / `[img]` / `[email]` / 媒体 / `[attachment]` 的地址取 `flatText`（纯拼接原文，不渲染、不重复记告警和附件引用），显示文字仍转义；表格单元格里只补转义尚未转义的 `|`；列表项标记 `[*]` 的剥除同步改。
- **块级空行**：引用 / 列表 / 表格前后各留空行（修懒续行吞字）；嵌套引用的空行输出 `>`；围栏之外每行去首尾空白（行首 ≥4 空格会变代码块，行尾两空格是硬换行）。
- **未知且未闭合的方括号词按字面保留**（本步新发现，258 篇）：`[QYsub][DVDRip][Skip_Beat]` 这类字幕组发布名此前被当作未知 UBB 标签整个吃掉；成对的未知标签仍剥壳，`[li]` 例外。
- **强调的边界**（本步新发现，约 175 篇残留字面 `**`）：加粗 / 斜体 / 删除线内容以标点开头或结尾且紧挨汉字时，CommonMark 的定界符规则让 `**` 不成立（`**【staff】**原作`）。这类边界改输出 `<strong>` / `<em>` / `<del>`；内容有空行时按段分别包裹；纯空白内容不产生记号；同类强调嵌套（原文未闭合的 `[b]` 把后文全收进来）省略内层；相邻加粗的 `****` 合并。**未采用** `remark-cjk-friendly`（转义后重测仍带入误判，见审查报告 §8.1）。
- **更正 S1**：S1 条目里的「1199 篇删除线 / 零误伤」已改写；真实的 UBB 删除线只有 37 篇，其余是用户自己打的 `~~心情~~`，现在由转义保住。
- 测试：语法契约 53 → 58 条，转换器 / 渲染器两侧的已知缺陷登记全部清空；新增 `ubb-render-roundtrip.test.ts`（随机特殊字符串 3000 条「转换 → 渲染」可见字符守恒，另有 6 个种子 × 4 万条的一次性压测；代码块不转义、链接地址不转义、门控伪造防护、强调边界 8 例）。变异验证：`escapeText` 恒等 12 + 5 项变红；引用不留空行 3 项；地址改用 inner 1 项；标点边界不走 HTML、不省略嵌套加粗、不按段落拆分强调、不合并相邻加粗各自变红。
- 本地门禁改进：`verify:fidelity` 只剥转换器认识的标签（未知方括号词算可见文字）、新增「渲染后多出 `*` / `~`」的反向检查（抓残留的未解析记号）、以 `<标签` 开头的整篇 HTML 排除；`verify:render` 四项上限全为 0。
- 导入：先在临时库 `qysub_next_s1b3` 演练（`verify:migration` 110 项对账全过，渲染 / 保真门禁全 0），再重导 `qysub_next`。

### Fixed（M5.6 S1b-2：渲染器修复）

- **软换行变 `<br>`**：`lib/markdown.ts` 在 `remarkGfmLite` 后加 `remark-breaks`。此前 `<p>a\nb</p>` 在浏览器里塌成「a b」，迁移库约 27% 的帖子受影响。对照：空行仍分段、围栏代码块与表格行不受影响、行尾两空格的硬换行与软换行一致。`verify:render` 软换行项 **8561 → 0**。
  - 探测器排除正文含原生 HTML 块（`<div>` / `<p>` / `<table>`）的帖子：HTML 里的换行本来就按空白折叠，与旧站显示一致（迁移库 7 篇，post:42268–42275，管理员贴的音乐推荐页）。
- **`<sup>` / `<sub>` 进净化白名单**（不给任何属性），迁移库 38 篇此前上下标被剥掉。净化语料补 8 条载荷（事件处理器、`style`、Tailwind `class`、嵌套脚本 / 图片、大小写、未闭合），输出检查器仍零告警。
- **未采用 `remark-cjk-friendly`**（`**“引号”**后文`）：评估结果见审查报告 §8.1。它能把残留 `**` 从 174 降到 130，但改变了 109 篇的渲染并带入新误判，而根因是转换器没转义纯文本 `*`。契约里 `bold-cjk-punct` 继续登记为已知缺陷，S1b-3 转义之后再重测。
- 测试：契约渲染侧已知缺陷登记 7 → 1；新增软换行 6 项、sup / sub 3 项。变异验证：去掉 `remarkBreaks` 7 项变红，去掉 sup / sub 4 项变红。
- 顺带：`syntax-contract.ts` 里的合成邮箱（非允许域名）在文件被跟踪后触发 `check:secrets`，改为 `example.com`。

### Added（M5.6 S1b-1：转换器 ⇄ 渲染器契约与保真门禁）

背景：S1 暴露「转换器和渲染器各有测试，但没人测两边接得上」。对迁移库 31825 份正文与旧库 UBB 原文做量化分析，发现 S1 之外还有三类缺陷（本步只**登记与度量**，修复在 S1b-2 / S1b-3）：

- **软换行塌陷**：转换器保留单个 `\n`，渲染器输出 `<p>a\nb</p>` 且无 CSS `pre-line`，浏览器里塌成空格 —— **8561 篇（27%）**。
- **引用 / 表格 / 列表后的文字被吞**（转换器缺空行，Markdown 懒续行）：引用 **2168 篇**、表格 4 篇、列表 1 篇。
- **转换器不转义纯文本里的 Markdown 特殊字符**：旧站用户打的 `5*3=15`、`好呀~~我也去~~`、行首的 `#` / `>` / `-`、`\` 等被渲染吃掉，**1901 篇**有字符丢失（`~` 1161、`*` 327、`\` 253、`-` 117、`_` 104、`=` 86…）。
- **更正 S1 的说法**：S1 条目写的「1199 篇删除线」与 `40cbe6a` 提交说明里的「零误伤」不准确。精确测量后，渲染出 `<del>` 的 1293 篇里只有 **37 篇来自真实的 UBB `[s]` / `[del]`，其余 1256 篇是用户打的 `~~心情~~` 被误当删除线**（S1 之前是字面显示，S1 后反而被划掉）。根因是转换器不转义，S1b-3 修；S1 提交尚未推送，无线上影响。
- `<sup>` / `<sub>` 不在净化白名单（转换器会产出它们，38 篇受影响），S1b-2 加入。

新增：

- `packages/content/src/syntax-contract.ts`：**迁移产出语法契约**（53 条纯数据：UBB 样例 → 期望 Markdown → 期望渲染 HTML 片段），导出给两侧测试共用。
- `migration/src/transform/syntax-contract.test.ts`：转换器对每条 UBB 样例必须产出契约里的 Markdown；`apps/web/src/lib/syntax-contract.test.ts`：渲染器对每条 Markdown 必须产出期望标签。均不依赖迁移库，CI 可跑。当前缺陷用 `it.fails` 登记（转换器 18 条、渲染器 7 条）：修好后用例会「意外通过」而报错，逼着把条目从登记表里删掉。
- **本地硬门禁**（依赖迁移库 / 旧库，不进 CI，挂在 `pnpm verify:migration`）：
  - `verify:render`：真实渲染器渲染迁移库全部正文，四类探测器（引用吞字、表格吞字、列表吞字、软换行塌陷）+ 渲染抛错数，**棘轮**：上限 = 当前基线，只许降不许升，目标 0。
  - `verify:fidelity`：旧库 UBB → 转换器 → 渲染器，数 `* _ ~ # > - = \ ` | [ ] ! ( ) + <` 这些特殊字符在「原文可见文字」与「渲染后可见文字」里的个数，变少即被吃掉。只数字符不比全文，避开图片 / 附件 / 站内链接改写带来的误报。基线 1901 篇，棘轮同上。
- 顺带：`docs/spikes/e0-editor/export-corpus.mts` 里的邮箱脱敏正则 / 占位串被 `check:secrets` 误报，改为 `\u0040` 写法与 `example.com` 占位。

### Added（M5.6 · E0 编辑器选型 spike）

- 选型结论：**Tiptap v3（所见即所得，默认）+ CodeMirror 6（源码模式）+ react-image-crop（裁剪）**。在仓库外搭三套原型放进同一个测试页，用 244 条语料（含真实迁移帖与还原后的门控完整源码）做「载入 → 不改 → 取回」往返，用站点真实渲染器判定渲染等价；桌面用 CDP 模拟拼音组合输入测 6 个位置，站长用手机真机测输入法与门控编辑。
- 关键数据：渲染等价 Tiptap 234/244（95.9%）、Milkdown 229/244（93.9%）、CodeMirror 244/244；体积（gzip）Tiptap 156 kB、CodeMirror 208 kB、Milkdown 458 kB。默认配置下两个编辑器都会把单个 `~` 改写成 `~~`（迁移库 1136 篇受影响）、Milkdown 对 336 篇的「冒号+字母」直接抛错，针对性修正后都可修复。
- 新增 `docs/spikes/E0-editor-selection.md`（选型记录）与 `docs/spikes/e0-editor/`（spike 源码存档，**不在 pnpm 工作区内**，不含语料）；`GATES.md` §9 与 `M6-posting.md` 写入结论与设计约束（服务端预览、往返保护、marked `del` 覆盖、裁剪「服务端先 auto-orient 再 extract」、首版不做旋转）。

### Fixed（M5.6 S1：渲染补精简 GFM）

- **渲染管线此前不解析 GFM**：迁移转换器把 UBB 的 `[table]` / `[s]` 产出为 Markdown 表格与 `~~`，渲染端没有 GFM 扩展，结果 **22 个表格显示成竖线原文**（并以为有 1199 篇的删除线显示成 `~~…~~`——这个数字后来证实不准：真实的 UBB 删除线只有 37 篇，其余是用户自己打的 `~~心情~~`，见 S1b-1 的更正与 S1b-3 的转义修复）。这是 M3 / M5.5 遗留缺陷，E2E 因为用夹具而没发现。
- 新增 `lib/gfm-lite.ts`：只启用**表格**与**删除线**，`singleTilde: false`。选型依据是对迁移库全部 31825 份正文 / 门控隐藏正文（帖子 31456 + 门控 369）的实测对比：
  - 完整 GFM 默认配置会多误伤 **1328 篇**——中文论坛用单个 `~` 表语气（「握爪~我也是今年5月份~好在图书馆」整句被划掉），所以必须 `singleTilde: false`；
  - 完整 GFM 的自动链接有 56 篇变化，且遇到中文不会停（百度网盘链接后面的「啊哦，你来…」被吞进 URL），而 `remark-gfm` 无法单独关闭它，所以直接组合 `micromark-extension-gfm-table / -strikethrough` 与对应 `mdast-util-*` 四个小包；
  - 任务列表在迁移数据里为 0 处，且 `<input>` 不在净化白名单，不启用。
- 测试：`gfm-lite.test.ts` 13 项（表格 / 对齐 / 转义竖线 / 删除线 / 语气词与集数区间 / 装饰性多波浪线 / 未闭合 / 嵌套 / 自动链接、邮箱、任务列表、脚注刻意不启用）；XSS 语料补 9 条表格与删除线输入，另加大表格与 2 万个未闭合 `~~` 的耗时上限；E2E 新增夹具帖 `gfm`（表格 + 对齐 + 删除线 + 单波浪线，E2E 共 70 + 冒烟 7）。变异验证：`singleTilde` 改回 `true` 抓到 1 项，去掉插件抓到 5 项。

### Fixed / Security（审查复查 A1–A6、B1–B5）

做法：对审查报告里证据偏弱的结论逐条复现；回归测试必须带对照组并做变异验证。详见审查报告 §8。

- **A6 间隙锁死锁（影响最大）**：640 次「不同新用户并发首次入账」，139 次（21.7%）重试耗尽后失败，InnoDB 统计死锁 1044 次。积分与解锁事务统一改用 READ COMMITTED（`POINTS_TX_OPTIONS`）后 0 失败、0 死锁。M7 的签到 / 发帖奖励会直接撞上这条。回归：`points/gap-lock.int.test.ts`（去掉修复 2/2 次变红）。
- **A5 `any` 模式重复收费**：门控已因回帖开放的读者构造请求仍被扣款。现扣款前先判定，返回新错误码 `already_open`（页面文案「你已经可以查看这段内容，无需购买」）；先买后回帖仍走幂等路径。
- **B1 `gate_key` 大小写**：`A1` / `a1` 在默认 `_ai_ci` 下撞 `uq_pg_post_key`，而应用层 `KEY_RE` 允许大小写。加 `utf8mb4_bin` 列补丁（`PATCHES`），`db:verify` 对账随之变为 13 项。
- **B2 积分越界**：此前抛 MySQL 原始错误（500）。新增 `PointsOverflowError` 与单笔 ±2147483647 上限；作者账户到余额上限时整笔购买回滚，读者看到 `unavailable` 而不是 500。
- **B3 模块启停 fail-open**：读 `module_state` 失败时此前把所有模块重新打开（停用开关在连接池耗尽等压力时刻失效）。改为沿用上一次成功状态，冷启动读不到则全部视为停用（`resolveEnablement`，可单测）。
- **B5 并发重复授权**：`grantRolePermission` / `assignUserRole` 先查后插，并发下抛原始唯一键错误。改为 `INSERT IGNORE` + `affectedRows` / upsert，仍只写一次库、一条审计。
- **A4 净化器**：`img` 降级为 `span` 时清空残留的 `alt/title/width/height`，alt 作为可见文字（原注释写「alt 文本保留」但实际不可见）。新增 96 条语料的结构化检查（`sanitize-corpus.test.ts`），检查器自身有反例验证；第一版语料无检测力，已补并两次变异确认。
- **A1–A3 确认无问题（新增永久回归）**：`rsc-leaf.spec`（其余页面对 RSC 叶子请求，带对照组）、`csrf-action.spec`（跨站 Origin 被拒、同源放行）、`tokens.int.test`（令牌并发单次消费）。顺带记录：不带 Origin 头的 Server Action 提交会被 Next 接受，兜底是 `SameSite=Lax`；反向代理须透传 Host。
- **B4 已复现、未修（需设计）**：升级版本新增的基线授权不会下发给已部署站点。已列为 M6 §6c 前置项。

### Security（M5.5 之后审查 · P2-15 → 升为 P0：`/admin/**` 页面未授权可读，已修复）

- **漏洞**：`/admin/**` 的鉴权只在 `layout.tsx`，页面与数据读取函数自己不鉴权。Next 的 RSC 局部渲染按路由状态树做差、只渲染变化的叶子，已持有的 layout 不再执行；伪造「客户端已持有 `/admin` 的 layout，只导航到子页面」的请求，**未登录的游客**就能拿到后台页面内容：角色列表、授权矩阵、版块权限视角（含版主用户名）。只读泄露——改授权的 Server Action 自带 `admin.roles` 校验，未受影响。
- **审查报告的更正**：初稿把这一项标为【未复现】并降级。原因是我的伪造请求被 Next 的 `?_rsc=<hash>` 缓存破坏重定向（307）拦住，我把这一跳误当成了鉴权结果。已在 `docs/reviews/2026-10-24-post-m5.5-review.md` 顶部与第 15 项更正；「没有 P0」的结论作废。
- **修复**：新增 `lib/authz/require-admin.ts` 的 `requireAdmin(...)`（始终先要求 `site.admin`，再叠加 `admin.roles` 等细分权限；未登录跳登录页，缺权限 404）。layout、`/admin` 首页、三个授权页面、全部 4 个 Server Action 统一使用，并且它必须是入口函数里的**第一个 await**——先于读 params / searchParams 与任何取数。副作用：`admin.roles` 的 Server Action 现在也要求 `site.admin`（此前只要求 `admin.roles`），与页面口径一致。
- **守护**：`app/admin/admin-entry-guard.test.ts` 静态检查每个入口函数的第一个 await 是 `requireAdmin`（先取数后鉴权也变红，对真实页面 / 动作变异验证逐个点名）；`require-admin.int.test.ts` 4 项真实 MySQL 行为测试（游客跳登录、非 admin 404、admin 通过并带可信 IP、只有 `admin.roles` 没有 `site.admin` 的角色一律 404）；E2E 新增伪造 RSC 请求用例，带**对照组**（admin 用同样请求拿得到页面，证明向量有效）与游客 / 会员 / 团队成员三组负例。**把页面级鉴权去掉后该用例对游客变红**，即漏洞确实存在；加回后全绿（E2E 共 62 + 冒烟 7）。
- 未做：审查原建议里「数据读取函数自己鉴权」。`listRoles` / `getRoleGrants` 读取的是授权配置而非用户数据，调用点只有后台页面，入口门禁 + 静态守卫已覆盖；如 M9 后台扩张出现被其他入口复用的读取函数，再补。

### Security（M5.5 之后审查 · P2 小批 6/6：演示种子的生产守卫）

- `db:seed` 会写入固定口令的演示管理员与固定邀请码，在真实站点库误跑等于开后门，此前没有任何保护。新增 `packages/db/src/seed-guard.ts`，`db:seed` 与 `db:e2e-fixtures` 启动前先过守卫：`NODE_ENV=production`，或目标库里已有**非演示用户**（用户名键不以 `demo_` / `e2e_` 开头，即真实注册或迁移导入的账号）→ 拒绝并打印原因，须显式 `--force` 才覆盖（并留下警告）。
- 空库与纯演示库照常放行（种子本身幂等，重复跑不受影响）。判定为纯函数；`LIKE` 前缀里的 `_` 已转义，`demoxadmin` 之类长得像演示前缀的真实用户名不会被放过（去掉转义后集成测试变红）。
- 真实命令验证：迁移库（10763 个真实用户）上 `db:seed` / `db:e2e-fixtures` 均拒绝且未写入任何演示用户；E2E 库加 `NODE_ENV=production` 拒绝，非生产放行。被拒绝时脚本只输出中文原因并以非零码退出，不再多打堆栈。

### Fixed（M5.5 之后审查 · P2 小批 5/6：硬约定 9 的守卫）

- `app/admin/actions.ts` 经 `lib/authz/admin.ts` 派发 `role.changed`，自己却没有 `import "@/modules"`：注册表不在该服务端上下文求值时，事件只落 `event_log`、消费者不会被调用。目前没有消费者所以无感，M8 通知订阅后会静默丢通知。已补上引入。
- 新增 `modules/kernel/modules-import-guard.test.ts`：静态分析 import 图（含传递引用与相对路径，忽略 `import type`），凡 Server Action（文件头 `"use server"`）与 `route.ts`，只要（传递）引用到会触及内核的文件（非 `modules/` 目录下运行时引入 `@/modules/kernel/*` 者，自动发现、无需维护清单），就必须直接 `import "@/modules"`。真实仓库当前 8 个入口，修复前只有 `admin/actions.ts` 违规，无误报。
- 分析函数是纯函数，附 5 组合成样例验证守卫本身（直接 / 传递 / 补引入 / 只引类型 / 页面不算入口）；对真实仓库做变异（删掉 `admin/actions.ts` 与 `actions/gates.ts` 的引入）时守卫逐个点名。局限已写进测试注释：只看静态 import，动态 `import()` 看不到；页面只读，不在检查范围。

### Security（M5.5 之后审查 · P2 小批 4/6：解锁核对价格）

- 购买表单此前只传 `gateId`，按事务内锁到的**当前价**扣款：作者在买家点击前改价，买家会被按新价扣款。现在表单带 `expectedPrice`（买家看到的价格），`unlockGate` 在锁住门控行后与当前价比对，不符返回新错误码 `price_changed`（不扣费、不记账、不解锁、不派发事件），页面提示「价格已变化，请确认新价格后重试」。
- 已解锁者不受改价影响；缺失 / 畸形的 `expectedPrice` 在 Server Action 里一律按价格不符处理；`unlockGate` 省略该参数 = 不核对（仅内部调用）。M6 改价功能上线前必修项，现提前落地。
- 回归：集成测试（价格相符、改价后拒绝且余额 / 台账 / 解锁记录 / 事件均不变、免费门控被改成付费、已解锁者不受影响；去掉核对后 2 项变红）；E2E 页面加载后改价 → 点击得到提示且不扣费，重新确认新价格后成功（E2E 共 61 + 冒烟 7）。

### Security（M5.5 之后审查 · P2 小批 3/6：首帖状态独立校验）

- `getThreadView` 此前只用主题状态判定可见，首帖自己的 `posts.state` 没有检查；而 `locateGate` 与 `/files` 都同时校验两者。一旦写入侧（M6）让主题与首帖状态分叉（如主题可见、首帖被隐藏），首帖正文会泄露给无权观众。现在首帖查询同样套 `visiblePredicate`：任一不可见整个主题 404。
- `DESIGN-MODEL.md` §4 新增「主题状态与首帖状态（不变量）」：读取时两者都必须可见；写入侧同事务同步首帖状态，读取侧不依赖这一点，分叉时按更严一方处理。
- 回归：集成测试把可见主题的首帖改成 hidden / pending（作者变更），逐观众断言（游客、会员、原作者、新首帖作者、版主），结束后还原；去掉新谓词后该用例变红。

### Security（M5.5 之后审查 · P2 小批 2/6：`code` / `pre` 的 class 白名单）

- 净化器此前对 `code` / `pre` 放行任意 `class`，作者可注入站内已有的 Tailwind 类（如 `fixed inset-0 z-50 bg-background`）整页覆盖做钓鱼。现改为逐个 class token 校验 `/^language-[\w-]+$/`（代码围栏产生的语法高亮类仍保留）；token 被剥空后不留空的 `class=""`。
- 回归：HTML 直通注入（纯注入类、与合法语言类混写、夹带引号的伪语言类）、其他标签 class 仍不在白名单、Markdown 围栏的 `language-ts` 保留；还原为旧配置后用例变红。迁移数据里没有内嵌 HTML 形式的 `code`/`pre` class（posts 与 gates 均 0 处），无误伤。

### Fixed（M5.5 之后审查 · P2 小批 1/6：小数页码 500）

- `?page=2.5` 曾让游客触发 500：页码变成 `OFFSET 37.5`，MySQL 报语法错误。新增 `lib/queries/paging.ts` 的 `clampPage`（小数向零取整、NaN 回第 1 页、±Infinity 与越界收束到两端），`listThreads` 与 `listReplies` 共用。
- 回归：`clampPage` 单测；`queries.int.test` 在真实多页数据上覆盖 1.5 / 2.5 / NaN / Infinity；E2E 水区 `?page=2.5|1e3|abc|-4` 均 200 且落在正确页（E2E 共 60 + 冒烟 7）。还原修复后单测与集成测试共 4 项变红。

### Added（附件与门控 · 第 5 步：E2E 与收尾）

- E2E 夹具 `gateAttach` 帖（`packages/db/src/e2e-fixtures.ts`，镜像常量见 `e2e/support/fixtures.ts`）：付费 10 / 回复可见两个门控，四个附件（公开 / 付费 txt / 付费图 / 回复 txt），门控图同时嵌在付费门控的隐藏正文里；demo_member 已购买付费门控。夹具集成测试覆盖归属与完整性。
- 新增 `e2e/gate-attachments.spec.ts`（4 项，E2E 共 59 + 冒烟 7）：游客与未解锁者的页面里没有被锁附件的名字 / 存储键 / 隐藏正文，直接请求 `/files` 全部 404；已购买者可取付费附件与门控图（`private, no-store`、无 ETag、带 If-None-Match 也是完整 200），回复门控的仍锁；作者全部可取。变异验证：让两处门控判定失效，3 项变红。
- 文档：`GATES.md` 新增 §5a；M6 里程碑新增 §6b（写入侧约束：作者选归属、保存事务校验、门控内联图登记、`gateConditions` 的决定）；审查报告 P1-2 标记已修复。

### Changed（附件与门控 · 第 4 步：迁移映射）

- UBB 转换器记录每个 `[attachment=N]` 引用所在的门控（`ConvertResult.attachmentRefs`；被丢弃的门控内的引用不记）；`bindAttachmentGates` 按设计稿 §7 的 R1~R5 给附件定 `gate_id`，歧义（R4）按「付费价高 > 回复可见 > 免费解锁，并列取最后一个」归属并列入导入报告待复核。`attachments` 写入带上 `gate_id`。
- `verify:migration` 新增 4 项（共 110）：无悬空 / 跨帖 / 挂在非门控帖；门控帖里未被引用的附件一律归属门控；只在门控内引用的归属引用它的门控；公开正文引用的保持公开。断言从导入结果按存储键反查引用位置，独立于转换器自己的统计。
- 单测：附件引用位置、R1~R5 与严格程度排序、改挂首帖时只看最终所挂帖子内的引用。
- **真实数据演练**（先临时库、再导入 `qysub_next`）：R1 32 / R2 74 / R3 11 / R4 13 / R5 272，与设计稿预测一致；R4 仅涉及 2 个帖子且门控全是「回复可见」。游客真实请求抽样：门控图片 404、公开图片 200。至此既有 130 个门控帖附件已受保护，审查 P1-2 的数据与读取侧均已关闭，剩第 5 步（E2E 夹具与文档收尾）。

### Security（附件与门控 · 第 3 步：读取侧接入，审查 P1-2）

- 新增 `lib/gates/attachments.ts`——**门控附件的唯一读取出口**：`listAttachments`（帖子页）、`resolveFileGrant` / `recordDownload`（`/files`）。附件与隐藏正文同权，判定复用 `openGateIds`。
- 帖子页：锁定的附件在类型上没有文件名 / 存储键 / 大小 / 下载数，只显示「🔒 本帖有 N 个附件需解锁后下载」；`getAttachments` 已删除。
- `/files`：附件行绑定了门控的，门控对观众开放才放行；**所有引用都绑定门控的图片也要过门控**，响应 `private, no-store`、无 ETag、不走 304；只要存在一条未绑定门控的引用，图片按内容已公开处理（行为同前）。
- fail-closed：`gate_id` 悬空 / 属于别的帖子 → 对所有人锁定（含作者与版主，较设计稿原文收紧一档，已回写设计稿 §4.1）。
- 新硬约定 3d + 守卫测试 `attachments-guard.test.ts`（除该模块外，运行时代码不得从 `@funwind/db` 引入 `attachments` 表）。
- 集成测试 `attachments.int.test.ts`（10 项）：游客 / 作者 / 版主 / 已购 / 未购的开放集合；锁定项序列化无任何元数据；悬空与跨帖；**列表与 `/files` 逐观众对账不可分叉**；门控图片缓存头；下载计数；变异验证（让两处判定失效，7 项变红）。
- **此步之后新建数据的门控附件已受保护**；迁移库里既有的 130 个附件 `gate_id` 仍全为 `NULL`，要到第 4 步映射并重新导入后才被保护，P1-2 尚未完全关闭。

### Changed（附件与门控 · 第 2 步：判定抽取）

- `lib/gates/service.ts`：把读取侧第 ① 步（加载门控元数据 + 观众事实 → `evaluateGate`）抽成内部函数 `decideGates`，`resolveViews` 改为复用它，**行为不变**（既有 gates 测试原样全绿）。
- 新增导出 `openGateIds(viewer, thread, postList, gateIds)`：返回观众可开放的门控 id 集合，**不读 `hidden_md`**（3b 守卫不变）。不存在 / 不属于 `postList` 的门控一律不在结果里（fail-closed）。
- 新增集成测试：与 `loadGateViews` 逐观众对账（正文与附件两条链路不可分叉）、只返回被问到的门控、空集合 / 不存在 / 不属于 postList 的门控均不开放（版主也一样）。
- 仍未接入读取侧：门控附件在第 3 步之前依旧未受保护。

### Added（附件与门控 · 第 1 步：数据模型）

- 设计稿 `docs/ATTACHMENT-GATES.md`（已确认）：门控帖的附件与隐藏正文同权，`attachments.gate_id` 归属门控，锁定项不下发任何元数据。
- `attachments.gate_id`（可空，`NULL` = 公开）+ 索引 `idx_att_gate`，版本化迁移 `0001_attachments_gate_id.sql`；无外键，一致性靠检查守住。
- 新增 `packages/db/src/integrity.ts` 的 `findAttachmentGateAnomalies`（悬空 / 跨帖 / 所属帖无门控三类），接入 `db:verify` 的 `integrity:附件门控归属`（共 12 项），并有临时库集成测试逐类造异常验证。
- **此步只改数据模型，行为不变**：读取侧（帖子页、`/files`）与迁移映射在后续步骤接入；在此之前开发库附件的 `gate_id` 全为 `NULL`，**门控附件仍未受保护**，P1-2 尚未修复。

### Fixed（M5.5 之后审查 · P1-1 数据库会话时区）

- **`NOW()` 与「库内 DATETIME 为北京墙面时间」不同口径**：mysql2 的 `timezone:"+08:00"` 只管客户端 `Date` 序列化，服务器会话时区仍是容器的 UTC，
  导致封禁/角色/会话过期判断偏移 8 小时、台账与审计时间显示早 8 小时。现 `createPool` 对每条新连接执行 `SET time_zone='+08:00'`（E2E 裸连接同样）。
- 新增 `packages/db/src/client.int.test.ts`（真实 MySQL：会话时区、`NOW()` 对客户端北京墙面时间误差 < 5s、池内多连接均生效；还原修复后全红）；`db:verify` 增加 `conn:会话时区`（共 11 项）。
- 审查报告见 `docs/reviews/2026-10-24-post-m5.5-review.md`（2 个 P1 + 16 个 P2）；本条为其 P1-1。

### Added（推送准备 · D：GitHub Actions CI）

- 新增 `.github/workflows/ci.yml`（`push` 到 main 与 `pull_request` 触发，`permissions: contents: read`，不使用任何仓库密钥）：
  - `verify`：MySQL 8.4 服务 → `check:secrets` / `test:scripts` / lint / format / typecheck / `pnpm test`（含真实 MySQL 集成测试与覆盖率门槛）/ build；
  - `e2e`：MySQL 8.4 + MailPit 服务 → 安装 Playwright Chromium → `pnpm test:e2e:run`（dev E2E + 生产构建冒烟）；失败时上传 `apps/web/test-results`。
- `test:e2e` 拆成 `test:e2e`（启动本机 MailPit 容器后调用）与 `test:e2e:run`（纯编排，CI 直接用）。
- 推送前在本机用「移走 `.env`、只给环境变量」的方式模拟 CI：verify 全流程与 E2E（55 + 7）均通过，确认代码不隐性依赖 `.env`。
- **已推送并验证**：`main` 推送到 `SkyJourney/FunWind`（公开）；`pre-push` 钩子经本地裸仓库（拦截 + 放行各一次）与真实推送验证。首轮 CI：`e2e` 一次通过，`verify` 因 CI 无 `db`/`content` 构建产物在类型检查处失败，加 `pnpm db:build` 步骤后第二轮全绿。

### Security（推送准备 · C：重写 git 历史）

- 为推送公开仓库重写全部 44 个提交：清除旧库与本机开发库口令（原出现在 BLUEPRINT / README / compose 的历史里）、3 个真实用户邮箱、4 个第三方论坛用户名，并去掉提交信息里的 `Claude-Session:` 行（保留 `Co-Authored-By`）。
  重写前后最终文件树哈希完全一致；全部 808 个 blob 与历史中旧值命中 0。所有提交 hash 随之改变，`CLAUDE.md` 里引用的 5 个旧 hash 已按映射表更新。
- 站长决定**不轮换**旧库口令；口令只放根 `.env`，由 `pnpm check:secrets`（pre-push / CI）防回流。重写前备份在站长本机，含旧口令，不得上传。

### Changed（推送准备 · B：E2E 自包含）

- **E2E 不再依赖真实迁移数据**：`pnpm test:e2e` 的编排改为「重置库 → `db:bootstrap` → `db:seed` → `db:e2e-fixtures` → dev E2E → 生产冒烟」，去掉 `migrate`。
  新增 E2E 专用夹具 `packages/db/src/e2e-fixtures.ts`（号段 950000+，幂等；与演示种子分开，不污染演示站）：公开版块（带主题前缀）、水区 60 个主题（3 页）+ 版块置顶 + 全站置顶 ×3、
  表情帖、正文内联图帖、已注销作者帖、投票帖、带 2 个 txt 附件的帖、已删除主题、无人被授权的受限版块 953、alice 头像；图片/附件文件由夹具脚本真实落盘到存储目录。
  用例引用的 fid/tid 集中在 `apps/web/e2e/support/fixtures.ts`（镜像夹具常量）。验证：在**从未迁移过**的库上 dev E2E 55 项 + 生产冒烟 7 项全绿。
- **P0 泄露回归不再空转**：受限版块改用 904（演示团队可读）与 953（仅 admin 可读），且同文件内有“有权限者读得到”的正向对照，断言不会因版块不存在而假绿。
- E2E 夹具写入 `points.name = 青翼币`（原来靠迁移写入，门控文案断言依赖它；演示种子保持中性的“积分”）。
- 取舍：真实迁移数据的渲染不再由 E2E 覆盖，改由 `verify:migration`（106 项对账）与转换器单测负责；迁移在本地与青翼最终迁移前演练。

### Changed（M5.5 · S5：E2E 重建与收官）

- **E2E 重写并扩展（原 26 项 → 62 项）**：dev 服务器 E2E 55 项 + 生产构建冒烟 7 项，`pnpm test:e2e` 一条命令完成「重置库 → 迁移 → 种子 → 两轮测试」，约 40 秒，连续两轮结果一致。
  - 摸底发现旧用例**一部分是假绿**：“受限版块游客/会员 → 404”用的 fid 53 是已不迁移的回收站版块，访问任何人都是 404，P0 泄露防线实际缺失；现改用真实受限版块 121/123/130/152 与演示 904，并新增“游客首页/版块页 HTML 里搜不到任何受限版块名与受限主题标题”的回归。
  - 新增 `visibility`（待审核/已驳回/隐藏/回帖隐藏的完整状态矩阵）、`gates`（**浏览器里真实点击购买**：扣费/到账/已购买标签/作者收益统计/余额不足/免费解锁/回复可见）、`files`（图片公开与响应头、304、附件鉴权、受限版块附件 404、下载计数）；
    `modules` 增加“界面真实登录 → `user.logged_in` 事件 → 横幅”（行为人与来源可断言，登录失败不派发）；`content`/`authz` 对齐 v2 语义。
  - 新增生产构建冒烟（`playwright.prod.config.ts`，真实 `next build` + `next start`）：开发入口 404 且 POST 不产生副作用、受限内容仍 404、门控零泄露、`/files` 安全头、生产下真实登录路径可用。
  - 基础设施：用例以会话注入代替界面登录（避开账号级频控），`withE2eDb()` 直连 e2e 库造夹具；gates/files 用例可在未重置的库上重复运行。
- **基础设施竞态修复**：`pnpm -r test` 并行时 content 与 db 的 vitest 同时清理共享缓存目录 → 间歇性 `ENOTEMPTY`（`verify:all` 偶发失败）；根 `test` 改为串行各包，`verify:all` 连续 3 次通过。
- 文档：M5.5 门禁全部勾选并附实测数据；BLUEPRINT §4 中 6 处把 `/attachment` 当现行路由的描述改为 `/files` / 已退役；`CLAUDE.md`、`ROADMAP` 更新；遗留事项如实记录（旧库口令仍在 git 历史、分支未合并、E2E 仅本地）。

### Changed（M5.5 · S4-6：收口）

- **开发入口收口**：`lib/dev-only.ts` 统一守卫 `/api/dev/*` 与 `/design`，`dev-only-guard.test.ts` 保证每个开发路由的每个处理器都接入（新增漏守卫即红）；首页的设计令牌链接仅开发环境显示；
  **生产构建实测**这些路径全部 404。
- **审计补全**：模块启停（`setModuleEnabled`）与站点设置（`setSetting`）同事务写 `audit_log`，状态/值真正变化才记，行为人为空时 `via` 标明来源（cli / dev-api / admin）。
- **覆盖率门禁恢复真绿**：去掉对 queries / session / tokens / settings / state 的整块排除（仅余 `slot.tsx`、`mailer.ts` 两个宿主壳，原因写在配置里），门槛未降；
  补会话真实 MySQL 集成测试（令牌只存哈希、过期/注销/封禁失效、滑动续期、登出与全部吊销）及 parse / storage / site / Markdown 缓存淘汰 / 频控清理测试。
- `tsconfig.tsbuildinfo` 出库；新增 `.husky/pre-push`（类型检查 + 全部测试；确无数据库可 `SKIP_DB_TESTS=1` 显式跳过集成测试）。
- 主题页：无 `attachment.download` 权限者看到附件名与「登录后下载 / 无下载权限」，不再渲染点进去只会 404 的链接。
- **`pnpm verify:all` 真实通过**（lint、format:check、typecheck、582 项测试、next build）；`CLAUDE.md` 的缺口清单改为处置状态，并补充权限/并发约定。

### Changed（M5.5 · S4-5：内核升级、积分核心与门控购买）

- **内核**：事件 10→21 个（`credit.changed`→`points.changed`、`medal.awarded`→`badge.awarded`，新增 11 个），actor 映射按 MODULES.md §3；注册边界 6→10 类（新增
  `pointChannels` / `gateConditions` / `notificationTypes` / `notificationChannels`），**注册期校验**（键格式、方向与前缀一致、全站唯一、不得与内置冲突），非法声明启动即失败；
  停用模块 = 其积分渠道被拒、其门控条件失败即封闭。
- **积分核心 `lib/points`**：`applyPoints` / `applyPointsInTx`——渠道注册、幂等（重放返回既有结果、冲突报错）、余额在行锁内检查永不为负、提交后派发 `points.changed`；
  守卫测试保证积分表只能经此写入（硬约定 3c）。
- **门控购买 `unlockGate`**：单事务完成扣款、作者收益（手续费 floor 取整、已注销作者收益销毁）、解锁记录与计数；“先锁账户再查已解锁”保证并发双击只扣一次；
  固定错误码；`GateBlock` 购买按钮接 Server Action，返回地址服务端计算。
- **并发缺陷（测试中真实复现并修复）**：① 渠道解析在事务内读 `module_state`，并发事务占满连接池后互相等待（连接池饥饿）；② 账户行用 `INSERT … ON DUPLICATE KEY UPDATE` 加锁，
  先共享后升级导致热门作者账户死锁；③ 门控行先 `FOR SHARE` 后更新计数，同门控多购买者升级死锁。现固定「门控行 → 账户行升序」排他加锁，56 个并发购买压在两位作者账户上连续多轮通过。
- **开始派发事件**：`user.logged_in` / `user.registered`（认证）、`role.changed`（授权管理）、`points.changed`、`gate.unlocked`；`demo-checkin` 的横幅从此由真实登录驱动。
- web 测试 296 项，覆盖率 94.9%。真实库（e2e 库）端到端：购买 −5/+5、解锁计数、台账幂等键、事件落库、重放不变、8 位读者各双击共 16 请求恰扣 8 次，全库对账 0 不一致。

### Changed（M5.5 · S4-4：门控读取与 /files 文件路由）

- **门控读取（`lib/gates`）**：纯函数 `evaluateGate`（作者/版主 → 登录 → 逐条件，`all`/`any`，未知条件与脏数据失败即封闭）+ 服务层 `loadGateViews`/`getGateContent`
  ——隐藏正文分两步读取，只对判定开放的门控才取 `hidden_md`；守卫测试保证其他源文件不得引用该列。`GateBlock` 渲染五种状态（含“已购买”标签），取代过渡的占位卡片。
- **`/files/<storage_key>` 路由**：只按数据库查 key（不探测文件系统）；图片公开（能力 URL，mime 取自 `files.mime`，`nosniff` + CSP sandbox + immutable + ETag/304）；
  非图片附件须“所属帖子对观众可见 + 该版块持有 `attachment.download`”，越权一律 404，下载计数仅 GET 累加，文件名防头部注入。
- **退役**：`/attachment/**`、`/emotion/**` 路由，以及把 `svg` 标为 inline 的扩展名映射（`contentDispositionFor`）；`next.config` 不再内联 `ATTACHMENT_DIR`/`EMOTION_DIR`，改为 `STORAGE_DIR`。
- **修复（真实数据验证前发现）**：净化白名单仍只放行 `/emotion/`、`/attachment/` 的图片，迁移后的 `/files/…` 图片与 `/emoji/…` 表情会被剥掉——改为放行 `/emoji/`、`/files/`。
- web 测试 244 项（含门控服务与 `/files` 的真实 MySQL 集成测试），覆盖率 93.5%；真实库端到端验证：游客锁卡片零泄露、真实购买者看到“已购买 · 14 青翼币”与完整隐藏内容、作者看到解锁人数与收益、附件游客 404 / 会员 200 / 受限版块附件 404、头像与正文图片 200。

### Changed（M5.5 · S4-2/S4-3：应用适配，权限内核与内容查询层）

- **权限内核（S4-2）**：`ForumTree`（祖先链/子树/沿链解析 read·write·review 策略）、纯函数评估器（显式 `Subject`，词汇表 25 个权限点显式归类写类/非写类）、
  规则快照常驻内存、授权管理校验 + 同事务写 `audit_log`、提权护栏与 admin 防自锁；会话/登录改按 `username_key`/`email_key`，封禁读 `user_restrictions`；
  注册事务化（自增 id，建用户/资料/核销邀请码同一事务）；邮件令牌消费即记邮箱已验证；`normalizeKey` 上移到 `packages/db`。
- **客户端 IP 与频控**：按 `TRUSTED_PROXY_HOPS` 取 IP；取不到可信 IP 时**跳过 IP 级限额**（共享桶会被占满成全站登录的拒绝服务），生产漏配直接报错；
  找回密码改按账号冷却（2 分钟 1 封 + 每小时 6 封，只对真实账号计数），开放注册在 IP 未知时退回全局兜底桶。
- **查询层与页面（S4-3）**：`/`、`/f/[fid]`、`/t/[tid]`、`/u/[uid]` 与 `lib/queries/*` 全部重写为统一 post 模型，所有查询显式接收 viewer，
  可见性在**取数前**翻译成 SQL 谓词（修 P0：受限版块的标题/计数/置顶/最新动态不再泄露；`is_listed=0` 不进聚合但直达可读）；
  置顶三档（版块/分区/全站，跨版块置顶同样过权限）；`pending`/`rejected` 仅作者与版主可见（带驳回理由），`hidden`/`deleted` 仅版主，其余 404；
  `generateMetadata` 与页面共用同一份带权限的加载结果，标题不再经 `<title>` 泄露；回复指针父帖在别的页时链接带页码；附件按帖批量取。
- **门控占位**：`packages/content` 新增 `splitByGatePlaceholders`（围栏代码块内不识别，往返无损，300 组随机用例）；正文里的门控暂渲染为中性卡片
  「此处有隐藏内容」，不读 `post_gates`，S4-4 换成真正的 `GateBlock`。
- 删除旧 `lib/auth/avatar.ts`（`/attachment` 头像路径）；头像与正文图片改用 `/files/<storage_key>`，**`/files` 路由在 S4-4 落地前图片会 404**。
- `apps/web` 类型检查转绿（M5.5 开工以来首次）；web 测试 203 项（含真实 MySQL 临时库集成测试），覆盖率 93%。

### Changed（M5.5 · R3：迁移适配层重做，代码）

- **映射层与框架**：旧站键/gid/路径知识集中在 `migration/src/mapping/`；运行时 schema 不再认识旧站，`migration_state` 与迁移 id 公式全部移除。
- **身份与结构**：spam 账号不迁；回收站版块子树不迁；内容作者/附件上传者缺失时建「已注销用户#uid」占位账号（保留原 uid，`state=deleted`，不持有任何资产）。
- **内容只迁 `visible`**：回收站/屏蔽/空壳的主题与回帖不迁（旧库即归档）；楼层连续；首帖 id 接在旧站全部帖子最大 pid 之后按 tid 升序自增，
  门控 id 按（帖子 id, 序号）自增、`gate_key=g{序号}`；`topped→pin_level`、`digest→is_featured`；回复指针分三类计数置空。
- **文件管线**：内容寻址 `files` 注册表（sha256 去重，`/files/<ab>/<cd>/<sha256>.<ext>`），头像/勋章图/附件/正文图统一入库，存储目录 `STORAGE_DIR`（默认 `<repo>/storage/`，已 gitignore）；
  源路径一律经 `confinedPath` 收束（防 `..`/绝对路径/符号链接穿越）；存储扩展名只认 MIME 白名单（防存储型 XSS），`/files` 路由的响应头要求写入 S4 范围。
- **积分与社交**：期初余额不变；签到每人只留最近一段连续区间；私信整链路移除；计数重算对齐 v2.1（`featured_count`）。
- **转换器补强**（对账暴露）：没有开标签的样式闭合标签丢弃；`[p_w_upload=N]` 同义 `[attachment=N]`；`attachment/` 与镜像域名 `qingyisub.gotoip1.com` 的上传路径同样改写；原始 `<img>` 走统一图片改写。
- **对账重写**（`verify.ts`，106 项）：期望值全部由独立 SQL/代码推导，新增文件哈希重算、占位账号不变量、首帖/门控 id 次序、签到连续段、私信为空等；`docs/reports/` 已重新生成。
- 开发库 `qysub_next`（纯导入）与 `qysub_next_e2e`（导入 + 演示夹具）已重建；`db:verify` 两库 10/10。`apps/web` 仍是 v1 代码，S4 适配。

### Changed（M5.5 · R2：schema v2.1 与内容包重做，代码）

- **`packages/db` 重做为 43 表**（已提交 R2-A）：详见 [DESIGN-MODEL.md](docs/DESIGN-MODEL.md)；旧迁移 SQL 以 `git rm` 删除，重新生成单一基线 `0000_init_v2_1`；
  权限词汇表与角色定义不再携带旧站信息；`schema-rules` 新增 `no-legacy` 断言；演示夹具补审核/通知/公告。
- **`packages/content`（R2-B）**：门控以帖内稳定 `key` 为身份（`:::gate{key="a1"}`），取代 id 公式与 seq；新门控缺省分配 `g{n}`，key 形态与重复有校验；
  内容只有 Markdown——`color/size/backcolor/align/font` 降级为纯文本并记 `style-degraded` 告警，删除线改为 `~~`；
  文件引用改由调用方注入的 `resolveAttachment` / `resolveUpload` 解析为 `/files/…`，转换器不再写死 `/attachment/`。
- **暂时破坏**：`migration/` 引用了被删除的导出与旧字段，类型检查为红，R3 修复；`apps/web` 仍是 v1 代码，S4 适配。

### Changed（M5.5 · R1：设计先行，文档重定）

站长在 S4 开工前调整思路：**以新系统设计为原则，旧数据向它靠拢，迁移只是适配层**。第一轮 v2（S1–S3，38 表）中沿袭旧结构的部分将经 R2/R3 重做；
本次 R1 仅改文档，未动代码。

- 新增 [DESIGN-MODEL.md](docs/DESIGN-MODEL.md)：设计原则与 **schema v2.1（43 表）**——新增 `files`、`notifications`、`notification_preferences`、`announcements`、`announcement_reads`、`content_reviews`，删除 `migration_state`；
  `topped→pin_level`、`digest→is_featured`；内容状态 `visible|pending|rejected|hidden|deleted`（去 `spam`）；`forums.review_policy`；门控 `gate_key`；运行时 schema 不含任何 `legacy_*`/迁移标记/id 公式。
- 新增 [NOTIFICATIONS.md](docs/NOTIFICATIONS.md)：通知中心（互动/私信/审核与管理/账号与安全 + 公告），内核注册边界扩为十类（+`notificationTypes`、`notificationChannels`，仅实现 `in_app`），顶栏铃铛在 M8，完整页面后续独立里程碑。
- 数据取舍：spam 空壳、回收站与屏蔽内容、私信、旧通知/公告**不迁**（旧库即归档）；附件迁入 `files` 内容寻址存储，`/files/**` 取代 `/attachment/**`；签到只迁最近连续段；正文内联样式降级为纯 Markdown。
- 同步更新：BLUEPRINT（决策 #19–25、§3.2/§4.2/§5）、AUTHZ（`review_policy`、去 `legacy_key`）、GATES（`gate_key`）、MODULES（十类边界、事件清单 21 个）、ROADMAP，以及 M5.5、M6、M8、M9、M10 里程碑范围。
- 计划：R2 重做 `packages/db` 与 `packages/content` → R3 迁移适配层重做并重建开发库 → S4 应用适配 → S5 收口。

### Changed（M5.5 · S3-B / B3：开发库重建为 v2）

- **开发库 `qysub_next` 重建为 schema v2 并全量导入**（原 v1 结构、30 张表，已删除）：迁移对账 83/83、`db:verify` 10/10，
  连跑两次导入后两份报告逐字节一致，且与临时库逐项相同（用户 10,701 / 帖子 36,630 / 门控 664 / 解锁 2,943 / 台账之和 528,473）。
- **E2E 库 `qysub_next_e2e` 重建**：全量导入 + `db:seed` 演示夹具（流程 reset → migrate → seed，`test:e2e` 将沿用）。
- 根脚本 `migrate` / `verify:migration` 先构建 `@funwind/content`（迁移依赖它）。
- `verify:migration` 识别到演示夹具（id ≥ 90000）时明确拒绝并提示，不再报一堆让人困惑的数量差异。
- 修正夹具：已购买的演示门控 `unlock_count` 与解锁记录一致。
- **注意**：`apps/web` 仍是 v1 代码，在 S4 适配前无法在 v2 库上运行。

### Added（M5.5 · S3-B / B2 迁移 v2：内容、积分、社交）

- 统一 post 模型迁入：主题 4,505（spam 空壳 3,033）、帖子 36,630 = 首帖 1,472 + 回帖 35,158；门控 664 个、积分解锁 2,943 条、附件 406、标签 12。
- 积分：期初余额 528,473（旧 credit1 431,823 + 银行本金 96,650），6,660 个账户；**不迁旧流水**。签到 72,914 次。徽章 31 枚。
- 社交：关注 3,828（用户 + 加入版块）、点赞 1,638、投票 133、真实私信 1,462 条 → 788 个会话（含未读状态）。
- 表情 50 枚复制为 `apps/web/public/emoji/{id}.gif`（1.5MB，入库）；计数（回复数/最后回复/版块/用户统计/点赞）全部由明细重算。
- 对账 v2 扩到 83 项，含**门控零泄露**、文本保留率 101.43%、台账之和 = 余额 = 旧库独立推导值。二次运行两份报告逐字节一致。
- 迁移独占表整体替换式加载 + 线上数据保险（`MIGRATION_FORCE=1` 才可覆盖）。

### Fixed（M5.5 · B2 验证中拦截的缺陷）

- **标签交叉嵌套 = 潜在泄露**：`[color][sell]…[/color]…[/sell]` 会让门控被弹出栈，之后隐藏内容落到公开区。改为门控优先。
- **表格重复渲染**：未闭合的 `[table]` 里的门控被渲染两次，产生重复/孤立门控；表格单元格内的门控占位提升到表格之后。
- 孤立的 `[/sell]` `[/post]` `[/hide]` 露在正文里：直接丢弃。
- 旧回收站内容映射为 `deleted` 而非丢弃；版块已删除的主题改挂到归档版块（内容保留）。
- 私信：uid 0 才是系统发信人；uid 1 是旧站已删除的虚拟账号（真人对话按「用户已不存在」丢弃）。

### Fixed（M5.5 · 安全审查整改）

- **未闭合门控标签改为失败即封闭**：此前去壳后把内容公开，会泄露已售出的付费内容（旧库 tid 2023 未闭合的 `[sell]` 有 22 条购买记录）。
  现在到容器末尾的内容都归入隐藏内容；性质测试加入「忘记闭合」变体；真实数据复验积分门控 309 → 318，文本保留率不变。
- **迁移报告脱敏**：入库的 `docs/reports/` 只含 uid 与脱敏邮箱（`j***@126.com`）；完整邮箱清单写入已 gitignore 的 `migration/reports/`。
  含完整邮箱的版本已从本地提交历史中改写掉（未推送过）。

### Added（M5.5 · S3-B / B0+B1 迁移 v2：身份、版块、限制、权限）

- `forums.write_policy`（`inherit|members|restricted`）：旧站「只有团队组能发帖」的 6 个版块与 restricted 读版块是同一批；增量迁移 `0001_forum_write_policy`。
- 迁移程序重构为 extract → transform（纯函数）→ load → verify 四层；`lib/php-serialize`（PHP 序列化解析器，取代 v1 的字符串匹配）；
  `lib/report`（确定性 Markdown 报告，入库 `docs/reports/migration-v2-import.md` / `-verify.md`）。
- 已迁入（临时库实测）：版块 43、主题前缀 91、用户 10,701（+资料）、用户限制 102、全局授权 117 + 版块作用域授权 68、用户角色 185。
- 对账 v2 共 40 项，期望值用与实现不同的 SQL 路径独立推导；**二次运行两份报告逐字节一致**（幂等证据）。
- `packages/db` 词汇表护栏单测；`migration` 引入 vitest，66 个测试，覆盖率 99%。

### Fixed（M5.5 · B1）

- **提权缺陷（开发期拦截）**：S2 词汇表曾把旧 `operate_thread` 映射为 `forum.moderate`，该键对普通会员只是设置数组（`up_time: 72`），
  真值判断误判为开启，会让全体会员/团队组获得全局版主权。已修复：词汇表不再映射；翻译器对数组值只接受 `allow_thread_extend` 与 `panel_*` 开关数组；
  对账新增「非 admin 无全局管理/版主权」护栏；各有回归测试。
- 迁移每次先执行幂等 bootstrap（不再以 `migration_state` 是否存在判断初始化），保证词汇表与代码一致。
- 迁移基线未重置：`write_policy` 以增量迁移 `0001` 追加（删除类命令被拒，改用 drizzle 标准做法）；基线合并留到 M13。

### Added（M5.5 · S3-A `packages/content`）

- 新包 `@funwind/content`：门控语法（`splitSource` / `assembleSource` / `validateGates`，条件规格可注入）与 UBB→Markdown 转换器 v2
  （门控提取、表情静态化、遗留表情码删除、站内链接/旧图片改写、表格/hr/sup/sub、媒体降级）。
- 69 个测试，覆盖率 99.7%；含 400 组随机嵌套的**泄露不变量**性质测试（隐藏内容绝不进入公开正文）。
- 真实旧库只读验证（36,715 条正文）：零异常；门控 674 个（积分 309 = 旧 `[sell]` 帖数 / 回复可见 365）；汉字假名保留率 101.41%。

### Fixed（M5.5 · S3-A，转换器相关）

- **v1 转换器数据丢失缺陷**：`[attachment=N]`、`[li]`、媒体与未知标签没有闭合标签，v1 把其后全部正文当子节点吞掉
  （约 200 个带附件的帖子的 `content_md` 在开发库中被截断）。v2 中这类标签未闭合时不再包裹后文；S3-B 全量重导后消除。
- 样式标签（`[color]`/`[align]` 等）包住门控时，占位被塞进 HTML 标签而无法识别：改为占位提升为顶层块，两侧文本各自保留样式。
- 颜色值白名单收紧（仅命名色/十六进制/rgb/hsl，其余函数调用整体丢弃）；媒体标签 URL 取内容优先于参数。

### Changed（M5.5 · S2 schema v2：**破坏性**，分支 `feat/m5.5-schema-v2`）

- **schema v2（38 张表）**：统一 post 模型、`forums` 物化路径 + `read_policy`、`user_restrictions`、`post_gates`/`gate_unlocks`、
  `point_accounts`/`point_ledger`、`checkins`、`badges`、`audit_log`、会话模型私信等；`role_grants`/`user_roles` 改 `scope_id NOT NULL DEFAULT 0`；
  业务表去掉全部 `raw`/`content_raw`；`groups`、`emoticon*`、`credit_logs`、`private_messages`、`message_dialogs`、`user_bans` 退出。
- **迁移基线重置**：删除 v1 的 `0000–0005`，生成单个 `0000_init_v2.sql`；开发库须重建（S3 迁移 v2 重新导入）。
- **权限词汇表 v2**：57 旧键 → 25 个权限点；`forum.manage` 并入 `forum.moderate`；`thread.sell/hide` → `gate.points/gate.reply`；
  内置角色 guest/member/admin。纠正 v1 把旧 gid 23/38（实习组/策划组）映射反了的错误。
- **bootstrap** 新增 `seedSystemData`（角色、权限点、首次基线授权、站点设置默认值；幂等、非破坏性）；列级 COLLATE 补丁泛化为 `PATCHES`。
- `db:seed` 重写为 v2 演示夹具（受限版块、不上目录版块、门控、已购买、积分台账、封禁、团队角色）。

### Added（M5.5 · S2）

- `packages/db/src/schema-rules.ts`：schema 结构规则断言（唯一键无可空列 / 无 raw 归档列 / 整型 id 自增 / 有主键），`db:verify` 与单测共用。
- `db:verify` 扩展到 10 项（含权限数据脏键零容忍、系统种子就位）。
- `packages/db` 引入 vitest（含真实 MySQL 临时库集成测试）：29 个测试，覆盖率 98.7%。

### Known（S2–S4 期间预期）

- `apps/web` 与 `migration` 依赖 v1 schema，类型检查/构建为红，S3（迁移）与 S4（应用适配）恢复；main 分支不受影响。

### Added（M5.5 · S1 设计定稿：重构里程碑，仅文档）

- **M0–M5 深度审查**（2026-10-23）：库表逐张分类、旧站源码与旧库二次探查、M3–M5 代码复验。结论与证据见新增的
  `docs/milestones/M5.5-schema-v2.md` 及 M3/M4/M5 里程碑文档的「复验发现」节。
- **M5.5 里程碑文档**：数据模型 v2（统一 post、`forums` 物化路径 + `read_policy`、`user_restrictions`、`point_*`、`post_gates` 等）、
  迁移 v2 转换规则（含丢弃清单）、S1–S5 分步、验收门禁，并把 M3–M5 的 P0/P1/P2 缺陷清账纳入 S4。
- **`docs/GATES.md`**：门控规范——`:::gate{unlock=…}` 容器指令；隐藏内容保存时拆入 `post_gates`（`body_md` 只留占位）；
  可插拔解锁条件注册表（`points` / `reply`，预留 `login`/`follow`/`time`）；SSR 切分渲染含「已购买」标签；`unlockGate` 单事务；
  价格 0 = 登录后免费解锁，旧价 ≥ 9999 一律改免费，作者收益 100%（手续费默认 0）。
- **`docs/POINTS.md`**：积分规范——单一用户积分（显示名可配），`point_accounts` + `point_ledger`，`applyPoints` 单一入口，
  `pointChannels` 渠道注册；获取仅发帖/回帖/签到；不迁旧流水，每人一条期初余额。
- 模块内核注册边界由六类扩为**八类**（`pointChannels`、`gateConditions`）；事件 `credit.changed` → `points.changed`，新增 `gate.unlocked`（实现随 S4）。
- BLUEPRINT 新增重构决策 #11–#18、§3.2 schema v2 目标态、§4.2 内容转换 v2、红线 #7–#8；AUTHZ 新增 §8（v2 修订）；
  LEGACY-FEATURE-MAP 新增「重构判定表」。

### Changed

- **ROADMAP**：插入 M5.5；M7 改为「积分与荣誉」并大幅收缩；M6 纳入编辑器与门控创作/购买；M10 收缩为交互层；M12 依赖 M5.5；
  取消「M14 情怀遗珠」（银行/抽奖）、任务引擎、用户等级、`pw_*` 遗留表迁移。门禁勾选改以真实命令输出为准。
- **M6–M13 里程碑文档**按新模型重写/修订（M6 编辑器选型推迟到开工时）。
- 全局测试基线新增「集成（DB）」层，不得以 IO 层由 E2E 覆盖为由排除统计目录；`pre-push` 钩子运行单测。

### Fixed（文档）

- 清除 `docs/BLUEPRINT.md` 中的旧库 root 口令明文（改读根 `.env`；推送前仍需审计 git 历史）。
- 订正文档漂移：权限「5 表」→ 4 表、README 进度、M3 重复「遗留事项」节、LEGACY-FEATURE-MAP 对签到机制的错误描述。
- M3/M4/M5 里程碑文档追加「复验发现」：`pnpm test` 覆盖率门槛为红、权限翻译不幂等（`user_roles` 重复 5 倍）、
  `role_grants` 脏键、管理动作无审计、首页权限泄露、门控内容变公开等——代码修复归 M5.5 S4。

### Added（M5 · 权限内核：现代 RBAC + 级联数据范围 + 分级权限）

- **四表**：roles（builtin|custom）/permissions（resource + level + legacy_key + condition_params）/
  role_grants（授权唯一通道，global|forum 作用域）/user_roles（可过期绑定）；0005 迁移。
- **词汇表** `packages/db/src/authz-vocab.ts`（单一事实源）：57 旧键 → 37 权限点归一；
  forum 分级域 read/write/manage（manage ⊃ write ⊃ read）；18 个数值型旧键转 ABAC 条件参数；
  10 角色（4 内置 guest/member/muted/admin + 6 团队 custom）。
- **评估器**（纯函数，单测 12 例）：admin 短路 → muted 拦截 → 授权匹配 → 默认拒绝。
- **作用域语义**（本轮最关键的设计收敛）：
  `forum.read` 显式优先（链上最近有配置的层说了算，不回退父级——防父级公开读击穿子级受限版块，
  实证：fid 53 会被 fid 98 父链的 guest 读打开）；`forum.write/manage` 级联合并（子版块自动带父版块版主）。
- **翻译迁移** `authz` 实体：旧五类数据 → 新模型（全局组权限、43 版块 allow_* 白名单逐格翻译、
  user_belong 299 带过期、users.group_id 主组；旧版主名单不迁移——派生制取代）。
  翻译结果：角色 10 / 权限点 37 / 全局授权 124 / 版块授权 5232 / 用户绑定 251；
  **对账报告** `migration/reports/authz-translation-report.md`（未知 gid / 未映射 rkey / 并集差异 / 疑点）。
- **派生版主**查询（授权角色 ∩ 持有人，含父链继承标注）；guard 接入 /f /t（DENY→404 不暴露存在性）。
- **/admin 最小三页**：site.admin 总门、角色列表 + 自定义角色增删、授权矩阵（分级三态 + 作用域切换）、
  版块视角（级联授权 + 派生版主）。
- **E2E 26/26**（新增 5 例权限用例 + 隔离库自证 /api/dev/whoami）。

### Changed

- **M7 范围调整**：取消用户等级/成长系统（levels 引擎），旧 LV 魔界称号改为**纯展示荣誉标识**（M7 承接）。
- 登录频控改**双层**（IP 20 次/10 分钟 + 账号 5 次/10 分钟）——原单层 IP 限流对共享 NAT 过严且使 E2E 失真。
- 迁移 UPSERT 回退 `VALUES()` 语法（`AS new` 别名在 ODKU 引用上存在歧义解析坑，技术债清单已记）。


### Added（M4 · 用户与认证）

- **认证数据层**：sessions（SHA-256 令牌/可撤销/滑动续期）、invite_codes、site_settings
  （register.mode）、email_tokens（reset/verify/claim 单次令牌）、user_bans（补迁 nw_user_ban
  103 行，fid=0 全局/end_time NULL 永久）；users 加 email_verified_at；0004 迁移；verify 25 项。
- **auth 库**：argon2id 密码、会话（登录轮换/全局封禁判定/Secure 协议自适应/请求级缓存）、
  滑动窗口频控（单实例约束文档化）、邮件令牌（原子单次消费）、旧站头像算法（双实证样本）。
- **页面与动作**：/login /register（invite|open 双模式）/forgot /reset/[token] /claim /verify/[token]
  /u/[uid]（旧头像+签名+积分+封禁徽标）+ 登出；Server Actions；统一话术防枚举；
  全局封禁登录拦截+站内只读横幅。
- **邮件**：nodemailer + MailPit 容器（SMTP 1025/UI 8025）；模板四封（重置/认领/验证/邀请）。
- **E2E 6 例**（邀请注册/重复码拒绝/找回重置/认领/防枚举/封禁拦截）+ Cookie 属性断言；
  E2E 基建升级：独立 3200 端口 + 配置内固定隔离库 env（杜绝与 dev 服务抢端口错配）。
- **种子夹具**：E2E 邀请码/被封禁演示用户（预计算 argon2id）/register.mode。

### Fixed

- E2E 与 dev 服务抢 3100 端口导致 env 错配（注册打错库）：E2E 迁至 3200 + 配置内注入隔离库。


### Added（M3 · 内容只读渲染）

- **topic_type 补迁**（M0 漏迁，150 行）：版块页主题分类筛选的前提；迁移实体 11→12，verify 23→24 项。
- **安全渲染管线**：unified/remark/rehype（allowDangerousHtml→raw→sanitize→harden→stringify）+ LRU 缓存；
  白名单 schema + style 声明级过滤（保住 UBB 彩色/字号情怀排版，封死 url()/expression()）；
  XSS 用例集 16 + 白名单保留 6（sanitize.test 29 例）。
- **静态资源路由** `/attachment/**`、`/emotion/**`：逐段穿越守卫 + resolve 前缀双保险 + Content-Type 映射 +
  非图片下载头 + immutable 缓存；探针实证含 `.env` 穿越拦截。
- **三个页面**：首页（分类版块目录 + 真实计数 + 最新动态）、版块页（置顶前置/主题分类筛选/分页 25）、
  帖子页（首帖正文 + 楼层 20/页 + 嵌套回复 + #p 锚点 + 首帖附件芯片）；
  组件 RichContent/UserBadge（已注销）/ThreadRow（置顶三级/精华/投票/附件徽标）/Pagination。
- **数据状态呈现**：spam→404、屏蔽→blocked 视图、孤儿作者→已注销（81 个真实作者）、售帖→付费提示块。
- **E2E 15 例**（真实数据夹具）+ **perf:lcp**（生产构建 LCP 断言 <2500ms：首页 128ms/版块 68ms/帖子 68ms）。
- **URL 格式冻结**（BLUEPRINT §4.5）：`/f/{fid}`、`/t/{tid}`、`?page=`、`#p{pid}` + 旧站 301 源映射表。


### Added（基线审查修复轮 · P1–P3 全项）

- **连接层重构（P1）**：web 运行时单例池 `getWebDb()`（globalThis 守卫，消除每请求建池）；
  连接统一 `timezone: "+08:00"` + `dateStrings` —— 库内 DATETIME 锁定为北京墙面时间，
  UTC 容器化不再漂移；`apps/web/src/lib/datetime.ts` 为唯一解析入口（parseDbDateTime/nowBeijingWallTime）。
- **actor 语义（P2）**：`event_log.actor_id` 按事件映射 payload 字段
  （thread.created→authorId 等 10 项），显式 actorId 可覆盖；语义表入 MODULES.md。
- **外部入口校验（P2）**：REQUIRED_PAYLOAD_KEYS + validateEventPayload，dev emit API 强制校验。
- **E2E 独立数据库（P2）**：`qysub_next_e2e`（e2e-reset 脚本 drop→create→bootstrap→seed，
  根 `test:e2e` 编排），测试不再污染开发库。
- **迁移 UPSERT 语法升级（P2）**：upsertBatch 迁至 `AS new` 别名（VALUES() 于 8.0.20 弃用）；
  迁移回归 23 项全绿。
- **并发锁（P3）**：迁移进程 GET_LOCK 互斥，双开即拒。
- **测试补强（P2）**：覆盖率改目录策略（kernel/lib 新文件自动纳入，当前 96/94/97）；
  event-names / datetime 单测补齐（48 用例）；e2e 纳入 typecheck。

### Fixed

- drizzle datetime 列统一 `mode: "string"`（与连接层 dateStrings 对齐，消除 Date/字符串双形态）。
- .dockerignore 补齐（构建上下文不再吞 node_modules/.next/dist）。
- next-env.d.ts 出库；state.ts 重复导入合并；db verify.ts `void key` 清理。
- BLUEPRINT §6/§9 文档漂移同步（pnpm 命令 + 根 .env 路径 + §2.3 新增时区/连接两条红线）。


### Added（M2 · 模块注册表内核）

- **内核五件**（`apps/web/src/modules/kernel/`）：types（10 事件 + home.* 槽位 + 六类注册边界，编译期防呆）、
  registry（唯一性/kebab-case/封板）、bus（顺序派发、逐消费者隔离、event_log 审计、落库失败降级、依赖注入）、
  state（module_state + React cache 请求级缓存、库故障降级）、slot（selectSlotRenderers 纯函数 + RSC 槽位宿主）。
- **平台表**：event_log + module_state（0001/0002 迁移；正式库补 drizzle journal 基线，与 P0 手写 DDL
  的 mediumint/bigint 类型漂移经 db:verify 暴露并以 0002 对齐）。
- **装卸机制**：`modules:toggle` CLI + dev-only API（/api/dev/emit 假会话事件、/api/dev/modules/toggle），
  双重生产守卫。
- **demo-checkin 演示模块**：user.logged_in 消费 + home.footer-notice 最近登录横幅（M7 由真实签到替换）。
- **契约文档** `docs/MODULES.md`：事件/槽位清单、六类边界、语义与边界（扩清单=改内核+说明）。
- **测试**：内核单测 18 例（注册唯一性/派发顺序/异常隔离/槽位合并/装卸过滤），E2E 2 例装卸闭环
  （串行——装卸共享 dev 服务器状态），全站 36 单测 + 6 E2E 全绿，内核覆盖率 95/97/95。

### Fixed

- API 路由与页面是两棵模块图：使用内核的 route handler 必须自行 `import "@/modules"`
  （已写入 MODULES.md 边界第 6 条，dev API 首版即踩）。

### Added（M1 · 工程骨架与基础设施）

- **pnpm workspace**（pnpm 12.15 自管版本）：`apps/web` + `packages/db` + `migration` 三包结构。
- **@funwind/db 数据内核（决策 #10 单一事实源）**：17 张表 Drizzle 定义、版本化迁移
  （`drizzle/0000_init.sql` 入库）、`db:bootstrap`（空库建表 + username 列级 as_cs 幂等 patch）、
  `db:seed`（90000+ 号段幂等演示种子）、`db:verify`（information_schema 逐表对账，期望自 schema.ts）。
- **双模式数据回归**：临时库空库→建表→全量导入 23 项对账全绿；正式库幂等重跑 23 项全绿。
- **apps/web**：Next.js 16.4.2 + React 19.3.1 + TS strict；三层设计令牌
  （primitives/semantic/themes：default + dark）；Tailwind v4 `@theme inline` 映射；
  shadcn CLI 4.22 首批 10 组件（统一 radix-ui 包 + cn 别名）；next-themes 三态切换（无闪烁）；
  令牌演示页（色板/字阶/圆角阴影/组件样例）。
- **质量工具链**：ESLint 10（flat config，eslint-config-next 原生 flat 数组）+ Prettier 3.9
  （tailwindcss 插件）+ husky/lint-staged；Vitest 5 + Testing Library（覆盖率门槛 90/85，当前 100%）；
  Playwright（E2E：主题切换/持久化/语义配色）；`verify:all` 一键门禁。
- **Docker dev**：`docker/dev/`（node:24-alpine + corepack pnpm，compose profile 可选路径）。

### Fixed

- Next 16 安全默认拦截 `127.0.0.1` 开发资源（HMR/运行时块）导致**开发模式整页无交互**（水合静默失败）——
  `next.config.ts` 配置 `allowedDevOrigins: ["127.0.0.1"]` 修复。

### Changed

- 里程碑重排：新增 M12「安装向导与零数据部署」，原 M12「部署与社区重启」改为 M13；
  ROADMAP/依赖图/相关里程碑引用已同步。

### 计划中

- M2 模块注册表内核（下一里程碑）
- M3–M13 里程碑（见 docs/ROADMAP.md）

## [0.1.0] - 2026-10-23 · 项目设计与数据迁移（P0）

### Added

- **技术蓝图与决策**：`docs/BLUEPRINT.md`——Next.js + MySQL 8.4 LTS + Drizzle + 模块注册表；两轮 8 项站长确认决策全部记录。
- **数据迁移程序** `migration/`：phpwind 9（GBK）→ qysub_next（utf8mb4）幂等迁移，
  11 实体 ≈16.7 万行（用户 10,701 / 主题 4,505 / 回帖 35,248 / 积分流水 93,765 / 私信 3,760 等）；
  旧库只读守卫、UBB→Markdown 转换器（36,771 行正文标签清单驱动）、content_raw/content_md 双写。
- **新库 schema**：保留旧主键（uid/tid/pid/fid/aid）+ 每表 raw JSON 归档；username 列
  `utf8mb4_0900_as_cs`（さくら/サクラ EUC-JP 历史字节实测修正）。
- **验证程序**：23 项对账（行数/600 行抽样 MD5/转换完整性/垃圾标记/附件磁盘/楼层连续性）全部通过。
- **新库容器**：`docker/qysub-next/` MySQL 8.4 LTS @ 127.0.0.1:33621。
- **源码对齐报告**：`docs/LEGACY-FEATURE-MAP.md`——旧 37 应用/40 服务归并为 M01–M15 模块清单，
  57 权限点词汇表提取，签到=每日红包任务等业务语义考古，骨架插入点清单。
- **前端方案**：`docs/FRONTEND-DESIGN.md`——三层设计令牌 + 主题包（现代浅色/暗色/复刻·青翼2010）+ shadcn/ui 模式。
- **权限方案**：`docs/AUTHZ.md`——自研 RBAC/ABAC（5 表 + 评估器），继承旧 57 权限点，旧数据翻译映射。
- **路线图与里程碑体系**：`docs/ROADMAP.md` + `docs/milestones/M1–M12`（范围/边界/测试规则/验收门禁）。

### Data quality（迁移期发现并处置）

- 3,033 条 2018-11 广告空壳主题标记 `is_spam` 隐藏（真实内容主题 ≈1,472）；3 个广告账号标记。
- 孤儿 uid（用户已删、帖仍在）确认为历史现象，方案：UI 渲染「已注销」。
- 附件路径勘误：实际位于 `wwwroot/.../attachment/`（527MB，两代目录并存）；415 个中仅 1 个源盘即缺失。
- pw8 遗留表情码 152 行（映射外）确认旧站亦无法渲染，保留原文；源帖截断/笔误标签原样保留，raw 可证。

