# M17 · 质量与可观测性收口（立项版 · 未启动）

- 阶段：四·运营与演进 ｜ 依赖：M13（部署上线）、M14（运维任务管线）、M15/M16（动效管线，均已收口公测）
- 状态：⬜ **仅立项，未启动**（2026-11-12 站长拍板方向：「M17 按方向 1 先把立项的里程碑文档写出来，但是不推进」）。
  本文是立项事实底座与范围草案，**推进线未经计划模式批准**，未建分支、未动代码、未部署。
- 立项动因：M13–M16 连续交付了「能力线」（部署 / 运维管线 / 动效管线），但**「运营可信度」欠账未清**——
  性能只有单点实测没有真实用户数据、告警触达从未验证、回滚演练从未完整做过、CSP 停在 Report-Only。
  这些是公测走向正式运营的入场券，也是三个跨里程碑长线项的收口载体。

## 目标

1. **从「感觉没问题」到「有数据证明」**：建立真实用户侧的性能与错误可见性（当前完全缺失），
   让 LCP/错误率有持续数据而非每次部署手工实测一次。
2. **关掉三个跨里程碑长线欠账**：告警触达验证、完整回滚演练、生产检查单逐项签字（M13 遗留 §转长线运营）。
3. **安全策略从观测转强制**：CSP 目前 Report-Only（不拦截），违规报告只落日志靠 grep——
   把「看报告」变成可查询的面，再评估转强制。
4. **不新增运维拓扑**：延续 M13 D3「最小自建」与 G-17（多实例不在边界内），优先复用既有
   `/api/health` + ops 管线 + 日志前缀体系，不引入第三方 SaaS 作为硬依赖。

## 1. 已核实事实（2026-11-12 只读探查，全部 file:line / 文档节佐证）

> 时点说明：本表是**立项时点**的现状快照。M14 已自动化的部分明确标注，避免重复立项。

| #   | 事实                                                                                                                                                                                                                                                     | 对 M17 的影响                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Q1  | **零真实用户监控**：全仓无 RUM / web-vitals 上报 / 前端错误上报通道（rg `sentry\|web-vital\|reportWebVitals\|RUM` 在 `apps/web/src` 与 package.json 零命中）。LCP 只有脚本单点实测：`apps/web/scripts/lcp.ts`（生产构建本地四页）与部署时的公网手工实测       | 性能与错误可见性从零建立；这是 M17 的核心增量                             |
| Q2  | **CSP 停在 Report-Only**：`apps/web/src/lib/security-headers.ts:75` 注释明写「注意是 Report-Only：不会拦截任何东西。转强制前须先看违规报告」；`connect-src 'self'`（:46，生产不放行外站）                                                                     | 转强制的前置是「报告可查询」；上报端点必须同站（CSP 自身约束）            |
| Q3  | **违规报告只记日志不落库**：`apps/web/src/app/api/csp-report/route.ts:1-9` 自述「只记一行日志，不落库。想看报告：grep 服务日志里的 `[csp-report]`」；已有体积上限/URI 脱敏/频控/永远 204                                                                     | 报告面可复用其脱敏与频控；落库或聚合是新增                                |
| Q4  | **健康端点已就绪**：`apps/web/src/app/api/health/route.ts:18-23` 探 DB（3s 超时兜底）+ 存储可写，200/503 区分；容器 HEALTHCHECK 已打此端点（`docker/production/Dockerfile`，30s）                                                                             | 拨测底座已有，不需要新建；缺的是外部拨测配置与触达验证                    |
| Q5  | **告警触达从未验证**：`docs/ops/OBSERVABILITY.md:25-38` 给了完整验证步骤（停容器 → 等 1–2 拨测周期 → 确认 down/up 告警），但 §6 检查单四项**全部未勾选**；文档自述「没验证过触达的监控等于没有监控」                                                            | M13 长线欠账之一，需要一次真实故障演练（有中断风险，须窗口）              |
| Q6  | **备份恢复演练已部分自动化**（不重复立项）：M14 Step 5 的 `drill.restore` 任务默认每周五 02:00 启用中，导入同实例临时库 → 表对账 → 清理，失败记 failed 并触发 ops.alerts（`docs/ops/BACKUP.md` §恢复演练）。台账表 `ops_runs`（管线自治建表，`packages/db/src/schema.ts:1143`） | **缺的是「跨实例人工演练 + 站长签字」**（§4 人工序列），不是自动化本身    |
| Q7  | **完整回滚演练从未做过**：M13 遗留明列「含一次回滚的完整演练」未勾选；M16 Step 5 部署也只做了前向核对，回滚口（旧镜像 tag）在位但未实演                                                                                                                     | M13 长线欠账之二；M16 已留好回滚点 `funwind-web:20261112`，可直接用于演练 |
| Q8  | **生产检查单未逐项签字**：M13 遗留「域名/证书/robots/sitemap/性能预算」未勾选；`docs/ops/LAUNCH-RUNBOOK.md:137` 的观察期 24h 清单与 OBSERVABILITY §6 均为待办                                                                                            | M13 长线欠账之三；属核对与签字，工程量小但不可跳                          |
| Q9  | **既有可观测底座可复用**：结构化日志前缀体系（OBSERVABILITY §3）、日级 digest 邮件（§4）、ops 管线台账与失败告警（M14）、`pwa:lighthouse` 脚本（package.json:44）                                                                                          | 优先扩展既有面，不新建平行体系                                            |
| Q10 | **性能门禁已成惯例**：每步 verify:all + E2E + visual 零更新 + LCP 实测（M15/M16 全程执行）；`scripts/lcp.ts` 预算 2500ms                                                                                                                                   | RUM 数据要能与既有单点门禁对照，不替代它                                  |

