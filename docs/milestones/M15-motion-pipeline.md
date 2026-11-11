# M15 · 统一动效管线（声明式动效引擎）

- 阶段：四·运营与演进 ｜ 依赖：无（与 M14 相互独立）；设计基准：[M10.5-S4-VISUAL-MOTION](../M10.5-S4-VISUAL-MOTION.md)（四级动效体系与令牌）、M10.7（页面切换与流式动效）、[M13 备忘](M13-launch.md)（立项来源）
- 状态：🚧 执行中（2026-11-09 立项，站长批准编排与 D1–D4；Step A / 0 / 1 / 2 / 3 已完成，元素层 MotionList 与魔法数令牌清账已落地，旧 rank/data-nav 灰度并存；Step 4 尚未开始，未合并 main、未部署生产）
- 来源：站长 2026-11-09 立项——动效收敛为「全局默认 + 统一管理管线」：动效规则不再散落在路由表、
  CSS 选择器与组件 className 三处；页面 / 元素接入动效应声明式完成；并建立**生命周期钩子**，
  未来页面或元素接入动效可快速挂接。M13 备忘「统一页面切换动效管线」并入本里程碑。
- 上线口径（站长 2026-11-09 拍板）：**本地灰度 + 测试通过即可发布线上公测**；逐段灰度迁移，
  收敛前两套方向语义并存且有一致性测试兜底。

> **执行纪律**：同 M13——先对齐设计再动代码；Step 0 是技术验证（结论回写 §10），任何一步实测
> 与本文冲突时先改文档再动代码；门禁以真实命令输出为准。

## 目标

1. **动效管线引擎**：全局默认配置（令牌 / 预设 / 减弱动效策略）+ 声明式接入 API
   （页面级 `<MotionPage>`、元素级 `<MotionList>` / `useMotion`）替代硬编码动效规则。
2. **共享段导航动效**：`/t/1 → /t/2`、`/a ↔ /a/{id}` 等兄弟页面切换获得过渡（立项时静切，Step 2 已接入试点）。
3. **生命周期钩子**：导航（intent / before-transition / ready / finish-skip）与元素（enter / in-view /
   exit / update）两级钩子，全局 → 页面 → 元素三级注册，近者优先；页面或元素接入动效零散改引擎。
4. **令牌收敛与魔法数清账**：动效时长 / 缓动 / 位移 / stagger 全部走令牌层，裸写由守卫测试拦截；
   清理演示遗留死代码。
5. rank 层级表（`nav-kind.ts`）与 `html[data-nav]` CSS 选择器**灰度退役**，全站 73 页收敛到注册表。

## 1. 已核实事实（2026-11-09 探查 + 官方文档核查，行号佐证）

