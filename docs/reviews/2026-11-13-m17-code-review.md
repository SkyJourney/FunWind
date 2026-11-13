# M17 质量与可观测性收口前独立审查报告（两路并审）

> 日期：2026-11-13 · 审查对象：`feat/m17-quality-observability` 的 `dc378bc~1..005ef17`（Step 1–6，7 提交 57 文件 +13070/−158，含 drizzle 快照）
> 方式：两路独立代理并审——**安全架构路**（运行时行为、安全、生命周期、测试自身质量）
> 与**规范文档一致性路**（实现 vs 已批准计划、文档数字准确性、注释/纪律）。两路均全程只读、禁跑 E2E。
> 主执行线负责：亲自核实每条 P1 证据、整改、注入回归验证、门禁复验。

## 一、结论总览

| 来源 | P0 | P1 | P2 |
|---|---|---|---|
| 安全架构路 | **0** | 4 | 8 |
| 规范文档路 | **0** | 2 | 5 |
| 合计 | **0** | **6** | 13 |

**6 项 P1 全部整改完毕**；P2 中 12 项整改（含真实缺陷与隐私加固），1 项记录在案（A-P2-4 恒 204 fail-fast 属有意设计）。
两路一致确认：**无契约破坏、无「失败冒充成功」路径、门禁基线三文件零改动（无偷改）、零新依赖、
7 提交零 docker 运维文件混入、注释全中文、禁改文件（notify/pref-types/instrumentation/scheduler-entry-guard/security-headers）零改动**；
文档路实测核对 web 4771→4783 / db 124 / content 55 / migration 278 / 表 58 / 迁移 0027-0028 / 重复率 1391-157 低于未动基线 1405-159，**全部属实**。

## 二、P1 与整改

### 安全架构路

**A-P1-1 「时区无关」卖点没有有效回归锚——删掉 +8 偏移全部 M17 测试照样绿**
`digest-job.test.ts` 把 `nowBeijingWallTime` 整个 mock，名为「时区无关性」的用例从未变换进程 TZ；
`datetime.test.ts` 对 `nowBeijingWallTime` 只断言格式正则。被测的时区行为恰是被 mock 掉的函数。
**整改**：① `datetime.test.ts` 补固定瞬间锚（`nowBeijingWallTime(Date.UTC(2026,0,1,0,0,0))==="2026-01-01 08:00:00"` + 跨日边界）
与进程 TZ 无关性用例（TZ=UTC/Asia/Shanghai 同瞬间同输出）；② `digest-job.test.ts` 该用例改用**真实墙面函数**
（`vi.importActual`）+ 固定 `Date.now` + 变换 TZ，钉「任务确实读北京墙面而非本地 getHours」。
**注入回归验证**：临时删 `datetime.ts` 的 `+8*3600*1000` → `datetime.test.ts` 立即 **2 failed**（恢复后绿），证明锚非永真。

**A-P1-2 digest 活跃判定按进程时区解析库内时间——TZ=UTC 容器活跃窗口错成 32h（M17 激活的既有缺陷）**
`digest.ts:94` `new Date(user.lastLoginAt.replace(" ","T"))` 无时区后缀，按进程本地时区解释北京墙面时间，
违反 `datetime.ts:1-5` 明文禁令。M17 接线使该缺陷首次在生产生效。
**整改**：改用 `parseDbDateTime(user.lastLoginAt)`（按 +08:00 解析），并补注释说明。

**A-P1-3 RUM E2E 的 p75 值断言打偏——命中表格单元格，破坏分位数实现仍绿**
`rum.spec.ts:122` `getByText("300ms")` 命中 value=300 的表格行，而 p75 概览聚合全库 LCP 实际 ≠300。
（注：`queries.test.ts:34-49` 已有 percentile 精确单测，算法本就被钉死；本条实质是 E2E 断言打偏。）
**整改**：E2E 改为锚定**概览段落内**的 LCP 正值（`overview.getByText(/LCP [1-9]\d*ms/)`），
percentile 恒返回 0 会显示 "LCP 0ms" 即红；用正值而非精确值以避开 prod 构建下 RumBeacon 异步补样本的竞态。

