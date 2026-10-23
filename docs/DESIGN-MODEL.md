# 目标数据模型（schema v2.1）· 设计先行

> 状态：2026-10-23 站长确认。本文是**数据模型的单一设计依据**：先按现代论坛的设计原则定下新系统，
> 旧数据向它靠拢；迁移程序只是适配层。冲突时以本文为准（BLUEPRINT §3 的 v1/v2 映射表仅作历史对照）。
> 对应实现：`packages/db/src/schema.ts`（R2 重做）。迁移适配见 [M5.5](milestones/M5.5-schema-v2.md)。

## 1. 设计原则

1. **运行时 schema 不认识旧站**：不出现 `legacy_*` 列、「迁来的」标记、迁移用 id 公式；零数据安装不带任何青翼专属数据（如团队角色）。
   旧键映射、旧 gid、旧路径等迁移知识只存在于 `migration/`。
2. **引用诚实**：每个 `author_id` 都指向 `users` 里真实存在的一行。账号注销 = 用户行转 `deleted` 并清除个人信息，不在内容表加冗余列。
3. **状态最小**：内容状态机见 §4；用户的限制统一走 `user_restrictions`，不在用户表里堆状态。
4. **存储抽象**：所有文件（附件、头像、正文图片、徽章图）进同一个按内容哈希寻址的 `files` 注册表。
5. **只保留 URL 必须稳定的 id**：`uid` / `fid` / `tid` / `pid` 保留（`/u/{uid}` `/f/{fid}` `/t/{tid}` 与 `#p{pid}` 已冻结）；
   其余一律自增。迁移的可重复性靠「清空后按确定的顺序重导」，不靠 id 公式。
6. **唯一键不得依赖 NULL 去重**（`scope_id = 0` 哨兵；唯一例外 `users.email_key`）。
7. **扩展点前置抽象**：积分渠道、门控解锁条件、通知类型与投递渠道，均为模块内核的注册边界；新增能力 = 新模块注册。
8. **内容只有 Markdown**：不产生也不存储内联样式（见 §6）。

## 2. 表清单（43 张）

### 身份（8）

| 表 | 要点 |
|----|------|
| `users` | `id`（保留 uid）、`username`、`username_key`（trim+小写，唯一）、`email`、`email_key`（唯一，可空）、`password_hash`、`email_verified_at`、`state(active\|deleted)`、`created_at`、`last_login_at`。已注销账号保留行：`state=deleted`，用户名「已注销用户#id」，无邮箱无密码 |
| `user_profiles` | `bio`、`location`、`website`、`gender`、`birthday`、`signature_md`、`avatar_file_id` |
| `user_stats` | 可重算的计数缓存：主题/帖子/精华/粉丝数、最后发帖时间 |
| `user_restrictions` | `kind(ban\|mute\|no_avatar\|no_signature)`、`scope_id`、起止时间、理由、操作者 |
| `sessions`、`email_tokens`、`invite_codes`、`site_settings` | 认证与站点配置，沿用 |

### 版块（2）

| 表 | 要点 |
|----|------|
| `forums` | 邻接表 `parent_id` + 物化路径 `path`/`depth`、`kind(section\|forum)`、`name`、`description`、`icon`、`sort_order`；策略三件套 `read_policy`（inherit\|public\|members\|restricted）、`write_policy`（inherit\|members\|restricted）、`review_policy`（inherit\|none\|threads\|all）；`is_listed`、`is_archived`；可重算缓存 `thread_count`/`post_count`/`last_post_*` |
| `forum_prefixes` | 主题前缀 |

### 内容（9）

| 表 | 要点 |
|----|------|
| `threads` | `forum_id`、`author_id`、`title`、`prefix_id`、`kind(normal\|poll)`、`first_post_id`、`state`、**`pin_level`**（0 无 / 1 版块 / 2 分区 / 3 全站）、**`is_featured`**、`is_locked`、`reply_count`/`view_count`/`last_post_*`（缓存）、`created_at` |
| `posts` | 统一 post 模型：首帖 = `floor 1`。`thread_id`、`floor`（`(thread_id, floor)` 唯一）、`author_id`、`body_md`（仅公开部分）、`reply_to_post_id`、`has_gate`、`state`、`like_count`、`created_at`、`edited_at` |
| `post_gates` | 门控：自增 `id`、`post_id`、**`gate_key`**（帖内唯一的短键，`(post_id, gate_key)` 唯一；正文占位引用它）、`conditions` JSON、`match_mode`、`hidden_md`、`unlock_count` |
| `gate_unlocks` | `(gate_id, user_id)` 主键、`price_paid`、`author_income`、`ledger_id`、`unlocked_at` |
| `content_reviews` | 审核历史：`post_id`、`reviewer_id`、`decision(approved\|rejected)`、`note`、`created_at` |
| `files` | **文件注册表**：`sha256`（唯一）、`storage_key`（由哈希派生）、`size_bytes`、`mime`、`width`、`height`、`created_at` |
| `attachments` | 帖子的下载附件：`post_id`、`file_id`、`uploader_id`、`original_name`、`downloads`、`created_at` |
| `tags`、`thread_tags` | 主题标签 |

### 互动（8）

`reactions`、`follows`（user\|forum）、`polls`、`poll_options`、`poll_votes`、
`conversations`（单聊，`pair_key` 唯一）、`conversation_members`（含 `last_read_message_id`）、`messages`。

