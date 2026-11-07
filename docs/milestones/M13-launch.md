# M13 · 部署与社区重启

- 阶段：三·上线 ｜ 覆盖模块：P4 ｜ 依赖：M9 + M12（全部功能就绪）
- 状态：🚧 实施中（2026-11-07 开工。探查完成：三专项并行核实，事实 F1–F11、决策 D1–D6 经规划审批——
  生产镜像与编排从零建（全仓唯一 Dockerfile 是 dev 模式），301 纯静态映射（id 恒等），备份/可观测最小自建，
  默认站标 = 清爽侦探半翼（管线自动初始化 + 检查单双保险），默认主题 = default 现代浅色，召回全量分批限速。
  开工后站长追加拍板：D7 部署拓扑（MySQL 独立编排 + 单 SSR 容器 + 宝塔反代）、D8 排序规则家族 unicode_ci）
- 设计基准：M12 交付（安装管线 / install:cli / migration/README / README 零数据部署）；BLUEPRINT §4.5 URL 冻结表；
  M6-carryover M13-1…M13-7；EMAIL-SCENARIOS S8 召回管线；SCHEDULED-JOBS §2 部署注意事项。
- 分支：`feat/m13-launch`；上线演练执行（Step 7）由站长在服务器主导，本里程碑交付全部脚本、配置与演练手册。

> **执行纪律**：每个 Step 单独提交、单独过门禁，完成后回写 §9 并汇报，站长确认后再进下一步；
> 门禁以真实命令输出为准（不套管道），冲突先改文档再动代码。§1 记录**已在代码/环境里核实过**的事实，
> §6 记录决策，二者不要混读。

## 目标

生产部署与社区重启：域名切换、旧 URL 301、备份与监控、老用户邮件召回——四阶段规划的收官。
**阶段三完成标志：社区重启**（ROADMAP §阶段划分）。

## 1. 已核实事实（2026-11-07 探查，行号/路径佐证）

