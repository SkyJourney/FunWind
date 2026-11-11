# FunWind 动效规范（M15 引擎契约 · Step 1/2 增补）

> 本文档是**动效引擎的契约依据**：预设表、钩子签名、方向策略、守卫与验收全部以此为准；实现与本规范冲突时先改文档再改代码（M15 执行纪律）。
> 视觉质感（圆角/阴影/边框/玻璃）继续以 [M10.5-S4](M10.5-S4-VISUAL-MOTION.md) 为准，本文只收动效。
> 上游：[M15](milestones/M15-motion-pipeline.md)（D1–D4 已批准）、站长动效总纲（M10.5-UI-LAYOUT §7）。

## 1. 令牌层

### 1.1 既有令牌（S4 §2 继续有效，落 `styles/tokens/primitives.css`）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--fw-dur-fast` | 150ms | L1 微交互、页面旧层退场 |
| `--fw-dur-base` | 250ms | L2/L4 常规淡入位移、进场 |
| `--fw-dur-slow` | 400ms | L2 页面级方向过渡新层进场 |
| `--fw-dur-spring` | 500ms | L3 过冲回弹、扩散打开 |
| `--fw-ease-out` | cubic-bezier(0.22,1,0.36,1) | 进场 |
| `--fw-ease-inout` | cubic-bezier(0.65,0,0.35,1) | 对称位移、扩散 |
| `--fw-ease-spring` | cubic-bezier(0.34,1.56,0.64,1) | 过冲回弹 |
| `--fw-ease-exit` | cubic-bezier(0.4,0,1,1) | 退场 |

### 1.2 已升格令牌（M15 Step 3 完成，统一定义于 primitives.css，含桌面断点覆写）

| 原散落形态 | 令牌 | 说明 |
|---|---|---|
| `--fw-page-shift`（28px / 桌面 14px，曾在 globals.css `:root`） | `primitives.css` 令牌 | 页面级位移，断点降半 |
| `--fw-tab-shift`（min(24vw,96px) / 56px，曾在 globals.css `:root`） | `primitives.css` 令牌 | Tab 切换位移 |
| `fw-nav-grow 12s`（慢网进度条 keyframes 内联时长） | `--fw-dur-progress: 12s` | 唯一的长时进度动画 |
| `fw-float-up` 内联 `×1.75` 时长放大 | `--fw-dur-float-up: calc(var(--fw-dur-slow) * 1.75)` | 点赞浮起专用（slow × 1.75，时长不变） |
| L4 stagger 步长 `50ms`（曾 8 处内联） | `--fw-stagger-step: 50ms` + `--fw-stagger-max: 10` | 进场编排步长与封顶；`<MotionList>` 按步长计算延迟，封顶与引擎 `MOTION_DEFAULTS.maxStaggerItems` 由守卫钉住一致 |

预设关键帧内部的小位移（fw-enter 8px、fw-float-up 20px、fw-pop scale 等）属预设实现细节，留在 globals.css 预设区（sanctioned），不在升格清单；裸写守卫只约束业务代码与非令牌 CSS。

## 2. 页面预设（方向语义，自现行 nav-kind 行为归纳）

| 方向 | 触发 | 旧层退场 | 新层进场 | 备注 |
|---|---|---|---|---|
| `push` | 目标层级更深 | fast · ease-exit · 左移出（page-shift） | slow · ease-out · 自右切入（opacity 0.6→1） | 「左切进入」 |
| `pop` | 目标层级更浅 | fast · ease-exit · 右移出 | slow · ease-out · 自左切入 | 「右切返回」 |
| `fade` | 同层 / 未知 / admin 路由组默认 | fast · ease-exit 淡出 | base · ease-out 淡入 | 克制默认 |
| `tab-next` / `tab-prev` | 两个 Tab 根之间（TAB_ORDER 左右序） | base · ease-exit · 反方向移出 | slow · ease-out · 错开 fast/2 自方向切入（全透明起） | 位移用 tab-shift，「滑出再滑入」 |
| `expand` | 内容卡片点进详情（触点扩散） | 静止垫底 | spring · inout · clip-path 圆形展开 | L3，圆心由 `onBeforeTransition` 测量写入 |
| `collapse` | 详情经站内链接返回来源列表 | slow · inout · clip-path 圆形收起，旧层抬高 | 静止垫底 | 复用展开上下文；不能将退场组与进场组互换 |