## 2. 边界（明确不做什么）

- **不引入第三方监控 SaaS 作为硬依赖**：延续 M13 D3 最小自建；Sentry 等留作可选（M13 §遗留事项原话），
  若引入须站长拍板且不得成为可用性单点。
- **不改运维拓扑**：G-17（多实例监控）不在边界内；不新增常驻容器（优先复用 web 与 ops 两个既有容器）。
- **不动备份/恢复的既有自动化**：`drill.restore` 每周演练已在跑（Q6），M17 只补跨实例人工演练与签字。
- **不为了 CSP 转强制而破坏功能**：转强制前必须先有违规数据支撑；`script-src 'unsafe-inline'`
  （RSC 内联载荷）与 `style-src 'unsafe-inline'`（Tiptap/Tailwind）的既有豁免理由不变，
  nonce 化不在本期（security-headers.ts:6-8 已记录理由）。
- **不做 APM / 分布式追踪 / 日志聚合平台**：规模不匹配（公测期单实例）。
- **告警演练必须有窗口与回滚口**：停容器制造故障会真实中断服务，须站长按窗口批准，不得在高峰自行执行。

## 3. 范围草案（待计划模式定稿）

> 以下为候选范围，**未批准**。按「价值 / 成本 / 风险」分为三组，站长可裁剪。

### A 组 · 真实用户可见性（核心增量）

- A1 前端性能上报：Core Web Vitals（LCP/CLS/INP）采样上报到**同站端点**（CSP `connect-src 'self'` 约束），
  落库或聚合，后台可查（复用 `/admin/ops` 或新增只读页）。
- A2 前端错误上报：`window.onerror` / `unhandledrejection` 捕获 → 同站端点 → 脱敏（复用 csp-report
  的 URI 脱敏与频控口径）→ 可查询面；须防「错误风暴打爆端点」（采样 + 频控 + 体积上限）。
- A3 数据面：按页面/时间窗聚合 p75，与既有 `scripts/lcp.ts` 单点门禁对照；保留策略与容量上限。

### B 组 · 长线欠账签字（工程量小、不可跳）

- B1 告警触达验证：按 OBSERVABILITY §2 在**站长批准的窗口**制造一次故障，确认 down/up 告警到达，勾选 §6。
- B2 完整回滚演练：用 M16 留好的回滚点实演一次「换回旧镜像 → 核对 → 再换回新镜像」，记录耗时与步骤勘误。
- B3 跨实例恢复演练 + 签字：按 BACKUP §4 人工序列执行一次，站长签字（自动化每周演练已在跑，不重复）。
- B4 生产检查单逐项核对签字：域名/证书/robots/sitemap/性能预算 + 观察期清单。

### C 组 · 安全策略推进（可选，风险较高）

- C1 CSP 违规报告可查询化（落库/聚合 + 后台只读面），为转强制提供数据。
- C2 基于 C1 数据评估 Report-Only → 强制；**若数据显示仍有违规，则本期只交 C1，诚实不转**。

## 4. 推进线草案（未批准）

> 若站长批准立项推进，建议按 M15/M16 纪律：独立分支、每 Step 提交汇报等确认、Step X.5 独立审查、
> P0/P1 未清不合并部署。**本草案不构成执行授权。**

- **Step 0 · 前置核实**（只读，不改任何东西）：① 核实 `ops_runs` 台账里 `drill.restore` 的实际执行历史
  （近几周成功/失败，本次立项未能核实——生产库凭据不在 Agent 手上，须站长提供或在后台 `/admin/ops` 查看）；
  ② 核实外部拨测是否真的配了（OBSERVABILITY §1 只是「配置建议」，未确认已配）；
  ③ 核实 digest 邮件是否真的每日到达；④ 汇总 CSP 违规报告的实际量与类型（grep 生产日志）。
  **Step 0 结论可能显著改变范围**（例如拨测根本没配，则 B1 的前置是先配拨测）。
- **Step 1 · 可见性底座**（A1+A2 采集与端点，含脱敏/频控/采样/容量上限 + 单测与集成测试）
- **Step 2 · 数据面与对照**（A3 + 后台只读页 + 与单点门禁对照口径）
- **Step 3 · 长线欠账**（B1–B4，**须站长窗口批准**，逐项签字入档）
- **Step 4 · CSP 推进**（C1，C2 视数据决定）
- **Step 4.5 · 独立审查** → **Step 5 · PR/CI/部署/文档收尾**

## 5. 待站长拍板的决策项（立项时未决）

| #   | 决策                                                                 | 备选与建议                                                                                                     |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| D1  | 可见性数据落哪：新建表 vs 复用日志聚合 vs 引入 Sentry                | **建议同站落库 + 后台只读页**（零外部依赖、CSP 友好、复用 ops 页模式）；Sentry 需外站 connect-src 且引入依赖     |
| D2  | 采样率与保留期                                                       | 建议性能全量采样（量小）、错误按类型去重 + 上限；保留 30 天滚动                                                  |
| D3  | 告警演练窗口                                                         | **必须站长指定**（会真实中断服务）；建议低峰 + 提前公告                                                        |
| D4  | CSP 是否本期转强制                                                   | **建议数据驱动**：C1 先行，违规清零才转；不为达标而放宽策略                                                      |
| D5  | 是否与「扫尾专项」合并推进                                           | 站长已决定**分开**：M17 只立项，方向 2/3/4 另做小专项（见该专项计划）                                            |

