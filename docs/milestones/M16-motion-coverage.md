# M16 · 动效补全与全站审计（已收口）

- 阶段：四·运营与演进 ｜ 依赖：M15（已收口上线公测）｜ 设计基准：[motion-spec](../motion-spec.md)、[M10.5-S4](../M10.5-S4-VISUAL-MOTION.md)
- 状态：✅ 已收口（2026-11-12 立项 → 同日完成 Step A/0/1/2/3/4/4.5/5 全流程；PR #14 CI 双作业绿合并 main（`f5a8592`），生产部署公测（镜像 `funwind-web:20261112-f5a8592`，回滚点 `funwind-web:20261112`），两路独立审查 P0×1+P1×8 全清（报告见 [docs/reviews/2026-11-12-m16-code-review.md](../reviews/2026-11-12-m16-code-review.md)）；执行记录见 §6–§12）
- 上线口径：延续 M15 D4（本地灰度 + 门禁全绿即发布线上公测）

## 目标

1. **无障碍补正**：弹层在系统减弱动效下的行为修正（现存唯一 reduce 硬缺口）。
2. **引擎闲置能力变现**：元素钩子（onInView/onEnter）、状态级驱动（playStateTransition）、float-up 预设、页面 preset 体系全部产生业务消费。
3. **覆盖补齐**：进场编排未覆盖的 7 类列表、29 处无动效交互、全站图片加载过渡。
4. **场景补足**：主题/明暗切换交叉淡化、门控解锁 reveal、公告横幅过渡、悬浮名片进出场等 M15 探查新发现场景。
5. **返回键动画可行性实验**：实验先行，验证不过则维持诚实跳过（不伪装）。

## 1. 已核实事实（2026-11-12 两路只读探查 + 自查，全部 file:line 佐证）

> **时点说明**：本表是**实施前**的现状快照（F1–F15），记录的是「立项当时缺什么」——表内行号与状态均为探查时点值。实施结果见 §7–§12（如 F6「弹层 reduce 硬缺口」、F11「无回顶按钮 / 锚点瞬跳」、F8「主题切换瞬跳」等均已在 Step 1/2/4 落地）。读当前状态请以 §12 与 motion-spec §6.3 为准。

