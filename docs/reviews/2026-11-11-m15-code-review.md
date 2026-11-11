# M15 统一动效管线 · 收口前独立审查报告（Step 4.5）

- 日期：2026-11-11 ｜ 审查对象：M15 Step 1–4 全部实现（分支 `feat/m15-motion-pipeline`，提交 `8b2634b` 为基线）
- 方式：两路独立只读自查——【安全/架构路】（引擎边界、并发重入、退役完整性、边界下沉、安全、React 契约）+
  【评审规范/文档一致性路】（钩子契约↔规范、reduce 覆盖、裸写守卫、性能红线、文档零漂移、G-15/16/19/20 适用性）。
  逐文件读码 + 全仓 grep 取证，不跑构建、不改文件；发现分级 P0/P1/P2，整改后复测。
- 结论：**无 P0**。4 项 P1 全部整改并经回归验证（其中架构路 P1 在整改中实际发现并修复了一个视觉缺陷）；
  P2 完成注释/措辞同步、守卫加固与文档口径校准，少数可选项记录在案由收口裁量。

## P0

无。两路审查在各自重点上均未发现阻断收口、安全/数据风险或契约破坏。

## P1（全部整改）

### A-1 共享 layout 边界下沉（Step 4 核心契约）零自动化覆盖 ——【安全/架构路】
- 发现：全仓测试无任何对 `SiteMotionBoundary`/`PageMotionBoundary`/`root-shared` 的渲染或断言；E2E 无
  /admin、/settings 动效用例。「每会话恰一个边界认领」「共享壳不重挂」只靠代码推理成立，且依赖
  「Next 根模板组内导航不重挂」这一未验证假设。
- 整改：新增 4 条边界契约 E2E（`page-motion-pilot.spec.ts` 共享 layout 组边界下沉组）——admin 组内、
  settings 组内（标记壳内导航节点实证不重挂）、跨组进入、跨组退出，断言单会话生命周期 + 页面快照组数。
- **整改中发现真实缺陷并修复**：跨组退出 admin 时旧页瞬切（无淡出）——嵌套 VT 在模板重挂卸载子树时不触发
  退场，原 root-shared 边界 `exit="none"` 又抑制了根层退场。修复为根共享边界 `enter="none"`（跨组进入不与
  下沉边界双进场）、exit 恢复默认（跨组退出旧页正常淡出）。4 条用例全绿，架构与文档同步校准。

### B-1 ROADMAP / S4 仍写「Step 4 门禁结果待回填」，与 M15 §14 已回填矛盾 ——【规范/文档路】
- 整改：两处改为「已回填」。

### B-2 motion-spec §6.1「旧 nav-kind / 手动 VT 助手保留独立兼容链」已失真且与 §7 自相矛盾 ——【规范/文档路】
- 整改：补时点标注——Step 1 时点口径，nav-kind 与 facade 已于 Step 4 删除，仅 nav-guard 保留（指向 §5/§7）。

### B-3 「admin 恒 fade」表述不精确（显式 direction hint 可覆盖） ——【规范/文档路】
- 整改：motion-spec/M15/CLAUDE/CHANGELOG/S4 共 5 处统一改为「默认 fade，显式 direction hint 仍可覆盖」。
  站长若意图为强制 fade 需在 resolver 层加钳制并补测试——按现行 preset 语义以「默认」为准。

## P2（处置记录）

已整改：
- 注释/措辞同步（指向已删除模块或过期试点模型的「现架构描述」类注释）：`template.tsx`（试点→全站收敛）、
  `globals.css`（`.fw-page` 挂类主体→MotionPage；`withViewTransition`→`engine/native.ts`）、`native.ts`
  （`html[data-nav]`→`html[data-motion-direction]`）、`motion-demo.tsx`（试点→全站管线）。
- M15 §3.1/§3.3 设计节加「终态指针」（试点/灰度并存为设计时点口径，终态见 §14）；遗留事项将已完成的
  「手动 VT 收编」标记完成，并记录 Radix/tw-animate-css 弹层 reduce 行为属 §2 明确不动的既有体系。
- motion-spec §6.2 补「共享壳层钩子作用域陷阱」（壳层默认 `page:"root-shared"` 永不匹配会话，须显式 global）；
  §7 性能红线澄清适用范围为页面/元素预设动画（S4 hover 过渡按其自身口径继续有效）。
- 裸写守卫加固：检测器扩展引号键 / kebab-case（style 字符串属性）/ CSS `animation-delay|transition-delay`，
  新增 3 条变异 fixture（25→28 项）；reduce 收编核对升级为语义断言（类名所在规则体必须真归零，而非仅出现）。
- harness 措辞修正：「生产渲染 null 且钩子对象为空（不含任何回调）」，与实现一致。

记录在案（未改码，收口裁量）：
- `nav-geometry` 取首个 `[data-fw-page]` 盒子：expand/collapse 仅在 /t/ 主题页触发（共享页无扩散卡片），
  当前非活缺陷；若未来共享页嵌入扩散卡片需改为按认领边界取盒子。
- `MotionList` 对 Fragment 子节点无开发期告警（文档已约束条目须接受 className/style）。
- 旧构建产物（`.next-e2e-prod` 等）含已删 motion-lab 路由，属 gitignore 构建缓存，E2E 每次重建，收口前顺手清理。
- harness 未激活时仍注册空钩子对象（无任何回调、无可观察效果），已按实际行为修正文档措辞。

## 已验证无问题（两路交叉，摘要）

- 引擎边界：内核零业务反向依赖、唯一 barrel 未被绕过、架构守卫 18 种导入形态全覆盖且含变异自检。
- 并发/重入：导航编号隔离、终态至多一次、旧回调不清新状态、更新入队序、异常预约丢弃、epoch/generation/owner
  三层隔离、旧 RSC 晚到不覆盖新目标、无孤儿会话——均有定向测试钉住。
- 退役完整性：nav-kind/view-transition/lab/panel/facade/vt-lab/vt-support 物理删除且无悬空 import；
  旧符号（rank/kindBetween/isMotionPilot/setNavKind/data-nav 方向选择器）全仓零残留（data-nav-busy 等守卫
  自有属性除外）；LEGACY_ENTRIES 仅 nav-guard。
- 安全：harness flag 仅测试激活、无信息泄漏；方向值来自注册表枚举白名单、圆心为数值插值，无注入面；
  VT API 调用收敛于三处；无秘密/token 回流。
- React 契约：participate 绑定渲染时 id、cleanup 幂等、不将 ViewTransitionInstance 当原生 VT、
  activeViewTransition 可选探测、MotionList 不破坏 key/SSR/非元素子节点。
- 钩子契约、reduce 全站覆盖、裸写守卫与令牌升格、性能红线（keyframes 只动 transform/opacity/clip-path、
  will-change 全站零使用、LCP 成功页校验）、G-16 降级路径覆盖（reduce/no-api/history/interrupted）、
  文档与实现一致性（除上述 P1 外）——均验证一致。

## 整改后回归

- 共享组边界 4 条 E2E 全绿（含修复后的跨组进/出）；裸写守卫 28 项、架构守卫 156 项全绿。
- 全量门禁（verify:all / 全量 E2E / 安装 / 视觉零更新 / LCP）在整改提交前完整重跑，结果见 M15 §15。
