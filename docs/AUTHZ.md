# 权限模型（AUTHZ）· 实现对照

> ⚠️ **M5.5 修订（2026-10-23）**：§1–§7 描述 M5 已交付的实现（v1）；复验发现其存在结构性缺陷，目标态见文末 **§8（v2）**。
> 与 §8 冲突处以 §8 为准：`scope_type` → `scope_id` 哨兵、内置角色去掉 `muted`、版块可见性改 `read_policy`、版主改由 `forum.moderate` 派生、封禁/禁言并入 `user_restrictions`。
> v2.1（设计先行）再做微调：权限表去掉 `legacy_key`/`condition_params`，团队角色改为站点数据，新增版块 `review_policy`，见 §8.2/§8.3/§8.4。

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

> M5 的旧签名 `check(userId, …)`（实际忽略 userId）已在 M5.5 S4-2 废弃；以下为 v2 实现。完整判定顺序见 §8.3。

```
checkPermission(subject, "resource.action", { forumId? }) → { allowed, reason }
  subject = loadSubject(userId) | getCurrentSubject()     // 显式传入，评估器不读“当前请求用户”
```

| 模块 | 职责 |
|------|------|
| `lib/forums/forum-tree.ts` | 纯类：祖先链、子树、沿链取最近非 inherit 的 `read/write/review` 策略（零 SQL） |
| `authz/types.ts` · `evaluator.ts` | 纯函数 `evaluate(subject, key, ctx, snapshot)`；`contentVisibleTo`；`readableForumIds` / `moderatedForumIds` |
| `authz/snapshot.ts` | 版块树 + 全部 `role_grants` 常驻内存（globalThis 单例，30s TTL 兜底，管理动作后 `invalidateAuthzSnapshot()`） |
| `authz/subject.ts` | `loadSubject`：登录用户隐含 `member@0`，过滤过期角色绑定与未生效/已结束的限制 |
| `authz/service.ts` | `checkPermission` / `requirePermission`（抛 `ForbiddenError`）/ `can` / `getForumModerators` |
| `authz/admin.ts` | 授权写操作：校验 + 同事务写 `audit_log` + 失效快照；`AdminError` 消息可直接展示 |

实现约定（S4-2 定稿）：

- **写类权限集合**（禁言/封禁与“开放注册未验证邮箱”拦的就是这一类）：`forum.write`、`thread.replyLocked`、`gate.points`、`gate.reply`、
  `attachment.upload`、`vote.create`、`pm.send`、`tag.add`、`tag.edit`、`tag.manage`。`forum.report`、`vote.participate`、`vote.view` 不拦。
  词汇表每个键都必须显式归入写类或非写类，单测校验完备性（新增权限点漏分类会红）。
- **作用域语义**：`user_roles.scope_id` 与 `role_grants.scope_id` 同义——0 全局，>0 只在该版块子树内生效；评估器只有一种“链上命中”。
- **`restricted` 的授权只认版块作用域**（全局基线不算）；授权可来自目标版块或其祖先；更高级别隐含低级别（moderate ⊃ write ⊃ read）。
- **写之前先过读**：`forum.write` 先通过 `forum.read` 判定。
- **封禁语义**：生效中的全站 `ban` 使会话失效、禁止登录（登录页显示理由与期限）；评估器对 ban 同样拦写类，作为纵深防御。
- **邮箱未验证**只在 `register.mode = open` 时拦写类；邮件令牌（reset/claim/verify）被成功消费即记 `email_verified_at`，
  因此已认领的迁移用户切到开放注册后不会被拦。
- **版主**：`getForumModerators` 列出链上持有 `forum.moderate` 授权的**非 admin** 角色的持有人（admin 的全局基线授权不算“版主”）。
- **管理护栏**：不得把 `forum.moderate`/`site.admin`/`admin.*`/`user.viewIp` 全局授予 `guest`/`member`；admin 的 `site.admin`/`admin.roles` 不可撤销；
  `createCustomRole` 只 insert，同名（含内置）拒绝；内置角色不可删；`guest`/`member` 不可绑定到用户。