| #   | 事实                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 对 M16 的影响                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| F1  | 引擎底座：四级体系全站上线；但**元素钩子（onInView/onEnter/onExit/onUpdate）业务零消费**，状态级 `playStateTransition`（engine/native.ts:39-69）仅 /design/motion 演示页使用，`float-up` 预设（engine/presets.ts:67）零业务消费；L1 类（fw-pop/roll/float-up/enter/fade-in）业务消费仅 like-toggle、follow-toggle 两组件                                                                                                                                                                                                                                         | 「补足」的本质是把闲置能力接到真实场景，引擎侧基本零改动                     |
| F2  | 进场编排缺口 7 类：`/boards` 板块卡网格、`/t/[tid]` 回复楼层、`/search` 结果、`/a` 归档、`/me` 我的主帖、`/submit` 可发帖列表、`/messages/[convId]` 气泡+上滑历史（chat-history.tsx:204-211 未走 stream-list 的追加淡入机制）                                                                                                                                                                                                                                                                                                                                    | MotionList 逐类包裹即可，DOM 零变化                                          |
| F3  | L1 缺失交互 29 处，重点：复制按钮文案瞬变（admin/copy-code.tsx:22-24、json-viewer.tsx:48）、未读徽标瞬现（notification-bell.tsx:107-114、bottom-tab-bar.tsx:146-150、me/page.tsx:80）、通知已读瞬变（notification-row.tsx:58-64）、投票结果条宽度瞬跳（poll-block.tsx:68-73）、门控解锁内容瞬现（gate-block.tsx:147）、签到成功无反馈（checkin/index.tsx:75-81）、AdminFlash 瞬插拔（admin-flash.tsx:28-44）、密码显隐瞬切（password-field.tsx:32-36）、头像上传全程无动效（avatar-uploader.tsx:48-94）、附件面板/上传无进度反馈（attachment-panel.tsx:325-413） | 按组件逐个补，多数是挂现有 fw-* 类                                           |
| F4  | hover/press 不一致：手写 chips/按钮大量 `hover:bg-*` 无 transition-colors（f/[fid] 前缀 chips:147-161、标签云:124-134、通知分类:84-93、AdminTabs:30-33、筛选条、分页 pagination.tsx:25-53、门控按钮:55-61、搜索提交按钮:57-62）；ForumDirectory 卡 hover 变边框但卡体不可点（forum-directory.tsx:31）；回复楼层 Card 无 hover 无进场（t/[tid]:310-355）                                                                                                                                                                                                          | 语义一致性问题（不只是动效），需与「可点面积」一起统一                       |
| F5  | 弹层清单：Dialog/Sheet/DropdownMenu/Popover/Tooltip 均有 tw-animate 动效且时长对齐令牌（overlay-durations.test.tsx 在案）；**HoverCard（用户名片，全站最高频悬浮触点）零动效**（user-hover-card.tsx:115-120）；下拉一律原生 select（无动效空间）；sonner 是唯一 reduce-safe 动效面（其 dist 自带 reduce 全禁）                                                                                                                                                                                                                                                   | HoverCard 补 fade 进出场（对齐 popover 口径）                                |
| F6  | **弹层 reduce 硬缺口**：tw-animate-css dist 无 prefers-reduced-motion 规则——Dialog/Sheet/Dropdown/Popover/Tooltip/HoverCard 在系统减弱动效下照常动画；globals.css reduce 块只覆盖 fw-* 类与 VT 伪元素（222-249、464-470）；Step 4.5 审查记录在案未修                                                                                                                                                                                                                                                                                                             | 全局 CSS 兜底一条规则即可覆盖全部 tw-animate 弹层，不换库                    |
| F7  | 图片加载过渡全站缺失：正文 content-md img（rich-content.tsx:9-14）、FeedCard 封面（:66-71）、Avatar fallback→image 瞬跳（avatar.tsx:27-35）、板块图、首页 hero、上传预览——无一有占位/淡入；Lightbox 已有库动效不需动                                                                                                                                                                                                                                                                                                                                             | 需要统一图片显影方案（占位背景 + 淡入），注意 SSR 直出与懒加载混合           |
| F8  | 主题切换瞬跳：明暗 = next-themes data-mode + `disableTransitionOnChange`（layout.tsx:143-148，有意防闪烁）；主题包 = `dataset.pack` 直写（theme-menu.tsx:47-66）+ startTransition PATCH 持久化；两者均无交叉淡化；`playStateTransition` 就绪未接线，reduce/无 API 自动降级直改                                                                                                                                                                                                                                                                                   | 状态级 VT 交叉淡化是引擎现成能力，包住属性写入即可                           |
| F9  | 加载态：路由级 loading.tsx **全仓 0 个**；真实页面零骨架（skeleton 仅 /design 演示用）；编辑器源码模式加载占位是空白 min-h-48（editor-shell.tsx:40-43，skeleton animate-pulse 现成未用）；请求期反馈 = fw-nav-progress + data-nav-busy + toast（M10.7 已拍板「真内容随提交，不推迟内容」）                                                                                                                                                                                                                                                                       | 不引入路由级骨架（哲学延续）；编辑器占位属组件级可裁量                       |
| F10 | 公告横幅（announcement-banner.tsx:21-85）挂载/关闭瞬插拔，是全站唯一直接推挤内容的元素；主题预览提示条同样无动效                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 过渡 + 布局跳动一并考量                                                      |
| F11 | 滚动行为：锚点 #p{pid} 瞬跳（原生 hash 导航，无 scroll-behavior:smooth、无楼层高亮）；无回顶按钮；ReplyFab 是全仓唯一组件级 reduce 处理（motion-reduce 内联）；页面切换不恢复滚动（Next 默认，collapse 兜底已适配）                                                                                                                                                                                                                                                                                                                                              | 锚点平滑滚动 + 楼层高亮为一行级 CSS/少量 JS；回顶按钮可裁量                  |
| F12 | 编辑器内部：模式切换（editor-shell.tsx:223-227 setMode+重挂）、门控块插入、预览出现、表情页签均无过渡；上传走 fetch 无 progress 事件；工具栏三类弹层已达标                                                                                                                                                                                                                                                                                                                                                                                                       | 记录现状供裁量；不作为 M16 主线                                              |
| F13 | 返回键：bundled react-dom 只处理 popstate（无 Navigation API 遍历集成）；现路径 popstate 同步提交诚实跳过（M15 决策）；可行路线三条——① Navigation API intercept 后主动重驱动（历史栈污染风险）② 手动 startViewTransition 包 popstate 提交（与 Next 内部时序耦合）③ 维持跳过                                                                                                                                                                                                                                                                                      | 必须 Step-0 式实验先行，三条路线 + 滚动恢复/历史栈风险实测，验证不过维持跳过 |
| F14 | FLIP：现有排序/筛选**全部 URL 驱动**（搜索排序 search/page.tsx:69-74、通知分类:78-96、admin 列表、用户主页 tab）——已有页面过渡，原位重排场景今天不存在                                                                                                                                                                                                                                                                                                                                                                                                           | FLIP/onUpdate 本期不实现，引擎预留维持；若未来加客户端重排再立项             |
| F15 | 探查新发现 12 项：UserHoverCard 无进出场（最高频触点）、横幅零动效、编辑器加载死白、门控解锁 reveal（expand 管线可复用）、主题切换瞬跳、锚点瞬跳、admin 抽屉导航时序、通知 chips 两态不对称、error/not-found 页未盘点、投票条瞬跳、CopyCode 失败路径静默（交互反馈缺失非动效）、邀请码「高亮定位」疑似只有锚点无视觉动效（需实测）                                                                                                                                                                                                                               | 纳入范围裁量                                                                 |