## 6. 门禁基线（沿用 M15/M16）

`pnpm verify:all` 退出 0；新增采集/端点须有单测 + 集成测试（含错误路径与频控）；E2E 覆盖上报链路
（含 CSP 不违规断言）；visual 基线零更新；**LCP 不因上报脚本回退**（采集必须异步、不阻塞渲染、
不进入 LCP 关键路径）；裸写守卫/架构守卫全绿；新增表须过 `db:verify` 与 schema 规则测试。

## 7. 风险与回滚

- **上报脚本拖慢首屏**：采集必须 defer/异步 + 体积极小；以 LCP 门禁守住，出问题单点 revert 采集接线。
- **错误风暴打爆端点**：采样 + 去重 + 频控 + 体积上限（复用 csp-report 既有防线），端点永远 204。
- **隐私与令牌泄漏**：上报内容一律走既有 URI 脱敏（去查询串/令牌段替换），不得原样上报 URL 与用户输入。
- **告警演练真实中断**：窗口批准 + 回滚口在位 + 演练脚本化（停→等→起→核对），失败立即恢复。
- **CSP 转强制误伤**：数据驱动，违规未清零不转；转强制后若出问题，回滚为 Report-Only 是一行改动。

## 8. 立项遗留（本文未完成的部分）

- Q6 的 `drill.restore` 实际执行历史**未核实**（生产库凭据不在 Agent 手上）——列为 Step 0 首任务。
- 外部拨测「是否已配置」未核实（文档只给了建议）——列为 Step 0。
- 本文的推进线与范围**未经计划模式批准**，D1–D5 未决；启动前须先走探查 + 计划模式（M16 同款流程）。

## 9. Step 0 前置核实结论（2026-11-13，全部只读实测）

立项时留了两项未核实事实，本节据实补齐，并**更正立项文档的一处错误假设**。
所有结论来自生产实测（`ssh QY_HK` + 容器内 MySQL 只读查询 + nginx 日志），非文档推断。

### 更正：生产库名是 `qingyisub`，不是 `qysub_next`

立项 §1 Q6 写「台账表 `ops_runs`」时按本机开发库名假设了 `qysub_next`。生产实际：
`NEW_DB_NAME=qingyisub`、`NEW_DB_HOST=funwind-mysql`（容器内 env 实测）。后续一切查询以 `qingyisub` 为准。

### ① 演练台账：自动化确实在跑，但历史连续性证据不足

- `ops_tasks`：`drill.restore` **enabled=1**；`backup.db` / `backup.storage` 均 enabled=1；
  `campaign.holiday` enabled=0。
- `ops_trigger_state`：`t7 drill.restore` last_result=**success**、last_fired **11-13 02:00**、
  next_fire **11-20 02:00**（每周五，与 BACKUP.md 一致）。
- 台账总量 **20 条**（db 9 / storage 9 / restore 1 / drill 1），跨度 **11-08 19:30 → 11-13 03:40**。
  **只有 1 条 drill 记录属预期，不是保留期截断**（Step 3 更正本节初版猜测）：11-08 是**周日**、
  11-13 是**周五**，即 11-13 那次是管线上线后的**首个周五**，此前根本没有触发点。
  台账未见截断迹象（记录可追到管线起点）；「每周都可用」需再积累几个周五才有历史样本，
  但**不必因此调整保留策略**。
- **结论**：Q6「M14 已自动化」证实，M17 **不重复立项自动化**是对的；但 B3 的「跨实例人工演练 + 签字」
  仍需要，且应顺带确认台账保留策略（否则演练历史无法追溯）。

### ② 外部拨测：**从未配置**（真缺口，且是 B1 的前置）

- 站点日志 `www.qingyisub.top.log` 连续覆盖 **11-09 17:33 → 11-13 09:30**（4 天、**90420 行**、无轮转归档），
  其中 `/api/health` 请求数 **0**。
- 排除误判：容器 HEALTHCHECK 是 `wget http://127.0.0.1:3311/api/health`，**直连容器端口绕过 nginx**，
  所以 nginx 看不到它——两者不矛盾，零请求不是日志轮转假象。
- **结论**：OBSERVABILITY §1 的「外部拨测配置建议」**从未落地**。容器挂 / 服务器宕 / 证书过期 / 反代断
  这四类故障目前**没有任何外部探测**；容器内 HEALTHCHECK 在容器自身挂掉时毫无意义。
  **B1 的前置是先配拨测**，否则「制造故障 → 等告警」根本无从触发。

### ③ digest：**从未发过一封**（代码就绪但从未被调度）

- `email_log` 全表仅 **8 条**：`security/password-changed` 5 + `verify/claim-account` 3，最后一条 11-09 09:11；
  **零 digest 记录**。
- 根因：web 进程内调度器只登记 3 个任务（`account-deletion.drain`、`unverified-accounts.purge`、`ops.alerts`），
  **digest 不在其中**；它靠独立脚本 `scripts/digest-cron.mts`，而宿主机 crontab **只有一条宝塔 ACME
  证书续期任务**（`acme_v2.py --renew_v2=1`），没有任何驱动 digest 的条目。
- **结论**：Q9 把 digest 列为「既有可观测底座」不准确——它是**未接线的资产**。M17 需决定：
  接进进程内调度器（与既有 3 任务同款）还是补外部 cron。

### ④ CSP 违规报告：近 24h **零条**