**A-P1-4 server-only 守卫把 schema.ts 钉成「不得标 server-only」——钉住了反向不变量**
`server-only-guard.test.ts` 把 `lib/rum/schema.ts` 列入「不被误标」清单，注释称「双栖」；
但双栖的是零依赖 `protocol.ts`，`schema.ts`（带 zod）自述「只服务端用」。守卫反而阻止正确加固。
**整改**：`schema.ts` 加 `import "server-only"`（vitest 已 alias 空实现，单测不受影响），列入 SERVER_BOUNDARIES，
从「不被误标」清单移除（protocol.ts 保留），更正注释。客户端误引 zod 从此变成硬错误。

### 规范文档路

**D-P1-1 M17 里程碑文档头部状态与自身正文矛盾**
头部仍写「立项版·未启动」「未建分支、未动代码」，但 §9–§15 已记录 Step 0–6 完成、分支 7 提交。
**整改**：头部改为「🚧 执行中：Step 0–6 已完成，Step 6.5 审查整改中，Step 7 未开始；7 提交已推送、尚未部署」。

**D-P1-2 ROADMAP M17 状态行未同步**
`ROADMAP.md:49` 仍「⬜ 仅立项未启动」，与 git 历史矛盾。
**整改**：与 D-P1-1 同批更新为执行中状态。

## 三、P2 处置

| # | 内容 | 处置 |
|---|---|---|
| A-P2-1 | CSP 路由单测未 mock 落库，M17 接线后真连开发库写 csp_reports 脏行（含 1% 清扫） | ✅ 补 `vi.mock("@/lib/csp/ingest")` |
| A-P2-2 | RUM detail 不做 URI 脱敏，错误消息里的令牌 URL 可入库 | ✅ cleanDetail 增加内嵌 http(s) URL 走 redactUri；补回归测试 |
| A-P2-3 | redactUri 对百分号编码段失效（`%61%62…` 编码令牌绕过） | ✅ 判不透明段前先 decodeURIComponent；补逐字符 %XX 编码回归测试 |
| A-P2-4 | 「恒 204」在漏配 TRUSTED_PROXY_HOPS 时破约（clientIpFrom 抛错→500） | 📋 记录：client-ip 既定 fail-fast 设计，runbook 要求生产 =1；纳入 try 会掩盖配错，保持现状 |
| A-P2-5 | csp toRow line-number：`Number("")=0` 误落 0；无上限可毒化整批 insert | ✅ 空/缺省→null、超 INT UNSIGNED→null；补集成测试 |
| A-P2-6 | 共享件 escapeLike/parsePageParam/pageLimit 缺直接单测 | ✅ 新建 sql.test.ts（3 例）+ paging.test.ts 补 4 例 |
| A-P2-7 | SERVER_BOUNDARIES 未收录 queries 层与 lib/sql.ts | ✅ 随 A-P1-4 一并收录 rum/csp queries + sql.ts |
| A-P2-8 | 杂项注释失实（digest「下一轮可重试」实为次日；alert-mail「(scene,user,status) 索引」不存在） | ✅ 两处据实更正 |
| D-P2-1 | 两处注释未随 Step 1 迁移同步（settings/actions、email 仍写「系统 cron」） | ✅ 改为「进程内调度器 email.digest 按北京墙面时间比对」 |
| D-P2-2 | schema.ts server-only 处理与计划措辞偏差、守卫注释理由失实 | ✅ 随 A-P1-4 解决 |
| D-P2-3 | §14→§15 重复率增量叙事不自洽（+31/+2 归因含糊） | ✅ 改为精确「从 Step 5 的 1399/158 推到 1436/161，超基线 31/2」 |
| D-P2-4 | security-headers E2E 后台零违规样本未纳入两新后台页 | ✅ 样本数组追加 /admin/rum、/admin/csp（增强转强制证据面） |
| D-P2-5 | migration 测试计数静态 ±1（279 vs 278） | ✅ 经 verify:all 实测裁定为 **278**（静态 grep 误计 fixture），文档无需改 |

