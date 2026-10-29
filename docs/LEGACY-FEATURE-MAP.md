# 旧 phpwind 源码 ↔ 新系统 · 功能对齐报告

> **M5.5 重构判定（2026-10-23）**：本报告是 P0 期「忠实搬运」视角的考古底稿；各模块在现代论坛视角下的砍/留/重做结论见**文末「重构判定表」**，冲突处以判定表与 [M5.5](milestones/M5.5-schema-v2.md) 为准。

> 研读对象：`/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top/`（只读参考，不运行不修改）
> 本文是**可复用的对齐底稿**：新功能模块落地时按此追溯旧实现语义；编号 M01–M15 即新系统的模块清单。
> 数据佐证均来自旧库实测（2026-10-23）。

图例 ——
**优先级**：P0 骨架必做 / P1 首批完善 / P2 情怀或外围 / P3 择机 / ✗ 弃用
**分类**：`骨架` `内容` `互动` `游戏化` `管理` `基建` `弃用`

---

## M01 论坛核心 core-forum `骨架·内容` **P0**

| 项 | 内容 |
|----|------|
| 旧源码 | `src/applications/bbs/`（发帖/回帖/读帖控制器）、`src/service/forum/`、`src/service/attach/`、`src/service/recycle/`、`src/service/draft/` |
| 核心表 | nw_bbs_threads(_content/_index/_buy/_sort)、nw_bbs_posts(_reply/_topped)、nw_bbs_forum(extra/statistics/user)、nw_bbs_topic_type |
| 已迁移 | ✅ 全部（threads.posts.attachments 表，UBB→MD 双写） |
| 待建 | 版块首页/帖子详情 SSR、MD 编辑器、楼层与嵌套回复（posts_reply 2,214 条）、主题分类 topic_type、售帖/隐藏阅读（threads_buy 6,984 条购买记录+SELL/HIDE 标签）、草稿 |
| 插入点 | 事件 `thread.created/replied/edited`；槽位 `帖子侧栏` `帖子底部` `版块头` |

## M02 用户与认证 users-auth `骨架` **P0**

| 项 | 内容 |
|----|------|
| 旧源码 | `src/applications/u/` `profile/` `verify/` `windid/`（独立用户中心体系）、`src/service/user/` |
| 核心表 | nw_user/_info/_data/_belong/_ban、nw_windid_user*、nw_user_register_check/register_ip（7,258/8,405 行——当年反广告注册的痕迹） |
| 已迁移 | ✅ users 表（四表合一 + raw 归档，密码置空） |
| 待建 | 注册（邀请制？开放制需站长定）、登录、**邮件密码重置**（旧哈希不可迁移的既定对策）、资料页、头像（旧头像算法 `attachment/avatar/{3位}/{2位}/`）、封禁 nw_user_ban(103) |
| 备注 | 2018 广告洪泛意味着注册策略要防刷（邮箱验证 + 频控是底线）；邀请码表 nw_invite_code 为空，旧站实际是封闭注册 |

## M03 权限 authz（RBAC/ABAC）`骨架·基建` **P0**

详见 [AUTHZ.md](AUTHZ.md)。旧词汇表 57 权限点已提取（`src/service/usergroup/srv/permission/permissions.php`），
新模型：Permission（继承旧词汇）× Role × ABAC 条件（版块/所有权/积分门槛/频控）。

## M04 附件与静态资产 attachments `骨架·基建` **P0（元数据已完成）**

- `src/service/attach/`；nw_attachs/_thread 已迁移。文件不复制，`/attachment/**` 直指原目录。
- 待建：上传组件（新帖）、缩略图策略、下载计数/售帖扣费（cost/ctype 字段语义在旧 `PwAttachService`）。

## M05 搜索 search `内容·基建` **P1**

- `src/applications/search/`（nw_app_search_record 2,124 行）、`src/service/seo/`。
- 新方案：MySQL FULLTEXT ngram 起步 → Meilisearch（中日文分词）。索引范围=非 spam 的 threads/posts。

## M06 互动套件 interact `互动` **P1**