- `docker logs funwind-app --since 24h | grep -c csp-report` = **0**，无违规指令分布。
- **结论**：C 组「转强制」的数据前提初步 favorable，但**样本仅 24h**，且 E2E 中曾见 `admin/themes`
  页面的 `eval` 违规（Report-Only 记录）→ 需更长窗口 + 覆盖后台路径才能判定可转。

### ⑤ 额外发现：告警链路**正常**，缺的是离站触达（自我纠正）

核实过程中我先只查 `email_log` 得出「告警从未发出」的**片面结论，现予纠正**：

- 11-11 有两次 `storage` 备份失败（03:40、08:31），11-12/11-13 已恢复 success。
- `notifications` 表有 **4 条 `ops.run.failed`**：11-11 **03:45** 与 **08:45**，各发给 2 位管理员
  （user_id 17911 / 5097）——正是失败时刻 + `ops.alerts` 的 `*/15 * * * *` 扫描周期。
- 实现核对（`lib/scheduler/tasks.ts:93-140`）：扫描窗口 7 天、单轮上限 20、按 `run id + uid` 幂等去重、
  接收人 = admin 角色且 state=active（实测 **2 人**）；走 `notify()` → **站内通知**渠道。
- 邮件为零的原因：**`opsAlertsJob` 从不调用 `sendUserEmail`**——邮件渠道根本没接线，不是「偏好默认关」（Step 2 读实现查明，本节初版说法有误，已更正）。
- **结论**：告警**链路可用且已被真实故障验证过**（这是好消息，B1 有了真实样本可对照）。
  真缺口是**离站触达**：站长不打开站点就看不到铃铛。M17 的 B1 应聚焦「让告警能到达站外」
  （邮件渠道开启 / 外部拨测告警 / 后续 M18 推送），而不是「修链路」。

### Step 0 对范围的影响（待计划模式定稿）

| 立项假设 | 实测结论 | 范围调整 |
| --- | --- | --- |
| B1「告警触达从未验证」 | 链路正常、已被真实故障验证；**外部拨测从未配** | B1 前置加「配拨测」；重心从「验证链路」转向「离站触达」 |
| Q9「digest 是既有底座」 | **从未发过**，未被任何调度驱动 | 新增「digest 接线」为独立交付项 |
| B3「跨实例人工演练」 | 自动化在跑但**历史仅 1 条** | 保留 B3，顺带确认台账保留策略 |
| C2「数据驱动转强制」 | 近 24h 零违规，但样本短 | C1 先行 + 延长观察窗口，覆盖后台路径 |
| A 组 RUM | 未变（仍零真实用户监控） | 保持核心增量 |

## 10. Step 1 digest 接进进程内调度器（2026-11-13）

把「从未真正运行过」的每日汇总接进调度器，并先补上让它能安全迁入的前置条件。

- **当日幂等闸（迁入的前置条件）**：`lib/notifications/digest.ts` 的 `runDigestOnce` 加「同一北京日
  已发过则跳过」（`skippedToday` 计数，`--force` 可绕过用于手动补发）。根因是未读私信计数不受 `since`
  时间窗约束（只按 `last_read_message_id` 过滤），同日第二次运行会给有未读私信的用户**再发一封**——
  这正是 `docs/SCHEDULED-JOBS.md` 当初记载「与系统 cron 双跑可能重复发信、本期不迁」的实质原因。
  **命名锁只防并发，不防先后双跑**，所以必须有当日闸；补上后顾虑消除。
- **发送失败不再静默**：`DigestResult` 加 `failed` 计数（此前 `sendUserEmail` 返回 false 时什么都不记，
  任务摘要看不出部分失败）；失败不写时间戳，下一轮可重试。
- **任务工厂 `digestJob()`**（`lib/scheduler/tasks.ts`，键 `email.digest`）：cron `"0 * * * *"`，
  run 内读 `getDigestHour()` 与 `nowBeijingWallTime()` 派生的北京小时比对，过闸才调 `runDigestOnce()`。
  **不用固定每日 cron**——发送时刻是后台可配项（`admin/settings` 有表单），固定 cron 会让该配置失效。
- **顺带修掉时区隐患**：旧脚本用 `new Date().getHours()` 读**进程本地时区**，容器 `TZ=UTC` 时后台配的
  「20 点」会错位成北京凌晨 4 点。现在统一按北京墙面时间比对，与调度器的 `Asia/Shanghai` 约定一致。
- **CLI 改走 `runJob` 共用命名锁**（`scripts/digest-cron.mts`，照 `account-deletion-cron.mts`）：
  此前它直调 `runDigestOnce` **不抢锁**，与调度器同时跑会双发。现在与调度器共用同一任务同一把锁，
  持锁时本次 skipped 且退出码 0；保留 `--user` / `--force` 手动入口；显式 `process.exit` 防连接池僵尸进程。
- **清单与守卫**：`jobs.ts` 登记；`index.test.ts` 的键数组断言 3→4（探查预判必改，果然）。
  **不改** `scheduler-entry-guard`、**不改** `instrumentation.ts`（任务本体在 tasks.ts，符合既有约定）。
- **测试 +20 例**：当日幂等集成 4 例（同日二跑不重发 / 当日闸拦住而 force 放行 / 跨日正常发 /
  失败计入 failed 且不写时间戳）、任务闸门 9 例（北京时刻比对 / **时区无关性** / 后台改时刻立即生效 /
  手动入口免闸 / 结果映射）、脚本真起进程 5 例（**干完活自行退出** / 共用锁被跳过 / --force / --user）、
  清单 cron 断言 1 例 + 键数组更新。