- **客户端 IP**（审计、频控）：`lib/net/client-ip.ts` 按 `TRUSTED_PROXY_HOPS` 取 X-Forwarded-For 从右数第 N 项；取不到可信 IP 返回 `null`，调用方**跳过 IP 级限额**、只留账号级/邮箱级限额（共享桶会被攻击者占满，反成全站登录的拒绝服务）。生产环境未显式设置该变量会直接报错。

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

## 8. v2 修订（M5.5，目标态）

### 8.1 为什么改（M5 复验发现）

| 缺陷 | 证据 | v2 对策 |
|------|------|---------|
| 全局授权行无法去重 | 唯一键含可空 `forum_id`；`user_roles` 1255 行仅 251 组不同，`role_grants` 2874 对 2035 | `scope_id INT NOT NULL DEFAULT 0`（0 = 全局，> 0 = 版块 id），删 `scope_type` |
| 「显式限制」靠推断 | 评估器以「该层是否有授权行」判断受限；删光读授权，受限版块悄悄变公开 | `forums.read_policy` 一等属性 |
| 派生版主错误 | 派生用 `forum.write`/`forum.manage`，而翻译产物每版块只有 `forum.write`（发帖白名单），整个团队角色被派生成版主 | 独立权限点 `forum.moderate`，版主 = 作用域链上持有它的角色的持有人 |
| 禁言三处并存 | `muted` 角色、`user_bans`、旧 status 位 | 并入 `user_restrictions`，评估器只读一处 |
| 评估入口隐式读当前用户 | `checkPermission(userId, …)` 忽略 `userId` | 显式 `subject`；`can()` 作为当前用户封装 |
| 脏键 | `role_grants` 含角色 `a`/`x`、权限点 `p1`/`p2`/`y` | 迁移 v2 对账零容忍断言；`role_key`/`permission_key` 外键式校验 |
| 无审计 | `/admin` 动作不写任何日志 | 所有管理动作写 `audit_log`（谁/何时/动作/对象/前后值） |

### 8.2 数据模型（v2）

| 表 | 语义 |
|----|------|
| `roles` | `key` / `name` / `kind(builtin\|custom)`；内置仅 `guest` / `member` / `admin`。**团队角色（如青翼的字幕制作组）是站点数据**，由管理员创建，不随零数据安装下发 |
| `permissions` | 词汇表：`key` / `resource` / `level` / `description`。**不含任何旧站字段**（v2.1 去掉 `legacy_key`、`condition_params`）；ABAC 参数到 M6 实现频控/编辑时限时按真实需求设计 |
| `role_grants` | `(role_key, permission_key, scope_id)` 唯一；`scope_id=0` 全局 |
| `user_roles` | `(user_id, role_key, scope_id)` 唯一；`expires_at` 可空（NULL 不进唯一键） |
| `user_restrictions` | `kind(ban\|mute\|no_avatar\|no_signature…)` / `user_id` / `scope_id`（0 全站）/ `starts_at` / `ends_at`（NULL 永久）/ `reason` / `created_by` |
| `forums.read_policy` | `inherit`（取最近非 inherit 祖先；全无则公开）\|`public`\|`members`\|`restricted` |
| `forums.review_policy` | `inherit`（取最近非 inherit 祖先；全无则 none）\|`none`\|`threads`（新主题需审核）\|`all`（所有发帖需审核）。持有 `forum.moderate` 者发帖免审 |
| `forums.write_policy` | `inherit`（取最近非 inherit 祖先；全无则 members）\|`members`\|`restricted`（须在该版块作用域持有 `forum.write` 授权，全局基线不算）。旧站「只有团队组能发帖」的 6 个版块即此类，也满足将来「只读公告版」需求 |
| `audit_log` | `id` / `actor_id` / `action` / `target_type` / `target_id` / `before` / `after` / `ip` / `created_at` |

