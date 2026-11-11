# M16 · 动效补全与全站审计（执行版）

- 阶段：四·运营与演进 ｜ 依赖：M15（已收口上线公测）｜ 设计基准：[motion-spec](../motion-spec.md)、[M10.5-S4](../M10.5-S4-VISUAL-MOTION.md)
- 状态：🚧 执行中（2026-11-12 立项：站长提议「M15 后全面审视当前项目所有动效并补足缺失场景」，8 项候选与探查新发现全部纳入；前置探查定稿 F1–F15，**推进线与 D1–D5 已经计划模式批准**，分支 `feat/m16-motion-coverage`；Step 0 尚未开始，未合并 main、未部署生产）
- 上线口径：延续 M15 D4（本地灰度 + 门禁全绿即发布线上公测）

## 目标

1. **无障碍补正**：弹层在系统减弱动效下的行为修正（现存唯一 reduce 硬缺口）。
2. **引擎闲置能力变现**：元素钩子（onInView/onEnter）、状态级驱动（playStateTransition）、float-up 预设、页面 preset 体系全部产生业务消费。
3. **覆盖补齐**：进场编排未覆盖的 7 类列表、29 处无动效交互、全站图片加载过渡。
4. **场景补足**：主题/明暗切换交叉淡化、门控解锁 reveal、公告横幅过渡、悬浮名片进出场等 M15 探查新发现场景。
5. **返回键动画可行性实验**：实验先行，验证不过则维持诚实跳过（不伪装）。

## 1. 已核实事实（2026-11-12 两路只读探查 + 自查，全部 file:line 佐证）

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