规则：layout 内容（顶栏/底部 Tab/页脚）为独立过渡组且保持静止；页面包装 `[data-fw-page]` 必须自带不透明背景（`--page-bg`）；过渡期间 `::view-transition` 不拦截指针。

## 3. 元素预设（类名约定，M15 Step 3 已落地）

| 预设 | 类名 | 参数 | 用途 |
|---|---|---|---|
| `list.enter` | `.fw-enter` | base · ease-out · stagger-step 50ms · 封顶 10 项（首屏） | 列表首屏错落切入：`<MotionList>` 声明式挂类并按令牌步长计算延迟（已替代 8 处 `index*50ms` 内联） |
| `list.append` | `.fw-fade-in` | base · ease-out · 无位移无延迟 | 翻页 / 触底追加入场：stream-list 追加类改引 `MOTION_ELEMENT_PRESETS["list.append"]`（不再裸写类名，renderItem 契约不变） |
| `pop` | `.fw-pop` | spring · ease-spring | 点赞 / 关注弹跳（现行 500ms，不按 L1 的通用 150ms 改短）；其他按压仍走 fast |
| `float-up` | `.fw-float-up` | dur-float-up · ease-out | 点赞浮起 |

`<MotionList>`（`engine/list.tsx`）是共享组件（无 `"use client"`，RSC 首屏即可挂类与延迟）：`cloneElement` 把预设类与延迟合并进条目根元素，不新增包裹盒子，DOM/版式/`:last-child` 零变化；`animate=false` 原样渲染（翻页/直达深页不重播）。预设定义（类名/时长/曲线）是引擎单一事实源 `MOTION_ELEMENT_PRESETS`；微交互组件（like-toggle/follow-toggle）继续消费 fw-* 类，行为零变化。

## 4. 导航生命周期钩子（契约）

| 钩子 | 时机 | 签名（Step 1 定稿，类型见公开入口） | 现行归化 |
|---|---|---|---|
| `onIntent` | 捕获导航意图（链接 / 编程式 / Tab / 返回键） | `(ctx: MotionContext) => MotionSelection \| false \| void`；可改方向/预设，false 只取消动效 | NavigationGuard + resolveNavKind |
| `onBeforeTransition` | 动效定稿后、驱动开始前 | `(ctx: MotionContext) => void`；旧快照所需测量必须由宿主在此时已具备 | 触点扩散圆心计算 |
| `onReady` | 过渡伪元素就绪 | `(ctx: MotionContext) => void` | 手动 VT 助手收编处 |
| `onFinish` / `onSkip` | 过渡结束 / 被跳过 | `onFinish(ctx)` / `onSkip(ctx, reason: MotionSkipReason)`；错误/超时/取消均有独立原因 | releaseNavKind 等 finished |
| 元素 `onEnter` / `onInView` / `onExit` / `onUpdate` | 挂载 / 滚入视口 / 退场（VT 快照语义）/ 布局更新 | `(ctx: MotionElementContext) => void`；包含 node 与作用域 | stream-list 哨兵 |

硬性约束（Step 1 实现与守卫依据）：

1. **三级注册**：全局配置 → 页面（`useMotionLifecycle`）→ 元素，**越近优先**；同层多注册按注册序执行。
2. **可取消**：`onIntent` 返回值可改写/取消本次预设；其余钩子返回值忽略。
3. **失败不阻塞**：钩子异常一律吞掉并 `console.warn` 上报，导航照常进行。
4. **可重入**：StrictMode 双执行安全——effect 注册/清理对称；页面 hook 用 useLayoutEffect 注册并返回清理函数。
5. **兜底清理**：导航未提交时由运行时安全计时器（现行 SAFETY_CLEAR 15s 语义）保证方向属性不残留。

## 5. 方向解析与全站收敛（D3，Step 4 退役完成）