| # | 事实 | 位置 | 对设计的影响 |
|---|---|---|---|
| F1 | 项目声明 react/react-dom **19.3.1**、next 16.4.2，`ViewTransition` 公开导入可用且无需 experimental 开关；Step2 进一步核实 Next 浏览器别名实际使用框架 bundled React（`19.3.0-canary-278794d7-20261002`），不能仅凭 package.json 称运行时全部 stable | `apps/web/package.json`、Next `create-compiler-aliases.js` 与 bundled React 版本字符串、本地 `dist/docs/01-app/02-guides/view-transitions.md` | 不升级依赖、不另开 canary；以框架内置实现和生产构建实测判断能力 |
| F2 | 根 template 只在**第一路由段**变化时重挂；共享段动态参数变化需另建进退场对。官方同时支持段级 template 和给 VT 本体设置 key；Step2 选择单根 keyed VT，避免在现有根 VT 内再叠段级边界 | [Next template 文档](https://nextjs.org/docs/app/api-reference/file-conventions/template)、[view transitions 指南](https://nextjs.org/docs/app/guides/view-transitions)；本地指南 §Step4 key 示例 | 试点只改根边界 key，不用 `startViewTransition + flushSync` 包导航；真正跨根和快照组数量补进 Step2 E2E，不能引用 Step0 错标的“跨段”用例作证明 |
| F3 | 立项时页面切换链路（Step2 后见 §12）：NavigationGuard 捕获点击 → `resolveNavKind` 由 rank 正则表判方向并写 `<html data-nav>` + 扩散圆心 CSS 变量 → 根 template 的 `<ViewTransition enter="fw-page-in" exit="fw-page-out">` → globals.css 按 data-nav 选择器播动画 → 等 `finished` 再清除 | `lib/motion/nav-kind.ts:30-48(rank),76-85(kindBetween),211-264(resolve)`、`components/site/navigation-guard.tsx:6,99`、`app/template.tsx:21`、`app/globals.css:274-423` | 方向判定 = 硬编码正则 + 全局属性 + CSS 选择器**三处分散**；引擎要把三处收敛为注册表单一事实源 |
| F4 | rank=null 静默退化 fade；新页面必须手动登记正则——`/a` 就是 M13 补录的（`d4bc890`）；同层跨模块只能 fade（`/f/3 → /u/9`）；Tab 另开 TAB_ORDER 特例表（9 个根） | `nav-kind.ts:30-48,55-68,83` | 「新页面零配置继承」是引擎的验收标准之一；跨模块同层方向交给 `transitionTypes` 声明 |
| F5 | 动效令牌基线已有：时长 4 档（fast150/base250/slow400/spring500）+ 缓动 4 种，注释明令「业务组件禁止裸写」；但魔法数绕过令牌层散落：进场 stagger `index*50ms` 内联 8 处（上限 10 条）、慢网进度条 12s（keyframes fw-nav-grow）、位移 28/14px 与 tab 96/56px 写死在 `:root`、`fw-float-up` 时长 `×1.75`、`vt-push-in` 为演示遗留（含死选择器 `[style*="vt-push-in"]`） | `styles/tokens/primitives.css:98-105`、`globals.css:190,205-214,250-252,262-269`、`app/page.tsx:216`、`f/[fid]:200`、`notifications:118`、`messages:146`、`follows:169`、`u/[uid]:223,255`、`points:98` | Step 3 令牌清账清单直接照此表执行；新增守卫测试（裸写时长/缓动/位移即红） |
| F6 | 26 个 keyframes 全在 globals.css；reduced-motion 三处降级（微交互/进场、全部 VT 置 none、主题 Surface）；VT 动画规则约 20 条按 `html[data-nav=…]` 属性选择器组织 | `globals.css:138-156,176-211,326-423,453-484`、`:222-256,493-499,847-851` | 引擎的 CSS 由「预设类名约定」生成，属性选择器退役；reduced-motion 统一收进引擎全局默认 |
| F7 | 主题包语义令牌层（M11.6）**不含动效槽**：token-schema 只有 colors/radius/shadows/font/surface | `lib/theme/token-schema.ts:86-92` | D2：本期不加主题动效槽，但令牌层按「可被主题覆盖」设计（后续可选） |
| F8 | 立项时双轨现状：路由级 = 框架公开 `<ViewTransition>`（根 template 一处）；同文档状态级 = 手动 `document.startViewTransition` 封装（`withViewTransition`，仅 /design/motion 演示页用）；无第三方动效库（弹层走 tw-animate-css + Radix） | `app/template.tsx:2,21`、`lib/motion/view-transition.ts:31-62`、`design/motion/motion-demo.tsx:120,142` | 引擎收编手动 VT 助手；第三方库继续不引入（保持零依赖动效栈） |
| F9 | 元素级入场现状：触底追加 `fw-fade-in`（stream-list 哨兵 IntersectionObserver）；首屏错落 = 8 个页面内联 `animationDelay: index*50ms`；微交互（点赞 pop/roll/float-up、Button active:scale、关注、FeedCard hover）各组件自管 | `components/stream/stream-list.tsx:9`、F5 的 8 处、`interact/like-toggle.tsx:85-111`、`follow-toggle.tsx:61,69` | 元素层 API（`<MotionList>` / `useMotion`）的迁移清单；微交互本期只收口到预设，不改行为 |
| F10 | 测试基线：`nav-kind.test.ts` ~45 例、`nav-guard.test.ts` ~28 例、`view-transition.test.ts` 7 例；E2E 有 VT 打桩（`e2e/support/vt.ts` 拦截 startViewTransition + rAF 采样）、page-transition 18 例、micro-interactions 15 例；禁动效手段 = `page.emulateMedia({ reducedMotion: "reduce" })`；visual 配置 `animations: "disabled"` | `lib/motion/*.test.ts`、`e2e/support/vt.ts`、`e2e/page-transition.spec.ts:399,414`、`playwright.visual.config.ts:24` | 灰度期一致性测试直接建在 nav-kind 测试上（两套判定对全路由矩阵比对）；E2E 打桩设施复用 |
| F11 | popstate 限制：React 文档明确「从 legacy popstate 启动的 transition 必须同步完成，动画会被跳过」，除非路由升级 Navigation API；M10.7 §5.7 遗留「浏览器返回键缓存命中无动画」；nav-guard 已有 Navigation API 接入（拦截 Next 整页回退兜底） | [React ViewTransition](https://react.dev/reference/react/ViewTransition)（popstate 节）、`M10.7-streaming-motion.md:144-145`、`lib/motion/nav-guard.ts:267-289` | Step 0-3 验证经 Navigation API 的返回键能否带出过渡；不能则该场景维持「无动画」并在规范里写明（诚实降级） |

## 1.1 Step A 增量复核记录（2026-11-11，版本/文件计数复核；框架语义由 Step2 补证勘误）

| # | 复核项 | 结论 |
|---|---|---|
| R1 | F1 版本基线 | 声明版本 react 19.3.1 / next 16.4.2 未变；不能由此推断浏览器运行时完全 stable，Step2 实现复核见 F1 |
| R2 | 页面总数 | ✓ 仍 73 页（M14 升级 /admin/ops 既有页，未新增路由） |
| R3 | stagger 内联 | ✓ 仍 8 处 `index*50ms`，M14 未新增 |
| R4 | rank 表 | ✓ `/a` 已登记；admin 兜底正则覆盖全部子页——M14 重构的 /admin/ops 自动被兜底，无登记缺口 |
| R5 | 测试基线 | ✓ nav-kind 33 声明（~45 例）/ nav-guard 27 / view-transition 7；E2E 18+15；vt.ts 打桩完好可复用 |
| R6 | M14 增量 | /admin/ops 与 OpsAutoRefresh 零动效使用（后台克制维持）；globals.css 行号漂移已刷新（fw-nav-grow→209、vt-push-in→250、fw-page-in→288、reduced-motion→222/493/847）——以符号检索为准 |
| R7 | 手动 VT 收编目标 | ✓ 仅 /design/motion 两处（expand/fade） |
| R8 | 元素级 class | fw 系列动效类共 11 个文件使用——Step 3 迁移清单 |
| R9 | reduced-motion | ✓ 三块降级与 F6 一致 |

**结论**：Step A 时维持既定范围与 D1–D4；Step 2 补证后已修正实际框架运行时、边界选择和实验结论，不能把当时复核外推为这些语义均已验证。**动效规范：[docs/motion-spec.md](../motion-spec.md)**（Step A 定稿，Step 1/2 增补契约；实现冲突时先改规范再改代码）。

## 2. 边界（明确不做什么）

- 不引入 framer-motion 等第三方动效库（零依赖动效栈延续，F8）。
- 不做主题包动效槽（D2）——主题换动效不在本期；令牌「可被主题覆盖」留接口不实现。
- 不做 JS 物理动画 / 手势驱动动效（拖拽跟手、弹簧物理）——页面切换与元素动效用 CSS + VT 足够。
- 不动 Radix / tw-animate-css 的弹层动画体系（已对齐令牌，重写无收益）。
- 不改流式加载与慢网兜底的行为语义（Step 0-4 只验证互不干扰）。
- 不做后台 31 页的逐页动效设计——后台整体走路由组默认（fade 微动），保持克制。

## 3. 设计

### 3.1 引擎分层

```mermaid
flowchart TD
  CFG["全局默认配置<br/>令牌 · 预设（页面/元素） · 方向策略 · reduced-motion"] --> RT["管线运行时：意图 → 解析 → 过渡 → 收尾"]
  RT --> HOOK["生命周期钩子总线<br/>全局 → 页面 → 元素（近者优先）"]
  HOOK --> API["接入 API：MotionPage · MotionList · useMotion · motion.play"]
  API --> USE["页面 / 元素（声明式）"]
  RT --> CSS["预设类名约定 → CSS 规则（全令牌化）"]
```

- **配置层**：全局默认 = 预设表（页面预设：detail / list / form / admin…；元素预设：enter / stagger /
  pop…）+ 方向策略 + reduced-motion 策略。本期落代码注册表（常量 + 类型），不落库、不进主题包。
- **运行时**：导航意图捕获（现 NavigationGuard 升级）→ 方向解析（注册表 + transitionTypes）→
  唯一根 ViewTransition（试点按 pathname 换 key，其他页面原模板兜底）→ 钩子总线 → 清理。
- **接入 API**（页面 / 元素声明式，站长核心诉求）：

  ```tsx
  // 根宿主统一使用，业务页不再额外嵌套；共享段通过 VT 本体 key 形成进退场。
  <MotionPage preset="detail" motionKey={`page:${pathname}`} pageKey={pathname}>…</MotionPage>

  // 元素：列表首屏错落 + 触底追加入场，时长/间隔全部来自全局令牌（替代 8 处 index*50ms 内联）
  <MotionList preset="list.enter">{items.map(renderCard)}</MotionList>

  // 钩子：页面级生命周期（导航 onIntent/onBeforeTransition/onReady/onFinish/onSkip）
  useMotionLifecycle({ onFinish: () => focusFirstUnread() });
  ```

### 3.2 生命周期钩子

| 层级 | 钩子 | 典型用途（现存实现归类） |
|---|---|---|
| 导航 | `onIntent` | 捕获导航意图（链接 / 编程式 / 返回键 / 底部 Tab），可改写本次预设——现 NavigationGuard + NavKindCapture 归此 |
| 导航 | `onBeforeTransition` | 旧页快照前：测量触点、写 CSS 变量——现触点扩散圆心计算归此 |
| 导航 | `onReady` | 过渡伪元素就绪：CSS 写不出的动画用 Web Animations API 兜（手动 VT 助手收编处，F8） |
| 导航 | `onFinish` / `onSkip` | 收尾（焦点/滚动/清理）；跳过时附带原因（reduced-motion / 无 API / 被新导航打断）——现 `releaseNavKind` 等待 `finished` 归此 |
| 元素 | `onEnter` / `onInView` | 挂载与触底追加入场、滚入视口显现（stream-list 哨兵收编） |
| 元素 | `onExit` / `onUpdate` | 退场（VT 快照语义）；布局变化 FLIP（可选，后期） |

- 三级注册：全局配置 → 页面 → 元素，**越靠近元素优先级越高**；执行顺序与可取消语义在 Step A 规范定稿。
- 钩子签名要求纯客户端、可重入（StrictMode 双执行安全）、失败不阻塞导航（异常吞掉并上报日志）。

### 3.3 共享段过渡与方向策略

- Step2 只保留一个根 `<MotionPage>`，试点路径给 VT 本体设置 pathname key，显式 `update/default="none"`；不重复包段级 VT。当前 `/t`、`/a` 无共享 layout，未来添加共享状态布局时应重审边界下沉，不能无条件扩大根 key 的重挂范围。
- 方向由注册表解析；主动 Link / push / replace 可用 `MotionLink` / `useMotionRouter` 透传 `transitionTypes`。灰度期旧 `data-nav` CSS 继续同时选择旧、新层动画，几何在快照前捕获；浏览器 back/forward 没有该参数，维持 history 跳过，不伪装 push。
- **灰度并存（D3）**：注册表逐段接管；未接管路由由现 nav-kind 兜底。一致性测试 = 两套方向判定对全
  路由矩阵（现有 73 页清单）比对一致，收敛完成后 rank 表与 `data-nav` 选择器整体退役。

### 3.4 引擎形态与边界（D1）

- 按**独立包的边界设计**：唯一公开入口（barrel），内部模块不对引擎外导出；架构守卫（F10 同级测试）
  新增「引擎不得反向 import 业务代码（app/**、components/** 业务域）」断言。物理位置先在
  `apps/web/src/lib/motion/`（升级现有目录），未来出现第二个前端再抽 `packages/motion`。
- 引擎不得持有业务状态；钩子是唯一的业务挂点（依赖倒置）。

## 4. Step 分解

> 分支 `feat/m15-motion-pipeline`；Step A → 0 → 1 → 2 → 3 → 4 → 4.5（独立审查）→ 5。
> 发布口径：本地灰度 + 门禁全绿即可部署生产（站长 2026-11-09 拍板）。

- **Step A · 文档先行**：本文件重写定稿 + **动效规范**（收拢 S4 口径：四级体系、预设表、钩子契约、
  reduced-motion 策略、裸写禁令）——规范是后续守卫与验收的依据。
- **Step 0 · 技术验证**（结论回写 §10，逐条含最小复现仓库内 demo）：
  1. 页面级带 key 的 `<ViewTransition>` 与根 template 共存是否**双重过渡**（F2）；
  2. 方向可否「延迟解析」（目标页在提交阶段声明角色）——决定页面声明能否只写在页面组件里；
     做不到则页面声明退化为「构建期生成路由清单」；
  3. 返回键经 Navigation API 能否带出过渡（F11）；不能则写明诚实降级口径；
  4. 与流式加载 / 慢网兜底 / 滚动恢复的相互干扰排查；
  5. Safari / Firefox 降级表现（VT 类型与 `view-transition-class` 支持面）。
- **Step 1 · 引擎内核**：配置/令牌/预设表 + 方向解析器 + 钩子总线 + 接入 API 骨架；纯逻辑（解析、
  优先级、预设选择）单测达覆盖率门槛；架构守卫断言（§3.4）。
- **Step 2 · 页面层接入**：根 `<MotionPage>` 单边界 + 共享段 key 试点（`/t/*`、`/a`、`/a/*`）+ Link/router transitionTypes 接线 + 灰度一致性矩阵；非试点仍由根模板兜底。
- **Step 3 · 元素层接入与魔法数清账**：`<MotionList>` / `useMotion` 收编 8 处 stagger 与 stream-list
  入场；令牌清账（F5 清单逐项）；守卫测试：引擎外裸写时长/缓动/位移即红；死代码清理
  （`vt-push-in`、死选择器）。
- **Step 4 · 全站收敛**：73 页按注册表接管（后台 31 页整体路由组默认）；rank 表与 `data-nav`
  选择器退役；nav-kind 测试迁移为注册表测试。
- **Step 4.5 · 独立审查**：按批准规划，两路自查输出 P0/P1/P2 报告，核对引擎边界、钩子契约、rank/CSS 灰度退役完整性、裸写守卫、reduce 与性能预算、文档一致性；整改复跑后由站长交互验收。P0/P1 未清不合并部署。
- **Step 5 · 收口**：全量门禁（§6）+ PR/CI 双绿合并 main + 文档回写 + CHANGELOG + 生产部署（公测口径）。

## 5. 测试规则

- 纯逻辑（解析器 / 预设选择 / 钩子优先级）：单测 ≥90% 行覆盖（全局基线下限），假时钟不用——动效
  时序断言用 VT 打桩（F10 设施）而非真实等待。
- 一致性（灰度期）：nav-kind 与注册表对全路由矩阵方向判定一致（参数化测试，新增路由自动纳入）。
- E2E：page-transition 用例扩展共享段场景（`/t/1 → /t/2` 有过渡断言、reduced-motion 下无动画断言）；
  既有 18 + 15 例业务行为断言零删减迁移（诊断 DTO 可随探针扩展同步更新）。
- visual：`animations: "disabled"` 下基线**零更新**；引擎不得改变静态渲染结果。
- 每个新增守卫测试做变异验证（守卫按文本匹配的坑见 CLAUDE.md 已知坑）。

## 6. 门禁标准

| 层级 | 标准 |
|---|---|
| Step 门禁（1–4） | `pnpm verify:all` 退出码 0；本步新增单测/E2E 全过；灰度一致性测试全绿；visual 基线零更新 |
| 里程碑收口（Step 5） | verify:all / 全量 E2E / 安装 E2E / layout+summary / lighthouse / perf:posting 达标；page-transition 扩展用例全绿；六档布局矩阵零问题；PR CI 双绿；站长目视验收（共享段切换、列表入场、reduced-motion） |
| 体验红线 | 既有动效行为回归零删减（push/pop/fade/tab/expand/collapse、触点扩散、慢网兜底）；LCP 预算不回退（动效不得阻塞渲染） |
| 分支纪律 | `feat/m15-motion-pipeline` → PR → CI 双作业通过合并 main；不 force push |

## 7. 决策记录（站长 2026-11-09 全部按推荐拍板）

- **D1 引擎形态** ✅ 按独立包边界设计（唯一公开入口 + 架构守卫禁止反向依赖），物理上先在
  `apps/web/src/lib/motion/`；未来第二个前端出现再抽 `packages/motion`（接口不返工）。
- **D2 主题动效槽** ✅ 本期不做；令牌层按可被主题覆盖设计留接口（后续可选里程碑）。
- **D3 迁移方式** ✅ 灰度并存、逐段接管、一致性测试兜底；收敛完成 rank 表退役。
- **D4 上线口径** ✅ 本地灰度 + 测试通过即发布线上公测（2026-11-09，与 M14 同口径）。

## 8. 与既有设计的关系

- [M10.5-S4-VISUAL-MOTION](../M10.5-S4-VISUAL-MOTION.md)：四级动效体系（L1 微交互 150 / L2 页面方向
  400 / L3 触点扩散 500 / L4 进场 250×stagger50）与令牌表**继续有效**，M15 把它升级为引擎规范（Step A）。
- [M10.7](M10.7-streaming-motion.md)：页面切换管线与慢网兜底由引擎收编；§5.7 遗留「返回键无动画」
  归 Step 0-3 处置。
- [M13 备忘](M13-launch.md)「统一页面切换动效管线」：并入本里程碑；其「手动 startViewTransition +
  flushSync」路线按 F2 更正为框架公开 VT 路径；Step 2 实测后选择单根 keyed VT + transitionTypes，不叠段级边界。

## 9. 执行记录

- [x] Step A 文档先行（2026-11-11：增量复核 R1–R9 回写 + [动效规范](../motion-spec.md) 定稿 + S4 头部指针）
- [x] Step 0 技术验证（实验代码与 5 项结论见 §10；267d402 已推送）
- [x] Step 1 引擎内核（2026-11-11，范围、复核整改与门禁见 §11；不接管现有导航）
- [x] Step 2 页面层接入与共享段过渡（2026-11-11，范围、实验勘误、独立复核整改与门禁见 §12；本地灰度，未部署）
- [x] Step 3 元素层接入与魔法数清账（2026-11-11，范围、裸写守卫与门禁见 §13；本地灰度，未部署）
- [ ] Step 4 全站收敛（rank 表退役）
- [ ] Step 4.5 独立审查与站长交互验收
- [ ] Step 5 收口

## 10. Step 0 技术验证结论（2026-11-11，实验路由 /motion-lab + e2e/vt-lab.spec.ts 实测）

| # | 验证项 | 结论 | 实测证据 |
|---|---|---|---|
| 1 | 双包裹（F2） | **Step2 勘误**：1a/1b 都在同一第一段 motion-lab 内，原“跨段”标签错误；一次原生 start 也不能证明只有一个快照组（旧探针归一化后丢失组身份）。Step2 改用单根 keyed VT，并以真实 `/boards ↔ /t/*` 及原始组名补证 | vt-lab 1b 标签已更正；page-motion-pilot 跨根与原始快照组断言 |
| 2 | 方向延迟解析 | 可改变**新层 CSS 选择**，但不能重写旧 fiber 的 exit props、旧像素/几何或当次已认领的 types。原 2a 实际也导航到 useEffect 页，Step2 改为 two→one，才真正覆盖 useLayoutEffect 对照。无需生成构建期路由清单，但不能据此取消快照前注册/测量；本期方向由意图阶段注册表/显式 hint 定稿，旧 CSS 桥保持到 Step4。改变 animation-name 可能重启动画，不将“晚改可见”当稳定契约 | 修正后的 vt-lab 2a/2b；Next bundled renderer 的删除分支读取旧 props 与快照前 types 认领顺序 |
| 3 | 返回键（F11） | ✅ 诚实降级成立：goBack 后 starts=[]（无任何过渡）。返回键无动画维持现状，规范写明；Navigation API 优化空间留未来 | vt-lab 验证 3（starts=[]） |
| 4 | 流式互扰 | **Step2 勘误**：lab 自己的 VT 未配置 default，update 继承 auto；生产根边界已有 default=none，不能把 lab 的两次 start 外推为任何生产流式页都闪。Step2 页面组件显式 update/default=none，同 key resolve 不播放额外整页动画/会话；子 VT 或空原生 start 仍允许。startTransition 是激活条件，不是抑制方法 | 保留 lab 自身 starts=["fade", null] 实验；新增同 key Suspense 的 rawAnimations 不含 vt-page、生命周期不重复断言 |
| 5 | 支持面 | webkit（Safari 27.2 引擎）实测三项全支持；Firefox 本机 Playwright 启动失败（juggler profile 环境问题），按 caniuse/MDN：VT 同文档 = Firefox 144+ / Safari 18.0+（全球 93.17%），view-transition-class = Chrome 125+ / Firefox 144+ / Safari 18.2+（90.32%），types 参数 = Baseline 2025 Newly available（2025-10；Firefox 精确版本未经真机复核）。**引擎红线成立**：不支持环境必须同步可用（探测红线断言过） | e2e/vt-support.spec.ts + caniuse |

- [x] Step 0 技术验证（5 项结论如上；实验路由位于 **`app/motion-lab/`**（顶层，脱离 /design 的 dev-only 守卫范围——VT 结论须在 prod 构建下验证），noindex 无站内入口，**本地生产构建可达，不代表已部署线上；Step 4 清账时连同持久导航面板整体移除**；vt-lab spec 在 prod E2E 持续回归，vt-support 仅 Step 0 一次性探测）
      **实验教训**：VT 采样必须在上一段过渡真正播完后 reset（页面过渡 slow 400ms，URL 变更早于动画
      结束——过早 reset 会让上一段的采样混入新观察，首轮 2a/2b 结论因此被污染反噬）；spec 已加
      settleTransitions 辅助。

### 10.1 Step 1 复核后的结论边界

- 验证 2 只证明目标页覆写会影响新层 CSS 动画，不能据此断言旧页快照前测量、尚未挂载的目标页钩子或流式晚到声明都可延迟。注册表是可选的提前声明来源，目标页仍可在本次动效定稿时覆盖；不要求构建期生成路由清单，但也不直接退役所有提前策略。
- Step 1 定稿使用实例级导航编号，`begin → commit → ready → finish/skip`；一次定稿后拒绝重复 commit 与过期回调。commit 指驱动开始前的动效定稿，不等同 React DOM commit，真实 React 接线时点仍在 Step 2 验证。
- Step 1 只给出隔离边界，不提前宣称消除流式互扰；Step 2 已将目标限定为“不重复整页动画/会话”，保留独立子 VT 或空原生 start 的可能，不以次数替代动画参与者证据。

## 11. Step 1 独立引擎内核（2026-11-11）

- **范围**：新增 `lib/motion/engine/`（配置、预设、纯解析器、生命周期、运行时与更新入队），唯一公开入口为 `lib/motion/index.ts`。旧 nav-kind / nav-guard / view-transition、根 template、全局 CSS 与全部页面消费者零改动；注册表迁入层级与 Tab 比较算法，业务路由清单在 Step 2 才注入。
- **公开契约**：`createMotionEngine` 生成独立实例；`begin/commit/ready/finish/skip` 按导航编号隔离，一次定稿，过期回调无效；`register` 按全局→匹配页面→匹配元素级联，近者覆盖，false 只取消动效；`play` 通过显式适配器驱动，减少动态效果/无 API/禁用/取消/history/同 pathname 均直接更新并通知 skip。`MotionPageProps/MotionListProps` 是类型骨架，实际组件、hook 和原生 VT 驱动分别留在 Step 2/3，不导出无效果的占位组件。
- **并发与错误**：驱动同步失败、ready/finished 拒绝、超时、快速连点均不重放业务更新；业务错误继续向调用方抛出。更新按 play 调用顺序预留并入队，不串行等待整个业务 Promise，避免更新内部嵌套 play 死锁；异步业务自己的结果失效/取消仍由调用方负责，内核不持有其状态。
- **独立复核整改**：发现 4 项 P2 并修复——旧更新晚于新更新、重入终止后仍分发非终态钩子、元素事件缺少快照、解析异常后残留预约会在后续 play 中执行。首轮先补 7 条失败回归再修复，另补第三笔重入、异步嵌套与 begin/commit 失败清理，最终并发/重入 11 项 + 预约契约 3 项通过；非终态逐回调检查会话有效，终态完整广播，元素上下文复制冻结（不冻结 DOM 节点），异常退出丢弃未入队预约且晚到请求明确拒绝。
- **预设对账**：修正文档早期归纳偏差，不改现有效果：pop 实际为 spring 500ms（不是 fast 150ms）；float-up 为 slow × 1.75（不是 base）；collapse 动的是旧层而非新层；reduce 下维持现有 pop/roll/switch/float-up 禁用口径。
- **测试**：内核与公开 API 119 项 + 旧动效 76 项 + 架构守卫 158 项，共 353 项定向测试通过；新内核可执行代码行/分支/函数/语句覆盖率均 100%。守卫复用 AST 依赖解析，检查静态/类型/转发/字面量动态导入及 require，禁止内核反向业务依赖与外部深导内部实现，旧入口暂保留。
- **变异验证**：隔离副本内分别移除导航归属保护、倒置作用域优先级、绕过 reduce、重放业务更新，四项均被回归测试拦截；另临时向真实引擎注入业务依赖，架构守卫立即失败，探针已清理。
- **最终门禁**：`pnpm verify:all` 退出码 0（web 4395 / db 124 / content 55 / migration 278；脚本测试 18 项；构建成功），jscpd 1405 行 / 159 克隆与基线持平，未放宽门禁；`pnpm test:visual` 10 项通过，截图基线零更新。独立复核已验证上述 4 项 P2 全部消除，无未处置 P1/P2；本步未新增页面 E2E，也未重跑全量 E2E，页面接入阶段再跑导航与共享段回归。
- **后续边界**：本步不解决 React 自发的流式二次 VT，不迁移 73 个业务页面，不退役 rank、不升格 CSS 魔法数、不部署生产；这些保持 Step 2/3/4 的既定分工。

## 12. Step 2 页面接入与共享段试点（2026-11-11）

- **实现选择**：D1–D4 不变；用单一根 VT 本体 pathname-key 实现试点，不叠根/段级双边界。`/t/*`、`/a`、`/a/*` 形成进退场，其他路径保持原根模板兜底；RSC 页面只作为 children 插槽，未迁客户端数据读取。
- **接入**：`MotionProvider/MotionPage/useMotion/useMotionLifecycle` 公开导出；站点适配器负责 Next 依赖、注册表与旧 CSS 桥。稳定 layout 保存实例，业务页不再重复包 MotionPage；组件只声明角色与作用域，层级/Tab 由宿主预注册。`MotionLink/useMotionRouter` 透传主动 transitionTypes，back/forward/refresh 保留原 API。
- **灰度一致性**：扫描全部 73 个业务页 + 5 个实验页，剥离路由组、填充全部动态参数，不认识的参数/catch-all 显式失败。87 个样本形成 7,569 个有向对，另测 query/hash、九个 Tab 根和未知路由；默认方向与旧 kindBetween 完全一致。几何助手至多调用一次，显式普通方向不留下假展开记录。
- **生命周期边界**：内核 id 管动效，宿主 epoch 管请求/URL/进度。请求完整准备后才发布外部 store，旧渲染 effect 与更早 RSC 提交不能结清新请求；guard.complete 比较目标键。Native 回调捕获 id 并返回 finished cleanup，旧 cleanup 不清新状态。公共 activeViewTransition 可选，不读 React 私有句柄。
- **复核整改**：独立复核发现并修复旧提交误清新导航、终态钩子重入后释放新 owner、程序化 hash/原地址误登记 pending。另补减少动态效果在加载期间变化、先发布请求后建立会话的同步通知空窗、旧链同方向收尾误清新写入、onStart 重入后旧 guard/router 动作覆盖新意图等回归；取消动效本身仍不取消业务导航。
- **真实历史事件教训**：Next 恢复历史时可在 pop 回调前同步更新 React 上下文，随后同 URL replace 写历史状态；不能把当前 ref 当真实来源，也不能让这次 bookkeeping replace 清掉 traverse 来源。通过公开 navigate capture 先取来源、保留同目标 replace 缓存并在 pop 消费一次；不支持 Navigation API 时保留捕获阶段 ref 降级。原来源/更新/卸载三条测试保留并扩展。
- **实验断言修正**：旧 probe 把自动组名归一化后放 Set，不能证明无双层；现保留 rawAnimations，跨根/共享段要求旧新各一个页面快照组。类型从原生 ready 后的最终 types 读取，不能用启动参数初始空数组判断丢失。reset 前等待探针持有的公共 finished，不再固定等 650ms；paint 后覆写不保证首帧，移除原不成立的“fade 首帧绝不会出现”断言，但仍验证覆写与独立 lab 参与者。
- **定向回归与覆盖率**：17 文件 / 703 项通过，包括 React 适配器 23、路由矩阵 268、页面协调器 25、导航组件 7、历史捕获 8、守卫 UI 14，以及既有内核/兼容链/架构守卫。新内核含 React 适配层的可执行代码语句/分支/函数/行均 100%；页面协调器行 100%、分支 94.89%。未降低既有覆盖率门槛。
- **变异验证**：隔离副本基线退出 0；改错公告层级、移除提交 epoch 校验、移除旧 cleanup 归属校验，三类变异均退出 1，被回归测试拦截；未改写真实工作区。
- **浏览器与安装门禁**：根编排串行运行 `pnpm test:e2e`（生产 506 + dev-only 8）、`pnpm test:e2e:install`（4）、`pnpm test:visual`（10），全部退出 0，截图基线零更新。新增 11 条页面试点 E2E 真实覆盖公告往返、主题兄弟页、程序化导航、query/hash、历史恢复、reduce/无 API、同目标去重、快速不同目标、同 key 流式与跨根单快照组；没有用普通 anchor 或整页 goto 冒充软导航。
- **最终全量门禁**：`pnpm verify:all` 退出 0：web 4,731 / db 124 / content 55 / migration 278，脚本测试 18 项全部通过，类型/lint/格式/秘密扫描/构建均通过；jscpd 1,405 行 / 159 克隆与原基线持平，未放宽棘轮。独立复核原 3 项 P2 与追加的守卫/路由重入场景均复验通过，本步复核范围内无未处置 P1/P2；不替代 Step 4.5 全里程碑独立审查。
- **性能**：最新生产构建对开发迁移库既有四页实测 LCP：首页 116ms、版块 `/f/109` 152ms、主题 `/t/6621` 176ms、搜索 88ms，均为成功 HTTP/匹配路径且低于 2,500ms 本地预算；未重置、重种或迁移开发库。性能脚本增加成功响应/路径校验并在异常时关闭浏览器与服务；以 E2E 库缺少迁移实体的 `/f/109` 做负例，明确 HTTP 404 并退出 1，防止错误页假绿。这是本地预算达标，不等同生产现场性能结论。
- **边界**：独立 lab 的流式 update-auto 可以额外启动 VT；生产页面边界 update/default=none，验收不重复整页动画和导航会话，不承诺所有场景 native start 次数恒为一。元素 MotionList、8 处 stagger/魔法数和 rank/data-nav 退役仍留 Step3/4。静态 Link 类型不是全局 hooks 定稿结果的完整替代；Step4 退役 CSS 桥前必须处理动态定稿传递及共享 layout 的边界下沉，不能粗暴给全站根边界统一 pathname-key。
- **实验资产**：只从 motion-lab 显式开启持久导航面板，以真实 Next Link/router 跨主题兄弟页验证，不用 goto/注入普通 anchor 冒充软导航。诊断只记录阶段/id，不暴露私有 router；面板和 lab 在 Step4 一并清理。未合并 main、未部署生产。

## 13. Step 3 元素层接入与魔法数清账（2026-11-11）

- **令牌升格**：`--fw-dur-progress`(12s)、`--fw-dur-float-up`(slow×1.75)、`--fw-stagger-step`(50ms)、`--fw-stagger-max`(10)、`--fw-page-shift`(28/14px)、`--fw-tab-shift`(min(24vw,96px)/56px) 全部入 `primitives.css`（含桌面断点覆写）；`globals.css` 改引令牌，删除 `:root` 位移定义、`fw-nav-grow 12s` 裸值、float-up `×1.75` 内联。预设关键帧内部的小位移（fw-enter 8px、float-up 20px 等）属预设实现细节，留在 sanctioned 预设区，不在升格清单。
- **MotionList**：新增 `engine/list.tsx` 共享组件（无 `"use client"`，只用 React 同构 API，RSC 首屏即可挂类与延迟）；`cloneElement` 把预设类与延迟合并进条目根元素（条目须接受 className/style），**不新增包裹盒子**，DOM/版式/`:last-child` 零变化。`list.enter` 前 `maxStaggerItems` 项挂 `fw-enter` + `calc(var(--fw-stagger-step) * 序号)`，其余项不挂；`list.append` 每项 `fw-fade-in` 无延迟无封顶；`animate=false` 原样渲染（翻页/直达深页不重播）。8 处首屏 stagger（首页/关注/版块/通知/私信/用户主页主题+回复/积分）全部迁移；`stream-list` 追加淡入类改引 `MOTION_ELEMENT_PRESETS["list.append"].className`（不再裸写类名，`renderItem` 契约与 DOM 不变）。
- **手动 VT 收编**：状态级驱动实现移入 `engine/native.ts`（`playStateTransition`/`prefersReducedMotion`/`supportsViewTransition`，经 barrel 导出；document/window 只在函数体内访问，SSR 安全）；`view-transition.ts` 降为薄兼容 facade（保留 `withViewTransition`/`captureTransitionOrigin` 旧签名与 7 项单测，Step 4 随旧链移除）。状态级选型收敛为 `fade`/`expand`（push/pop 为演示遗留，已删；facade 单测原 push 用例改 fade，行为覆盖零删减）。
- **演示页更新**：`/design/motion` StaggerDemo 用 `MotionList`、DirectionalDemo 用 `MOTION_DIRECTIONS` 方向预设（关键帧名 + 令牌时长/曲线，reduce 经 `prefersReducedMotion` 降级）、ExpandDemo 用 `playStateTransition` 显式圆心，不再依赖旧 facade 与裸写魔法数。
- **死代码清理**：删除 `vt-push-in`/`vt-pop-in` 关键帧、`html[data-vt="push"/"pop"]` 规则、reduce 块死选择器 `[style*="vt-push-in"]`/`[style*="vt-pop-in"]`。
- **裸写守卫**：`src/test/motion-bare-write-guard.test.ts` 上线——业务 TS/TSX 禁裸写 `animationDelay/Duration`（纯令牌引用豁免）、`cubic-bezier`、`animation` 简写裸时长；非令牌 CSS 禁裸写时长/曲线（globals.css 预设区已全量令牌化，全文件扫描零命中）；令牌收敛断言（primitives 定义升格令牌、globals 无残留魔法数/死代码、引擎 `maxStaggerItems` 与 `--fw-stagger-max` 钉住一致）；reduce 收编核对（元素预设类全部在 reduce 媒体查询内归零）。检测器为纯函数 + fixture 自检（合法写法不误伤：令牌引用/变量驱动/散文注释/令牌展示表；引擎与 lib 不在业务扫描范围）。
- **变异验证**：隔离副本基线退出 0；注入内联 `animationDelay` 裸值、`cubic-bezier`、CSS 裸时长三类变异均退出 1 被拦截；未改写真实工作区。
- **reduced-motion 口径**：CSS `@media (prefers-reduced-motion: reduce)` 仍是稳健机制（无 JS 也生效），引擎拥有预设定义；页面导航 reduce 由引擎驱动（Step 2），元素 reduce 由 globals.css 统一归零并由守卫钉住覆盖。本步不把 CSS reduce 迁成 JS（避免无 JS 退化与视觉漂移），属「收编为引擎对齐的单一策略 + 守卫」而非重写。
- **测试**：新增 MotionList 7 / native 驱动 6 / 裸写守卫 25，共 38 项；动效定向（含架构守卫 158、路由矩阵 268）429 项通过。E2E 断言的 computed `animationDelay`（`["0s","0.05s","0.1s"]`）与 `calc(var(--fw-stagger-step)*i)` 解析结果一致，stream 用例零改动通过。
- **最终门禁**：`pnpm verify:all` 退出 0——web 4,769（360 文件）/ db 124 / content 55 / migration 278，脚本 18 项，类型/lint/格式/秘密扫描/构建均通过；jscpd 1,405 行 / 159 克隆与原基线持平。`pnpm test:e2e` 生产 506 + dev 8 全过（**微交互 15 例零删减**，含点赞/关注/开关/Tab/hover 与各自 reduce 用例）；`pnpm test:e2e:install` 4 全过；`pnpm test:visual` 10 全过、**截图基线零更新**（DOM 结构经 cloneElement 保持原样）。
- **性能**：最新生产构建对开发迁移库四页实测 LCP——首页 84ms、版块 `/f/109` 168ms、主题 `/t/6621` 176ms、搜索 80ms，均成功 HTTP/匹配路径且低于 2,500ms 本地预算；未重置/重种/迁移开发库。本地预算达标，不等同生产现场结论。
- **边界**：微交互组件（like-toggle/follow-toggle）仍用 fw-* 预设类，行为零变化；rank/data-nav 旧链未退役（Step 4）；view-transition facade 与 lab/实验面板 Step 4 清理；Firefox 站长本步明确暂缓（仍未本机实测）；未合并 main、未部署生产。

## 遗留事项

- （收口时回写）主题包动效槽（D2 预留接口）。
- （收口时回写）FLIP 布局动画（`onUpdate`）是否立项。
- （收口时回写）手动 VT 助手（`withViewTransition`）收编进度与 /design/motion 演示页更新。
