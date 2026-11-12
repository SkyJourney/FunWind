# M16 Step 1–4 收口前独立审查报告（两路并审）

> 日期：2026-11-12 · 审查对象：`feat/m16-motion-coverage` Step 1–4 全部提交（bf4b672…8a63ee0）
> 审查方式：两路独立代理并审——**安全架构路**（运行时行为、生命周期、竞态、无障碍、回归风险）
> 与**规范文档路**（实现 vs motion-spec/M16 文档契约逐条核对）。本报告为两路发现的并集，
> 整改记录随附；全部 P0/P1 已在 Step 4.5 内整改并复验，P2 处理情况逐条注明。

## 一、发现总览

| 级别 | 数量 | 处置 |
|---|---|---|
| P0 | 1（两路同指） | ✅ 已整改 |
| P1 | 8（安全路 3 + 文档路 5，其中 1 项两路重叠） | ✅ 已整改 |
| P2 | 11 | 选择性整改 6 项，其余记录在案 |

## 二、P0

### P0-1 FloorReveal 状态机漂移：pending 死状态 + 首屏错落被吞 + 深层闪变（两路同指）

- **安全路**：state 仅两条设置路径（无 IO 兜底 direct / IO 相交 fade），无任何
  `setState("pending")`——视口外楼层无预隐藏，滚入触发 fade 时「已可见 → 跳回透明 → 再淡入」
  闪变，与 §6.3「滚入视口才显现」语义相反；运行时 trace 证实。
- **文档路**：同一缺陷的契约面——首屏 10 层会被 IO 首回调标为 fade，`fw-fade-in`（globals.css
  后声明）与 MotionList 注入的 `fw-enter` 同元素竞争，错落位移预设被吞成纯淡入；既有 E2E 只断言
  `.fw-enter` 存在与 animationDelay，未断言 animationName，故 74 例全绿与此缺陷兼容。
- **整改**（`ui/floor-reveal.tsx` 重写为三态 `direct/pending/fade`）：
  - SSR 与首帧一律直出（不推迟 LCP、无水合 mismatch、无 JS 可读全文）；
  - 分类在 IO 首次回调完成（observe 即回报当下状态，setState 全在订阅回调内，lint 合规）：
    相交或本体已入可视视口（折叠线楼层）→ direct 直出；完全在视口外 → pending（opacity-0，
    施加时楼层仍不可见，无闪烁窗口）；此后首次滚入触发区（底缘收窄 80px）→ fade 并 disconnect
    （单向显影，滚出不回退）；
  - direct 不挂 fw-fade-in，与 fw-enter 无声明序竞争；
  - E2E 收紧：滚入前断言 wrapper 含 `opacity-0` 且无 `fw-fade-in`；新增首屏错落 animationName
    统一为 `fw-enter` 的钉住断言。

## 三、P1

### P1-1 BackToTop 未满足「ReplyFab 同款可见性模式」契约（安全路 + 文档路重叠）

display 两分支切换（md:flex/md:hidden）使 transform/opacity 过渡因无起始态而**从不播放**；
移动端 show 分支缺基础 display 类 → 按钮出现并与 ReplyFab 同位重叠；隐藏分支仅 opacity-0、
无 pointer-events-none/inert → 不可见仍可点、可聚焦。
**整改**（`site/back-to-top.tsx`）：常驻渲染 + `hidden md:flex` 基础类（display 恒不切换，
过渡恢复生效）；隐藏态 `pointer-events-none translate-y-2 opacity-0` + `inert` + `aria-hidden`
（ReplyFab 逐项同款）；移动端 base hidden 彻底不参与布局。E2E 重写为属性定位器状态断言
（getByRole 会跳过 aria-hidden 元素），并新增移动端视口 `display:none` 断言。

### P1-2 恢复循环跨页强滚 + 键盘捕获监听泄漏（安全路）

popstate 恢复循环（4s interval + wheel/touchstart/keydown 让位监听）不随导航清理——返回后
4s 内软导航到新页，循环会把强滚带进新页面；且 `removeEventListener("keydown", …)` 漏了捕获
标志（注册为 capture `true`），取消后监听永远泄漏。另：keydown 让位不区分输入法组合。
**整改**（`site/nav-kind-capture.tsx`）：恢复循环停止函数抽为模块级 `activeRestoreStop`，
换页（key effect 清理）与卸载统一 `cancelRestoreLoop()`；removeEventListener 补捕获标志；
`cancelKeys` 增加 `isComposing / key === "Process"` 守卫（IME 组合键不算滚动意图）。

### P1-3 锚点 pushState 与滚动存档互相污染：返回锚点历史项错恢复到锚点位置（文档路）

SmoothAnchors 平滑滚动的每一帧都触发持续采集，把「点击前位置」刷成锚点位置；从锚点历史项
返回时恢复循环强制滚回锚点处，破坏浏览器原生语义；同页返回还会被 traverse intercept 播一次
整页 fade（文档未变，纯噪声）。
**整改**：
- 滚动存档抽为共享模块 `site/scroll-record.ts`（采集/导航锁/节流落盘/容量上限）；
- SmoothAnchors 点击先 `pinScrollAtCurrent()`（max 快照 + 锁 + 强制落盘）——动画期间采集被锁
  压制，存档保持点击前位置；同页返回恢复即回到点击前位置（原生语义一致）；