| 子功能 | 旧源码/表 | 规模 |
|--------|-----------|------|
| 点赞 | `src/service/like/` nw_like_content/log/statistics | 344/1,649/372 |
| 关注（人/版块） | `src/service/attention/` nw_attention(+fresh 推送流) | 4,390 关注；fresh 流表可弃 |
| 标签 | `src/service/tag/` nw_tag(+relation) | 12 标签 |
| 通知 | `src/service/remind/` nw_remind + nw_message_notices(32,572) | 未迁移，待建通知中心 |
| 嵌套回复 | nw_bbs_posts_reply | 2,214（已随 posts 迁移 reply_to_pid） |

## M07 游戏化 gamification `游戏化` **P1** ← 模块注册表的第一个消费者

| 子功能 | 旧实现 | 新模块设计 |
|--------|--------|-----------|
| 积分 | `src/service/credit/` applications/credit；credit1..8（青翼币/入住资格证…）+ nw_credit_log 93,765 行已迁移 | credits 模块：账户（JSON 列已留）+ 流水 + 发放 API（`credit.grant` 事件消费方） |
| 等级 | nw_user_groups.points 阈值（LV1.魔狱原住民→LV12.圣魔王，25 组已迁移） | groups 模块：按积分自动升降级（事件驱动） |
| 勋章 | `src/service/medal/` nw_medal_*（25 枚/3,833 人已迁移展开） | medals 模块 |
| 签到/任务 | `src/applications/task/` nw_task(5 任务)+nw_task_user(17,246)；~~签到=「每日红包」punch 任务~~ **（M5.5 更正）**签到实为站点配置 `punch.open=1` / `punch.reward` 随机 1–5，连签存 `nw_user_data.punch`；「每日红包」任务 `is_open=0` 且无一条完成记录；任务引擎死于 2017 | **签到**：重做为 checkins；**任务引擎：取消**（M5.5 决策） |

## M08 投票 poll `互动` **P2**

`src/applications/vote/` `src/service/poll/`；nw_app_poll*（147 票/1,511 选项/3,540 投票已迁移）。挂到 threads.special='poll' 渲染 + 投票组件。

## M09 私信 pm `互动` **P2**

`src/applications/message/` `src/service/message/`；nw_windid_message/_dialog（7,738 行已迁移，UI 后做）。

## M10 站点框架 site-chrome `内容·管理` **P1**

公告 announce(10)、导航 nav(30)、友链 link(15+8)、页脚/统计——旧源码 `src/applications/announce/ nav/ link/`。
新版做成可配置导航 + 公告条（admin 可编辑），不再需要独立页面群。

## M11 管理后台 admin `管理` **P1**

- 旧源码：`src/applications/admin/`（运营后台）+ `pwadmin/`（phpwind 授权后台，✗ 不需要）+ `manage/`（版主操作：mawhole.php 等 pw8 遗留入口）+ `src/service/log/`（nw_log 706/nw_log_login 2,116）
- 新版：独立 `/admin` route group，复用前台主题 token；功能=内容审核（spasm 队列/回收站 nw_recycle_* 8,561 行·一期不迁移仅归档）、用户管理、权限矩阵（M03）、数据看板
- 版主体系：nw_bbs_forum.manager（用户名串）+ nw_bbs_forum_user(163) → 新版 forum_overrides + moderator 角色

## M12 首页装修 design→theme `内容` **P2**

- 旧源码：`src/service/design/` nw_design_*(15 表，组件化 portal 装修)+`src/applications/design/`
- 新方案：**不再做装修引擎**——现代化替代 = 设计令牌主题包 + 少量可配置首页区块（公告/最新/热门/精华），这是"旧时代主题→现代轻量主题"的具体落点
- 怀旧素材：`themes/forum/` 10 套皮肤（default/whitesimple/wood_phpwind/black_phpwind/19楼仿…）+ `template/kiminitodoke/`（好想告诉你定制阅读页）→ 提取色板做「复刻主题包」

## M13 基建横切面 infra `基建` **P1**

