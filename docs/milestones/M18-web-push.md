# M18 · Web Push 推送渠道（立项版 · 未启动）

- 阶段：四·运营与演进 ｜ 依赖：M8（通知中心后端）、M11（PWA 底座）、M16.1（离线深化，SW 扩展的前置）
- 状态：⬜ **仅立项，未启动**（2026-11-12 站长拍板：「Web Push 独立立项，本专项只做离线深化」——
  M16.1 扫尾专项的前置探查判定推送为里程碑量级，故单独立项）。
  本文是立项事实底座与范围清单，**推进线未经计划模式批准**，未建分支、未动代码、未部署。
- 立项动因：M13 遗留明列「不做人机验证、Web Push（遗留事项，视重启后反馈立项）」
  （`docs/milestones/M13-launch.md:107`）。站内通知与邮件双渠道已实现，**推送是通知触达的最后一块**；
  公测期用户回流依赖「有新回复/私信时能被叫回来」，站内铃铛只在打开/聚焦时拉取（无实时推送）。

## 目标

1. **补齐第三条通知渠道**：在既有 in_app / email 之外落地 push，让用户离开站点后仍能收到关键通知。
2. **复用而非另起**：镜像邮件渠道的成熟模式（偏好查询、尽力而为发送、活跃抑制、频控、审计日志），
   不新建平行的通知体系。
3. **尊重用户选择与隐私**：推送必须显式 opt-in（浏览器权限 + 偏好开关双闸），可随时退订；
   不默认开启、不静默订阅。

## 1. 已核实事实（2026-11-12 M16.1 前置探查，全部 file:line 佐证）

| #   | 事实                                                                                                                                                                                                                                              | 影响                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| W1  | **DB 渠道枚举已含 push**：`NOTIFICATION_CHANNELS = ["in_app", "email", "push"]`（`packages/db/src/schema.ts:66-67`）；`notification_preferences.channel` 是该三值 mysqlEnum，主键 `(user_id, type, channel)`（:765-774）                            | **偏好表无需迁移**（重要好消息，省一次 schema 变更）       |
| W2  | **邮件渠道已成熟可镜像**：`lib/notifications/email.ts` —— 安全强制类走站点开关 `site_settings("email.security")`（:15-23）、场景类查偏好 `channel="email"` **无行=关**（:37-50）、尽力而为失败不反噬（:56-73）、私信频控 1 封/小时（:76-78）、30 分钟内活跃不发（:81-88）；每次发送写 `email_log` 审计（`lib/mail/transport.ts`） | 推送渠道整体镜像这套模式                                   |
| W3  | **渠道接线方式**：邮件不是注册的适配器，而是各模块事件消费者里直接调 `sendUserEmail`（`modules/pm/index.ts:40,55`、`modules/notifications/index.tsx:135-136,224-225,244,356`、`app/settings/actions.ts:121`）。内核注册表预留 `notificationChannels` 适配器接口（`modules/kernel/registry.ts:69-71,140`）但**无任何模块注册过** | 推送可沿用直接调用模式，或首次真正启用适配器接口（决策项） |
| W4  | **站内偏好默认值与邮件相反**：in_app 无行=开（`notify.ts:34-47`），email 无行=关（`email.ts:37-50`）                                                                                                                                                 | push 应取「无行=关」（显式 opt-in）                        |
| W5  | **用户侧 9 类通知**（`pref-types.ts:12-22`）：post.replied / post.reply_to / post.mentioned / post.liked / user.followed / gate.sold / pm.received / content.submitted / content.approved                                                              | 推送类型清单沿用；可裁量哪些类型允许推送                   |
| W6  | **偏好 UI 只有两列**：`app/settings/notifications/page.tsx:37-87` 站内 + 邮件 + 每日汇总，**无推送列**                                                                                                                                              | 需加第三列 + 权限申请入口                                  |
| W7  | **SW 无任何推送能力**：`public/sw.js` 71 行只有 install/activate/fetch；无 push / notificationclick / pushsubscriptionchange                                                                                                                        | 三个监听器全新                                             |
| W8  | **零推送基建**：无 `web-push` 依赖（apps/web / 根 / packages/db 的 package.json 与 lock 均零命中）、无 VAPID 引用与密钥管理位置、无 `push_subscriptions` 表、无 PushManager/getSubscription 客户端代码                                                | 从零建立                                                   |
| W9  | **CSP 当前不阻塞**：全站 Report-Only 不强制（`security-headers.ts:75-76`）；无显式 worker-src（回落 default-src 'self'，同源 sw.js 不受影响）；**推送服务连接由浏览器推送服务发起、不受页面 CSP 约束**                                                 | 无阻塞；若 CSP 转强制需补 worker-src（与 M17 协调）        |
| W10 | **读侧无实时推送**：铃铛靠打开/聚焦时拉取（`docs/NOTIFICATIONS.md:147`「不做实时推送」）；`pref-types.ts:3` 注释「邮件/推送未实现」已过时（邮件已实现，M16.1 修正）                                                                                  | 推送补的是「离站触达」，不是站内实时性                     |
| W11 | **既有密钥注入模式可参照**：根 `.env` / `.env.example`（SMTP_URL、THEME_PREVIEW_SECRET）+ `docker/production/compose.yaml` + 各 Playwright 配置 `webServer.env`（`playwright.prod.config.ts:47-55`）                                                | VAPID 密钥按同款方式注入，不入库                           |
| W12 | **cron 基建已有**：`scripts/digest-cron.mts` 等三个 cron 可参照；ops 管线有任务/触发器体系（M14）                                                                                                                                                   | 失效订阅清理可挂既有调度                                   |

