# 权限模型（AUTHZ）· 实现对照

> M5 落地：现代 RBAC + 级联数据范围 + 分级权限。
> 设计取舍见 [LEGACY-FEATURE-MAP.md](LEGACY-FEATURE-MAP.md) 与 M5 里程碑文档。
> 旧系统语义（phpwind 9）考古：25 个用户组 × 57 个权限点 + 附加组补丁（`nw_user_belong` 299 行，带过期）
> + 版块 gid 白名单（`nw_bbs_forum.allow_*`，43 个版块全部配置）。旧运行时判定入口为用户 BO 的 `getPermission(key)`。

## 1. 三条核心决策（2026-10-23 站长定）

1. **不搬运旧结构，按现代模型重组**：旧「特殊组/等级组」在旧系统既是权限载体又是展示标识，职责混杂。
   新模型拆开——
   - **内置角色**（builtin，4 个）：`guest` / `member` / `muted`（禁言）/ `admin`，权限基线，不可删除；
   - **可分配角色**（custom）：管理员可任意创建（旧 6 个团队组由翻译生成）；
   - **纯展示标识**：旧 LV 魔界称号等 → 零权限语义，交给 M7「荣誉/称号」功能。
2. **用户等级/成长系统整体出局**：不再有 LV1–LV12 等级组与升级引擎；旧 LV 称号作为考古信息保留
   （翻译报告），展示由 M7 承接。**M7 范围随之调整**：保留 青翼币 / 勋章 / 签到，去掉等级引擎。
3. **版主是派生的，不是指派的**：旧站「板块设版主 + 查询联查」改为——
   版主 = 在该版块作用域（含父链级联）持有 `forum.write` / `forum.manage` 授权的用户，由查询派生；
   子版块自动继承父版块的授权与版主，旧 `forum.manager` 名单不迁移（导出至对账报告供核对）。

## 2. 数据模型（四表）

| 表 | 语义 |
|----|------|
| `roles` | 角色目录：`key` / `name` / `kind(builtin\|custom)` / `description` |
| `permissions` | 权限点：`key` / `resource` / `level(read\|write\|manage\|NULL)` / `legacy_key`（旧 57 键对照）/ `condition_params`（ABAC 参数） |
| `role_grants` | **角色获得权限的唯一通道**：`role_key` + `permission_key` + `scope_type(global\|forum)` + `forum_id` |
| `user_roles` | 用户→角色绑定：`user_id` + `role_key` + `scope_type` + `forum_id` + `expires_at`（可过期） |

**权限点两级形态**：
- **分级域**：`forum.read`（只读）→ `forum.write`（可编辑：发帖/回帖/编辑）→ `forum.manage`（可管理：置顶/加精/删除/审核）；
  级别隐含：持有 `manage` 即满足 `write`/`read`。
- **动作型**（无级别）：`thread.sell` / `thread.hide` / `attachment.upload` / `vote.create` / `pm.send` / `tag.add` /
  `site.admin`（后台总门）/ `admin.roles`（角色矩阵管理）… 共 37 点，逐一映射自旧 57 键。
- **数值型旧键**（`threads_perday` / `post_pertime` / `post_url_num` / `message_max_send` 等 18 个）
  → 转 **ABAC 条件参数**（`condition_params`），不是权限点；M6 实装计数。

## 3. 作用域与级联

- 作用域：`global` > `forum`（版块授权自动覆盖其子版块）。
- 解析链：目标版块 → 父 → … → 全局。
- **读权限 forum.read = 显式优先**：链上最近一「有该权限点配置」的版块层说了算，**不回退父级**。
  理由：旧站 `allow_read` 是每版块独立的显式白名单；若回退，父级的公开读会击穿子级受限版块
  （实证：fid 53「真·酱油无双」在 fid 98 父链上会被公开读打开）。
- **管理权限 forum.write / forum.manage = 级联合并**：任一层命中即生效——这正是「子版块自动带父版块版主」。
- 链上完全无配置 → 默认策略（读=游客可读；写=注册用户）。

## 4. 评估器（apps/web/src/lib/authz/）

```
check(userId, "resource.action", { forumId? }) → { allowed, reason }
  1. admin 内置角色 → 短路 ALLOW
  2. muted 生效 → 发帖类权限 DENY（优先于授权）
  3. 授权匹配（按角色键直查 role_grants —— 授权是角色属性，与谁绑定无关）
     · forum.read → 显式优先（就近层判定）
     · 其余 → 级联合并（任一层命中）
  4. 默认拒绝
```

- `getScopeChain(fid)`：作用域链解析（请求级缓存）。
- `getUserPermissionSet`：预加载 + React `cache()` 请求级缓存。
- `getForumModerators(fid)`：**派生版主**查询（授权角色 ∩ 角色持有人，含父链继承标注）。
- ABAC 条件接口已定义（ownership / 频控 / 积分门槛），**计数实现随 M6 落地**。

## 5. 后台与菜单权限

**后台不设平行权限体系**——复用同一套权限点与作用域解析：

| 关注点 | 机制 |
|--------|------|
| 能否进后台 | `site.admin`（admin 角色基线授予） |
| 菜单可见性 | 菜单声明其所需权限点，由用户权限集派生（**不建菜单权限表**） |
| 后台数据范围 | 版主仅见其授权辖区（与前台同一评估器，作用域链解析） |
| 角色矩阵管理 | `admin.roles`（新权限点，旧系统无对应键） |

`/admin` 最小实现（M9 完善为完整后台）：① 角色列表 + 自定义角色增删；② 单角色授权矩阵
（分级域三态 + 动作勾选 + 全局/版块作用域切换）；③ 版块视角（级联授权 + 派生版主列表）。

## 6. 翻译与对账

| 旧 | 新 | 规则 |
|----|----|------|
| `nw_user_groups`(25) | roles(10) | default→member、游客 2→guest、系统 3/4/5→admin、禁止发言 6→muted、special 6 组→custom 团队角色；**member LV 12 组→称号清单（不建 levels）** |
| `nw_user_permission_groups`(1383) | role_grants(global) | 经 `legacy_key` 映射；**member 十二组取最宽并集**（差异清单入报告）；旧 panel_* 的 PHP 序列化 rvalue 需识别为开启 |
| `nw_bbs_forum.allow_*`(43×6) | role_grants(forum) | 白名单 gid→角色逐格翻译；**forum 域权限不走全局授权**（否则击穿白名单），仅 admin 例外 |
| `forum.manager` | **不迁移** | 派生制取代；旧名单导出至报告供核对 |
| `nw_user_belong`(299) | user_roles | 团队角色/muted，过期时间保留（永久优先） |

对账报告：`migration/reports/authz-translation-report.md`（自动生成）——含未知 gid、未映射 rkey、
member 并集差异、gid3 allow_post=0 疑点、旧版主名单。

## 7. 已知边界与后续

- **ABAC 条件只留接口**：频控/编辑时限/所有权判定随 M6 实装（M6 清单：`threads_perday`、`post_pertime`、
  `post_url_num`、`post_modify_time`、`uploads_perday`）。
- **member 基线最宽并集**会抹平个别 LV 组的旧行为差异——差异报告供复核；如需找回，走荣誉标识（不进权限内核）。
- **旧 status 位标志**（51 人非零）语义未考古：仅 raw 归档，不参与判定。
- 后台菜单清单与完整后台交互归 M9。
