# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式；
版本号采用语义化版本（SemVer）。里程碑交付在条目中标注（M1–M13，见 docs/ROADMAP.md）。

## [Unreleased]

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