- **注册表单一事实源**：`components/site/motion-routes.ts` 路由段/页面 → 预设与层级；rank 层级语义已迁入，旧 `nav-kind.ts` rank 表/TAB_ORDER/kindBetween 已删除。admin 路由组 preset=`admin`（resolver 层默认 fade，显式 direction hint 仍可覆盖，克制）。
- **方向→CSS 桥（引擎自有属性）**：引擎定稿后写 `html[data-motion-direction]`（`nav-direction.ts`），CSS `:root[data-motion-direction="…"]::view-transition-*(.fw-page-*)` 选动画，沿用同名 keyframes。保留「几百处链接无需逐个加类型」的原设计优点；expand/collapse 在点击拦截时由 `nav-geometry.ts` 定稿，引擎在导航 transition 之外写属性，不依赖 `addTransitionType`（仅限 startTransition 内）。
- **transitionTypes**：主动 Link / push / replace 经 `MotionLink` / `useMotionRouter` 透传 `fw-*` 原生类型（pilot E2E 断言）；浏览器 back/forward 没有该选项，按 history 诚实跳过，不以主动 push 冒充历史恢复。
- **全站接管**：移除 isMotionPilot 灰度门，所有路由（除同 pathname）建引擎会话；根边界非共享路由 pathname-key，共享路由（admin/settings）根边界 root-shared/enter-exit none，动画与生命周期交壳内下沉的 `PageMotionBoundary`（每会话恰一个边界认领）。
- **退役完成（Step 4）**：rank 表、`html[data-nav]` 选择器、新旧一致性矩阵（motion-routes/resolver）整体退役；nav-kind 几何/属性时序 23 例迁 `nav-geometry.test`/`nav-direction.test`，方向判定由纯注册表矩阵承载。新增页面只需登记注册表（自动纳入方向矩阵），不再维护两套。

## 6. reduced-motion 统一策略

`prefers-reduced-motion: reduce` 下（现行三处收编为引擎全局默认）：

1. 页面过渡（VT 全部方向）：动画归零，直接切换（钩子 `onSkip("reduced-motion")` 仍触发）；
2. L4 进场编排（.fw-enter / append）：动画归零，内容直接呈现；
3. L3 触点扩散：退化为普通切换；
4. **L1 状态反馈保留，运动效果按现状禁用**：现行 reduce 规则取消 pop / roll / switch 动画并隐藏 float-up，按压/色变仍按既有 CSS 工作；不把“保留即时反馈”误读为重开位移/弹跳。

## 6.1 Step 1 内核边界与定稿契约

- 新内核放 `lib/motion/engine/`，只由 `lib/motion/index.ts` 对外导出；旧 nav-kind / nav-guard / 手动 VT 助手在 Step 1 时保留独立兼容链，不由新内核引用（**Step 4 已退役**：nav-kind 与手动 VT facade 已删除，仅 nav-guard 点击/进度守卫保留，见 §5/§7）。本步不修改现有宿主、CSS 或模板。
- 页面注册表接收显式规则（正则 + 页面声明），匹配不到时继承全局 fade；页面声明可在定稿时传入并覆盖注册表。层级比较与 Tab 顺序算法迁入纯解析器，业务路由清单留 Step 2 接入时注入，内核不引用业务模块。
- `onIntent` 从全局 → 匹配页面 → 匹配元素级联调用，同层按注册序；返回的 direction / preset 覆写由近者优先，返回 `false` 只取消本次动效（终止该阶段级联），不取消导航与业务更新。其他通知钩子全部调用，返回值忽略；错误独立上报且不阻塞后续回调。
- 每个实例持有自己的导航编号与状态；`begin → commit → ready → finish/skip`。`commit` 是驱动开始前的唯一动效定稿点，不等同 React 的 DOM 提交；重复定稿、过期 ready/finish 与已结束任务的安全计时器全部忽略。新意图使前一笔 `skip(interrupted)`，终态至多发出一次。
- `play` 接收显式驱动适配器，不直接安装浏览器监听或调用原生 VT。无驱动、reduce、显式取消、history 或同 pathname（含查询串变化）的导航只运行更新并发出 skip；驱动失败也须确保更新至多执行一次，业务更新本身失败继续向调用方抛出。更新按调用顺序预留并入队，不串行等待业务 Promise，异步业务自己的结果失效仍由调用方负责；开始/定稿异常须丢弃尚未入队的预约，后续导航不能复活已经拒绝的业务操作。
- Step 0 的目标页覆写实验只证明新层动画可变化，尚未证明旧快照测量、目标页未挂载的钩子与流式晚到都可延迟：这些仍须提前捕获或在 Step 2 验证。流式内容就绪不新建导航会话（无在途编号不允许 commit/ready），但 React 自发的二次 VT 能否抑制仍归 Step 2 实测，不在本步宣称解决。
- Step 1 只交付接入类型；`MotionPage/MotionProvider/useMotion/useMotionLifecycle` 已在 Step 2 实现，`MotionList` 仍归 Step 3。安全超时测试使用注入的调度器，只测状态与清理，不用假时钟推断浏览器动画。

