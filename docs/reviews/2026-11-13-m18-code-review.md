# M18 Web Push 收口前独立审查报告（两路并审）

> 日期：2026-11-13 · 审查对象：`feat/m18-web-push` 的 `b873704~1..271ac5e9`（Step 1–6，六提交）
> 方式：两路独立代理并审——**安全架构路**（运行时/安全/生命周期/测试自身质量）与**规范文档一致性路**
> （实现 vs 已批准计划/文档数字/纪律）。两路全程只读、禁跑 E2E。主执行线亲自核实每条 P1、整改、注入回归、门禁复验。

## 一、结论总览

| 来源 | P0 | P1 | P2 |
|---|---|---|---|
| 安全架构路 | **0** | 3 | 8 |
| 规范文档路 | **0** | 4 | 3 |
| 合计（SW mock 两路同指，去重） | **0** | **6** | 11 |

**6 项 P1 全部整改完毕**；P2 中 9 项整改、2 项记录在案（属约定/流程，非缺陷）。
两路一致确认：**无 P0、无契约破坏、无「失败冒充成功」、VAPID 私钥无泄漏路径、D1–D6 与五条硬约束及「明确不做」全部落实、
门禁基线三文件零改动、零新依赖（仅 web-push）、零 docker 运维文件混入、注释全中文**。

## 二、P1 与整改

### 安全架构路

**A-P1-1 · 180 天订阅清扫按 created_at 误删活跃订阅，推送静默死亡且不可自愈**
`subscriptions.ts` 清扫判据是 `created_at`，而 upsert 与投递成功均不刷新它——持续收推送的活跃用户满 180 天被
`push.cleanup` 删除服务端行，浏览器订阅仍有效（不触发 pushsubscriptionchange）、UI 仍显示「已订阅」，但服务端无行 →
永久失去推送且无提示。**整改**：push_subscriptions 增 `last_sent_at` 列（迁移 0030），投递成功刷新它，清扫改按
`COALESCE(last_sent_at, created_at)`（最后活跃）判超期。**注入回归验证**：临时改回 created_at 判据 → 「活跃订阅不被误删」
用例立即红（removed=1），恢复后绿——证明测试确能捕获缺陷。

**A-P1-2 · SW 推送 E2E 是源码文本断言，计划承诺的「push 事件 mock 送达」未兑现（规范路 D-P1-3 同指）**
原 pwa.spec 只断言 sw.js 文本含 `addEventListener("push"` 等子串——把监听器改空函数仍绿。**整改**：新增行为级用例，
Playwright `Worker.evaluate` 在 SW 作用域替身 `showNotification` 并派发 push 事件，断言通知真被展示（空监听器即红）。
完整 payload 解析与 notificationclick 跳转由站长真机（含 iOS PWA）验证（计划要求的补偿控制）。

**A-P1-3 · push 渠道 outbox 隔离无故障注入测试**
email-failure 测试只注入邮件三阶段故障，push 并联后未扩展；trySendUserPush 深层路径无覆盖（删其 try/catch 仍绿）。
**整改**：email-failure 增 push 阶段——spy 跨模块 `email.userActiveRecently` reject（notify 从 email 导入它）+ 种 push 偏好
使门控走到活跃查询，断言 outbox dispatchedAt 非空、errorJson null、站内计数只 +1、故障被内部捕获记日志。4/4 过。

### 规范文档路

**D-P1-1 · M18 头部 + ROADMAP 状态与已执行矛盾**（仍「立项版·未启动」）→ 同步为「执行中：Step 1–6 完成、Step 6.5 整改中」。
**D-P1-2 · NOTIFICATIONS.md 渠道章节失实**（「当前仅 in_app；email/push 预留适配器」）→ 更新为 in_app 写库、email/push 消费者直调（D1），适配器接口预留未启用（三处）。
**D-P1-4 · web 测试计数 4802 vs 静态预测 4800**（疑似）→ **实测裁定 4802 正确**：4783(M17) + 17(push 13+log-query 4) + 1(scheduler it.each 第 5 任务) + 1(motion 矩阵 /admin/push 新页)；静态预测漏算两处动态展开。整改后实测 **4809**（+7 新测试）。

## 三、P2 处置