## 2. 边界（明确不做什么）

- **不动 Radix / tw-animate-css 体系本身**：弹层 reduce 缺口用 globals.css 全局规则兜底（对 animate-in/out 类归零），不换库、不改第三方 dist（延续 M15 §2）。
- **不引入路由级 loading.tsx / 骨架屏**：M10.7 拍板「真内容随提交、不推迟内容」，请求期反馈维持进度条 + busy 态 + toast 体系。
- **FLIP / onUpdate 本期不实现**（F14：无真实原位重排场景）；引擎预留不删。
- **编辑器内部动效最小化**：工具栏弹层已达标不动；模式切换/上传进度/门控插入仅记录，默认不做（站长可点名）。
- **返回键不伪装**：实验验证不过就维持诚实跳过；不为了动画而破坏历史栈/滚动恢复语义。
- 不引入第三方动效库（零依赖栈延续）；裸写守卫与令牌纪律全程有效。

## 3. 范围（Step A 定稿）

| 级别     | 场景                                                                                                                                                                               | 对应事实         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 无障碍   | 弹层 reduce 全局兜底（含 HoverCard 若补动效）                                                                                                                                      | F6/F5            |
| 高感知   | 主题包/明暗切换状态级 VT 交叉淡化；门控解锁 reveal；公告横幅过渡；UserHoverCard 进出场；图片加载淡入体系（正文图/封面/头像/hero）                                                  | F8/F15/F10/F5/F7 |
| 覆盖补齐 | 7 类列表 MotionList；onInView（深层楼层滚入、图片显影驱动）；L1 补齐（复制反馈、徽标 pop、已读过渡、投票条、签到、AdminFlash、密码显隐、chips transition 统一、附件/头像上传反馈） | F2/F1/F3/F4      |
| 实验先行 | 返回键动画三路线实验（含滚动恢复与历史栈实测）；邀请码高亮实测；error/not-found 页盘点                                                                                             | F13/F15          |
| 明确不做 | FLIP/onUpdate、路由级骨架、编辑器内部动效主线、原生 select 弹出                                                                                                                    | F14/F9/F12       |

## 4. 推进线（2026-11-12 计划模式批准）

> 分支 `feat/m16-motion-coverage`，每 Step 提交该分支并汇报；Step 4.5 审查通过后 PR → CI 双作业绿 → 合并 main → Step 5 生产部署。不 force push。

- **Step A · 文档定稿**：本档补记 D1–D5 决策；motion-spec 增补（弹层 reduce 兜底规则、图片显影规范、状态级 VT 主题切换契约、onInView 消费契约、reveal/横幅/HoverCard 口径）；S4 头部指针。
- **Step 0 · 可行性实验**（结论回写 §6）：① 返回键三路线（Navigation API 重驱动 / 手动 startViewTransition 包 popstate / 对照跳过；动画、滚动恢复、历史栈、生产构建实测）；② 主题切换 VT（交叉溶解、PATCH 失败回滚不闪烁、与页面导航 VT 互不干扰、reduce 降级）；③ 图片显影 × LCP（hero/首屏大图淡入对 LCP 计入的影响，定首屏豁免规则；lazy 图与 onInView 配合）。
- **Step 1 · 无障碍兜底**：globals.css 一条全局规则让 tw-animate 弹层（Dialog/Sheet/Dropdown/Popover/Tooltip）在 reduce 下归零（不换库、不改第三方 dist、不误伤 sonner）；HoverCard 补进出场（对齐 popover fade 口径）；新守卫断言 reduce 块覆盖弹层类。
- **Step 2 · 高感知场景**：主题包/明暗切换状态级 VT 交叉淡化（与 next-themes `disableTransitionOnChange` 的配合按 Step 0 结论）；门控解锁 reveal；公告横幅出现/关闭过渡（含布局跳动缓解）；返回键动画若 Step 0 验证通过则本步落地。
- **Step 3 · 图片显影体系**：共享显影方案（占位背景 + onLoad 淡入，组件化）应用到正文图、FeedCard 封面、Avatar、板块图、首页 hero（按 Step 0 豁免规则）、上传预览；**LCP 不回退**为本步重点门禁。
- **Step 4 · 覆盖补齐**：进场编排 7 类（/boards、/t 楼层、/search、/a、/me、/submit、messages 气泡+上滑历史）；onInView 消费（深层楼层滚入）；L1 批量（复制反馈含失败路径、未读徽标 pop、通知已读过渡、投票结果条、签到成功、AdminFlash、密码显隐、chips transition 统一、附件/头像上传反馈、楼层 hover 与 ForumDirectory 语义统一）；锚点平滑滚动 + 楼层高亮 + 回顶按钮；编辑器 lazy 占位 skeleton（D5）。
- **Step 4.5 · 收口前独立审查**（M15 模式）：两路自查 P0/P1/P2 报告——reduce 双口径全站走查复核、新增场景与规范零漂移、既有动效零删减、守卫覆盖、LCP 红线、文档一致性；整改后站长交互验收。P0/P1 未清不合并部署。
- **Step 5 · 收口与生产部署**：PR → CI 双作业绿 → 合并 main → 生产部署（RUNBOOK 流程复用，amd64 防呆）→ 部署后核对（公测冒烟 + **生产 reduce 走查** + LCP 对比 + 告警安静）→ 文档收尾。

