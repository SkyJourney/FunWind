# M9 · 管理后台与站点框架

- 阶段：三·完善 ｜ 覆盖模块：M10 / M11 / M13 ｜ 依赖：M5.5（`audit_log`、`user_restrictions`、`ForumTree`）+ M7/M8
- 状态：🚧 2026-10-26 开工

> **开工拍板（2026-10-26 站长，探查后）**：
> 1. **approve 补发事件**（内核契约 `types.ts` 注释的兑现）：审核通过时除 `content.moderated(approve)` 外
>    补发 `thread.created` / `thread.replied`（pending 路径此前只发过 `content.submitted`——积分奖励据此到位；
>    幂等键 `thread:{id}` 兜底，无双发窗口）。
> 2. **举报幂等口径**：`reports` 唯一键 `(post_id, reporter_id)`——同一用户对同一帖只可举报一次，
>    重复提交提示「已举报」；处理后的新违规走新帖。
> 3. **通知 dedup 幂等**（M8 审查挂账兑现）：`notifications.dedup_key` 可空唯一列，非聚合通知携带
>    dedupKey 后 at-least-once 重放不再重复入行；聚合类型（review.pending）不适用 dedup，接受重放
>    count 虚增 1 的极小概率（爆炸半径=铃铛数字），留档。
> 4. **回收站**：`admin.recycle` 权限点启用为审核页的「已删隐内容」tab（恢复复用既有 restorePost），
>    不做独立页面。
> 5. **公告管理权限**：用 `site.admin` 总门（唯一管理员操作，不新增权限点；M10 站点框架细化时再议）。

## 目标

运营能力：`/admin` 管理后台（审核/用户/权限/日志/举报）+ 站点框架配置（公告/导航/友链）。
完成后社区可自治运转，不再依赖开发者操作数据库。

## 范围（做什么）

1. `/admin` shell：侧边导航、高密度令牌、admin/moderator 视角差异（权限复用 M5；菜单可见性由权限集派生，不建菜单权限表）。
2. **内容审核**（状态机见 [DESIGN-MODEL.md](../DESIGN-MODEL.md) §4）：版块 `review_policy` 配置；**审核队列**（`pending` 内容：通过 / 驳回并附理由，写 `content_reviews` 与 `audit_log`）；
   版主删除/屏蔽/恢复（`hidden`/`deleted`）；作者对 `rejected` 内容修改后重新提交。每次状态变化发 `content.moderated` 事件，
   生成通知（`content.approved|rejected|removed|hidden|restored`，及版主侧聚合的 `review.pending`）。
3. **举报队列**（`reports`，新表）：前台举报入口 + 处理（忽略/处理/附处理说明）+ 通知举报人；旧举报数据（2 行）不迁。
   > `reports` 为 M9 新增表，不在 v2.1 的 43 张之内，随 M9 增量迁移加入。
4. **用户管理**：搜索/详情（积分台账/徽章/登录记录）、限制管理（`user_restrictions`：封禁/禁言/禁头像，带起止时间与理由）、
   角色调整（写 `user_roles` 并审计）、重复邮箱人工处理清单（M5.5 报告遗留）。
   限制与角色变更发 `restriction.changed` / `role.changed` 事件，当事人收到 `account.restricted` / `account.restriction_lifted` / `account.role_changed` 通知（强制类型，带理由）。
5. **公告管理**（`announcements` / `announcement_reads`，见 [NOTIFICATIONS.md](../NOTIFICATIONS.md)）：创建/编辑/下线公告，级别、受众、生效时段、是否横幅；发布发 `announcement.published`。旧 10 条已全部过期，不迁，手工重写。
6. **站点框架**（`site_settings` JSON 配置，**不建独立导航/友链表**）：
   导航项（旧 30 条含死链，手工整理为种子）、友链（旧 8 条通过审核，人工复核）、页脚配置。
7. **审计日志中心**：`audit_log` + `event_log` 统一查询页（筛选/导出 CSV）；旧 `nw_log` 不迁。
8. **积分管理**：规则配置（发帖/回帖/签到数值与日上限）、手工调整入口（M7 能力的后台页）。
9. 数据看板（轻量）：注册/发帖/活跃趋势（SQL 聚合 + 简单图表，不引重库）。

## 边界（明确不做什么）

- 不做主题可视化装修器（M11 方案是令牌主题包，旧 `nw_design_*` 明确不复活）。
- 不做多管理员细粒度后台权限拆分（admin/moderator 两级起步）。
- 图表不引入重型 BI 库。

## 测试规则

- E2E 越权矩阵：moderator 访问全站管理页 → 403/404；moderator 仅能操作所辖版块内容；非登录访问 → 登录跳转。
- 审核流 E2E：版块开启审核→新帖 `pending`（仅作者/版主可见）→驳回带理由→作者收到通知并可编辑重提→通过→公开可见；删除/屏蔽→恢复。
- 审计完整性：任何后台操作后 `audit_log` 新增一条（断言性 E2E 覆盖每类操作）。

## 验收门禁

- [x] 越权矩阵 E2E 全绿（moderation-review.spec：版主仅所辖版块/会员 404/游客跳登录）；后台全部操作出审计（review/reports/restrictions/roles/announcements 各服务同事务 writeAudit，int 断言）
- [x] 内容状态机（visible/pending/rejected/hidden/deleted）E2E 全绿（审核流全链路：pending 仅作者版主可见→驳回带理由→重提→通过→公开+积分入账；屏蔽→恢复），状态变化均触发对应通知与审计
- [x] 站点框架改动即时生效（site-chrome TTL 缓存 + invalidate，int 断言「绕过 invalidate 读旧值/invalidate 后读新值」）
- [x] 移动端管理可用性手工清单（审核与封禁两操作 375px 走查：表单为原生控件、按钮触控目标 ≥ 尺寸规范；后台导航横向滚动）
- [x] `pnpm verify:all` 与 `pnpm test:e2e` 全绿；CHANGELOG 记录
  （实测 2026-10-26：verify:all = content 55 + db 66 + web 1321 + migration 251；test:e2e = 桌面/移动 175 + 生产冒烟 10）

## 阶段推进（S1–S9）✅ 全部完成（2026-10-26）

## 遗留事项

（无）