- **一处自查纠正**：`force` 用例初版断言「force 后必然发送」是错的——首发后 `lastDigestAt=NOW()`，
  未读通知也是 NOW()，`gt(createdAt, since)` 取不到新动态，走「零动态」分支不发。force 只绕过当日闸，
  不会凭空造出内容。改为把时间戳挪回今日零点，才真正区分「被闸拦住」与「没有新动态」。
- **文档同步三处**：`SCHEDULED-JOBS.md`（总表行改进程内调度器 + 重写「不迁」段为「已迁 + 动因」）、
  `EMAIL-SCENARIOS.md:87`（删「需配 crontab / 没有迁入」）、`admin/settings/page.tsx` 表单说明
  （改为「站点定时任务每小时按北京时间比对，同日只发一封，无需另配 crontab」）。
- **门禁**：`pnpm verify:all` 退出 0（web **4,700**（+20）/ db 124 / content 55 / migration 278）。
  `check:secrets` 曾拦下我测试里的 `example.test` 合成邮箱（允许清单只有 .com/.org/.net）——
  按仓库既有约定改用 `example.com`，**没有给扫描器开例外**。
- **E2E**：核实全仓 E2E 无 digest 功能覆盖（grep 命中的 `digest` 全是 `createHash().digest("hex")`），
  本步不需跑 E2E；功能由单测 + 真起进程测试覆盖。
- **生产验收待 Step 3**：接线后是否真发出，以生产 `email_log` 出现 `scene=digest` 为准（部署后核对）。

## 11. Step 2 告警离站触达（2026-11-13）

把「链路正常但只到站内铃铛」的运维告警补上离站触达这一层。

- **根因据实更正**：Step 0 我曾写「告警零邮件是因为渠道默认关」——**错的**。真实原因是
  `opsAlertsJob` 只调 `notify()` 写站内表，**从不调 `sendUserEmail`**，即使有偏好行也不会发。
  是「渠道根本没接线」，不是「偏好关着」。
- **模板 `opsRunFailedMail`**（`lib/mail/templates.ts`）：`kind:"system"`、`scene:"ops-run-failed"`，
  含任务名 / 运行 id / 失败原因 / 告警时间 + 「查看运维台账」按钮。按守卫要求在 `previews.ts` 登记样例
  （`mail-guard.test.ts` 强制每个导出模板都有预览，漏登记会红）。
- **防重是本步技术核心**（新增 `lib/ops/alert-mail.ts`）：告警任务每 15 分钟重扫近 7 天失败，
  无条件发信会反复打扰。**用 `email_log` 查询而非进程内 `rateLimit`**——后者重启即失忆，
  用它做主防重会导致重启后把整周失败再发一遍。照 `lib/mail/recall.ts` 范式，零 schema 变更。
  - **主题锚点的子串撞车**：`%运行 #1%` 会命中 `#10`/`#11`，把不同运行误判为已发 → **静默漏告警**。
    锚点带右全角括号（`运行 #<id>）`）后不再撞车。模板主题格式与防重查询是一对契约，
    双向撞车（1 vs 10/100、10 vs 1）都有显式用例钉住。
- **站点开关 `email.ops`**（默认开）：照 `email.security` 三件套（helper + action + 后台表单）。
  默认开的理由：告警价值就在「不打开站点也能知道」，默认关等于没接线。
  **不改 `notify.ts`**（邮件按既定架构由调用方显式附带；改它自动并联会波及全部通知类型并破坏
  「场景类查用户偏好 / 强制类查站点开关」分层）；**不改用户偏好页**（`ops.run.failed` 是 mandatory 类型）。
- **邮件是附带渠道**：`sendOpsAlertMails` 的异常被 `.catch(() => null)` 兜住，摘要记 `mail=error`，
  不反噬已写入的站内告警、也不把任务标记为 failed（站内才是主渠道）。
- **`failed` 语义已澄清**：`sendUserEmail` 对「管理员无邮箱」同样返回 false，所以该计数含
  「无邮箱」与「SMTP 失败」两种情形，已在类型注释写明，避免运维误读摘要。
- **测试 +13 例**（web 4,700 → 4,713 实测）：防重与发送 12 例（双向子串撞车 / failed 不算已发 / 跨场景跨用户隔离 /
  首发与重扫 / 多管理员各自防重 / 不同运行互不影响 / 开关关闭与默认开 / 发送失败可重试 /
  空输入 / 错误原因截断）+ 任务层接线 1 例 + 既有 114 例全过。
  **测试替身的关键设计**：发送替身成功时**按 transport 真实行为写 `email_log`**，
  这样「重扫不重发」走的是真实防重查询，而不是把防重一起 mock 掉（那就成了空转断言）。
- **真实送达验证（站长提供地址）**：用真实模板 + 真实品牌 + 真实 SMTP 发出一封告警邮件，
  返回 `ok:true`，主题 `运维任务失败：backup.storage（运行 #990001）· 青翼字幕组`。
  **收件人只经 env 注入、临时脚本跑完即删，未写入任何入库文件**（真实邮箱属个人信息，
  `check:secrets` 也会拦）。committed 测试一律用 `example.com` 合成地址。
  本机与生产共用同一真实 SMTP 中继（阿里云 DirectMail），所以本机验证即等价生产链路。
- **一处操作失误已报告**：查 SMTP 主机时脱敏正则假设 scheme 为 `smtp://`，实际是 `smtps://`，
  两条替换均未命中，导致凭据原文出现在工具输出里。已停止回显该串并建议站长按需轮换。