## 四、两路一致确认无问题（摘要）

**安全**：redactUri 主路径（43 字符 base64url 令牌→:token、去查询串/片段、非 http 只留协议、裸路径→[other]）既有单测逐条锚定；
readBodyBytes 复用（Content-Length 快速拒绝 + 逐块计数超限取消）有分块流式实测；两信标端点恒 204、异常全吞；
extractReports 控制字符→空格 + 200 截断 + 最多 10 条防日志注入；落库全 drizzle 参数化，两处 sql.raw 为常量 90 无注入面；
RUM 隐私（IP 仅频控键、无 UA/堆栈列、zod 仅服务端、客户端只引零依赖 protocol）；采集 return null 零 DOM + buffered:true + idle 注册 + 首屏零请求；
digest 当日幂等（北京墙面日期与库内 NOW() 同口径）+ 命名锁；告警邮件 email_log 防重（右全角括号锚点防 #1 撞 #10，双向撞车有实测）+ .catch 隔离 + email.ops 开关；
/admin/csp、/admin/rum 首行 requireAdmin("admin.logs") + NAV 登记过 admin-nav-guard；分页 parsePageParam 拒小数/负数/NaN。

**纪律与文档**：门禁基线三文件（.jscpd.json / duplication-baseline.json / file-length-baseline.json）git diff 全空，**无重锚定**；
零新依赖（package.json/pnpm-lock 零改动）；新增行无 eslint-disable/any/ts-ignore/.skip；覆盖率阈值 90/85/90/90 与排除清单未动；
注释全中文、标识符英文；7 提交零 docker/compose；BACKUP.md 改动仅 Step 3 授权勘误；E2E 用独立库 qysub_next_e2e（withE2eDb 硬编码 + NEW_DB_NAME 不符即抛错）；
CSP 仍 Report-Only（security-headers.ts 零改动），§15「只交报告面、不转强制」与代码一致；M18 仅立项未推进。
文档数字经实测全部吻合（web 4771→整改后 4783 / db 124 / content 55 / migration 278 / 表 58 / 迁移 0027-0028 / 重复率 1391-157）。

## 五、整改后门禁（真实命令输出）

| 门禁 | 结果 |
|---|---|
| `pnpm verify:all`（整改后） | 退出 0：web **4,783**（+12）/ db 124 / content 55 / migration 278；381 测试文件 |
| 重复率棘轮 | duplicatedLines **1391** / clones **157** ≤ 基线 1405/159（整改未新增重复） |
| 守卫 | architecture/server-only/admin-nav/motion-architecture/motion-bare-write/scheduler-entry 全绿 |
| 注入回归验证 | 删 `datetime.ts` +8 偏移 → `datetime.test.ts` **2 failed**（恢复后绿），证明时区锚非永真 |
| 受影响 E2E（rum/csp/security-headers，prod 构建） | **15/15 全过**（37.5s）：csp 1 + rum 3（含改后 p75 概览锚）+ security-headers 11（「管理员浏览后台页面：零违规」纳入 /admin/rum、/admin/csp 后仍绿） |

## 六、结论

无 P0；6 项 P1 全部整改并复验，其中「时区卖点」经注入回归证明确实能捕获缺陷（删 +8 偏移即红）——
这对 M17 Step 1 的核心修复尤其重要，否则「已钉住」仍是空话。12 项 P2 整改、1 项记录在案。
满足「P0/P1 未清不合并部署」红线，可进入站长验收与 Step 7 收口部署。

**留待 Step 7 / 部署后闭环**（两路提出，非代码缺陷）：
- 告警全链验收（任务失败→站长收件）与 digest 次日到达，须部署后真实注入复核（生产仍是 M16.1）。
- 外部拨测配置（站长执行项）与跨实例恢复演练签字。
- BACKUP.md 演练记录宜注明 bootstrap 跑的代码版本（生产备份 56 表 vs 分支 58 表，「新增全 0」指种子行非表）。