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
  // —— 以下四类为 M5.5 新增边界（设计定稿，S4 落地到 kernel/types.ts）——
  pointChannels: [{ key: "earn.checkin", direction: "earn", label: "签到奖励" }], // 见 docs/POINTS.md
  gateConditions: [{ type: "login", kind: "derived", /* paramsSchema/check/prompt */ }], // 见 docs/GATES.md
  notificationTypes: [{ key: "badge.awarded", category: "account", aggregate: false, mandatory: false }], // 见 docs/NOTIFICATIONS.md
  notificationChannels: [{ key: "in_app", deliver: async (n, user) => {} }], // 当前仅站内；email/push 预留
  tokenOverrides: { "--accent": "var(--fw-teal-500)" },
  routePrefix: "/my",         // 约定：自有页面放 src/app/(module-my)/…
});
```

清单注册（`modules/index.ts`）：`const MODULES = [demoCheckin, …]; for (…) registerModule(m); sealRegistry();`
—— **启用/停用运行中模块 = `pnpm --filter @funwind/web modules:toggle <id> <on|off>`**（module_state 表；
M9 后由管理后台管理）。

## 事件清单（21 个，M5.5 v2.1 设计定稿）

> M5.5 把注册边界由六类扩为**十类**：新增 `pointChannels`（[POINTS.md](POINTS.md)）、`gateConditions`（[GATES.md](GATES.md)）、
> `notificationTypes`、`notificationChannels`（[NOTIFICATIONS.md](NOTIFICATIONS.md)）。
> **已落地**（M5.5 S4-5，`kernel/types.ts` 为准）：21 个事件与十类边界的类型、注册期校验、保留项均已实现。
> 当前有真实派发者的事件：`user.logged_in`、`user.registered`（认证 Server Action）、`role.changed`（授权管理）、`points.changed`（积分核心）、
> `gate.unlocked`（门控购买）；其余为契约，由各自里程碑接线。
> 注册期校验（启动即暴露，非法声明让应用起不来）：积分渠道键须形如 `earn.xxx / spend.xxx / adjust.xxx` 且方向与前缀一致、全站唯一、不得与内置渠道
> （`opening` / `spend.gate_unlock` / `earn.gate_sale`）冲突；门控条件类型全站唯一、不得与内置 `points` / `reply` 冲突、目前只开放 `derived`；
> 通知类型键为命名空间形态且全站唯一、分类限 `interaction|message|moderation|account`；通知渠道键唯一，`in_app` 为保留键。
> **启停语义**：模块被停用，它声明的积分渠道一律被 `applyPoints` 拒绝，它声明的门控条件按“未知条件”失败即封闭（门控锁定而不是放行）；内置项不随模块启停。
> 事件的一部分专为驱动通知而设：通知模块消费这些事件，解析接收人后写入（见 NOTIFICATIONS.md §4）。

| 事件 | payload | 首个派发者 |
|------|---------|-----------|
| `user.logged_in` | `{ userId }` | M4 认证 |
| `user.registered` | `{ userId }` | M4 注册 |
| `user.followed` | `{ userId, targetType, targetId }` | M8 关注 |
| `thread.created` | `{ threadId, forumId, authorId }` | M6 发帖 |
| `thread.replied` | `{ threadId, postId, authorId, replyToPostId? }` | M6 回帖 |
| `thread.edited` | `{ threadId, editorId }` | M6 编辑 |
| `thread.deleted` | `{ threadId, operatorId }` | M6 删除 |
| `thread.moderated` | `{ threadId, operatorId, action: lock\|unlock\|move\|feature\|pin, detail? }` | M9 版主操作 |
| `content.submitted` | `{ postId, authorId, forumId, pending }` | M6 提交（版块需审核时 `pending=true`） |
| `content.moderated` | `{ postId, operatorId, action: approve\|reject\|remove\|hide\|restore, reason? }` | M9 审核/版主操作 |
| `post.mentioned` | `{ postId, authorId, mentionedUserId }` | M6 保存时解析 @ |
| `reaction.added` | `{ userId, postId, kind }` | M8 点赞 |
| `message.sent` | `{ conversationId, messageId, senderId, recipientId }` | M10 私信 |
| `attachment.uploaded` | `{ attachmentId, fileId, uploaderId }` | M6 上传 |
| `restriction.changed` | `{ userId, kind, action: created\|lifted, operatorId, reason?, endsAt? }` | M9 限制管理 |
| `role.changed` | `{ userId, roleKey, scopeId, action: granted\|revoked, operatorId }` | M9 角色管理 |
| `announcement.published` | `{ announcementId, createdBy }` | M9 公告管理 |
| `points.changed` | `{ userId, channel, delta }` | M5.5 积分核心 `applyPoints` |
| `gate.unlocked` | `{ gateId, userId, authorId, price }` | M5.5 `unlockGate`（M6 交互） |
| `badge.awarded` | `{ userId, badgeId }` | M7 徽章（原 `medal.awarded`） |
| `checkin.done` | `{ userId, streak }` | M7 签到 |

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
   **actor 语义**：`event_log.actor_id` = 动作发起者，按事件映射 payload 字段
   （user.\* → userId；thread.created/replied → authorId；thread.edited → editorId；
   thread.deleted / thread.moderated / content.moderated / restriction.changed / role.changed → operatorId；
   content.submitted / post.mentioned → authorId；attachment.uploaded → uploaderId；
   announcement.published → createdBy；其余按 payload 的 userId / senderId）；
   调用方显式传 `deps.actorId` 时覆盖映射（如代操作场景）。
4. **装卸**：注册（编译期，改 modules/index.ts）与启用（运行期，module_state）分离；禁用模块不渲染不消费，注册信息保留。
5. **注册表封板**：modules/index.ts 求值完毕即封板，运行时注册抛错（无热插拔）。
6. **API 路由与页面是两棵模块图**：任何使用内核的 route handler **与 Server Action** 必须自行 `import "@/modules"`（凡传递引用会触及内核的代码都算；`modules-import-guard.test.ts` 静态分析守护，漏写直接变红）。
7. **外部入口校验**：emit 本身是类型安全的内部 API；任何**外部**入口（dev API、未来的表单/开放接口）
   必须先经 `validateEventPayload`（REQUIRED_PAYLOAD_KEYS）校验 payload 必填键再派发。

## 消费者实现清单

| 消费者 | 状态 |
|--------|------|
| demo-checkin（演示：user.logged_in 消费 + home.footer-notice 横幅） | ✅ M2（M7 由真实签到替换） |
| 积分规则 / 签到 / 荣誉徽章 真实模块（等级引擎已取消） | M7 |
| 权限点汇聚 → authz | M5 |
| 导航汇聚 → 站点框架 | M10 |
| cron 调度 → 基建 | M13 |