## 2. 边界（明确不做什么）

- **不默认开启推送**：浏览器权限 + 用户偏好双闸，显式 opt-in；不静默订阅、不诱导授权。
- **不做站内实时推送（WebSocket/SSE）**：W10 的「不做实时推送」口径不变，推送只解决离站触达。
- **不改通知类型体系**：沿用既有 9 类（W5），不新增通知语义。
- **不引入第三方推送 SaaS**：用标准 Web Push + VAPID（`web-push` 库是协议实现，非 SaaS）。
- **不做推送内容富媒体**（图片/动作按钮）：首期只标题 + 正文 + 点击跳转。
- **不在 M16.1 内实施**：本里程碑独立推进，M16.1 只做离线深化。

## 3. 落地清单（9 大项，探查产出）

1. **依赖**：apps/web 引入 `web-push`（服务端发送库）。
2. **VAPID 密钥管理**：生成密钥对；`.env.example` 增 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`；
   `docker/production/compose.yaml` 与各 Playwright `webServer.env` 按 SMTP_URL 同款注入（W11）。**密钥不入库**。
3. **数据库**：新表 `push_subscriptions`（user_id、endpoint 唯一、p256dh、auth、时间戳）+ 迁移；
   可选 `push_log` 审计表镜像 `email_log`。**偏好表无需迁移**（W1）。
4. **服务端 API**：订阅 / 退订路由（POST/DELETE），走现有 CSRF action 防护口径；VAPID 公钥下发端点。
5. **客户端订阅流程**：`settings/notifications` 增推送列（W6）；权限申请 + `PushManager.subscribe(applicationServerKey)`；
   `pushsubscriptionchange` 重订阅；同步修正 `pref-types.ts:3` 过时注释（M16.1 已先修）。
6. **SW 扩展**：`sw.js` 增 `push`（showNotification）、`notificationclick`（聚焦/打开目标 URL）、
   `pushsubscriptionchange` 三监听器；缓存版本策略沿用 M16.1 的 shell/assets 分离方案。
7. **投递管线**：`sendUserPush` + `userPushEnabled(channel="push")`（镜像 `email.ts:37-73`，**无行=关**）；
   在现有邮件接线点旁并联推送（W3）；404/410 失效订阅清理；复用活跃抑制与频控。
8. **测试**：偏好默认值/载荷构建单测、投递与失效清理集成测试、订阅流程 E2E
   （真实推送送达在 Playwright 中需 mock web-push 或 SW 内 dispatchEvent 模拟）；`pwa.spec.ts` 增 push 事件断言。
9. **文档与运维**：`docs/NOTIFICATIONS.md` 渠道章节更新；可选站点级推送总开关（镜像 `email.security` 模式）；
   失效清理挂既有调度（W12）。

## 4. 待站长拍板的决策项（立项时未决）

| #   | 决策                                     | 备选与建议                                                                                       |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D1  | 接线方式：直接调用 vs 首次启用适配器接口 | 邮件是直接调用（W3）；**建议沿用直接调用**保持一致，适配器接口留待有第三方案例再抽象             |
| D2  | 哪些通知类型允许推送                     | 9 类全开 vs 只开高价值（post.replied / post.mentioned / pm.received）；**建议后者**，避免打扰      |
| D3  | 是否需要 `push_log` 审计表               | 镜像 email_log 利于排查；**建议要**（推送失败率是运营关键指标）                                   |
| D4  | 站点级推送总开关                         | 镜像 `email.security`；**建议要**（出问题可一键停推）                                             |
| D5  | 与 M17 的 CSP 转强制协调                 | 若 M17 先转强制，需补 `worker-src 'self'`（W9）；两里程碑需协调顺序                               |
| D6  | 启动时机                                 | 站长原话「视重启后反馈立项」——**建议先看公测期真实回流数据**（M17 的 RUM 能提供），再决定是否启动 |

## 5. 门禁基线（沿用 M15/M16）

`pnpm verify:all` 退出 0；新表过 `db:verify` 与 schema 规则测试；订阅/投递/失效清理须有单测 + 集成测试
（含错误路径）；E2E 覆盖订阅流程与 push 事件（mock 送达）；visual 基线零更新；LCP 不回退
（订阅流程不得进入首屏关键路径）；密钥不入库（`check:secrets` 拦截）。

## 6. 风险

- **打扰用户**：类型裁量（D2）+ 频控 + 活跃抑制（镜像邮件）；退订必须一步可达。
- **密钥泄漏**：VAPID 私钥只在 env，`check:secrets` 守住；公钥可下发。
- **失效订阅堆积**：404/410 即时清理 + 定期兜底（W12）。
- **浏览器兼容**：iOS Safari 需 PWA 安装后才支持 Web Push；不支持时优雅隐藏推送列，不报错。
- **送达不可控**：推送服务（FCM/Mozilla/Windows）由浏览器决定，失败不反噬业务（镜像邮件的尽力而为）。

## 7. 立项遗留

- 本文推进线**未经计划模式批准**，D1–D6 未决；启动前须先走前置探查 + 计划模式（M16 同款流程）。
- 真实送达验证需要站长在真机（含 iOS PWA）配合，不能只靠 Playwright mock。
- 启动时机建议参考 M17 的公测回流数据（D6）。
