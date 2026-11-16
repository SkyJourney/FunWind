# M19 · 后台管理重塑（IA 重塑 + 拆分合并 + 多尺寸列表 + 筛选基建 + 一致性清账）

- 阶段：四·运营与演进 ｜ 依赖：无（M18 已收口）｜
  状态：🟡 **工程交付完成**（2026-11-17 S0–S5 全部收口，提交至 `39dce10e`，执行记录见 §9；
  verify:all 与全量 E2E 收口门禁 + PR 合并后转 ✅，站长真机清单留观察期）
- 立项动因：站长 2026-11-16 两轮指示——①「整个后台管理的菜单和功能做一次规整，现在用起来有点混乱」，
  列表要有**多尺寸显示效果**、**更多筛选项**；根因认知：「菜单乱也跟不断地加功能有关，现在正好是根据功能重塑后台的一次好时机，
  正好也把列表的样式和统一的组件搞起来，后续菜单就更统一和规整了」；②计划评审追加：「后台菜单的内容，也可以根据功能重新梳理规划，
  **该拆分的拆分，该合并的合并，分组重新定义**，以及是否有**已经废弃的项目**也从后台管理中删除（包括代码清理）」。
- 依据：2026-11-16 两轮只读调研（第一轮 4 路：认证权限/API 层/后台前端/数据模型；第二轮 3 路：菜单守卫 Flash 现状/列表基建与补筛页/接线页与测试基建，
  另含区块级功能盘点与废弃代码猎取），证据全部 file:line。
- 决策定稿（2026-11-16 站长拍板）：D1 页面 title 以菜单短名为准；D2 分页抽象统一组件/函数库、**默认每页统一 20**、档位 10/20/50/100；
  D3 不预建多选控件；D4 UserPicker 搜索化进末步；S5 Flash 键名**全面统一迁移**（`?ok=key`/`?err=code`）；
  **Q1 review 并入 contents；Q2 logo+hero 合一「品牌素材」（decor 维持二级页）；Q3 站点框架拆入站点配置；Q4 节日装扮移到运营排期**。

## 0. 混乱的根因

M9.5 之后又有 6 个批次往 `/admin` 下加页面：M9.6（appeals）、M11.1（decor）、M13（mail/ops）、M11.2（campaigns）、M17（rum/csp）、M18（push 记录页）
——它们是「菜单之外」或「塞进『系统』大杂烩」的。守卫测试只查「菜单→页面」单向（admin-nav-guard.test.ts:119-132），
页面漏登记不报错——**缺的是制度化防漂移，本次一并补上**。此外存在结构性功能重叠与域错位（见 §2 处置表），本次一并重塑。

## 1. 已核实事实（2026-11-16 两轮探查，file:line）

### 1.1 菜单与页面

| # | 事实 | 证据 |
|---|---|---|
| F1 | 可达页面无菜单入口：appeals（唯一入口 users/page.tsx:133）、decor（主题编辑器 theme-pack-editor-form.tsx:255）、mail/preview（mail 页内链）；**decor 菜单项曾被站长拍板移除**（commit `906dd710`「主题素材菜单移除——无用，功能保留」） | users/page.tsx:133；theme-pack-editor-form.tsx:255；git 906dd710 |
| F2 | 图标表停摆在 M9.5 当天（仅 11 项专属图标），其余回落 ClipboardCheck | admin-shell.tsx:36-48,75 |
| F3 | 菜单名 ≠ 页面 title 共 8 处（看板≠数据看板、公告≠公告与站点框架、积分≠积分管理、徽章≠荣誉徽章、用户监测≠真实用户监测、CSP 报告≠CSP 违规报告、主题管理≠主题包、表情≠表情管理） | layout.tsx:38-87 vs 各页 metadata.title |
| F4 | 菜单守卫只单向校验；守卫测试用 TS AST 解析（`parseNavItems` 已导出可复用） | admin-nav-guard.test.ts:39-67 |
| F5 | 「系统」组 9 项杂烩、「站点管理」组 8 项，逐里程碑塞入所致 | layout.tsx:60-86 |
| F6 | /admin 首页按权限落点：admin.logs→看板、版主→review、其余→authz | admin/page.tsx:13-23 |