**每 Step 门禁基线**：`pnpm verify:all` 退出 0；既有动效行为零删减（微交互 15 例 E2E 不动）；visual 基线核对（占位背景类改动先定截图策略）；LCP 不回退；裸写守卫/架构守卫全绿；reduce 双口径走查。新增交互至少一条错误/降级路径（G-16）。

## 5. 决策记录（2026-11-12 计划模式批准）

- **D1 返回键**：实验先行——Step 0 三路线实测（含滚动恢复与历史栈风险），验证不过维持 M15 的诚实跳过，不伪装。
- **D2 主题/明暗切换**：**状态级 VT 整页交叉溶解**（站长拍板）——复用引擎 `playStateTransition` 包住属性写入，reduce/无 API 自动降级直改；不采用 CSS transition 局部过渡（与防闪烁初衷冲突）。
- **D3 图片显影**：占位背景 + onLoad 淡入，组件化可扩展；**首屏 LCP 元素豁免规则由 Step 0 实验定**。
- **D4 锚点/回顶**：纳入——锚点平滑滚动 + 楼层高亮 + 回顶按钮。
- **D5 编辑器**：**只修 lazy 加载死白**（skeleton animate-pulse 替代空白）；其余编辑器内部不动（站长拍板）。

## 6. Step 0 可行性实验结论（2026-11-12，实验③独立静态台 + 实验②真机接线 + 实验①/ m16-lab 三路线；实验页已删）

| #   | 实验                 | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 证据                                                                                 |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | 图片显影 × LCP       | **淡入使 LCP 推迟 ≈ 过渡时长**：同一 0.98MB 首屏大图，无显影 LCP≈40ms，onLoad 淡入后 LCP≈310ms（快网）；慢图（+800ms）872ms→1100ms——Chromium 在 opacity 渐入元素**动画结束（完全不透明）**时才计入 LCP。muted 占位底色救不回（纯 background-color 不构成 LCP 候选，实测占位变体 LCP 条目中无占位元素）。**豁免规则：首屏视口内可能成为 LCP 的图片直接渲染不挂淡入；首屏外 lazy 图片全部显影**                                                                                               | /tmp 独立静态台（0.98MB 基线 JPEG × 三变体 × 快/慢网，PerformanceObserver 全时间线） |
| 2   | 主题切换 VT          | **四项全过**：① 交叉溶解生效（`html[data-vt=fade]` + root `vt-fade-in/out` 播放）；② 属性落快照正确（旧帧 light→新帧 dark；next-themes 的属性写在 effect 里异步，须在 VT 内同步预写 data-mode——`theme-motion.ts` 已实现，system 就地解析）；③ reduce 降级无 VT、直改生效；④ 与页面导航 VT 共存互不干扰（同序列中状态级 `vt:fade` 与页面级 `vt:null` 各自正常）。PATCH 失败回滚保持直改（既有 9 项 jsdom 测试通过）。**接线代码保留在分支（`theme-motion.ts` + 4 个切换点），Step 2 补 E2E** | 真机 3100 + VT 探针（含 root 伪元素采样）；`theme-menu.test` 9/9                     |
| 3   | 返回键三路线         | **intercept 路线可行，predrive 否决**：② intercept（Navigation API 拦截遍历 + 手动状态级 VT，update 等 popstate）——返回动画完整播放（root 溶解）、**历史栈零污染**（长度稳定）、前进键正常、URL 正确、dev 与生产构建一致；③ predrive（preventDefault + router.push 重驱动）——**前进键实测失效**（返回后前进仍停原页，历史栈污染实锤）否决；① baseline 现状无动画。intercept 仅覆盖 lab 范围遍历、Navigation API 不支持时优雅回退 baseline                                                   | m16-lab 三路线（实验页已删）+ Playwright 三状态断言 × dev/prod                       |
| 4   | **新发现（全站级）** | **返回滚动恢复全站失效（既有缺陷，非 M16 引入）**：真实页板块(滚动 800)→主题→浏览器返回→scrollY=72（期望 800），dev/prod、baseline/intercept 一致；实验首版测得「三模式全 0」曾系实验页不足视口高（max scroll=0）的测量缺陷，加高后真实页复核实锤。intercept 不改变该行为（与 baseline 同坏同好）                                                                                                                                                                                           | 真实页 /f/109→/t→back 实测（prod 3411）                                              |

