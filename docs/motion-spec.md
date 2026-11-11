# FunWind 动效规范（M15 引擎契约 · Step A 定稿）

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

### 1.2 待升格令牌（M15 Step 3 清账，现状散落在 globals.css）

| 现状 | 升格为 | 说明 |
|---|---|---|
| `--fw-page-shift`（28px / 桌面 14px，`:root` 内联） | `primitives.css` 令牌 | 页面级位移，断点降半 |
| `--fw-tab-shift`（min(24vw,96px) / 56px，`:root` 内联） | `primitives.css` 令牌 | Tab 切换位移 |
| `fw-nav-grow 12s`（慢网进度条 keyframes 内联时长） | `--fw-dur-progress: 12s` | 唯一的长时进度动画 |
| `fw-float-up` 内联 `×1.75` 时长放大 | `--fw-dur-float-up: calc(var(--fw-dur-base) * 1.75)` | 点赞浮起专用 |
| L4 stagger 步长 `50ms`（8 处内联） | `--fw-stagger-step: 50ms` + `--fw-stagger-max: 10` | 进场编排步长与封顶 |

## 2. 页面预设（方向语义，自现行 nav-kind 行为归纳）

| 方向 | 触发 | 旧层退场 | 新层进场 | 备注 |
|---|---|---|---|---|
| `push` | 目标层级更深 | fast · ease-exit · 左移出（page-shift） | slow · ease-out · 自右切入（opacity 0.6→1） | 「左切进入」 |
| `pop` | 目标层级更浅 | fast · ease-exit · 右移出 | slow · ease-out · 自左切入 | 「右切返回」 |
| `fade` | 同层 / 未知 / admin 路由组默认 | fast · ease-exit 淡出 | base · ease-out 淡入 | 克制默认 |
| `tab-next` / `tab-prev` | 两个 Tab 根之间（TAB_ORDER 左右序） | base · ease-exit · 反方向移出 | slow · ease-out · 错开 fast/2 自方向切入（全透明起） | 位移用 tab-shift，「滑出再滑入」 |
| `expand` / `collapse` | 内容卡片点进详情 / 站内返回（触点扩散） | 静止垫底 | clip-path 圆形展开（spring/inout，圆心 `--vt-x/y`、半径 `--vt-r`） | L3，圆心由 `onBeforeTransition` 测量写入 |

规则：layout 内容（顶栏/底部 Tab/页脚）为独立过渡组且保持静止；页面包装 `[data-fw-page]` 必须自带不透明背景（`--page-bg`）；过渡期间 `::view-transition` 不拦截指针。

## 3. 元素预设（类名约定，Step 3 落地）

| 预设 | 类名 | 参数 | 用途 |
|---|---|---|---|
| `list.enter` | `.fw-enter` | base · ease-out · stagger-step 50ms · 封顶 10 项（首屏） | 列表首屏错落切入（替代 8 处 `index*50ms` 内联 → `<MotionList>`） |
| `list.append` | `.fw-fade-in` | base · ease-out · 无位移无延迟 | 翻页 / 触底追加入场（stream-list 哨兵收编进 `<MotionList>`） |
| `pop` | 微交互组件内 | fast · ease-spring | 点赞 / 开关 / 勾选弹跳（本期只收口到预设，不改行为） |
| `float-up` | `.fw-float-up` | dur-float-up · ease-out | 点赞浮起 |

## 4. 导航生命周期钩子（契约）

