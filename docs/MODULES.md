# 模块内核契约（M2 定稿）

> 内核位置：`apps/web/src/modules/kernel/`。模块唯一入口：`apps/web/src/modules/index.ts`。
> 原则：**扩展事件/槽位清单 = 修改 kernel/types.ts 并在本文件说明**——模块不得私设插入点。
> 语义承接旧 phpwind：钩子点=领域操作（after_login/after_post/after_reply），新内核 = 领域事件 + 页面解剖槽位。

## 定义模块

```ts
import { defineModule } from "@/modules/kernel/types";

export const myModule = defineModule({
  id: "my-module",            // 全局唯一 kebab-case；重复注册启动即抛错
  description: "…",
  events: { "thread.created": async (p) => { /* p.threadId 类型安全 */ } },
  slots: { "home.footer-notice": (ctx) => <div>…</div> },
  permissions: [{ key: "checkin.do", description: "…" }],  // M5 消费
  nav: [{ id: "my", label: "我的", href: "/my", order: 10 }], // M10 消费
  cron: [{ name: "my-daily", schedule: "0 3 * * *", run: async () => {} }], // M13 消费
  schemaFragments: [myTable], // M7 起消费（表仍需登记进 @funwind/db 单一事实源）
  tokenOverrides: { "--accent": "var(--fw-teal-500)" },
  routePrefix: "/my",         // 约定：自有页面放 src/app/(module-my)/…
});
```

清单注册（`modules/index.ts`）：`const MODULES = [demoCheckin, …]; for (…) registerModule(m); sealRegistry();`
—— **启用/停用运行中模块 = `pnpm --filter @funwind/web modules:toggle <id> <on|off>`**（module_state 表；
M9 后由管理后台管理）。

## 事件清单（10 个，定稿）

| 事件 | payload | 首个派发者 |
|------|---------|-----------|
| `user.logged_in` | `{ userId }` | M4 认证（承接旧 after_login） |
| `user.registered` | `{ userId }` | M4 注册 |
| `thread.created` | `{ threadId, forumId, authorId }` | M6 发帖（承接旧 after_post） |
| `thread.replied` | `{ threadId, postId, authorId }` | M6 回帖（承接旧 after_reply） |
| `thread.edited` | `{ threadId, editorId }` | M6 编辑 |
| `thread.deleted` | `{ threadId, operatorId }` | M6 删除 |
| `attachment.uploaded` | `{ attachmentId, uploaderId }` | M6 上传 |
| `credit.changed` | `{ userId, creditType, delta }` | M7 credits |
| `medal.awarded` | `{ userId, medalId }` | M7 medals |
| `checkin.done` | `{ userId, streak }` | M7 checkin |

## 槽位清单（M2 启用 home.*；页面级随 M3 扩充）

| 槽位 | 宿主页面 | 状态 |
|------|----------|------|
| `home.after-header` | 首页 header 之后 | ✅ M2 |
| `home.footer-notice` | 首页 footer 之前 | ✅ M2 |
| `thread.sidebar` / `thread.after-content` | 帖子详情 | 预留（M3） |
| `forum.header` | 版块页 | 预留（M3） |
| `profile.tab` | 个人资料页 | 预留（M4+） |
| `nav.right` | 顶部导航右侧 | 预留（M3） |

## 语义与边界

1. **派发顺序**：单事件内按模块注册序；跨模块全局顺序不做。
2. **隔离**：消费者抛错→记入该事件 `event_log.error_json`，后续消费者照常，业务主流程不受影响；
   Slot 渲染失败→该模块跳过，宿主页不受影响。
3. **审计**：每次 emit 落 `event_log`（payload/actor/source/错误摘要）；落库失败仅降级告警。
4. **装卸**：注册（编译期，改 modules/index.ts）与启用（运行期，module_state）分离；禁用模块不渲染不消费，注册信息保留。
5. **注册表封板**：modules/index.ts 求值完毕即封板，运行时注册抛错（无热插拔）。
6. **API 路由与页面是两棵模块图**：任何使用内核的 route handler 必须自行 `import "@/modules"`。

## 消费者实现清单

| 消费者 | 状态 |
|--------|------|
| demo-checkin（演示：user.logged_in 消费 + home.footer-notice 横幅） | ✅ M2（M7 由真实签到替换） |
| credits / levels / medals / checkin 真实模块 | M7 |
| 权限点汇聚 → authz | M5 |
| 导航汇聚 → 站点框架 | M10 |
| cron 调度 → 基建 | M13 |