| # | 事实 | 位置 | 对设计的影响 |
|---|---|---|---|
| F1 | id 恒等：`threads.id=旧 tid`、`posts.id=旧 pid`、`forums.id=旧 fid`、uid 原样保留 | `migration/src/transform/content.ts:256,338`；`forums.ts:118`；`users.ts:129` | 301 是**纯静态映射**（无需查库），nginx 层即可；锚点 `#p{pid}` 已冻结 |
| F2 | 全仓唯一 Dockerfile 是 dev 模式（`docker/dev/web.Dockerfile`，CMD `pnpm dev`）；无 nginx/Redis 定义、无 `/api/health`、无备份脚本；应用无 standalone output——生产运行需整仓 + node_modules + 根 .env 在场 | `docker/`；`apps/web/next.config.ts`（无 output 字段） | 生产镜像/compose/健康端点/备份脚本全部从零建；产物形态保持「整仓 + env 外置」 |
| F3 | SMTP 凭据嵌在 `SMTP_URL` 连接串内（阿里云 DM）；`THEME_PREVIEW_SECRET` 多实例必填已文档化；`TRUSTED_PROXY_HOPS` 生产必填已文档化 + 运行时报错兜底；M12 文档称「向导自检提示 TRUSTED_PROXY_HOPS」与代码不符（向导自检只有 Node 版本与存储可写） | `.env`；`.env.example:42-49`；`apps/web/src/lib/net/client-ip.ts:13-17`；`app/install/page.tsx:129` | 密钥管理 = 部署层 env_file 分离（无代码改动）；向导自检补一行提示顺带修出入 |
| F4 | 导入路径 users 非空：install:cli/向导的站点设置与管理员写入被防重装拒绝；管理员由旧 gid 3/4/5 推导 | `lib/install/run-install.ts` installTargetGuard；`migration/README.md:45-48` | 上线品牌（LOGO）与站点初始化不能依赖向导——需独立幂等运维命令 + 检查单 |
| F5 | 召回链已建：S8 模板/digest 管线/认领（30 天令牌 + 强制换密门）；缺**批量发送器**；旧用户 ≈1.07 万，通道为阿里云邮件推送 | `docs/EMAIL-SCENARIOS.md:47-56`；`lib/mail/`；`lib/notifications/digest.ts` | 召回发送器 = S8 手动变体：分批限速 + email_log 防重 + dry-run 默认 |
| F6 | 备份对象 = MySQL 数据卷 + STORAGE_DIR（hex 桶 + site/；.cache/.tmp 可弃）+ 根 .env + 旧库最终转储（签字前不删）；表情随 git（public/emoji） | `docker/qysub-next/compose.yaml:22`；`lib/uploads/thumbnail.ts:4` | 备份脚本覆盖四对象；恢复演练到临时实例 |
| F7 | 表情迁移展开到 `public/emoji/{id}.gif` 随 git 发布；旧 `/attachment/**`、`/emotion/**` 已退役（`/files/**` 接管），旧外链 301 归 M13 评估 | `migration/src/config.ts:36`；`app/files/[...key]/route.ts:5`；BLUEPRINT §4.5 | 旧 attachment/emotion 外链返回 **410**（比 301 更诚实）而非映射 |
| F8 | 多实例清单（G-17 1–5 + G-18）现状均为单实例语义且注释内建 M13 指向；三个配置动作 = THEME_PREVIEW_SECRET / TRUSTED_PROXY_HOPS / nginx client_max_body_size ≥50MB（M13-3） | `lib/auth/ratelimit.ts`、`lib/views/`、`lib/authz/snapshot.ts`、`lib/events/outbox.ts`、`lib/theme/catalog.ts`、`lib/scheduler/` | 处置 = 检查记录文档节 + 配置动作；**不改造为多实例**（G-17 原文：未处置前不得改拓扑） |
| F9 | favicon 缺失（无 favicon.ico/app/icon.*）；manifest/PWA 图标已自动跟随 LOGO 池（≤5 分钟收敛）；`NEXT_PUBLIC_LOGO` 静态回退链有素材无文档 | `app/manifest.ts`；`app/brand/pwa-icon/[size]/route.ts`；`components/site/site-header.tsx:13-54` | favicon 顺带补齐（从定稿图生成入库）；`NEXT_PUBLIC_LOGO` 补文档 |
| F10 | npm audit 现状未测（安全走查含「npm audit 高危清零」）；CI 无部署 job（部署 = 站长服务器单机 compose 手工） | `.github/workflows/ci.yml`；M13 边界「不做容器编排平台」 | 安全走查入 Step 5；交付物标准 =「本机 docker 可验证 + 服务器可照做」 |
| F11 | 「清爽侦探半翼」定稿图 = `apps/web/public/logo/qy2010.png`（224×224，与 M10.5 二次元稿 `qy-二次元-03清爽侦探动画-224.png` 同字节；源稿 1254×1254 在 ~/Pictures/LOGOS/QYISUB）；LOGO 池机制/后台/联动已完备（`lib/brand/`、`/admin/logo`、`applyPackLogo`）；**install:cli 不写 site.logo** | `docs/LOGO-POOL.md`；`lib/theme-packs.ts:31-35`；`storage/site/logo-*` 实测同 MD5 | 默认站标走 D2：管线自动初始化 + `init-brand` 运维命令 + 检查单 |

## 2. 与视觉类里程碑的本质差异（为什么 M13 大量工作是「配置与脚本」）

部署里程碑的产物是**运维资产**（Dockerfile、compose、nginx conf、备份脚本、演练手册），不是应用代码。
判定标准随之不同：应用代码由单测/E2E 守护，运维资产由「本机 docker 实测 + 服务器可照做」守护——
每个交付物必须在本机 docker 环境真实起过、断言过，才允许进入演练手册；真实上线由站长按手册在服务器执行。

## 3. 范围与 Step 分解（2026-11-07 规划版）

> 分支 `feat/m13-launch`；Step A → 1 → 2 → 3 → 4 → 5 → 6 由 AI 实施，Step 7 由站长主导执行。

**Step A · 文档先行**：重写本文件（§1 事实 F1–F11、§6 决策 D1–D6、§3 分解、§5/§7/§8 门禁与检查单、§9 执行记录）；
BLUEPRINT §4.5「M12 实施」笔误勘误（301 归 M13）；ROADMAP M13 改 🚧。只改文档。

**Step 1 · 健康端点 + 生产镜像**：
- `/api/health`：DB ping + STORAGE_DIR 可写探针 → `{status:"ok",db,storage}`；失败 503 且不泄露细节；无鉴权（拨测用）。
- `docker/production/Dockerfile`：多阶段 builder（node:24-alpine，corepack，全仓 install + db:build + next build）→
  runner（非 root，HEALTHCHECK 打 /api/health）。**不做 standalone**（保持整仓 + env 外置形态，F2）。
- 本机 docker build + 容器冒烟（容器起、health 200）。