**Step 0 决策落点**：① 图片显影按豁免规则实现（Step 3）；② 主题切换 VT 接线已验证保留（Step 2 补 E2E 与 next-themes `disableTransitionOnChange` 共存核对——实验中未见冲突）；③ 返回键采用 intercept 路线（Step 2 落地：nav-kind-capture 扩展为可拦截遍历并驱动状态级 VT，支持 Navigation API 的浏览器生效、其余优雅回退）；④ **Step 2 增补范围：根因修复返回滚动恢复**（全站级既有缺陷，优先级高于动画本身）。实验页 `src/app/m16-lab/` 已删除（无 spec 引用，无残留）。

## 7. Step 1 无障碍兜底（2026-11-12）

- **弹层 reduce 全局兜底**（globals.css）：tw-animate-css 自身不提供 reduce 规则，Dialog / Sheet /
  DropdownMenu / Popover / Tooltip 的 animate-in / animate-out 在 reduce 下照播——**不换库、不改第三方
  dist**，改为一条全局规则归零：`[class*="animate-in"], [class*="animate-out"] { animation: none !important }`。
  **子串匹配**是关键（教训：裸 `.animate-in` 漏掉 `data-[state=open]:animate-in` 变体形态）；sonner 自带
  reduce 全禁、Lightbox 由库管理，两者不使用 tw-animate 类，不在兜底面内。
- **HoverCard 进出场**（content/user-hover-card.tsx）：此前只有出现无退场，补 animate-in /
  `data-[state=closed]:animate-out` + fade-in-0/fade-out-0（对齐 popover 的 fade 口径与时长令牌）。
- **守卫**（motion-bare-write-guard.test.ts）：新增断言钉住 reduce 块须含 animate-in/out 兜底且**真归零**
  （`animation: none !important`）——防回归（Step 4.5 又扩展到 animate-pulse 归零）。
- **测试**：新增 e2e/reduce-overlays.spec.ts 4 例（主题下拉 × 正常/reduce、用户悬浮名片 × 正常/reduce）：
  reduce 下断言 computed animationName 为 none、正常下为 tw-animate 的 enter。
- **门禁**：`pnpm verify:all` 退出 0；E2E reduce 断言 4 例全过；visual 10 项基线零更新。

## 8. Step 2 高感知场景（2026-11-12）

- **返回滚动恢复（全站级缺陷修复，本步最重交付）**：根因三层叠加——① Chrome 对软导航 history API 调用
  会丢弃条目滚动存档；② Next 的 ScrollHandler 每次 commit 都会滚顶（流式页面分次 commit、滚顶多次晚到）；
  ③ Next 恢复历史时的 replaceState 记账会派发 navigate(replace)，此时 scrollY 已是滚顶残值。
  修复（nav-kind-capture）：**链接点击捕获**（document capture，必早于滚顶）快照离开页滚动（max-guard：
  UA 上滚取元素不覆盖用户更深位置）+ 导航锁（4s，锁期间忽略该页记录覆盖）+ 持续滚动记录经
  **sessionStorage 持久化**（正文 markdown 链接渲染为 target=_blank 新标签、普通站内 <a> 是整页跳转——
  两者的返回都是 back_forward 整页加载，内存表会丢）+ back_forward 加载挂载时按记录恢复（先修被初始
  record 写 0 的条目）+ 恢复循环带**用户让位**（wheel/touch/滚动键立即取消）。
- **返回键动画落地（intercept 路线）**：同站 traverse 拦截驱动状态级 fade（update 等 popstate），
  同站判定用 destination.origin 比对（跨站不拦截）、intercept 特性检测（jsdom 等优雅回退诚实跳过）。
- **主题切换 VT**：`theme-motion.ts`（Step 0 已接线）补正式 E2E——交叉溶解 data-vt=fade + root 动画、
  reduce 无 VT 直改、mode 正确切换。
- **门控解锁 reveal**：`gate-reveal.tsx`（GateUnlockButton/GateReplyLink 打标记 + GateReveal 消费标记
  淡入一次）；首次访问已解锁内容不播；reduce 归零。
- **公告横幅过渡**：出现 fw-fade-in；关闭 grid-rows 1fr→0fr 折叠（缓解布局跳动）+ motion-reduce:transition-none。
- **测试**：单测 nav-kind-capture 8→12（VT 生命周期/跨站不拦截/点击快照 max-guard/replace 不写快照）；
  E2E 新增 motion-step2.spec 4 例（滚动恢复+返回动画+前进键 / 用户让位 / 主题 VT×reduce / 门控 reveal）；
  架构守卫全仓扫描用例显式超时 20s（全仓 AST 扫描是套件最重单用例，并行全量 5s 默认超时不够——仅测试
  基建调整，断言不变）。