## 6.2 页面宿主与全站收敛契约（Step 2 试点 → Step 4 收敛）

- **边界（Step 4 全站接管）**：根 template 使用 `SiteMotionBoundary → MotionPage`，不外套另一层 VT。非共享路由 VT 本体 key 取 pathname（全站进退场）；共享 layout 组（admin/settings）根边界 key/pageKey=`root-shared`、enter=`none`（跨组进入不与壳内下沉边界双进场）、exit 默认（跨组退出由根层播旧页淡出——嵌套 VT 在模板重挂卸载子树时不触发退场，根层是共享侧唯一可靠的退场载体；Step 4.5 E2E 实测），动画与生命周期交壳内下沉的 `PageMotionBoundary`（pathname-key），每会话恰一个边界认领。进入共享组时旧页内容会被出边界退场与进边界组的旧快照各捕获一次（同位置同动画，视觉为单次淡出）。query/hash 不入 key。不为所有页面设置同一个显式 name（否则会走 share 而非进退场）。
- **不重写 RSC**：异步页面仍作为 children 插槽，数据库读取不迁到客户端；引擎/provider 位于 layout 稳定层。业务页面不要在根宿主内再套一层 `MotionPage`；页面级 hook 放在客户端岛中即可。**钩子作用域陷阱（Step 4）**：共享壳层（下沉边界之外，如 `admin-shell`/`settings` 壳内组件）的 `useMotionLifecycle` 默认落 `page:"root-shared"` 作用域，永不匹配导航会话而静默不触发——壳层钩子须显式 `scope={level:"global"}`，页面级钩子须位于下沉边界内的页面岛（默认 page 作用域即正确）。
- **职责分离**：`MotionPage` 负责快照与页面作用域，`preset` 标记当前角色；层级、Tab 顺序和目标预设由宿主注册表在意图阶段提供。组件不接受尚未实现的 level/tabOrder 覆写，也不在目标页 effect 中重写已经定稿的整次导航。
- **方向桥（Step 4 退役 data-nav）**：方向由注册表单一事实源解析，引擎定稿后写 `html[data-motion-direction]`（`nav-direction.ts`），CSS 按该属性选动画（同名 keyframes）。触点展开/收起几何在 `nav-geometry.ts`，只调用一次（显式普通方向不创建展开记录）。自动方向不冒充显式 hint，以便全局 preset 仍能生效；显式 Link/router hint 或 expand/collapse 才传入 intent.direction。旧 rank 表与 `data-nav` 选择器已删除。
- **两类编号**：宿主请求 epoch 保护 URL 提交、进度条和旧 effect，内核导航 id 保护动效 ready/finish。不可变请求快照在会话与桥接状态准备完整后才发布，通过 `useSyncExternalStore` 订阅；提交通知必须携带渲染时的 epoch，旧提交和更早目标的晚到 RSC 不能结束新请求。守卫 `complete(url)` 再核对在途比较键。hash-only/原地址程序化调用仍交给 router，但不登记新 pending；history 在 capture 阶段保留来源完整 key。
- **React 收尾**：参与者回调绑定渲染时捕获的 id，而非晚到时读取 current 来认领新导航；回调返回的 cleanup 由 React 绑定原生 finished，幂等归并为一次终态。`ViewTransitionInstance` 不是原生 VT，不从它读取 ready/finished；公共 `activeViewTransition` 仅可选补充，存在时校验 ready 的失败分支，缺失时使用 React 参与者的逻辑就绪/清理契约，不冒称物理动画已成功启动。
- **取消与降级**：reduce/no API/history 不影响内容可用；cancel/disabled 的 CSS 抑制标记持有至对应 React cleanup，旧 cleanup 不得删新标记。加载期间偏好变化在参与者就绪时再次检查。现有慢网、重复点击去重、生产失败重置与重试继续由原守卫负责。
- **流式边界**：`update="none" default="none"` 明确关闭持久页面边界的更新动画；pathname-key 变化形成进退场。同 key 的流式就绪不产生额外整页动画/导航会话；独立子 VT、空的原生 start 仍可能存在，不要求全局原生 start 次数永远等于一。
- **测试宿主（Step 4 脱离 lab）**：`motion-lab` 与实验面板已删除。pilot E2E 改用 `motion-test-harness.tsx`——测试专用持久宿主，挂根 layout、provider 内、页面边界外（落全局作用域），仅 E2E 经 addInitScript 置 `window.__fwMotionTest` 激活，生产渲染 null 不注册钩子；以真实 MotionLink/useMotionRouter 跨页验证，生命周期 hook 写只含阶段与编号的诊断输出，不导出应用私有 router。

