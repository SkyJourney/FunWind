# FunWind 路线图

> 里程碑制推进：先骨架后功能，预留插入点，逐模块完善。
> 模块编号（M01–M15）见 [LEGACY-FEATURE-MAP.md](LEGACY-FEATURE-MAP.md)；里程碑编号（M1–M13）见本文与 `docs/milestones/`。
> 状态：✅ 完成 · 🚧 进行中 · ⬜ 未开始

## 已完成的前置工作（里程碑制之前）

- ✅ **P0 数据迁移**：新库 schema + 幂等迁移程序（11 实体 ≈16.7 万行）+ 23 项验证全通过（2026-10-23）
- ✅ 旧源码研读与功能对齐报告（M01–M15）、前端/权限/插件化方案定稿

## 里程碑总览

| 里程碑 | 名称 | 覆盖模块 | 阶段 | 状态 |
|--------|------|----------|------|------|
| [M1](milestones/M1-infra-scaffold.md) | 工程骨架与基础设施 | — | 一·骨架 | ✅ 2026-10-23 |
| [M2](milestones/M2-module-kernel.md) | 模块注册表内核 | 插入点 | 一·骨架 | ✅ 2026-10-23 |
| [M3](milestones/M3-content-readonly.md) | 内容只读渲染 | M01/M04 | 一·骨架 | ✅ 2026-10-23 |
| [M4](milestones/M4-users-auth.md) | 用户与认证 | M02 | 一·骨架 | ✅ 2026-10-23 |
| [M5](milestones/M5-authz.md) | 权限内核（RBAC/ABAC） | M03 | 一·骨架 | ⬜ |
| [M6](milestones/M6-posting.md) | 发帖与内容生产 | M01 交互层 | 二·核心 | ⬜ |
| [M7](milestones/M7-gamification.md) | 游戏化（积分/等级/勋章/签到） | M07 | 二·核心 | ⬜ |
| [M8](milestones/M8-interact-search.md) | 互动套件与检索 | M05/M06 | 二·核心 | ⬜ |
| [M9](milestones/M9-admin.md) | 管理后台与站点框架 | M10/M11/M13 | 三·完善 | ⬜ |
| [M10](milestones/M10-poll-pm.md) | 投票与私信 | M08/M09 | 三·完善 | ⬜ |
| [M11](milestones/M11-themes-pwa.md) | 主题包与 PWA | M12 | 三·完善 | ⬜ |
| [M12](milestones/M12-install-wizard.md) | 安装向导与零数据部署 | 数据层基建 | 三·完善 | ⬜ |
| [M13](milestones/M13-launch.md) | 部署与社区重启 | P4 | 三·上线 | ⬜ |

依赖关系：

```
M1 ─ M2 ─ M3 ─ M6 ─ M7 ─ M8 ── M9 ─────┐
        └── M4 ─ M5 ──┘  └ M10 ─ M12 ──┴─ M13
             └──────────── M11（可并行）
```

> M12（安装向导）依赖 M4 + M10；M13（部署上线）依赖 M9 + M12。
> **数据层双模式**是全程约束：schema 单一事实源在应用侧（Drizzle），零数据 bootstrap 是默认路径，
> `migration/`（青翼导入器）只在可选导入场景运行——M13 上线演练必须包含一次完整的青翼迁移跑通。

## 阶段划分

- **阶段一·骨架（M1–M5）**：工程基线 + 模块内核 + 数据只读可见 + 账号体系 + 权限内核。完成标志：一个游客能在真数据上浏览论坛，登录与权限链路贯通。
- **阶段二·核心（M6–M8）**：能发帖、能互动、能检索，游戏化作为模块注册表的第一个真实消费者。完成标志：功能闭环可内测。
- **阶段三·完善与上线（M9–M13）**：管理后台、外围功能、主题包/PWA、安装向导与零数据部署、生产部署与老用户召回。完成标志：社区重启。

---

## 全局测试基线（每个里程碑的门禁都以此为下限）

| 层 | 工具 | 要求 |
|----|------|------|
| 静态检查 | ESLint + tsc `--noEmit` + Prettier | 0 error，0 warning 入库 |
| 单元测试 | Vitest | 纯逻辑模块（转换器/评估器/引擎/工具）行覆盖 ≥90%、分支 ≥85% |
| 组件测试 | Testing Library | 交互组件（编辑器/矩阵编辑/投票）必须有用例 |
| 集成/E2E | Playwright | 每里程碑至少覆盖其声明的「核心用户路径」 |
| 数据/迁移脚本 | 对账思路（同 `migration/src/verify.ts`） | 幂等性：连跑两次结果一致；迁移前后计数/抽样校验 |
| 手工验收 | 里程碑 checklist | 移动端视口（375px）过一遍核心路径 |

**全局门禁（合并前必须全绿）**：lint ✓ tsc ✓ 单测 ✓ 组件/E2E ✓ build ✓ 覆盖率达标 ✓ CHANGELOG 已更新 ✓ 里程碑文档 checklist 全勾 ✓

**性能预算（本地基准）**：帖子列表/详情 LCP < 2.5s（M3 起生效）；接口 p95 < 300ms（M6 起）。

**安全基线（M4 起）**：密码 argon2id；会话 Cookie `HttpOnly+Secure+SameSite=Lax`；`content_md` 渲染必经净化（白名单标签）；一切变更操作出审计日志（M5 起）。

## 完成定义（DoD，适用于所有里程碑）

1. 里程碑文档「验收门禁」逐项可勾且全部通过；
2. 自动化测试随代码入库并在本地一键可跑（`npm test` / `npm run e2e`）；
3. CHANGELOG.md 新增条目；涉及架构决策的同步回写 BLUEPRINT/AUTHZ/FRONTEND-DESIGN；
4. 下一里程碑开工前，上一里程碑遗留事项记录在其文档「遗留事项」节。