SEO/sitemap（`applications/seo/` nw_seo 70 行）、缓存（`nw_cache` 86 行→新版 Redis）、定时任务（`service/cron/` nw_common_cron→新版 cron/队列）、敏感词 nw_word(空，✗ 用现代内容安全替代)、举报 report(2)、操作日志。

## M14 情怀与遗珠 legacy `游戏化·情怀` ~~P2/P3~~ **✗ 已取消（M5.5）**

> 银行（存款 96,650 枚将结算进余额）与抽奖整体删除，不再立项；下表仅作历史考古。

| 功能 | 表（活数据） | 判定 |
|------|--------------|------|
| 银行（积分理财） | hack/bank → nw_app_bank(30)/banklog(326) | P3 情怀（社区重启后可选回归） |
| 抽奖 | hack/luck → nw_app_luckyfree(1,332 记录) | P3 情怀 |
| 加密帖/阅读权限 | nw_app_encryptposts(0)/readprivilege(0) | ✗ 无数据，ABAC 已覆盖语义 |
| 活动 | nw_app_activity(0) | ✗ |

## M15 弃用清单 ✗

weibo 同步(1,974 行只读归档)、aCloud(阿里云开放平台)、appcenter/pay(支付宝握手)、mobile 客户端接口、passport_client、domain/school/education(地区学校档案，3549/2428 行仅 raw 归档)、pwadmin。

---

## 骨架预留边界（与蓝图 §8 模块注册表对应）

1. **事件**：`thread.created/replied/edited/deleted`、`user.registered/logged_in`、`attachment.uploaded`、`credit.changed`、`medal.awarded`、`checkin.done`
2. **UI 槽位**：`帖子页·侧栏/底部`、`版块页·头/侧`、`首页·区块位(N)`、`导航·右侧`、`个人资料·页签`
3. **注册边界**：路由前缀 / 数据表（Drizzle schema 片段）/ 权限点（继承 57 点词汇表扩展）/ 导航项 / 主题令牌覆盖 / cron 任务
4. **落地顺序**：M01–M04 骨架（含 M03 权限内核与空注册表）→ M05/M06/M10/M13 → M07（验证注册表）→ M11 → M08/M09/M12/M14

## 附：旧权限点 57 键全清单（新权限模型词汇表基线）

```
allow_visit allow_read allow_post allow_reply allow_upload allow_download uploads_perday
allow_thread_extend(sell/hide) threads_perday post_pertime post_url_num post_check
post_modify_time thread_edit_time thread_award remote_download reply_locked_threads
allow_add_vote allow_participate_vote allow_view_vote allow_publish_vedio allow_publish_music
multimedia_auto_open allow_sign sign_max_length sign_max_height sign_ubb sign_ubb_img
message_allow_send message_max_send tag_allow_add tag_allow_edit tag_allow_manage
allow_report remind_open remind_max_num invite_allow_buy invite_buy_credit_num invite_limit_24h
user_binding sell_credits sell_credit_range enhide_credits
panel_bbs_manage panel_log_manage panel_recycle_manage panel_report_manage panel_user_manage
operate_thread force_operate_reason look_thread_log view_ip_address fresh_delete design_allow_manage
```

---

## 重构判定表（M5.5，2026-10-23；数据均为旧库实测）

方针：以现代论坛视角裁剪；未被新模型使用的旧表**丢弃且不建归档库**，旧库保持只读至 M13 签字。落地里程碑见 [ROADMAP](ROADMAP.md)。