## 7. 守卫与验收

| 守卫 | 内容 |
|---|---|
| 裸写禁令（Step 3 已上线） | `motion-bare-write-guard.test.ts`：业务 TS/TSX（app/**、components/**）禁裸写 `animationDelay/Duration`（纯令牌引用豁免）、`cubic-bezier(`、`animation` 简写裸时长；非令牌 CSS 禁裸写时长/曲线。白名单 = 令牌文件（styles/tokens/**）、引擎模块；globals.css 预设区已全量令牌化故全文件零命中。检测器纯函数 + fixture 自检 + 隔离副本变异验证。预设关键帧内部小位移属 sanctioned 预设区，不在禁令范围 |
| 架构守卫 | 引擎（`lib/motion/`）不得 import 业务代码（`app/**`、`components/**` 业务域）；引擎不持有业务状态；`LEGACY_ENTRIES` 仅留 nav-guard.ts（Step 4 退役 nav-kind/view-transition） |
| 注册表方向矩阵 | Step 4 一致性对比退役后，纯注册表方向/声明/query-hash 不变性矩阵承载（新增页面自动纳入） |
| 静态零变 | visual 基线零更新（`animations: "disabled"`） |
| 性能 | 页面/元素预设动画（keyframes）只动 `transform/opacity/clip-path`；`will-change` 仅限进行中过渡；LCP 不回退。S4 既有的 hover 过渡（box-shadow/border-color）按 S4 自身口径继续有效，不在本红线内 |
| 依赖 | 不引入第三方动效库（零依赖栈延续，F8） |

## 8. Step 映射

| 规范节 | 落地 Step |
|---|---|
| §1.2 令牌升格 + §3 元素预设（MotionList）+ §7 裸写守卫 | Step 3 ✅ |
| §2 页面预设 + §4 导航钩子 + §5 注册表/全站收敛 | Step 1（内核）→ Step 2（试点）→ Step 4 ✅（全站接管） |
| §4 元素钩子（onEnter/onInView 等） | 引擎已具备（`engine.element`/`useMotionLifecycle`）；业务挂点随 Step 3/4 按需接入 |
| §6 reduced-motion 统一 | Step 3 ✅（CSS reduce 仍为稳健机制，引擎拥有预设定义，守卫钉住元素预设覆盖；页面导航 reduce 由引擎驱动） |
| §5 退役（rank/data-nav/一致性测试） | Step 4 ✅（引擎自有方向属性 data-motion-direction，注册表单一事实源） |