- **门禁**：`pnpm verify:all` 退出 0（web 4,591 / db 124 / content 55 / migration 278，jscpd 持平）；
  E2E 定向 70 例全过（motion-step2 4 + gates 14 + reduce-overlays 4 + micro-interactions 15 +
  page-motion-pilot 19 + page-transition 14，**既有动效零删减**）；visual 10 项、**基线零更新**
  （motion-step2 自建线程经 afterAll 清理，不污染首页信息流基线）。
- **边界**：横幅关闭的折叠过渡 150ms+220ms 卸载，既有 E2E 无横幅断言（人工目视随 Step 4.5 验收）；
  返回滚动恢复的用户让位窗口 4s 内用户滚动生效，4s 后无对抗（用户此后自由滚动）；Step 3 图片显影未开始。

## 9. Step 3 图片显影体系（2026-11-12）

- **共享组件 `FadeImage`（ui/fade-image.tsx，客户端原子）**：bg-muted 占位底色 + 加载完成前
  opacity-0 + onLoad 后挂 fw-fade-in 淡入一次；状态机 hidden→fading→（CSS 收尾）。
  - **eager 豁免**（Step 0 实验③）：首屏 LCP 图片直接渲染——不懒加载、无任何显影类；
  - 缓存命中（挂载即 complete）：直接显示不播动画（load 事件已错过，重播是噪音）；
  - 加载失败也置 shown（露出 alt/破图态，不无限隐藏）。
- **正文图委托 `ContentImageFade`**：content-md 经 dangerouslySetInnerHTML 无法逐图挂
  React onLoad——客户端组件自发现未处理的 .content-md 容器（data 标记幂等），逐图判断：
  缓存已加载不动（无闪烁）；首屏视口内不动（LCP 豁免）；视口外置 loading=lazy + 挂
  fw-img-fade（未加载隐藏 / load 后过渡显影 / error 也显影）。
- **CSS**（globals.css）：`.content-md img.fw-img-fade` 未 loaded opacity 0、loaded 过渡显影
  （fw-dur-base/ease-out 令牌）；**自带 reduce 媒体查询**（opacity 1 + transition none——
  过渡不归动画兜底覆盖，须单独规则）。
- **应用面**：FeedCard 封面、/boards 板块图、me/u 大头像（FadeImage）；AvatarImage 挂
  animate-in fade-in-0 duration-fast（Radix 仅在加载成功后挂载，天然只播一次）；
  content-md 视口外正文图（委托）；**首页 hero 未动**（首屏 LCP 元素，豁免）。
- **单测**：FadeImage 4 项（懒加载隐藏→淡入 / eager 无显影类 / 缓存命中不播 / 失败显示）。
- **门禁**：`pnpm verify:all` 退出 0（web 4,595 / db 124 / content 55 / migration 278，
  jscpd 持平）；E2E 定向 70 例全过；visual 10 项**基线零更新**（显影终态 = 原图，静态截图
  等价；占位底色 bg-muted 与原图重合不产生像素差）；**LCP 不回退**：开发迁移库四页实测
  72 / 132 / 188 / 84ms 全部低于 2,500ms 预算（豁免规则生效——首页 hero 直接渲染）。
- **边界**：上传预览（avatar-uploader/attachment-panel）本步未接显影（上传过程反馈属
  Step 4 范围）；emoji 面板小图未接（装饰性、可见性无碍）；ContentImageFade 只在挂载时
  扫描一轮——后续 JS 动态插入的正文图（当前不存在）不处理。

## 10. Step 4 覆盖补齐（2026-11-12）

- **进场编排 7 类**：/t 楼层（MotionList 首 10 错落 + FloorReveal 深层滚入）、/search 结果、/a 归档、
  /me 我的主帖、/submit 可发帖列表、/boards 板块卡网格、chat-history 上滑加载追加淡入
  （MessageBubble 增 className 透传）。除 /t 楼层外均MotionList 声明式包裹（页 1 播放、深页不重播）。
- **FloorReveal 深层滚入淡入**（ui/floor-reveal.tsx）：三态状态机 direct/pending→fade
  （Step 4.5 定稿）——SSR 与首帧一律直出（不推迟 LCP、无水合 mismatch、无 JS 也可读全文）；
  IO 首次回调完成分类：相交或本体已入可视视口（折叠线楼层）→ direct 直出（MotionList 错落
  照常）；完全在视口外 → pending（opacity-0 挂起，施加时楼层仍不可见、无闪烁窗口）；此后
  首次滚入触发区（底部收窄 80px）→ fade 永久显影、**滚出不回退**。direct 不挂 fw-fade-in，
  与 fw-enter 无同元素声明序竞争；className/style 透传承接 MotionList 注入的错落类与延迟。