- traverse intercept 增加 `from !== to` 守卫：同页历史移动不再拦截、不再播整页 fade；
  motion.pop(same, same) 保持原有记账路径（page-motion 对同 pathname 归零为无动画，既有
  单测钉住该契约——整改中曾误加同页提前 return，被 nav-kind-capture.test 3 例当场拦下）。

### P1-4 poll-block 投票条 `transition-[width]` 无 motion-reduce（文档路）

布局型过渡在 reduce 下漏网（同类：横幅折叠、附件面板均有保护）。**整改**：补
`motion-reduce:transition-none`。

### P1-5 M16 文档尾部被 shell 片段污染（文档路）

「## 遗留事项（如有）」两处后接 `__zcode_status=$?` 工具残片且标题重复。**整改**：残片清除，
标题去重；结尾以 §10 整改记录 + 真实遗留事项收口。

### P1-6 Skeleton 脉冲在 reduce 下无限循环（文档路）

D5 引入的 `animate-pulse`（tailwind 内置无限脉冲）不属于弹层，animate-in/out 兜底覆盖不到。
**整改**：globals.css reduce 块补 `.animate-pulse { animation: none !important }`；守卫测试
（motion-bare-write-guard）新增「reduce 块须包含且真归零」断言钉住。

### P1-7/P1-8 （并入 P1-2/P1-1 的两路重复项，不另计数）

## 四、P2（处置记录）

| # | 内容 | 处置 |
|---|---|---|
| P2-1 | S4 头部引用不存在的 motion-spec「§6.5」 | ✅ 改「§6/§6.3」 |
| P2-2 | SmoothAnchors 高亮 timer 连点被旧 timer 掐断；spec 注释「:target」措辞不准 | ✅ timer 持句柄（连点清旧挂新、卸载清理）；注释更正 |
| P2-3 | reduce 口径未成文（色彩/透明度 vs 布局型过渡） | ✅ motion-spec §6 第 6 条成文 |
| P2-4 | sessionStorage 每滚动帧同步写 | ✅ scroll-record 800ms 节流 + pagehide/转后台强制刷盘 |
| P2-5 | keydown 让位误伤输入法组合键 | ✅ isComposing 守卫 |
| P2-6 | Avatar 注释「弹层兜底」表述反向依赖不清 | ✅ 注释更正（非弹层但属预期覆盖面） |
| P2-7 | G-16 缺口：BackToTop/SmoothAnchors reduce 降级无 E2E | 📋 记录：两者 reduce 行为均为纯参数分支（behavior auto / 不挂类），组件单测覆盖 reduce 分支，E2E 收益低，留待有真实回归时补 |
| P2-8 | ContentImageFade 全页扫描 + SSR 图 loading=lazy 可能无效 | 📋 记录：每页仅挂载时扫描一轮、幂等标记防重入，实测无性能问题；带宽问题等真实正文长图场景出现再优化 |
| P2-9 | spec 注释/文档微调（m16dbg 措辞等） | ✅ 随调试残留一并清理 |
| P2-10 | CLAUDE.md 尚无 M16 条目 | 📋 按 Step 5 收口节奏注入 |
| P2-11 | reveal 失败路径（stale 标记→再解锁）无显式用例 | 📋 记录：失败路径已有单测，E2E 显式用例留待需要时 |

**调试残留清理（安全路 P1-3 并入）**：`[m16dbg]` console.log（motion-step2:118、motion-step4:86）
与配套 `__y` 时序探针、motion-step4 `lockStates` 死代码全部移除。

## 五、两路一致确认无问题的清单（摘要）

水合一致性（SSR=首帧）；IO/监听清理对称；无双重拦截（SmoothAnchors 与 click-capture 按 href
分工）；reduce 双口径（弹层兜底误伤面、sonner/Lightbox 不受影响）；FadeImage 状态机
（eager 豁免/缓存直显/失败显影）；主题状态级 VT（引擎 playStateTransition、PATCH 失败回滚、
data-vt 机制）；令牌与守卫（新 CSS 全令牌零裸写、守卫断言覆盖）；intercept 路线安全面
（origin 比对/特性检测/历史栈零污染）；退役完整性（旧 nav-kind 无残留）；gate-reveal
标记/消费/清理闭环；scroll-map 污染防线（锁/快照/max-guard）。

## 六、整改后门禁（真实命令输出）

| 门禁 | 结果 |
|---|---|
| `pnpm verify:all` | 退出 0（secrets/scripts/lint/format/duplication/db:build/typecheck/test/build） |
| 单测 | web 4,595（含守卫新增 animate-pulse 断言）/ db 124 / content 55 / migration 278 全绿 |
| E2E 动效定向（prod 配置） | **74 例全过**：motion-step2 4 + motion-step4 4 + reduce-overlays 4 + gates 14 + micro-interactions 15 + page-motion-pilot 19 + page-transition 14（既有动效零删减） |
| visual | 10 项通过，**基线零更新** |
| LCP（生产构建，scripts/lcp.ts） | 首页 84 / 版块 140 / 帖子 208 / 搜索 76ms，全部低于 2,500ms 预算（较 Step 4 的 104–296ms 持平略优） |

## 七、结论

P0×1 + P1×8 全部整改并复验；P2 整改 6 项、在案 5 项（均不阻断收口）。实现与
motion-spec/M16 文档契约重新对齐（FloorReveal 三态、BackToTop 可见性模式、锚点返回语义、
reduce 过渡类型口径已回写文档）。满足「P0/P1 未清不合并部署」红线，可进入站长交互目视验收。