| # | 内容 | 处置 |
|---|---|---|
| A-P2-1 | endpoint 校验放行任意协议（z.url() 放行 javascript:/file:/内网 http，受限盲 SSRF 面） | ✅ 收紧 `startsWith("https://")`（Web Push 规范恒 https） |
| A-P2-2 | subscribePush 归属覆盖 / unsubscribePush 防越权零测试 | ✅ 补「用户 B 删 A 的 endpoint → A 行仍在」集成测试 |
| A-P2-3 | check:secrets CI 无 .env 时挡不住裸 base64url VAPID 私钥；Playwright 合成密钥有被搬进生产风险 | 📋 记录：属流程风险，生产密钥必须现场生成（部署注意）；扫描器 SENSITIVE_KEY 已覆盖 PRIVATE_?KEY 名 |
| A-P2-4 | unsubscribeDevice 忽略 DELETE res.ok，服务端失败仍报成功 | ✅ 查 res.ok，失败保留浏览器订阅返回 false 供重试 |
| A-P2-5 | push_log.message_id 存 HTTP 状态码（无追查价值） | ✅ 改存推送服务 Location 头（缺失回落状态码） |
| A-P2-6 | pmPushAllowed 在活跃抑制前消耗频控额度 | ✅ 活跃抑制移到频控前（活跃期私信不白耗小时额度） |
| A-P2-7 | 设置页为全 9 类渲染推送开关，但 D2 只接线 3 类（失准开关） | ✅ PushCell 加 available 属性，非 D2 类型显示「—」占位 |
| A-P2-8 | 测试卫生（死代码占位 insert / 缺 410 / 缺 VAPID 缺失 / build 惰性未钉 / log-query q 分支无测试） | ✅ 删死代码 + 补 410、VAPID 缺失、build spy、queryPushLogs q 数字/转义用例 |
| D-P2-1 | vapid-public-key 路由未带 server-only | 📋 记录：route handler 天然服务端不进客户端 bundle，与 preferences 等路由约定一致，非缺陷 |
| D-P2-2 | tasks.ts 头注释「当前两个任务」过时 | ✅ 改为「当前任务均不发事件，防御性预留」 |
| D-P2-3 | lib/push/index.ts 桶文件未自标 server-only | 📋 记录：与 mail 桶范本一致，守卫靠传递闭包检测污染，types.ts 已列双栖豁免 |

## 四、两路一致确认无问题（摘要）

**安全**：VAPID 私钥仅 process.env，不入任何表/日志/响应（push_log/push_subscriptions 无密钥列；WebPushError 不含签名材料）；
订阅 API 门口链完整（同源→会话→zod→共享频控，错误形状与原 preferences 逐字一致）；unsubscribePush 按 userId+endpoint 防越权；
SW notificationclick 同源校验真能挡跨 origin（绝对/协议相对/反斜杠变体均回落「/」）；trySendUserPush 永不抛出（多层 try/catch，
outbox 不重放）；门控四关口径正确（站点开关无行=开、偏好无行=关、私信独立桶、活跃抑制复用）；邮件/推送故障互相隔离；
404/410 即时清理正确（500 保留有测试）；隐私落实（push_log 无 body 列、私信预览只进加密 payload 与通知栏不落库）；
server-only 五边界登记 + types.ts 双栖豁免 + /api/push 调服务层免触 architecture-guard；审计页 admin.logs 鉴权 + React 转义无 XSS。

**纪律与文档**：D1 直接调用（未启用适配器）/ D2 严格三类（post.reply_to 正确排除）/ D3 push_log 镜像 email_log / D4 站点总开关三件套 /
D5 未放宽 CSP / D6 先行推进；「明确不做」全守住（不默认开启/不静默订阅/不做站内实时/不改类型体系/不引 SaaS/不做富媒体/VAPID 不入库）；
表数 58→60 两处断言、迁移 0029（+整改 0030）、基线/覆盖率阈值未改、仅新增 web-push 依赖、零 docker 混入、注释全中文、
新增行无 eslint-disable/any/ts-ignore/.skip、E2E 独立库、SCHEDULED-JOBS 同步 push.cleanup。

## 五、整改后门禁（真实命令输出）

| 门禁 | 结果 |
|---|---|
| `pnpm verify:all`（整改后） | 退出 0：web **4,809**（+7）/ db 124 / content 55 / migration 278；383 测试文件 |
| 重复率棘轮 | duplicatedLines **1398** / clones **158** ≤ 基线 1405/159（未重锚定） |
| 注入回归验证 | 清扫改回 created_at → 活跃订阅用例红（恢复后绿）；push 隔离测试对删 try/catch 变异有效 |
| 受影响 E2E（pwa/push，prod 构建） | **8/8 全过**（37.9s）：push 订阅 CRUD/公钥/推送列 3 + pwa manifest/离线壳/联网感知/SW 扩展 4 + **SW push 行为测试**（Worker.evaluate 派发 push 事件真触发 showNotification，空监听器即红） |

## 六、结论

无 P0；6 项 P1 全部整改并复验，其中「活跃订阅误删」经注入回归证明确能捕获缺陷。9 项 P2 整改、2 项记录在案。
满足「P0/P1 未清不合并部署」红线，可进入站长验收与 Step 7 收口部署。

**留待 Step 7 / 部署后闭环**（非代码缺陷）：
- VAPID 生产密钥由站长**现场生成**写入服务器 .env（勿照抄 Playwright 合成密钥）；compose env_file 整体注入，无需改 compose。
- 站长真机（含 iOS PWA）真实送达验证：订阅 → 三类通知 → 收推送 → 点击跳转 → 一步退订（Playwright mock 不可替代）。
- 外部拨测配置与跨实例恢复演练签字（M17 遗留观察期项）。