## 12. Step 3 运维欠账（2026-11-13，进行中）

### 已完成：生产检查单实证核对（只读）

M13 遗留「域名/证书/robots/sitemap/性能预算」逐项实测，结果已写入
[OBSERVABILITY.md](../ops/OBSERVABILITY.md) §6：

| 项 | 实测结果 |
| --- | --- |
| 域名 | apex 与 www 均直接 200，无重定向链 |
| 证书 | 通配 `*.qingyisub.top`，2026-11-10 → **2027-02-08** |
| robots.txt | 200，规则正确（禁抓 /admin、/api/、/files、/login、/register、/forgot） |
| sitemap.xml | 200，合法 urlset，**980 条 loc 全为本站域名** |
| 性能预算 | M16.1 部署后生产 LCP 716 / 832 / 948 / 564ms（当前生产即该构建） |
| 健康端点 | 公网 `/api/health` 200 |
| 日志安静度 | 近 24h web error/fatal/unhandled **0**、ops **0**、CSP 违规 **0** |
| slow log | **关闭**（`@@slow_query_log=0`、`long_query_time=10s`）；决策：公测期规模小暂不开 |

**两项据实保持未勾**（不假勾）：
- **外部拨测**：未配置（Step 0 实证）。已把 §1 从「配置建议」升级为**可照做的逐步清单**
  （两条 monitor 覆盖 apex+www、5 分钟间隔、200=up、绑站长邮箱、SSL 到期提醒），
  并给出**配好后的实证核对方法**（查 nginx 日志是否出现周期性外部 `/api/health`，
  而不是只看平台显示 up）。**待站长执行**——注册账号无法代做。
- **digest 次日到达**：**暂无法核对**，因为 Step 1 的接线还在分支上、**尚未部署**，
  生产仍是 M16.1 代码。待 M17 部署后次日复核 `email_log` 的 `scene=digest` 再勾。

### 已完成：两处结论更正

- **告警零邮件的根因**：§9 初版写「渠道默认关」→ 更正为「`opsAlertsJob` 从不调 `sendUserEmail`，
  渠道根本没接线」（Step 2 读实现查明）。
- **台账 drill 只有 1 条**：§9 初版猜「保留期短或近期才启用」→ 更正为**属预期**：
  11-08 是周日、11-13 是周五，11-13 是管线上线后首个周五，此前没有触发点；台账未见截断。
  **不必调整保留策略**，只需再积累几个周五的样本。

### 已完成：回滚演练（站长授权后执行，2026-11-13）

M13 遗留「含一次回滚的完整演练」——**回滚口首次实演，确认可用**。

| 步骤 | 镜像 | 耗时 | 核对 |
| --- | --- | --- | --- |
| 基线 | `ee1f4c254179`（M16.1） | — | healthy，五页 200 |
| 换回旧版 | `1329758bdb66`（M16，tag `20261112-f5a8592`） | **33s** | 实跑镜像 ID 相符；五页全 200 |
| 还原新版 | `ee1f4c254179` | **35s** | healthy；五页全 200；真实浏览器确认 SW 注册回到 `sw.js?v=rcR_qmfbdtVjnKigPNjkX`、壳缓存同名、运行时错误 0 |

- **实测往返 68 秒**，比我事前估的「30–40 秒」长（含健康检查等待）。估算偏乐观，据实记录。
- **流程勘误**：compose 用 `funwind-web:latest` 标签，所以换版靠 `docker tag <日期戳> latest` + `compose up -d`，
  不是改 compose 文件。
- **一处无效判据自查**：我最初用 `curl … | grep 'sw.js?v='` 判别新旧版本——**该判据不成立**，
  这个 URL 是客户端 React prop 里拼的，从不出现在 SSR HTML，两个版本 curl 都是 0 次。
  镜像 ID 比对是有效证据，功能层面改用真实浏览器读 `navigator.serviceWorker` 注册信息才作数。

### 已完成：跨实例恢复演练（不影响线上服务，2026-11-13）

M13 遗留「备份恢复演练签字」——**用生产最新备份恢复到独立实例，全链通过**。

- **先查出一处危险文档缺陷**：`BACKUP.md` §4 的演练命令指向 `/opt/funwind/backups/mysql/`，
  那是 **M13 宿主机 crontab 时代**路径，M14 换 ops 容器后已不再写入，那里只剩 11-08 的遗留文件。
  **照旧文档做演练会把 5 天前的旧备份当「最新」**——这正是演练该抓出的问题。
  真实路径由 ops 挂载决定：`/var/lib/docker/volumes/funwind-backup-files/_data/{db,storage}/`；
  且存储备份是 **tgz 归档不是目录**，旧版 `find` 比对写法不适用。**§4 已按实测全面更正**。
- **备份本身健康**：台账 `path` 字段与磁盘一致；db 与 storage **各保留 9 份**，保留策略正常。
- **演练全链**：最新备份 4,767,862 字节 → scp 本机后 **sha256 与生产双向一致** →
  临时 MySQL 8.4（本机 33622，同版本）→ **导入 3 秒 / 59 表**（schema 56 + 管线自治 3）/ **10763 用户** →
  **`db:verify` 21 项全过** → **bootstrap 幂等**（三列 `_bin` 全「跳过」、新增全 0，证明与当前迁移版本对齐）→
  **存储镜像 2048 文件清单逐条一致 + 抽样 3 个字节级 sha256 OK** → 实例与临时文件清理干净
  （容器 0 / 端口 0 / 目录已删）。
