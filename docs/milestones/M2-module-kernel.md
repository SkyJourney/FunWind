# M2 · 模块注册表内核

- 阶段：一·骨架 ｜ 覆盖模块：插件化插入点（蓝图 §8）｜ 依赖：M1
- 状态：✅ 完成（2026-10-23）

## 目标

实现 `defineModule` 内核：编译期注册的功能模块机制（事件总线 + UI 槽位 + 权限点/导航/令牌覆盖/路由/表结构注册），
并交付一个演示模块验证装卸闭环。这是全项目「即插即用」的地基，先于一切业务功能。

## 范围（做什么）

1. `src/modules/registry.ts`：`defineModule()` 类型与注册表；模块清单唯一入口 `modules/index.ts`。
2. 事件总线：类型化领域事件（`thread.created/replied/edited/deleted`、`user.registered/logged_in` 等），
   同步派发 + 事件审计落表（`event_log`），消费失败不阻塞主流程（隔离）。
3. UI 槽位：`<Slot name="thread.sidebar" />` 服务端渲染机制，槽位清单文档化
   （帖子页·侧栏/底部、版块页·头/侧、首页区块位、导航·右侧、个人资料·页签）。
4. 注册边界接口（本期空实现即可）：权限点注册、导航项注册、令牌覆盖、路由前缀、cron 任务、Drizzle schema 片段。
5. 演示模块 `modules/demo-checkin/`：监听 `user.logged_in` → 槽位渲染一条横幅——仅用于内核验收，M7 会被真实签到模块替换。

## 边界（明确不做什么）

- 不做运行时热插拔/插件市场（phpwind 式运行时注入明确不做）。
- 不实现任何真实业务模块（credits/checkin 等属于 M7）。
- 事件总线不做跨进程/消息队列（单体内同步总线；异步化留到有真实需求时）。

## 测试规则

- 内核单测 ≥90% 行覆盖：注册唯一性、事件派发顺序、消费者抛错隔离、槽位合并规则。
- Playwright：demo 模块启用→登录（假会话）→横幅出现；禁用→横幅消失（装卸不影响内核）。

## 验收门禁

- [x] 内核单测覆盖率达标（内核 95/97/95，全局 18+18 用例全过）
- [x] demo 模块装卸 E2E 通过（启用+事件→横幅出现；禁用→横幅消失、宿主页正常）
- [x] 槽位与事件清单写入文档：`docs/MODULES.md`（扩清单需改内核并在该文件说明）
- [x] `pnpm verify:all` 全绿；CHANGELOG 记录

## 遗留事项

- **Next 16.4.2 `title.template` 未生效**（M1 遗留，仍观察）。
- **API 路由双模块图**：route handler 必须自行 `import "@/modules"`（已文档化；M3 起新路由注意）。
- **Slot 动态渲染**：挂 Slot 的页面为动态渲染（force-dynamic），缓存策略随 M3 建页统一定。
- **modules:toggle CLI** 与 dev API 为 M9 前过渡，管理后台页面在 M9 交付。