### 1.2 功能重叠与域错位（拆分/合并的依据）

| # | 事实 | 证据 |
|---|---|---|
| F7 | **review 与 contents 写路径已 100% 共用**（contents/actions.ts:7 import review 的 approve/reject/hide/disable）；但恢复动作只在 review 的 removed tab——M9.5 §9.2-A 站长已拍板「contents 是超集定位、回收站并入」，现状只做了一半 | contents/actions.ts:7；review/page.tsx:308-325；M9.5-admin-ux.md:376 |
| F8 | review/contents 状态口径不一致：review 判主题态用 posts.state，contents 用 threads.state | review.ts:308-311 vs contents.ts:56 |
| F9 | **品牌三页（logo/hero/decor）共用 BrandPoolAdmin 组件 100%**，页面只是配置注入（ERR_TEXT/emptyText/limits/badge/取数顺序）；logo/hero 有「取数顺序刻意相反防克隆」注释——非守卫、合并后自然消亡 | brand-pool-admin.tsx:20-43；logo/page.tsx:26；hero/page.tsx:26 |
| F10 | announcements 页 = 公告 CRUD + 站点框架三卡（导航/友链/页脚，site.nav/links/footer 三键独立 action）；settings 已读 getSiteChrome 且 action 同构（setSetting+invalidateSiteChrome），拆入 settings 冲突极低 | announcements/page.tsx:282-348；settings/page.tsx:109 |
| F11 | ops 页「节日装扮规则卡」是 campaigns 域能力（M11.4），靠「任务存在才渲染」混进运维页；组件自包含迁移成本低 | ops/page.tsx:160-192 |
| F12 | users/[uid] 单页 10 区块双列堆叠（资料/邮箱/限制/角色/会话/台账/徽章/申诉/审计），到分签阈值；actions 全独立无迁移成本 | users/[uid]/page.tsx |
| F13 | authz/forum/[fid] 与 forums/[fid] 是「看/改」配对页，合并存在 admin.roles≠site.admin 门禁冲突——维持二级页；mail/preview iframe 二级页同理 | authz/forum/[fid]/page.tsx:63-68 |

### 1.3 列表基建（M9.5 交付，13 列表页在用）

| # | 事实 | 证据 |
|---|---|---|
| F14 | 筛选控件只有 search 关键词 + 单选 select；无日期范围/排序位；每页条数全部硬编码（logs/mail/rum/csp/push=50、其余 20、ops=25）；密度切换全仓库不存在；服务层 perPage 参数已预留 | admin-filter-bar.tsx:10-72；各页 PER_PAGE |
| F15 | logs 的 `LogFilter.since` 服务层已存在但页面/CSV 未暴露；logs/invites 两页筛选表单是 M9.5 前手写残留 | logs.ts:14；logs/page.tsx:52-75；invites/page.tsx:161-172 |
| F16 | URL 纪律良好：buildAdminQuery（空值/page=1 不进 query）+ Pagination 透传；ops 台账伪总页数 `page+(hasMore?1:0)` 是唯一 pageBounds 例外 | lib/admin/query.ts:6-33；ops/parts/run-ledger.tsx:101 |
| F17 | messages 表无时间/发送者索引（仅 idx_msg_conv）——pm 加时间筛选为全表扫描，量级小可接受，注释标注 | schema.ts:713 |

### 1.4 一致性漂移与死码