- **签字**：以上为 AI 执行的实测记录，**站长签字待确认**（本步结论已可复核：命令与输出均在 §4 与本文）。

### 待执行（需站长参与）

- **外部拨测配置**：站长执行 §1 清单，我做实证核对后勾选。**这是当前唯一仍无外部探测的故障面**。
- **恢复演练站长签字**：演练已实测通过，等站长确认签字。
- **digest 次日到达**：待 M17 部署后次日复核 `email_log` 的 `scene=digest`。

## 13. Step 4 RUM 采集与落库（2026-11-13）

从零建立真实用户侧可见性：Core Web Vitals + 前端错误采样落库，与 `scripts/lcp.ts` 单点门禁**对照而非替代**。

### 交付

- **新表 `rum_samples`**（照 `email_log` 范式，索引全以 `created_at` 收尾）：`kind`(vital/error) /
  `name` / `value`(LCP/INP 毫秒、CLS×1000) / `route`(脱敏路径) / `detail`(错误摘要) / `created_at`。
  **不存 IP/UA/堆栈/正文**。表数 56→57，迁移 `0027_last_tinkerer.sql`（只建本表，无捎带改动），
  dev 库与 E2E 库均已迁移，`db:verify` 21 项全过。
- **`/api/rum` 端点**：防线照 views 信标（同源→廉价限流→有上限读体→zod 校验→脱敏→落库），
  响应照 csp-report **恒 204** 不泄露状态。复用 `readBodyBytes`/`clientIpFrom`/`rateLimit`/`isSameOrigin`/`redactUri`。
- **采集组件 `RumBeacon`**（挂根布局，零新依赖）：原生 PerformanceObserver（LCP/CLS/INP，`buffered:true`）
  + error/unhandledrejection 只入队 + `keepalive` fetch。**不拖慢首屏三招**：return null 零 DOM、
  idle 延迟注册（buffered 不丢 entry）、首屏绝不发请求（仅 pagehide/转隐藏/60s 定时）。
- **协议拆分**：`protocol.ts`（零依赖常量/类型，双栖）+ `schema.ts`（zod 校验，仅服务端）。

### 我引入又修掉的真缺陷（CSP 硬红线）

- **zod 被拖进每个页面的客户端 bundle**：`RumBeacon` 挂根布局且 import 带 zod 的 `schema.ts`，
  即使只取一个常量，整个 zod 也进每页 bundle——实测多出 zod chunk 并触发 `script-src` 违规，
  **CSP 零违规 E2E 3 条红**。拆出零依赖 `protocol.ts` 后 **11/11 全绿**。这同时是 bundle 体积回归（LCP 风险）。
- **`redactRoute` origin 注入**：客户端传 `https://evil.test/x` 时拼 base 变成 `/https://evil.test/x`，
  外站域名被当路径存下污染 route 维度。改为只接受单斜杠开头的站内路径，否则 `[other]`。

### 自查失误（均已纠正，记录以免再犯）

- **漏改表数断言**：只改了 `schema-rules.test.ts`，漏了 `bootstrap.int.test.ts` 的硬编码 56 → 门禁撞红后补改，
  再全仓扫描确认无残留。教训：改表数要一次扫齐所有断言点。
- **E2E 过滤子串陷阱**：用 `rum` / `rum.spec.ts` 做过滤会匹配到 `stream-fo**rum**.spec.ts`，
  前两轮「绿」其实没跑 RUM。改用路径锚点 `e2e/rum.spec.ts` 才真正跑到。教训：过滤词要带路径锚点。
- **E2E 库缺新表**：直接跑 playwright 不走 `test:e2e:run` 的重置编排，E2E 库无 `rum_samples` →
  对 E2E 库幂等 bootstrap 补建。
- **IP 测试假设错**：默认 `TRUSTED_PROXY_HOPS=0` 不信任 XFF，我传的伪造头不生效。改为显式 stubEnv，
  并新增「默认不信任 XFF、伪造头不能绕过限额」的安全用例。

### 门禁（真实输出）

- `verify:all` 退 0：web **4,746** / db 124 / content 55 / migration 278。
- **LCP 不回退**：120 / 136 / 172 / 68ms（预算 2500）。
- **CSP 零违规** 11/11；**RUM E2E** 2/2（端点错误路径 + 采集组件 pagehide 落库，G-16 兑现）。
- 单测：schema 8 + 端点 19 + 落库 6；边界守卫（server-only/architecture）27/27。

## 14. Step 5 RUM 数据面与保留（2026-11-13）

把 Step 4 采集到的样本变成可查、可聚合、有保留期的运营数据。

### 交付

- **`/admin/rum` 后台页**（`admin.logs` 权限，与审计/邮件同档；NAV_GROUPS 登记「用户监测」，
  过 admin-nav-guard）：类别/指标/路径筛选 + 分页 + 24h 概览 + 各 vital 指标 p75。
  表头/筛选/行单元格均数据驱动渲染。只展示脱敏路径/指标值/错误摘要。
- **`lib/rum/queries.ts`**：`parseRumFilter`（纯函数，非法值回退）+ `queryRumSamples`（分页）+
  `rumSummary`（24h）+ `rumPercentiles`（p75，JS nearest-rank，与 perf-posting 同算法，不引 SQL 窗口函数）。
- **90 天写侧概率清扫**（照 `lib/mail/transport.ts`：1% 概率、`DELETE … LIMIT 1000`，不依赖 SCHEDULER）。

### 重复率棘轮：引入→提取→降到基线以下