- **L1 批量**（18 文件，全部既有 fw-* 类/令牌工具类，无裸写）：复制成功 fw-pop + 失败文案反馈
  （copy-code/json-viewer）；未读徽标 fw-pop + key 重播（铃铛/底部 Tab）；通知已读 transition；
  投票结果条 transition-[width] duration-spring；签到成功 fw-pop；AdminFlash 出现 fw-fade-in；
  密码显隐图标 fw-fade-in + key；chips transition-colors 统一（版块前缀/标签云/通知分类/AdminTabs/
  筛选条/分页/门控按钮）；AdminTable 行悬停；看板柱条 transition-colors；附件面板收起
  grid-rows 折叠（展开保持瞬现——常挂方案会引入空容器布局回归，实测后弃用）。
- **锚点与回顶（D4）**：SmoothAnchors（同页 #锚点点击 → scrollIntoView 平滑 + pushState 写 hash +
  JS 挂 fw-floor-hl-on 高亮类 2.1s——**pushState 不触发 Chromium :target 激活**，故深链与点击分两路）；
  深链直开的 :target 高亮走 CSS 规则；BackToTop 桌面右下（滚动超一屏出现、smooth 回顶、reduce 瞬时）。
- **编辑器 lazy 占位（D5）**：源码模式加载占位用 Skeleton 脉冲替代空白块（其余编辑器内部不动）。
- **测试**：E2E 新增 motion-step4.spec 4 例（31 楼自建夹具线程：首屏 10 错落 computed 断言 /
  深层滚入 wrapper fade / 锚点点击高亮 + hash / 深链 :target；回顶含出现-点击-隐藏全链）；
  attachment-panel/admin-tabs 既有测试适配（展开延迟卸载 / transition-colors 类断言）。
- **门禁**：`pnpm verify:all` 退出 0（web 4,595+（FadeImage 4 + attachment/admin-tabs 适配）/ db 124 /
  content 55 / migration 278，jscpd 持平）；E2E 定向 **74 例全过**（motion-step2 4 + motion-step4 4 +
  gates 14 + reduce-overlays 4 + micro-interactions 15 + page-motion-pilot 19 + page-transition 14，
  **既有动效零删减**）；visual 10 项、**基线零更新**；**LCP 不回退**：四页实测 116 / 260 / 296 / 104ms
  全部低于 2,500ms 预算（开发迁移库）。
- **边界**：看板柱条生长动画、pref-toggles 私信 chips（已有 transition）、avatar-uploader/attachment
  上传过程进度反馈不在本步；楼层 Card 无 hover（不可点元素不加悬停反馈，与探查建议一致）。

## 11. Step 4.5 收口前独立审查与整改（2026-11-12）

两路代理并审（安全架构路 + 规范文档路），全文见
[docs/reviews/2026-11-12-m16-code-review.md](../reviews/2026-11-12-m16-code-review.md)。
**P0×1 + P1×8 全部整改复验，P2 整改 6 项、在案 5 项。** 要点：

- **P0-1 FloorReveal 重写**（ui/floor-reveal.tsx）：三态 direct/pending→fade（§10 记录已同步
  修正）——SSR/首帧直出不推迟 LCP；IO 首回调分类（setState 全在订阅回调内），折叠线楼层
  直出防「闪现→消失」，视口外 pending 挂起，滚入触发区单向 fade；direct 不挂 fw-fade-in，
  与 fw-enter 无声明序竞争；E2E 收紧（滚入前 opacity-0 断言 + 错落 animationName 钉住）。
- **P1 BackToTop**：ReplyFab 同款常驻口径（display 恒不切换，过渡恢复生效；隐藏态
  pointer-events-none + inert + aria-hidden；移动端 base hidden 不与 ReplyFab 重叠），
  E2E 重写为状态断言并新增移动端断言。
- **P1 恢复循环**：停止函数模块化（activeRestoreStop/cancelRestoreLoop），换页/卸载统一取消
  （不跨页强滚）；keydown 捕获标志补齐（原 removeEventListener 漏 capture 永远泄漏）+ IME
  组合键守卫。
- **P1 锚点×滚动存档**：存档抽为共享模块 **site/scroll-record.ts**（采集/导航锁/800ms 节流
  落盘/pagehide 刷盘/容量上限）；SmoothAnchors 点击先 pinScrollAtCurrent 钉住点击前位置——
  从锚点历史项返回回到点击前位置（浏览器原生语义）；traverse intercept 增加同页守卫
  （from !== to）：同页历史移动不再播整页 fade。motion.pop 同 key 记账路径保持（既有单测
  钉住，整改中误加同页提前 return 被 3 例单测当场拦下）。
