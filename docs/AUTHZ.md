# 权限体系现代化方案（✅ 已确认：自研轻量评估器；邀请制起步后开放）

> 旧模型考古（2012 年 phpwind 9）：
> ① 25 个用户组（gid）× **57 个权限点**（`nw_user_permission_groups`，gid+rkey → rvalue，1,383 行覆盖值）
> ② 版块级 ACL：`nw_bbs_forum.allow_visit/read/post/reply/upload/download` 六列存「允许的 gid 串」
> ③ 版主：`nw_bbs_forum.manager`（用户名串）+ nw_bbs_forum_user(163 行)
> ④ 升级机制：member 组按积分阈值自动迁移（points 列）
> 问题：权限点语义分散在代码里、无策略组合能力、"特殊权限组"本质是 gid 的补丁表。

## 1. 新模型：角色（RBAC）为骨、属性条件（ABAC）为肉

```
check(user, "forum.reply", { forum, thread }) → ALLOW | DENY(原因)
```

- **权限点 Permission**：`resource.action` 字符串。**直接继承旧 57 点词汇表**（改名归一：
  `panel_bbs_manage → forum.moderate` 等，建一张新旧映射表），一次审计到位。
- **角色 Role**：guest / member / veteran / moderator / admin + 特殊组直映射
  （字幕制作组/资源组/美工组/技术分流组/实习组 → 与旧 gid 一一对应，用户绑定关系已随 users.group_id 迁移）。
- **等级**：member 组不再膨胀成 12 个组（旧 LV1–LV12），改为 `level` 属性
  （由 credits 计算，阈值沿用旧 points 表——等级只影响展示与 ABAC 条件，不影响角色）。
- **ABAC 条件**（策略维度，均来自旧系统真实语义）：
  - `forum`：版块级覆盖（替代旧 allow_* 六列，细粒度到权限点）
  - `ownership`：作者本人可编辑（post.edit_time 时限沿用）
  - `credit-threshold`：积分/等级门槛（旧 readprivilege/threads_buy 语义）
  - `rate-limit`：threads_perday / post_pertime / post_url_num（旧反灌水三件套）
  - `content-state`：locked/digest/shield/spam 状态位参与判定

## 2. 存储（5 张表，MySQL 8.4）

```sql
roles             (id, key, name, is_system, builtin_flags)
permissions       (key, resource, action, description, legacy_key)
role_permissions  (role_id, permission_key, allowed)
forum_overrides   (forum_id, permission_key, allowed_gids JSON / denied_gids JSON)
user_roles        (user_id, role_id, granted_by, expires_at)   -- 兼容旧 nw_user_belong(299)
```

- 评估器（自研，~200 行）：请求时加载 `user → roles → 权限集`，再叠 `forum_overrides` 与条件；
  结果按请求缓存（React `cache()` / Redis）。**不用 Casbin**——模型就这五种关系，引库成本>收益（此点可议）。
- 中间件形态：Server Component 直查 + Server Action/Route Handler 入口统一 guard。

## 3. 旧数据迁移（追加进 migration/）

| 旧 | 新 |
|----|----|
| nw_user_groups 25 组 | roles（member 12 组→合并为 member + level 阈值表 levels） |
| nw_user_permission_groups 1,383 行 | role_permissions（经 57 点映射表翻译） |
| nw_bbs_forum.allow_* 六列 | forum_overrides |
| manager / nw_bbs_forum_user | user_roles: moderator + forum_overrides |
| nw_user_ban(103) | user_roles: banned（带过期） |

## 4. 管理后台（M11 的权限页）

- 组×权限点**矩阵编辑器**（勾选即改 role_permissions）
- 版块覆盖页：选版块 → 权限点 → 允许/拒绝的角色（可视化旧 allow_* 六列）
- 全部变更出审计日志（M13 log 模块）

## 5. 子决策状态

1. **评估器**：✅ 自研轻量（5 表 + ~200 行评估器），不引 Casbin/Casl。
2. **注册策略**：✅ 邀请制起步（老用户召回发放邀请码），稳定后切开放注册+邮箱验证+频控；**骨架期两套接口都留**（authz 注册边界里 `register.mode` 为配置项）。
3. **LV 组名称号**（魔狱原住民→圣魔王）：建议作为等级称号完整保留（社区记忆），未收到异议即按保留执行。