照 admin-list 既有模式写新页/新查询层引入了重复（+42 行/+5 clones，棘轮红）。按「提取/复用」消除：
- 抽 `lib/sql.ts`（`escapeLike`/`countRows`/`pageItems`）与 `lib/paging.ts`（`parsePageParam`/`pageLimit`），
  并让 `log-query.ts`/`admin/logs.ts`/`queries.ts` 全部改引用（同时降低了既有基线重复）；
- rum 页 select/表头/行改数据驱动，打破与 mail 页的逐字同构。
- 结果 **duplicatedLines 1399 < 基线 1405、clones 158 < 159**，棘轮绿。
- 自查失误：移除 `desc` 导入时漏了 `rumPercentiles` 仍用它，类型/运行时报错，已补回。

### 门禁（真实输出）

- `verify:all` 退 0：web **4,761** / db 124 / content 55 / migration 278；重复率低于基线。
- 单测：queries 纯函数 + 集成（筛选/分页/转义/24h/p75/清扫触发与不触发）；既有 log-query/admin 测试无回归。
- **RUM E2E 3/3**（重构后复跑）：端点错误路径、采集 pagehide 落库、后台管理员可见+非管理员被拒。

## 15. Step 6 CSP 报告面与转强制评估（2026-11-13）

把 Report-Only 预演收集到的违规从「只记日志靠 grep」变成**可查询落库 + 后台只读面**，并据此数据驱动地评估是否转强制。

### 交付

- **`csp_reports` 表**（表数 57→58）+ 迁移 `0028_wet_lord_hawal.sql`（只建本表 + 3 索引：
  `createdAt` / `violatedDirective+createdAt` / `documentUri+createdAt`）。`schema-rules.test.ts` 与
  `bootstrap.int.test.ts` 的表数断言**两处同步**改 58（吸取 Step 4 漏改教训，一次扫齐）。
- **`lib/csp/ingest.ts`**（server-only）：`recordCspReports` 映射落库（`violated-directive` 缺省回退
  `unknown`、`line-number` 解析、逐字段截断）+ **90 天写侧概率清扫**（1% 概率、`DELETE … LIMIT 1000`，
  照 `lib/mail/transport.ts`，不依赖 SCHEDULER）。
- **`lib/csp/queries.ts`**（server-only）：`parseCspFilter`（纯函数，非法值回退）+ `queryCspReports`
  （复用 `lib/sql` 的 `countRows`/`pageItems` 与 `lib/paging`）+ `cspSummary`（24h 计数 + Top5 指令 groupBy）。
- **`/admin/csp` 后台页**（`admin.logs` 权限，NAV_GROUPS 登记「CSP 报告」，过 admin-nav-guard）：
  指令/文档筛选 + 分页 + 24h 概览 + Top 指令；表头/筛选/行单元格数据驱动渲染。
- **`csp-report` 路由**：在既有脱敏（`redactUri`）/频控/恒 204 基础上并联 `recordCspReports` 落库；
  读体改用共享 `readBodyBytes`（删私有 `readCapped` 副本，符合计划「勿抄私有 readCapped」）。
- **测试**：`queries.test.ts` 纯函数单测 + `csp.int.test.ts` 集成（映射/筛选分页/24h/清扫触发与不触发）；
  E2E `csp.spec.ts`（上报→落库→管理员可查 + 非管理员被拒，document-uri 须传完整 URL）。

### 转强制评估结论（数据驱动，诚实不转）

- **评估依据**：`security-headers` E2E 的零违规清单覆盖前后台主要路径，但**不含 `/admin/themes`**——
  该页编辑器存在 `eval` 违规（E2E 曾见）。观察窗口内违规**未清零**。
- **结论**：本期**只交报告面，不转强制**。转强制开关就是 `lib/security-headers.ts:76` 的 header key
  （Report-Only → 强制），回滚是一行改动。待 `/admin/themes` 的 eval 违规消除（nonce 化或编辑器改造，
  均不在本期）且观察窗口违规清零后，再凭 `/admin/csp` 数据评估转强制。
- 不为转强制而放宽策略；nonce 化不在本期（`security-headers.ts:6-8` 已记录理由）。

### 重复率棘轮：引入→提取→降到基线以下

照 admin-list 既有模式写 csp 页/查询层引入重复（**+31 行/+2 clones**，1436/161 > 基线 1405/159，棘轮红）。
按「提取/复用」消除，而非重锚定基线：
- 抽 `admin-list.tsx` 三个共享件——`AdminDataTable`（列定义→表头、单元格数组→行）、`AdminFilterSelect`
  （筛选下拉）、`AdminListPager`（计数行 + 分页器）；**rum 与 csp 页同改引用**，壳与渲染逻辑集中单一来源。
- 路由删私有 `readCapped`，改复用 `readBodyBytes`（同时消除与 `read-body.ts` 的克隆）。
- 结果 **duplicatedLines 1391 < 基线 1405、clones 157 < 159**，棘轮绿（净消除 45 行/4 clones）。

### 门禁（真实输出）

- `verify:all` 退 0：web **4,771** / db 124 / content 55 / migration 278；重复率 1391/157 低于基线；
  architecture(17)/server-only(10)/admin-nav(5)/motion-architecture(156)/motion-bare-write(30)/scheduler-entry(4) 守卫全绿。
- **CSP E2E 1/1**（重构后复跑，27.7s）：上报→落库→管理员后台可查 + 非管理员被拒。

### 后续

转强制评估留待违规清零（见上）。Step 6.5 两路独立审查 → Step 7 收口 + 部署（M17 各步攒到一起部署）。