### 通知（4）——详见 [NOTIFICATIONS.md](NOTIFICATIONS.md)

`notifications`、`notification_preferences`、`announcements`、`announcement_reads`。

### 积分与荣誉（5）

`point_accounts`、`point_ledger`、`checkins`、`badges`（`icon_file_id`）、`user_badges`。详见 [POINTS.md](POINTS.md)。

### 权限（4）——M5 架构沿用，微调

`roles`、`permissions`（**去掉 `legacy_key`、`condition_params`**）、`role_grants`（`scope_id`）、`user_roles`（`scope_id`）。
内置角色只有 `guest` / `member` / `admin`；团队角色是**站点数据**，由管理员创建（青翼的由迁移创建）。详见 [AUTHZ.md](AUTHZ.md)。

### 平台（3）

`event_log`、`module_state`、`audit_log`（**删除 `migration_state`**：迁移记录由对账报告承担，不进业务库）。

## 3. 关键字段的设计说明

- **`pin_level` / `is_featured`**：产品语义清晰，取代「topped 0–3 / digest 0–2」这类沿袭命名。
- **`gate_key`**：门控在帖内的稳定身份。作者编辑时 key 不变，解锁记录因此不丢；新增门控由服务端分配新 key。正文占位为 `:::gate{key="a1"}\n:::`。
- **`files.storage_key`**：形如 `ab/cd/<sha256>.<ext>`，由哈希派生，不含任何业务含义；存储根目录由 `STORAGE_DIR` 配置，可平移到对象存储。
- **`forums.review_policy`**：与读/写策略同一套继承规则；`threads` = 新主题需审核，`all` = 所有发帖需审核。

## 4. 内容状态机

```
              提交（版块需审核）            审核通过
  ───────────────► pending ───────────────► visible ◄──── 恢复
                     │                        │  ▲
                     │ 驳回                    │  │
                     ▼                        ▼  │
                  rejected              hidden / deleted（版主/作者操作，带理由）
                     │ 作者修改后重新提交 → pending
```

| 状态 | 谁能看到 |
|------|----------|
| `visible` | 按版块读策略 |
| `pending` / `rejected` | 作者本人（可见驳回理由、可编辑后重新提交）+ 持有 `forum.moderate` 的版主 |
| `hidden` / `deleted` | 版主（可恢复）；对其他人表现为不存在 |

状态变化由领域事件驱动通知（见 NOTIFICATIONS.md），并写 `audit_log` 与（审核类）`content_reviews`。

## 5. 文件与 `/files` 路由

- 上传 → 计算 SHA-256 → 已存在则复用 `files` 行，否则落盘 → 写 `attachments` / `user_profiles.avatar_file_id` / 正文图片引用。
- `/files/<storage_key>`：**图片类**（头像、正文图片）公开；**非图片附件**必须经 `attachments` 反查所属帖子，按该帖所在版块的读权限校验，
  并累加下载数。取代旧 `/attachment/**` 公开静态直出，补上「受限版块附件无鉴权」的缺口。
- 正文引用图片一律写 `/files/<storage_key>`（能力 URL，不可枚举）。

## 6. 内容约定（Markdown only）

- 支持：标题、段落、粗体/斜体/删除线、引用、代码、列表、表格、链接、图片、水平线、`<sup>`/`<sub>`、`<u>`、门控容器指令。
- **不支持也不存储**：`color` / `size` / `backcolor` / `align` 等内联样式；渲染白名单去掉 `style` 属性与 `align`。
- 表情：Unicode emoji 直输；历史表情码在迁移期展开为 `/emoji/{id}.gif` 静态图（运行时无表情表）。

## 7. 旧数据靠拢：值不值得迁

迁移不是设计的约束，只是适配。逐类判断「新系统有没有天然归宿、迁过来有没有价值」：

| 价值 | 数据 | 处理 |
|------|------|------|
| **核心，迁** | 用户账号（召回要用）、可见主题与回帖、版块结构与可见性、门控与真实购买、附件文件 | 迁入新模型；附件与头像复制进 `files` 存储 |
| **有价值，迁** | 关注、点赞、投票历史、积分期初余额、在期内的限制、勋章与团队徽章、标签 | 迁入 |
| **压缩后迁** | 签到：只迁每人「截至最近一次的连续签到段」，保住连签状态；正文内联样式：降级为纯 Markdown | 适配时转换 |
| **不迁（旧库即归档）** | spam 空壳主题、旧回收站与屏蔽内容、私信、系统消息、旧通知、旧公告、任务/银行/抽奖等已取消功能、`pw_*` 遗留表 | 旧库保留到 M13 签字 |
| **补齐** | 已注销作者的帖子 → 为被引用但已不存在的 uid 建「已注销用户」占位账号 | 适配时生成 |

## 8. 与里程碑的关系

| 里程碑 | 落地内容 |
|--------|----------|
| M5.5（R1–R3、S4–S5） | 本文的 schema、迁移适配层、应用适配 |
| M6 | 编辑器、发帖/回帖、门控创作、`/files` 上传、审核提交 |
| M7 | 积分规则、签到、徽章展示 |
| M8 | 互动（点赞/关注/标签）、**通知中心后端 + 顶栏铃铛**、搜索 |
| M9 | 后台、**审核队列**、举报、**公告管理**、用户限制管理 |
| M10 | 投票与私信界面（私信接入通知指针） |
| 后续独立项 | 通知中心完整页面 |