**Step 2 · 双编排 + 宝塔 nginx 反代（D7 修订版）**：
- `docker/mysql/compose.yaml`（基础设施独立编排，与 app 解耦）：MySQL 8.4 容器，绑 `127.0.0.1:3306`
  （退役旧 MariaDB 后即得标准端口；独立卷 `funwind-mysql-data`，未来其他服务可直接复用此库）。
- `docker/production/compose.yaml`（应用编排）：**单个 SSR 容器**（Next.js，连 127.0.0.1:3306，env_file .env）。
  **不含 nginx 容器、不含 Redis**（D5/D7——宝塔系统级 nginx 已持 80/443 与现成证书）。
- 宝塔 vhost conf（交付物）：改现有 `www.qingyisub.top` 站点为反向代理（proxy_pass → 127.0.0.1:3311）+
  `client_max_body_size 64m`（M13-3）+ **301 映射块**（F1 全集）+ TLS 用既有证书路径。
- 301 用例集（本机宝塔 nginx 或临时 nginx 容器 + Host 头，≥20 条）：read/thread/simple/space/分页/锚点/410。

**Step 3 · 备份与恢复（含旧栈退役序列，RUNBOOK 详版）**：
- **退役序列**（上线窗口内、站点未开放时执行）：① MariaDB 全量 dump 归档（--default-character-set=utf8mb4
  转码输出）→ ② 停 MariaDB 服务 + php-fpm 5.6/8.3 + Flarum vhost（3306 腾出）→ ③ MySQL 8.4 独立编排起 3306 →
  ④ 归档恢复为 `qingyisub_legacy` 源库（迁移源；备选：迁移直接在线读 MariaDB，演练时两条都验证取稳者）。
  数据卷保留至站长签字，不删数据。
- 迁移源口径（演练验证后定稿）：主路径 = 在线读 MariaDB（迁移本为 GBK 源设计）；备选 = 归档恢复库。
- `scripts/backup/backup-db.sh`（mysqldump --single-transaction 全备 + 保留 N 天轮转 + binlog 说明）、
  `backup-storage.sh`（rsync 增量，排除 .cache/.tmp）、`docs/ops/BACKUP.md`（恢复到临时实例 → db:verify → 切换；
  旧库最终转储命令）。本机对 dev 库实测一轮备份 → 恢复 → db:verify 绿。

**Step 4 · 社区重启包**：
- 默认站标（D2）：`scripts/init-brand.mts`——幂等（site.logo 已有 active 即跳过），把 `public/logo/qy2010.png`
  入池（name「清爽侦探半翼」）+ 设当前（审计 via=cli）；安装管线 site-settings 步骤调用同一逻辑（零数据安装即得品牌）；
  导入路径上线检查单执行 `pnpm init-brand`（F4）。
- favicon（F9）：从定稿图生成 `app/icon.png` + `favicon.ico` 入库（一次性 sharp 脚本，产物入库运行时不依赖）；
  `NEXT_PUBLIC_LOGO` 补文档。
- 批量召回（D4）：`scripts/recall-blast.mts`——S8 变体，分批限速（每批 N 封 + 批间隔）、email_log 场景+用户防重、
  失败重试上限、**dry-run 默认（--apply 才真发）**；白名单过滤（已注销/禁言/无邮箱）；预加载钩子纪律。
- `docs/ops/OBSERVABILITY.md`（D3）：日志前缀约定表、拨测配置建议、告警触达验证步骤、Sentry 留作后续。
- 向导环境自检补 TRUSTED_PROXY_HOPS 提示行（F3 出入修正）。

**Step 5 · 全量回归与安全走查**：全量 E2E + 安装 E2E + visual 基线零更新 + layout + lighthouse + perf:posting +
`pnpm audit --prod` 报告 + 安全走查清单（Cookie/CORS/CSP/密钥不入库，对照 M6-carryover M13-4）。

**Step 6 · 收口与演练手册**：`docs/ops/LAUNCH-RUNBOOK.md`（两次演练含一次回滚的逐步清单 + 切换日动作序列：
公告 → 邀请码批次 → `pnpm init-brand` 核对 → 召回发送）+ 多实例检查单处置记录节 + CHANGELOG +
BLUEPRINT「上线实录」占位 + M13 文档 ✅（演练执行项留站长）+ PR 合并（CI 双绿）。

**Step 7 · 上线执行（站长主导）**：按 RUNBOOK 在服务器两次演练（含回滚）→ 正式切换 → 品牌核对 → 公告/邀请码 →
召回发送 → 验收门禁逐项勾选（AI 配合远程排查与文档回写）。

