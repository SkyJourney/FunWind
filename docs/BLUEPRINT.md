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
7. **权限：自研轻量 RBAC/ABAC**（5 表 + ~200 行评估器，继承旧 57 权限点词汇表；见 AUTHZ.md）。
8. **注册：邀请制起步、稳定后开放**（邀请码 + 邮箱验证 + 频控两套接口骨架都留）。
9. **开发路线：先骨架后功能**——按 [LEGACY-FEATURE-MAP.md](LEGACY-FEATURE-MAP.md) 的 M01–M15 顺序，
   骨架期就落事件总线/UI 槽位/注册表边界，逐模块填充。
10. **数据层双模式**：项目必须支持**零数据部署**（Web 安装向导 + CLI bootstrap，见里程碑 M12），
    青翼 phpwind 迁移导入是可选路径而非前提。schema 单一事实源在应用侧（Drizzle 定义，M1 起），
    `migration/` 降级为「青翼专项导入器」，其 schema-init 与应用共用同一 Drizzle 管线。

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
- 用户侧同类：广告发帖账号 3 人被标记 `is_spam`（user-a/user-b/user-c）；另有 uid 21220（「user-d」SEO 垃圾，9 空壳帖）**用户行已被删、帖子仍在**——用户表存在孤儿 uid，属正常历史现象，UI 需容忍「已注销」作者。
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

## 3. 新库 schema（qysub_next）

设计原则：**保留旧主键**（uid/tid/pid/fid/aid）→ 历史 URL 可 301、附件路径天然可用；每表带 `raw JSON` 归档旧行，永不丢信息。
schema 演进：P0 期的 `migration/schema/schema.sql` 为基线底稿；**M1 起以应用侧 Drizzle 定义为单一事实源**（决策 #10），
零数据 bootstrap 与迁移导入共用同一建表管线。

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

完整 DDL：`migration/schema/schema.sql`

## 4. 内容转换（UBB → Markdown）

`migration/src/ubb.ts` 单遍状态机：

- `[b][i][u][s]` → Markdown 强调；`[color=]`/`[size=]` → 内联 HTML span（Markdown 允许内联 HTML）
- `[quote]` → 递归转 blockquote；`[code]` → 围栏代码块；`[url=]`/`[img]` → MD 链接/图片
- `[s:N]` → `![表情](/attachment/emotion/{folder}/{icon})`（查 emoticons 映射）
- `[attach]` 类 → 附件链接；`[hide]/[buy]` → 折叠提示块（购买记录 threads_buy 保留）
- 未知标签：剥壳留肉；`usehtml=1` 的极少数行原文保留走净化渲染
- **双写**：`content_raw`（原始 UBB，永远可回滚）+ `content_md`

## 5. 附件策略

不复制文件。新系统以 `/attachment/**` 静态路由直指原目录（本地 dev 用 nginx/Next rewrite 指到
`/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/attachment`；生产 rsync 同布局）。
元数据进 `attachments` 表。将来若要独立存储，路径语义不变，只换挂载点。

## 6. 里程碑（沿用四阶段，细化）

1. **P0 数据迁移** ✅（2026-10-23 完成）：`migration/` 幂等迁移程序 + 23 项验证全部通过
   - 新库：`qysub-next-mysql`（MySQL 8.4 LTS）@ 127.0.0.1:33621 / `qysub_next`
   - 重跑：`npm run migrate`（UPSERT 幂等）· 验证：`npm run verify`
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
| 旧附件热链失效 | 301 表 + `/attachment` 静态路由双保险（415 附件仅 1 个源盘即缺失） |
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
| 旧库（只读！） | `127.0.0.1:33620/qingyisub`（GBK，root / ***REMOVED***） |
| 新库 | `127.0.0.1:33621/qysub_next`（MySQL 8.4，root / ***REMOVED***） |
| 旧站本地还原 | http://127.0.0.1:8080（qingyisub-nginx） |
| 附件目录 | `/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/attachment/`（527MB） |
| 表情目录 | 同上 `res/images/emotion/{folder}/`（新站路由 `/emotion/**`） |
| 迁移程序 | `FunWind/migration/`（`.env` 已配好；`npm run migrate` / `npm run verify`） |
| 新库容器 | `FunWind/docker/qysub-next/compose.yaml` |
