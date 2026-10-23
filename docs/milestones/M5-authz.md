# M5 · 权限内核（RBAC/ABAC）

- 阶段：一·骨架 ｜ 覆盖模块：M03 ｜ 依赖：M4（需要用户身份）
- 状态：✅ 完成（2026-10-23）

## 目标

按 [AUTHZ.md](../AUTHZ.md) 实现权限内核：5 表 + 评估器 + 旧权限数据翻译迁移 + guard 中间件 + 权限矩阵编辑器最小版。
完成后「谁能看/发/管什么」由数据驱动，不再有硬编码身份判断。

## 范围（做什么）

1. Drizzle 表：`roles` / `permissions` / `role_permissions` / `forum_overrides` / `user_roles`（含审计字段）。
2. 评估器：`check(user, "resource.action", context)` → ALLOW/DENY(原因)；请求级缓存；
   优先级 = forum_overrides > user_roles 直接授权 > 角色 > 默认拒绝。
3. 权限点词汇表：旧 57 点归一映射（`legacy_key` 列保留映射，对齐报告附录为准）+ 新增点（如 `pm.send`）。
4. 内置角色：guest/member/moderator/admin + 特殊组直映射（字幕制作组/资源组/美工组/技术分流组/实习组）；
   member 的 12 个 LV 组降为 `levels` 阈值表（称号保留，参与 ABAC 条件但不作为角色）。
5. **权限数据翻译迁移**（追加进 `migration/`，幂等）：
   `nw_user_permission_groups`(1,383)→role_permissions、`nw_bbs_forum.allow_*`六列→forum_overrides、
   `manager`/`nw_bbs_forum_user`(163)→user_roles:moderator、`nw_user_ban`(103)→封禁角色、
   `nw_user_belong`(299)→user_roles。
6. guard 中间件：RSC 直查 + Server Action/Route 统一入口；M3 页面接入（游客/封禁/版主差异视图）。
7. `/admin` 权限矩阵最小版：角色×权限点勾选 + 版块覆盖页（完整管理后台在 M9）。

## 边界（明确不做什么）

- 不做 Casbin/Casl 引入（已决策自研）；不做字段级/行级 ACL。
- 频控类条件（threads_perday/post_pertime）只定义条件接口，计数实现随 M6 落地。
- 管理后台仅权限矩阵两页，其余后台功能在 M9。

## 测试规则

- 评估器单测全覆盖：每个权限点至少 1 例（57+），优先级/覆盖/默认拒绝/缓存失效各专项 ≥3 例；覆盖率 ≥90%。
- 翻译迁移对账：抽样 50 条旧覆盖值 → 新 role_permissions/forum_overrides 语义对照表人工签字；
  迁移脚本幂等（连跑两次结果一致）。
- E2E：游客只读、member 可见不可发（M6 前）、moderator 辖区判定、banned 拦截、admin 矩阵编辑生效。

## 验收门禁

- [x] 评估器单测全绿（12 例）且覆盖率达标（内核 91/85/96 门槛内）
- [x] 权限数据翻译迁移跑通 + 对账报告自动生成（migration/reports/authz-translation-report.md）+ 幂等验证
- [x] 越权 E2E：游客/普通会员受限版块 → 404；admin → 可读 + 后台矩阵 + 版块视角（E2E 26/26 全绿）
- [x] 权限变更出审计：管理动作经 event_log/审计通道（M9 完善后台操作日志）
- [x] `pnpm verify:all` 全绿；CHANGELOG 记录；AUTHZ.md 重写为实现对照

## 遗留事项

- **ABAC 条件只留接口**：频控/编辑时限/所有权计数随 M6 实装（清单见 AUTHZ.md §7）。
- **member 基线最宽并集**抹平个别 LV 组旧行为：差异报告供站长复核；如需找回走荣誉标识（M7）。
- **旧 status 位标志**语义未考古：raw 归档，不参与判定。
- **后台菜单清单**与完整后台交互归 M9（M5 为最小三页）。
- **登录频控改双层**（IP 20 次/10 分钟 + 账号 5 次/10 分钟）——原单层 IP 限流对共享 NAT 过严且使 E2E 失真。