## 4. 边界（明确不做什么）

- 不做容器编排平台/K8s、CDN、多可用区、自动化 CD（单机 compose + 手工部署符合当前规模）。
- 不做旧站双写/灰度并存（一次性切换 + 回滚预案）。
- 不引入 Redis / 不改造多实例（G-17 只要求检查记录，D5）；不做对象存储迁移（M13-6 仅记录）。
- 不接 Sentry（D3 最小自建；后续可选）。
- 不做人机验证、Web Push（遗留事项，视重启后反馈立项）。

## 5. 测试规则（2026-11-07 版）

- **运维资产**：本机 docker 实测（镜像 build → 容器起 → health 200；nginx 容器 301/410 断言）；
  备份脚本对 dev 库实测一轮备份→恢复→db:verify 绿。
- **301 用例集 ≥20 条**：read.php/thread.php/simple/space/分页/锚点/attachment 410/未知名 404；
  生产核对时再对真实域名抽 20 条旧帖。
- **应用回归**：全量 E2E、安装 E2E、visual 基线零更新、layout+summary、lighthouse、perf:posting 全过；
  既有断言零改动。
- **安全走查**：npm audit --prod 高危清零；密钥不入库复查（check:secrets）；Cookie/CORS/CSP 核对清单。

## 6. 决策记录

### 6.1 已拍板（站长 2026-11-07，随规划审批确认）

- **D1 上线默认主题** ✅ default 现代浅色；qy2010 保持可选情怀包（2026-11-01 决策延续）。
- **D2 默认站标** ✅ 清爽侦探半翼（F11 定稿图）——安装管线幂等初始化 + `pnpm init-brand`（导入路径）+
  上线检查单复核，三重覆盖。
- **D3 可观测** ✅ 最小自建：/api/health 拨测 + 结构化日志约定 + 告警触达验证（停服演练）+ digest 日级汇总；
  Sentry 不在本里程碑。
- **D4 召回** ✅ 全量分批限速（≈1.07 万用户，分批 + 防重 + dry-run 默认）。
- **D5 生产 compose 不含 Redis** ✅（规划显式偏离 M13 原文「含 Redis」）：代码零 Redis 消费者，
  多实例前置记入检查单——加无消费者的容器是死重。
- **D6 部署形态** ✅ 站长自有服务器单机 compose 手工部署；CI 保持纯验证；真实演练/切换站长主导。
- **D7 部署拓扑（站长 2026-11-07 敲定）** ✅ MySQL 8.4 **独立编排**（`docker/mysql/compose.yaml`，退役旧
  MariaDB 后接管 127.0.0.1:3306，独立卷，未来其他服务可直接复用）+ 应用编排**仅单个 SSR 容器**（不含
  nginx 容器、不含 Redis）+ 80/443 与 TLS 由宝塔系统级 nginx 承担（改现有 vhost 为反向代理）。
- **D8 排序规则家族（站长 2026-11-07 拍板）** ✅ 家族默认 `utf8mb4_0900_ai_ci`（MySQL 8 专有）→
  **`utf8mb4_unicode_ci`**（整个 MySQL 系可移植；与 general_ci 相比保留重音不敏感语义、国际排序更准）。
  三列 _bin（username_key/email_key/gate_key）与 rehearsal username 的 _as_cs 为刻意保留的区分性特例。
  既有库由 bootstrap 幂等对齐（唯一索引先摘、_bin 恢复后按终态重建——假名数据不受影响）；
  全部 CREATE DATABASE 语句、本地 dev compose、CI MySQL 服务、迁移 rehearsal 已同步。

### 6.2 待确认

无。

## 7. 门禁标准（2026-11-07 版）

| 层级 | 标准 |
|---|---|
| Step 门禁（1–5） | `pnpm verify:all` 退出码 0；本步新增用例/实测全过；回归断言零改动 |
| 里程碑收口（Step 6） | verify:all / 全量 E2E / 安装 E2E / visual 基线零更新 / layout+summary / lighthouse PWA 100/100 / perf:posting p95<300ms / `pnpm audit --prod` 高危 0 / PR CI `verify`+`e2e` 双绿 / AI 读图目视（health 响应、nginx 301 表现、品牌初始化后的顶栏与 manifest） |
| 上线门禁（Step 7，站长执行） | 本文件「验收门禁」原文逐项：演练两次含回滚、301 用例全绿 + 旧帖抽样 20 条直达、备份恢复签字 + 告警触达验证、生产检查单（域名/证书/robots/sitemap/性能预算）、CHANGELOG + BLUEPRINT 上线实录 |
| 分支纪律 | `feat/m13-launch` → PR → CI 双作业通过后合并 main；不 force push；不触碰开发库 `qysub_next` 与旧库 |
| 执行规则 | 以真实命令输出为准，验证命令不套管道；失败先定位，疑似偶发单独复跑并如实报告；守卫测试全绿；每步实测记录写入 §9 |