| 模块 | 数据活跃度 | 判定 | 现代形态 / 备注 | 落点 |
|------|-----------|------|-----------------|------|
| M01 论坛核心 | 活 | **重做** | 统一 post 模型（首帖=floor 1）、`posts_reply` 丢弃（与 `rpid` 逐行重复）、`forums` 物化路径 + `read_policy`、`topic_type`→`forum_prefixes` | M5.5 |
| M01 售帖/隐藏 | 购买 6,984 条（91% 价格 0，总花费 2,142）；`[post]` 306 帖 | **重做为门控** | 容器 + 可插拔解锁条件，见 [GATES.md](GATES.md) | M5.5 / M6 |
| M02 用户与认证 | 10,701 人，266 人 2019 后登录 | **瘦身** | `users` + `user_profiles`；删 `group_id`、QQ/MSN 等低填写率字段；邮箱/用户名归一化唯一 | M5.5 |
| M03 权限 | — | **修订** | `scope_id` 哨兵、`read_policy`、`forum.moderate`、`user_restrictions` | M5.5 |
| M04 附件 | 415 条（`nw_attachs` 为 `nw_attachs_thread` 的逐行子集） | **重做** | `post_id` 必填、`storage_key`；新上传带鉴权下载 | M5.5 / M6 |
| M05 搜索 | 记录 2,124 行，止于 2023 | **新建** | FULLTEXT ngram，仅索引 `body_md`；搜索记录功能取消，旧记录作测试词表 | M8 |
| M06 点赞 | 1,649 条，止于 2025-04 | 迁移 + 重做 | `reactions` | M5.5 数据 / M8 交互 |
| M06 关注 | 4,390 条（711 条引用无效用户） | 迁移 + 重做 | `follows`；动态流表不迁 | M5.5 / M8 |
| M06 标签 | 12 个主题标签（止于 2013）；用户兴趣标签 75 个 | 主题标签重做；**兴趣标签取消** | `tags`/`thread_tags` | M8 |
| M06 通知 | 32,572 条（89% 为任务/勋章/欢迎语） | **重做，旧数据不迁** | 统一收件箱 | M8 |
| M07 积分 | `credit_log` 93,765（起于 2013-02，与余额对不上） | **重做** | 单一用户积分 + 台账 + 渠道注册，见 [POINTS.md](POINTS.md)；只迁期初余额；获取仅发帖/回帖/签到 | M5.5 / M7 |
| M07 等级 | 10,617/10,701 人同为 LV1 | **取消** | LV 称号不再保留 | — |
| M07 勋章 | 25 枚，3,833 持有（99% 为注册自动发的「社区居民」） | 迁移 + 重做 | `badges`/`user_badges`，手动授予，纯展示 | M5.5 / M7 |
| M07 签到 | 约 72,992 次，连签最长 230 天 | 重做 | `checkins`，历史自 punch 流水提取 | M5.5 / M7 |
| M07 任务引擎 | 止于 2017 | **取消** | — | — |
| M08 投票 | 147 个，止于 2017-08 | 迁移 + 重做 | 结构化块；以实际投票记录重算计数 | M5.5 / M10 |
| M09 私信 | 3,760 条，其中 2,268 条为系统消息，止于 2017-08 | 重做 | 会话模型；系统消息丢弃 | M5.5 / M10 |
| M10 站点框架 | 公告 10 条（全过期）、导航 30、友链 15 | **改配置** | `site_settings` JSON，手工整理种子，不迁表 | M9 |
| M11 管理后台 | 日志 706 + 2,116 | 重做 | `audit_log` 统一审计；旧日志不迁 | M5.5 / M9 |
| M12 首页装修 | — | 不复活 | 主题令牌包 | M11 |
| M13 基建 | 举报 2、缓存/定时/敏感词 | 举报重做为队列 | 其余现代方案替代 | M9 / M13 |
| M14 情怀（银行/抽奖） | 银行 30 户止于 2021，抽奖止于 2023 | **取消** | 存款结算进余额 | — |
| M15 弃用 | weibo、aCloud、pwadmin 等 | ✗ | 同前 | — |
| 旧库未覆盖的遗留表 | `pw_*` 共 311 张（如 `pw_creditlog` 77,106、`pw_ms_messages` 32,650） | **丢弃** | pw8 时代数据，止于 2010–2013 | — |

附：旧站表情仅 50 枚映射码（使用 12,556 次）+ 147 行映射外遗留码，全部在迁移期展开为静态图片；新编辑器不带表情面板（**M10.9 更新**：旧 50 枚元数据以原 id 入 `emojis` 表、后台可管理、面板接入社区表情页签；映射外遗留码仍为已删除）。