| # | 事实 | 证据 |
|---|---|---|
| F18 | Flash 回跳参数名各页自造（err/error/saved/approved/rejected/resolved/dismissed/closed/deleted/reopened/revoked/created/updated/toggled/navErr/linksErr…）；8 页手写回显未用 AdminFlash；campaigns 的 FLASH 表+textOf（Object.hasOwn）是可推广样板 | 各页；campaigns/page.tsx:18-45 |
| F19 | appeals 双重容器（全后台唯一）；空态手写灰字清单（appeals:29、users/[uid]×4、announcements:274、campaigns:168、emojis:275/430、points:161、ops:153/252、authz/forum:98） | appeals/page.tsx:16 等 |
| F20 | UserPicker 候选固定 limit(50)，10,701 用户下基本失效（pm/badges/points 共用）；提交 username 由服务端反查 | user-picker.tsx:26-27 |
| F21 | **确认死码**：`listInvites()`（invites.ts:44-46，仅 int 测试引用）；emojis `moveGroupAction`/`moveEmojiAction`（actions.ts:248/441，全仓零引用）；theme-asset-library `canApplyAsFill/canApplyAsContent/AssetApplyCapability`（:187-196 零引用）；`lib/admin/format.ts` `fmtDate`（:14-19 零引用）；settings 与 themes 同名导出 `saveThemePackAction`（语义不同易混淆） | grep 逐个验证 |
| F22 | **死权限点 4 个**（无任何评估调用）：vote.create、vote.view、tag.edit、tag.manage；删除需动 schema 词表+种子+评估器+单测——**移交 M20**（本来就要动 schema） | authz-vocab.ts:54,56,63-64；evaluator.ts:19-52 |
| F23 | 读兼容旧键（有意保留，记录清理条件）：register.mode、ops.backup.policy；「读但无人写」键：points.gate_fee_rate、punch.reward | lib/auth/settings.ts:28-48；ops-task-seeds.ts:15 |
| F24 | `admin.recycle` 非死权限——唯一真实消费者是 contents 全站视角（contents/page.tsx:77）；review 页注释声称 recycle 可达不成立（requireModerator 会 404 纯 recycle 持有者），合并时一并纠正 | contents/page.tsx:77；review/page.tsx:43 |

## 2. 定位与边界

- **按功能重塑**：拆分/合并/域归位/死码清理全部纳入范围（处置表见 §3.2）；不动 schema 与权限模型（死权限点移交 M20）、
  不改 Server Action 鉴权与审计语义；新增查询能力只按惯例加服务层查询参数。