## 8. 多实例与规模前置检查单（上线门禁 G-17/G-18，处置记录节）

> 当前实现为单实例语义。以下为多实例/规模扩展前的强制核对项：任何一项未处置前不得改拓扑。
> M13 的处置 = 逐条「记录」写入 LAUNCH-RUNBOOK 附录 + 三个配置动作落地。

1. 限流/上传并发闸/浏览量计数换共享存储（M13-1）——**记录：单实例语义维持**（`lib/auth/ratelimit.ts:3`、`lib/views/counter.ts:3`）。
2. authz 快照失效通道（globalThis）——**记录：单实例语义维持**（`lib/authz/snapshot.ts`）。
3. outbox 自愈巡检迁调度器——**记录：候选，未做**（`lib/events/outbox.ts:249`；M13-launch 原文同口径）。
4. THEME_PREVIEW_SECRET 显式一致——**配置动作**：生产 .env 显式配置（`lib/theme/preview.ts:19`）。
5. 跨实例缓存收敛窗口（主题目录/emoji 30–60s TTL）——**记录：单实例可接受**。
6. G-18 集合规模 ≤5——**核对：导入器不写 theme_packages，不会超额**。
7. 先 db:bootstrap 再部署（M11.6 Step 5）——**操作项**：已有库先跑幂等 bootstrap（导入路径已隐含）。
8. M6-carryover M13-1…M13-7——TRUSTED_PROXY_HOPS（配置动作）、client_max_body_size ≥50MB（nginx conf 落地 64m）、
   旧会话核对、孤儿文件巡检（db:gc-files 报告）、对象存储（记录）、HTTP 基准（部署环境补测）。

## 9. 执行记录

- [x] Step A 文档先行（2026-11-07）：§1 事实 F1–F11、§6 决策 D1–D6、§3 分步、§5/§7/§8 门禁与检查单重写；
      BLUEPRINT §4.5「M12 实施」笔误勘误；ROADMAP M13 改 🚧；`pnpm format:check`、`pnpm check:secrets` 通过（退出码均 0）。
- [x] 前置变更：排序规则家族切换 0900_ai_ci → unicode_ci（D8，2026-11-07）：14 处 CREATE DATABASE、
      dev compose/CI 服务端级默认、migration rehearsal 同步；bootstrap 新增幂等家族对齐
      （0900 表 CONVERT 为 unicode_ci；唯一索引先摘、PATCHES 恢复 _bin 后按终态重建——users 表
      さくら/サクラ 实测不受影响）。dev 库 qysub_next 已实测对齐（55 表全 unicode_ci、三列 _bin 完好、
      db:verify 21 项全过、二次 bootstrap 幂等）；db 包 119 用例（新增对齐用例）与 `pnpm verify:all` 全绿。
- [ ] Step 1 健康端点 + 生产镜像：
- [ ] Step 2 生产 compose + nginx 301：
- [ ] Step 3 备份与恢复：
- [ ] Step 4 社区重启包：
- [ ] Step 5 全量回归与安全走查：
- [ ] Step 6 收口与演练手册：
- [ ] Step 7 上线执行（站长主导）：

## 验收门禁

- [ ] 演练全流程两次通过（含一次回滚）（Step 7，站长执行）
- [ ] 301 用例集全绿；旧帖抽样 20 条直达新页面
- [ ] 备份恢复演练签字；监控告警触达验证（人为制造一次错误）
- [ ] 生产检查单（域名/证书/robots/sitemap/性能预算）逐项通过
- [ ] CHANGELOG 记录；BLUEPRINT 补「上线实录」

## 遗留事项

- 人机验证、Web Push——视重启后社区反馈立项。
- 任务引擎、银行、抽奖、多币种已于 M5.5 决策**取消**，不再立项。
- （收口时回写）Sentry 集成、Redis 多实例改造、对象存储迁移均为「检查记录」级后续项。
