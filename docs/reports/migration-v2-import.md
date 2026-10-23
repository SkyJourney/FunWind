# 迁移 v2 导入报告

基准时间（过期判断用，保证重跑一致）：2026-10-23 00:00:00
本报告由迁移程序自动生成，内容确定性（不含运行时间戳）；连跑两次应得到逐字节相同的文件。
标有「待站长处理」的小节需要人工复核。

## 版块

共 43 个；名称内嵌 HTML 样式已剥离 4 个（颜色不保留）；回收站版块标记归档 1 个。

| 读策略 | 版块数 |
| --- | --- |
| public | 37 |
| restricted | 6 |

| 写策略 | 版块数 |
| --- | --- |
| inherit | 37 |
| restricted | 6 |

| 层级深度 | 版块数 |
| --- | --- |
| 1 | 7 |
| 2 | 34 |
| 3 | 1 |
| 4 | 1 |

不出现在首页目录（is_listed=0）：106、137、138、141、142、155

restricted 版块的团队角色作用域授权 72 条（读 36 / 写 36）。

（无）

## 主题前缀

旧分类 150 个，被主题实际引用 91 个，其余 59 个丢弃。

## 用户

共 10701 人；标记 spam 3 人；有头像文件 7333 人；密码一律不迁移（password_hash=NULL，走邮件认领）。

- 用户名归一化冲突 0 个
- 用户名为空 0 个
- 注册时间缺失已修复 2 个：17892（lastvisit）→ 2018-11-24 00:28:44；19921（fallback）→ 2010-01-01 00:00:00

### 待站长处理：非法邮箱（已置空）3 个

| uid | 原邮箱（脱敏） |
| --- | --- |
| 19553 | d***@163.com |
| 23042 | g***@yahoo.com |
| 23539 | l***@163.com |

### 待站长处理：重复邮箱 6 组（保留最早注册者，其余置空）

| 邮箱（脱敏） | 保留 uid | 已清空 uid |
| --- | --- | --- |
| j***@126.com | 4584 | 5545 |
| j***@126.com | 5494 | 5557 |
| y***@163.com | 5503 | 5510 |
| h***@163.com | 5599 | 5610 |
| 7***@qq.com | 22692 | 22695 |
| 3***@qq.com | 22696 | 22697 |

完整邮箱清单见本机 `migration/reports/migration-v2-todo-pii.md`（含个人信息，已 gitignore，不入库）。

## 用户限制

旧封禁 83 条 + 禁止发言组 19 人 = 102 条；已过期丢弃 20；与现有禁言重复的禁言组成员 47；用户已不存在 0；类型未知 0。

| 类型 | 条数 |
| --- | --- |
| mute | 68 |
| no_avatar | 17 |
| no_signature | 17 |

说明：旧站 `nw_user_ban.typeid` 1/2/4 = 禁言/禁头像/禁签名，**从无「禁止登录」类封禁**；禁止发言组成员翻译为永久禁言。

## 权限翻译

全局授权 113 条 + 版块作用域授权 72 条；用户角色绑定 185 条。（翻译类表采用「替换式加载」：整体由旧数据推导，重跑不遗留过期授权。）

| 角色 | 全局授权数 |
| --- | --- |
| admin | 25 |
| guest | 1 |
| member | 13 |
| team-art | 12 |
| team-intern | 12 |
| team-planning | 12 |
| team-resource | 12 |
| team-subtitle | 13 |
| team-tech | 13 |

| 角色 | 持有人数 |
| --- | --- |
| admin | 21 |
| team-art | 1 |
| team-intern | 30 |
| team-planning | 1 |
| team-subtitle | 99 |
| team-tech | 33 |

### 旧权限键的去向

- 版块读权限（allow_read）交由 read_policy 表达，不翻译为授权：23 行
- 版主操作键（operate_thread）不翻译：对普通会员只是设置数组，版主权限只能经 forum.moderate 作用域授权获得：15 行
- 非开关键出现数组值（设置而非开关，未翻译）：无
- 条件参数型旧键（转 ABAC，M6 消费）：message_max_send×23、post_check×23、threads_perday×23、post_pertime×23、post_url_num×15、uploads_perday×23、sign_max_length×23、sell_credits×23、sell_credit_range×23、enhide_credits×23、sign_max_height×23、post_modify_time×23
- 词汇表无对应的旧键（多为已取消功能）：user_binding×15、allow_publish_vedio×23、allow_publish_music×23、remind_open×23、remind_max_num×23、thread_edit_time×23、look_thread_log×23、sign_ubb×23、sign_ubb_img×23、app_search_open×23、app_search_time_interval×23、app_activity×23、invite_allow_buy×23、invite_buy_credit_num×23、invite_limit_24h×23、force_operate_reason×15、fresh_delete×15、design_allow_manage×3、app_encryptposts×18、panel_bbs_manage×3、app_mark_credits×17、app_mark_manage×3、app_mark_open×17、app_readprivilege×20、app_xmThreadHtml×8
- 禁止发言组的权限行（改走 user_restrictions）：34 行
- PHP 序列化值解析失败：0 行

### 未映射的旧 gid（站长已决策：已删除组的成员/权限不恢复）

| 旧 gid | 权限行数 | 用户绑定数 |
| --- | --- | --- |
| 7 | 47 | 0 |
| 14 | 37 | 0 |
| 15 | 37 | 0 |
| 16 | 37 | 0 |
| 17 | 33 | 0 |
| 19 | 0 | 78 |
| 20 | 0 | 23 |
| 24 | 0 | 3 |
| 25 | 33 | 0 |
| 26 | 0 | 2 |
| 27 | 0 | 4 |
| 35 | 0 | 1 |

### 会员权限的「最宽并集」（只有部分会员组开启的权限点）

| 权限点 | 开启的会员组 | 未开启的会员组 |
| --- | --- | --- |
| attachment.download | 1,8,9,10,11,12,13,28,29 | 30,31,32,33 |
| attachment.upload | 1,8,9,10,11,12,13,28,29 | 30,31,32,33 |
| forum.report | 8,9,10,11,12,13,28,29 | 1,30,31,32,33 |
| forum.write | 1,8,9,10,11,12,13,28,29 | 30,31,32,33 |
| gate.points | 28 | 1,8,9,10,11,12,13,29,30,31,32,33 |
| gate.reply | 8,9,28 | 1,10,11,12,13,29,30,31,32,33 |
| pm.send | 8,9,10,11,12,13,28,29 | 1,30,31,32,33 |
| sign.use | 1,8,9,10,11,12,13,28,29 | 30,31,32,33 |
| site.visit | 1,8,9,10,11,12,13,28,29 | 30,31,32,33 |
| tag.add | 8,9,10,11,12,13,28 | 1,29,30,31,32,33 |
| vote.create | 1,8,9,10,11,12,13,28 | 29,30,31,32,33 |
| vote.participate | 1,8,9,10,11,12,13,28,29 | 30,31,32,33 |
| vote.view | 10,13,29 | 1,8,9,11,12,28,30,31,32,33 |

- 用户角色：隐式角色（会员/游客）不落行 0；已过期丢弃 0；用户已不存在 0

## 站点设置

积分显示名设为「青翼币」；注册模式保持默认（邀请制）。