- **前台零影响**：全部改动限定在 `app/admin/*`、`components/admin/*`、各域 admin 服务层；**不改共享组件本体**
  （Pagination / EmptyState / ui/* 前台在用）；多尺寸/密度做成 admin 内组件。
- **维持现状项**：authz/forum/[fid]、mail/preview、decor 均为二级页（decor 尊重 906dd710 拍板不回菜单）；
  rum/csp/push 不做页间合并（仅同构接线）；/brand/* 公开输出路由不动。
- **不做**：后台 UI 迁移 REST API（M20 的事）；拖拽排序/虚拟滚动等重交互；review 旧路由直接删除（保留永久跳转兼容）。

## 3. 设计基线

### 3.1 菜单 IA v2：按功能域 6 组 24 项（Q1 合并后）

```
总览(1)      看板 [admin.logs]
内容治理(5)   内容管理 [moderate]（吸收审核队列与回收站） · 板块管理 [site.admin] · 举报处理 [admin.reports]
            · 投票管理 [moderate] · 私信管理 [site.admin]
用户与权限(6) 用户管理 [admin.users] · 角色与授权 [admin.roles] · 申诉复核 [admin.users] · 积分 [admin.points]
            · 徽章 [admin.badges] · 邀请码 [site.admin]
站点运营(3)   公告 [site.admin]（瘦身为纯公告） · 运营排期 [site.admin]（吸收节日装扮） · 表情 [emoji.manage]
外观与品牌(2) 主题管理 [site.admin] · 品牌素材 [site.admin]（LOGO/首页横幅页签）
系统与观测(7) 站点配置 [site.admin]（吸收站点框架签） · 审计日志 [admin.logs] · 邮件 [admin.logs]
            · 推送记录 [admin.logs] · 用户监测 [admin.logs] · CSP 报告 [admin.logs] · 运维 [site.admin]
            （API 令牌页随 M20 增设进本组）
```

配套规则：①label 单一事实源（顶层页 metadata.title 与菜单 label 逐字一致，守卫断言）；②**反向守卫**——扫描
`app/admin/**/page.tsx`，每路由必须命中菜单项（精确或前缀父项）或登记于 `SECONDARY_PAGES`/`REDIRECT_PAGES`
允许清单（二级页 6 个 + review/logo/hero 跳转页），否则红灯；③图标全量登记（守卫断言）；④/admin 落点改为
admin.logs→看板、版主→`contents?state=pending`、其余→authz。

### 3.2 处置表（拆分/合并/删除）

| 处置 | 对象 | 内容 |
|---|---|---|
| 合并 | review → contents | 批量审核 UI（checkbox+吸底条）搬入 contents pending 态（保留先到先审正序）；hidden/deleted 行补「恢复」、disabled→deleted 彻底删行内动作；统一状态口径（主题以 threads.state 为准，F8）；`/admin/review` 变 permanentRedirect→`contents?state=pending`；E2E `moderation-review.spec` 与六档场景迁移 |
| 合并 | logo+hero → `/admin/brand?kind=` | kind→config 注入表（ERR_TEXT/emptyText/limits/badge/取数）；旧路由 permanentRedirect；actions 三件套不动；decor 页不动 |
| 拆分 | announcements → 站点框架入 settings | 导航/友链/页脚三卡 + 三个 action 迁入 settings 新签「站点框架」（ChromeRowsEditor 复用）；公告页瘦身 |
| 域归位 | 节日装扮卡 → campaigns | HolidayRuleForm + action 移至 campaigns（保留条件渲染）；ops 减卡 |
| 页内 IA | users/[uid] 三签 | 概览（资料+邮箱）/ 治理（限制+角色+申诉）/ 活动与审计（会话+台账+徽章+审计）；`?tab=` 与台账 `?page=` 共存 |
| 删除 | 死码（F21 清单） | `listInvites()`、emojis 两死 action（连带评估 `list-reorder.ts` 全死则删）、theme-asset-library 三死导出、`fmtDate`、`saveThemePackAction` settings 版改名 `setDefaultThemePackAction`、admin 范围顺手收窄过度导出 |

### 3.3 列表多尺寸与筛选基建

**URL 参数约定**（默认值不进 query，非法回落）：`?size=` 档位白名单 10/20/50/100、**默认统一 20**（logs 系 50→20、ops 25→20）；
`?density=` cozy（默认）/compact 两档（AdminTable/AdminDataTable 加 density prop + `densityCellClass()` 供手写表格）；
`?from=`/`?to=` 日期范围（原生 date input，北京墙面时间，to 含当天）；排序位沿用 AdminFilterSelect 模式（users 已有）。
`AdminListPager` 加可选 `controls`（每页 AutoSubmitSelect + hidden 保留参数 + density 链接切换，noscript 回退；不传时渲染与现状一致）。
新建 `parseAdminListParams`（lib/admin/query.ts）与 `admin-date-range.tsx`。

**五页补筛选**（服务层只加查询参数）：logs（回流 FilterBar + 日期 + targetType 下拉 + actor 换 UserPicker + until + CSV 透传）、
reports（关键词 + 日期，idx_reports_status 支撑）、pm（日期，无索引注释标注）、announcements（title LIKE，无 created_at 不做时间）、
invites（日期 + 批次表单回流 FilterBar）。

### 3.4 一致性清账

**Flash 全面统一**：`?ok=key`（成功）/`?err=code`（失败）；新建 `lib/admin/flash.ts`（`flashText(table,key)`，
Object.hasOwn 防原型污染，样板 campaigns textOf）；每页声明 FLASH/ERR_TEXT 表（文案不变）；全部 admin 页 actions redirect 键
+ 页面读取迁移；手写回显 8 页（settings/points/authz×2/forums×2/emojis/logo/hero→brand）换 AdminFlash；grep 验证无残留旧键。
appeals 摘双重容器；空态统一 EmptyState（F19 清单）。**UserPicker 搜索化**：`/api/admin/users/search`
（同源+session+requireAdmin("admin.users") JSON 语义，复用 searchUsers，limit 10）+ user-picker 改轻量客户端组件
（提交 username 语义不变）；pm/badges/points 调用点 props 不变。

## 4. 实施步骤（S0–S5，每步收口汇报，经站长确认再进下一步）

| Step | 内容 | 要点 |
|---|---|---|
| S0 | 立项登记与文档修订 | ROADMAP 四行 + 依赖说明；本文档 v2 修订 |
| S1 | 功能拆分/合并 | §3.2 处置表五项逐个落地（review→contents、品牌素材页、站点框架入 settings、节日装扮归位、users/[uid] 三签），每项收口跑相关 E2E + 架构守卫 |
| S2 | 菜单 IA 与守卫 | NAV_GROUPS v2 + 图标全量 + title 拉齐 + 三条新守卫断言 + test:visual 基线重录 |
| S3 | 列表基建扩展 | parseAdminListParams + DateRange + density + AdminListPager controls + 单测 |
| S4 | 各页接线 | 14 页 size/density（默认统一 20）+ 五页补筛选 + int 测试 + 新 E2E admin-lists.spec + 六档矩阵两场景 |
| S5 | 一致性清账 + 死码清理 | Flash 全面统一 + appeals/空态 + UserPicker 搜索化 + 死码删除 |

## 5. 验收门禁

- `pnpm verify:all` 退出 0；E2E（prod 全量 + dev 冒烟）；`test:visual` 8/8（S2 重录基线后）；`pnpm test:layout` 六档矩阵。
- 新增守卫断言全绿（反向 + label===title + 图标覆盖）；服务层新增查询参数有真实临时库集成测试。
- CHANGELOG 条目（标注 review 页退役、logs 系默认 50→20、菜单重排）；本文档执行记录回写；真机清单（站长勾选）。

## 6. 决策记录（2026-11-16 全部定稿）

| # | 决策 | 结论 |
|---|---|---|
| D1 | title 拉齐方向 | 以菜单短名为准（页面 title 改短） |
| D2 | size 档位与默认 | 分页抽象统一组件/函数库；默认全站统一 20；档位 10/20/50/100 |
| D3 | 多选控件 | 不预建（无真实场景，出现需求再增补） |
| D4 | UserPicker 搜索化 | 进 S5 末位 |
| Q1 | review 并入 contents | 合并（完成 M9.5 §9.2-A 既定意图） |
| Q2 | 品牌池 | logo+hero 合一「品牌素材」；decor 维持二级页（尊重 906dd710 拍板） |
| Q3 | 站点框架 | 拆入站点配置新签 |
| Q4 | 节日装扮 | 移到运营排期页 |
| Q5 | Flash 键名统一范围 | 全面统一迁移（?ok/?err + 每页 FLASH 表） |

## 7. 风险

- **合并回归面**：review 是版主日常第一站——contents 待审态必须完整承接批量审核与正序队列；E2E `moderation-review.spec` 全量迁移并保持断言强度。
- **状态口径**（F8）：合并时统一主题态为 threads.state，防「review 能看到、contents 看不到」类回归——用集成测试钉死。
- **Flash 迁移面宽**：约 20 页 + 存量 E2E 旧键断言，放 S5 末位集中做、grep+守卫双重验证。
- **菜单肌肉记忆**：一次性适应成本；各页 URL 不变（review/logo/hero 旧链接永久跳转兼容）。
- **前台误伤**：共享组件本体禁改，E2E 前台核心路径回归兜底。

## 8. 遗留移交（不在本里程碑）

- 死权限点删除（vote.create/vote.view/tag.edit/tag.manage）→ **M20**（随 schema 变更一并做）。
- register.mode、ops.backup.policy 读兼容键清理条件 → M20 设计时定（如「全量库已写新键后删兼容层」）。
- points.gate_fee_rate、punch.reward「读但无人写」→ M20 决策补 UI 或声明 SQL-only。
- Firefox 真机回归、站长真机清单 → 收口后观察期。

## 9. 执行记录（2026-11-16/17，S0–S5 全部收口）

> 分支 `feat/m19-admin-console-reorg`，8 个提交逐 Step 留痕；每步收口跑相关 E2E + 架构守卫，全量门禁在收口节。

### 提交清单

| Step | 提交 | 内容 |
|---|---|---|
| S0 | `424164a3` | ROADMAP M19–M22 四行 + 本文 v2 修订（Q1–Q5+D1–D4 决策记录） |
| S1-1 | `e3c6be0a` | review→contents 合并 + ConfirmSubmit 误拦修复 + E2E/矩阵迁移 |
| S1-2 | `eb9423dd` | 品牌素材页 ?kind= 页签 + pool-actions 回跳安全化 |
| S1-3 | `caebe6c2` | 站点框架入 settings + announcement-audit 补页脚用例 |
| S1-4 | `ff630beb` | 节日装扮归位 campaigns（回执并入 FLASH 表） |
| S1-5 | `743dfa65` | users/[uid] 三签 + users 域七动作回跳带 tab |
| S2 | `77edb993` | 菜单 IA v2 + 图标全量 + title 拉齐 + 三条守卫断言 |
| S3 | `ab5353f2` | parseAdminListParams + DateRange + density + Pager controls |
| S4-A/B | `7427a0e9`/`f215bb85`/`709e6bbc` | 五页补筛选 + 14 页 size/density 接线 + ops 真分页 |
| S5 | `39dce10e` | Flash ?ok/?err 统一 + 空态/回显收编 + UserPicker 搜索化 + 死码清理 |

### 过程发现与修复的存量缺陷

1. **ConfirmSubmit 表单级误拦**（S1-1 钓出）：确认门监听整表单 submit，共享表单里点「批量通过」会误弹
   「批量驳回」确认框且确认后以驳回 formAction 提交——即 M9.5 起 review 页批量通过在真实浏览器从未
   可用（只有 mock 单测无 E2E）。修复为仅拦 `event.submitter === 本按钮`，补共享表单回归测试。
2. **回跳硬拼 `?`**：threadFlagsAction 在已带 query 的 back 上硬拼产生畸形 URL → `appendQueryParam`
   统一（S1-1 引入，后续 S1-3/S1-4/S1-5 复用）。
3. **GET 表单双值**（S4 钓出）：FilterBar 的 hidden from/to 与 AdminDateRange 可见输入同名，GET 提交
   产生同名双值，Next 归并成数组后日期校验静默失效——hidden 改为仅透传 size/density，日期输入独占承载。
4. **审计日志「查看」按钮中等视口折行**（六档矩阵新场景 admin-logs-filters 首扫发现）→ whitespace-nowrap。

### 门禁实测（收口节，2026-11-17）

- `pnpm test` 全量单测（含临时库集成）exit 0；`pnpm --filter @funwind/web typecheck` 0 错；
  pre-commit（lint-staged prettier + 全 workspace eslint）逐提交全绿。
- 六档布局矩阵 18/18（含 S4 新增 users-list-controls / logs-filters 两场景，限 admin 视角）；
  视觉基线重录后双向 10/10；admin-lists E2E 3/3（size/密度 URL 保持、logs 筛选+CSV 透传、
  invites 日期两态、UserPicker 候选下拉真实点击）。
- Step5 相关 13 个 E2E 全量重置库实测全绿（announcement/badges/points/emojis/governance/email/
  ops/campaigns/moderation/admin-lists/settings-admin/admin-mail/hero）；全量 E2E 与 verify:all
  见下方收口门禁。

### 遗留（移交与观察期）

- 死权限点删除（vote.create/vote.view/tag.edit/tag.manage）→ **M20**（随 schema 变更）。
- register.mode、ops.backup.policy 读兼容键清理条件 → M20 设计时定。
- points.gate_fee_rate、punch.reward「读但无人写」→ M20 决策补 UI 或声明 SQL-only。
- Firefox 真机回归、站长真机清单勾选 → 观察期。
- dev 冒烟 E2E（3200）与全量 prod E2E 未在本节单列的用例随收口门禁一并跑。