- **P1 杂项**：poll-block 投票条补 motion-reduce:transition-none（§6 第 6 条口径成文于
  motion-spec）；globals.css reduce 块补 .animate-pulse 归零（守卫断言钉住）；M16 文档
  shell 残片清理；[m16dbg]/lockStates/__y 探针等调试残留清除；S4 头部 §6.5 指针更正；
  Avatar 兜底注释更正。
- **门禁**：verify:all 退出 0（web 4,595 + db 124 + content 55 + migration 278）；E2E 动效
  定向 **74 例全过**（既有动效零删减）；visual 10 项**基线零更新**；**LCP** 生产构建四页
  84 / 140 / 208 / 76ms 全部达标。


## 12. Step 5 收口与生产部署（2026-11-12）

- **收口前置优化（站长拍板）**：`verify:all` 的 build 步骤以 `NEXT_DIST_DIR=.next-verify` 运行——生产构建不再覆盖
  本机 dev 正在使用的 `.next`（当日实证过一次撞库：dev 报错，重启 + 清产物恢复）；eslint ignores 与 .gitignore 同步；
  Next 重写 tsconfig 补 `.next-verify` 类型路径已入库。另：vitest `testTimeout` 对齐 `hookTimeout`（30s）——CI 2 核
  runner 上全库扫描型守卫（gate-wording-guard 5.3s / server-only-guard）随机撞默认 5s，连续两轮各红一个后统一放宽。
- **PR #14**：CI 第一轮 verify 红（gate-wording 超时）→ 修；第二轮红（server-only-guard 超时）→ 上条根治；第三轮
  **双作业绿（verify 9m11s / e2e 17m35s）** 合并 main（merge commit `f5a8592`，保留 M16 分步提交历史）；收尾文档推送后 main 留档 run `43193288025` success。
- **生产部署（仅 web）**：本机 `docker build --platform linux/amd64` → save/load → inspect 核对 amd64 → tag
  `funwind-web:20261112-f5a8592`（**同日 tag 已被 M15 占用**，追加 merge commit 短哈希防覆盖回滚点）→ compose up。
  无 schema 迁移、ops 管线未触碰。回滚点 `funwind-web:20261112`（M15，545040330cd0）。
- **部署后核对**：容器 healthy；公测五页全 200；M16 资产 SSR 标记上线（回顶按钮常驻口径 + 页顶隐藏态、楼层包裹层
  无隐藏类=直出契约生效、`fw-fade-in` 无 SSR 泄漏）；应用日志与 CSP report 零异常；ops 管线安静（30m 零 failed）。
  **生产 LCP 公网实测（含 RTT）**：首页 1156 / 版块 608 / 帖子 1004 / 搜索 600ms，全部远低于 2.5s 预算。
- **站长目视验收**：六项清单（共享段过渡/楼层滚入/锚点高亮与返回位置/回顶/主题交叉溶解/reduce 双口径）通过后执行
  本步（2026-11-12「基本没啥问题，可以进入step5」）。

## 13. 遗留事项

> **2026-11-12 扫尾专项前置探查更正**：本节初版有两处失实陈述与两条已完成项，据实修正如下。

**仍是缺口（转扫尾专项）**：

- BackToTop / SmoothAnchors 的 reduce 降级：**单测与 E2E 双缺**（初版称「组件单测已覆盖」失实——
  `back-to-top.test.*` / `smooth-anchors.test.*` 均不存在）。两者 reduce 是点击时的 JS 参数分支
  （behavior auto / 不挂 `fw-floor-hl-on`），不能套用弹层的 animationName 断言，需 emulateMedia +
  行为断言或 scrollTo/scrollIntoView 探针。
- GateReveal 失败路径：**无单测、E2E 只覆盖成功路径**（初版称「失败路径已有单测」失实）。
  行为本身按设计无害：解锁失败 → 内容仍 locked → GateReveal 不渲染 → stale 标记留在 sessionStorage，
  下次成功时消费并淡入一次（把动画记账到下一次成功）。
- ContentImageFade：**无任何测试**；全页 `.content-md` 扫描 + 仅挂载扫一轮（无 MutationObserver）；
  `sanitize.ts` 在 SSR 期已给所有白名单 img 设 `loading="lazy"`，组件 effect 期再设属冗余
  （对已开始加载的请求无取消作用），真实增量是淡入类与 load/error 显影监听。优化按设计挂起
  （等真实长图场景），但测试缺失应补。

**已完成（初版误列为待办）**：

- CLAUDE.md 的 M16 口径注入：已于 Step 5 完成（CLAUDE.md 当前阶段段 / 动效管线小节 / M16 增补资产明细）。
- 站长交互目视验收：已于 Step 5 前通过（见 §12），不再是待办。