| 钩子 | 时机 | 签名（草案，Step 1 实现定稿） | 现行归化 |
|---|---|---|---|
| `onIntent` | 捕获导航意图（链接 / 编程式 / Tab / 返回键） | `(intent: NavIntent) => NavIntent \| void`——可改写本次预设 | NavigationGuard + resolveNavKind |
| `onBeforeTransition` | 旧页快照前 | `(ctx: { intent; origin: OriginMeasure }) => void`——测触点、写 CSS 变量 | 触点扩散圆心计算 |
| `onReady` | 过渡伪元素就绪 | `(ctx) => void`——CSS 写不出的用 Web Animations API 兜 | 手动 VT 助手收编处 |
| `onFinish` / `onSkip` | 过渡结束 / 被跳过 | `(ctx, reason?: "reduced-motion" \| "no-api" \| "interrupted") => void`——收尾（焦点/滚动/清理） | releaseNavKind 等 finished |
| 元素 `onEnter` / `onInView` / `onExit` / `onUpdate` | 挂载 / 滚入视口 / 退场（VT 快照语义）/ 布局更新 | `(el: Element) => void` | stream-list 哨兵 |

硬性约束（Step 1 实现与守卫依据）：

1. **三级注册**：全局配置 → 页面（`useMotionLifecycle`）→ 元素，**越近优先**；同层多注册按注册序执行。
2. **可取消**：`onIntent` 返回值可改写/取消本次预设；其余钩子返回值忽略。
3. **失败不阻塞**：钩子异常一律吞掉并 `console.warn` 上报，导航照常进行。
4. **可重入**：StrictMode 双执行安全——钩子注册/清理对称（useEffect 返回清理函数）。
5. **兜底清理**：导航未提交时由运行时安全计时器（现行 SAFETY_CLEAR 15s 语义）保证方向属性不残留。

## 5. 方向解析与灰度并存（D3）

- **注册表**（Step 1 起）：路由段/页面 → 预设与层级的单一事实源；rank 层级语义迁入。
- **transitionTypes**：跨模块同层、返回键等注册表表达不了的方向，用 `<Link transitionTypes>` / `router.push(…, { transitionTypes })` 显式声明（F2 官方路径）。
- **灰度**：未接管路由由现行 nav-kind（rank 表 + `html[data-nav]` 选择器）兜底；一致性测试参数化比对两套判定对全路由矩阵一致，新增路由自动纳入。
- **退役标准**：73 页全部接管且一致性测试连续一个 Step 全绿 → rank 表、`data-nav` 选择器、一致性测试整体退役（Step 4）。

## 6. reduced-motion 统一策略

`prefers-reduced-motion: reduce` 下（现行三处收编为引擎全局默认）：

1. 页面过渡（VT 全部方向）：动画归零，直接切换（钩子 `onSkip("reduced-motion")` 仍触发）；
2. L4 进场编排（.fw-enter / append）：动画归零，内容直接呈现；
3. L3 触点扩散：退化为普通切换；
4. **L1 微交互保留**（按压/色变——不涉及位移，反馈即时性不牺牲）。

## 7. 守卫与验收

| 守卫 | 内容 |
|---|---|
| 裸写禁令 | 引擎外（globals.css 预设区与引擎模块之外）出现 `cubic-bezier(`、裸 `ms` 动画时长、裸位移 px 即测试红；白名单 = 令牌文件、tw-animate 内部 |
| 架构守卫 | 引擎（`lib/motion/`）不得 import 业务代码（`app/**`、`components/**` 业务域）；引擎不持有业务状态 |
| 一致性 | 灰度期两套方向判定全路由矩阵一致（Step 2 起） |
| 静态零变 | visual 基线零更新（`animations: "disabled"`） |
| 性能 | 只动 `transform/opacity/clip-path`；`will-change` 仅限进行中过渡；LCP 不回退 |
| 依赖 | 不引入第三方动效库（零依赖栈延续，F8） |

## 8. Step 映射

| 规范节 | 落地 Step |
|---|---|
| §1.2 待升格令牌 + §3 元素预设 + §7 守卫 | Step 3 |
| §2 页面预设 + §4 导航钩子 + §5 注册表/灰度 | Step 1（内核）→ Step 2（试点）→ Step 4（全站收敛） |
| §4 元素钩子 | Step 3 |
| §6 reduced-motion 统一 | Step 3（收编现行三处） |
| §5 退役标准 | Step 4 |