词汇表变化：`thread.sell` → `gate.points`、`thread.hide` → `gate.reply`；新增 `forum.moderate`；
`forum.manage` 并入 `forum.moderate`（`forum.write` 仅表示「可发帖/回帖/编辑自己的帖」）。

### 8.3 评估顺序（v2）

```
check(subject, "resource.action", { forumId? })
  1. admin 角色 → ALLOW
  2. 有效 user_restrictions（作用域覆盖该 forumId）与写类权限冲突 → DENY（优先于授权）
  3. 开放注册模式且邮箱未验证 → 写类权限 DENY
  4. forum.read：沿 ForumTree 祖先链找最近的非 inherit read_policy
       public → ALLOW；members → 已登录即 ALLOW；restricted → 须持有该版块作用域的 forum.read 授权
       全链 inherit → ALLOW（公开）
  5. forum.write：沿 ForumTree 找最近的非 inherit write_policy
       restricted → 须持有该版块（或祖先版块）作用域的 forum.write 授权（全局基线不算）
       members / 全链 inherit → 登录用户凭全局 forum.write 即可
     forum.moderate / 其它：沿作用域链级联合并（任一层命中即 ALLOW）；全局授权作基线
  6. 默认拒绝
```

**发帖时的审核分流**（评估通过 `forum.write` 之后）：沿 ForumTree 取最近的非 inherit `review_policy`；
`threads` 且为新主题、或 `all` → 内容以 `pending` 状态入库（持有 `forum.moderate` 者直接 `visible`）。
内容状态机与可见性矩阵见 [DESIGN-MODEL.md](DESIGN-MODEL.md) §4。

作用域链来自内存树 `ForumTree`（`path` 切分），评估器零 SQL 取链。

### 8.4 旧数据翻译（v2；v2.1 起该映射表只存在于 `migration/src/mapping/`，运行时不认识）

| 旧 | 新 |
|----|----|
| `nw_bbs_forum.allow_read` 白名单 | 含游客组 → `public`；含任一会员组 → `members`；否则 `restricted` + 逐团队角色 `forum.read` 作用域授权（admin 短路，不落行）。实测 43 版块：public 37 / restricted 6 |
| `allow_post` ∪ `allow_reply` 白名单 | 含任一会员组 → `inherit`；否则 `write_policy=restricted` + 逐团队角色 `forum.write` 作用域授权。**实测「只有团队能发帖」的 6 个版块与 restricted 读版块是同一批** |
| 旧 `operate_thread`（版主操作） | **不翻译**：对普通会员组只是设置数组（`up_time`/`topped_type`），不是开关；翻译会让全体会员获得版主权（迁移 v2 开发期曾踩到，已加翻译器白名单与对账护栏） |
| `allow_upload` / `allow_download` 白名单 | `attachment.upload` / `attachment.download` 逐角色版块授权 |
| `allow_visit` | 并入 `read_policy`（不再单列 `site.visit` 版块授权） |
| `nw_user_ban` + 禁止发言组(6) + `nw_user_belong` 中的禁言 | `user_restrictions` |
| `nw_user_belong` / 主组 → 团队角色 | `user_roles`（`scope_id=0`）；已删除组成员不恢复 |
| 旧 `forum.manager` 名单（仅 1 个版块有值） | 不迁移（派生制取代，名单仅入报告） |
| 版主授权 | 新建 `forum.moderate` 授权由站长在后台按需配置；迁移期不凭空派生版主 |

### 8.5 测试（v2）

词汇表每个权限点至少 1 例；`read_policy` 四取值各 ≥ 3 例；级联合并、就近层、restriction 优先、未验证邮箱各 ≥ 3 例；
迁移后权限抽样 50 条人工对照（`docs/reports/` 留档）；覆盖率含服务层（DB 集成测试）。
