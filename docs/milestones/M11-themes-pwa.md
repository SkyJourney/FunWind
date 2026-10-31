# M11 · 主题包与 PWA

- 阶段：三·完善 ｜ 覆盖模块：M12 ｜ 依赖：M10.5（主题包与暗色走查以其打磨后的界面为基准）
- 状态：🟡 实施中（2026-10-31 开工；插槽体系设计稿见 [THEME-SYSTEM](../THEME-SYSTEM.md)）

## 目标

主题系统的兑现：「复刻·青翼2010」情怀主题包 + 用户自选主题 + 暗色打磨 + **主题插槽体系**
（表面/背景/板块卡/Hero）+ PWA 基础。
这是「旧时代重主题 → 现代轻量主题」承诺的交付点。

## 架构决策（定稿，详见 THEME-SYSTEM.md）

1. `html[data-mode]`（明暗，next-themes）× `html[data-pack]`（主题包，服务端直出）正交；
   原 `data-theme` 一词两义废止（Step 1 全库更名迁移）。
2. 主题包注册表 `lib/theme-packs.ts`（id/标签/可选自带 LOGO）；CSS 在 `styles/tokens/themes/<id>.css`；
   qy2010 仅浅色（`:not([data-mode="dark"])`，暗色回退默认暗色）。
3. 令牌扩展（插槽表面组）：`--header-bg/-blur/-border`、`--tabbar-bg/-blur`、`--page-bg`、
   `--gradient-brand`、`--fw-font-display`；`--band-*` 板块卡插槽参数归位 CSS 层。
4. 主题偏好：用户级 `user_profiles.theme_pack`（NULL=跟随站点默认，schema v2.5）；
   站点默认 `site.theme` 键（并入 site-chrome TTL 缓存），admin/settings 兑现既有 M11 占位。
5. 主题↔LOGO 池联动：设全站默认主题时自带 LOGO 自动入池（`pack` 标签去重）并设为当前；
   独立切换随时可用（补充关系，见 THEME-SYSTEM.md §5）。
6. Hero 配置位：复刻 LOGO 池模式（PNG 直存、`site.hero`、`/brand/hero`、`admin.hero.*` 审计），
   首页 `home.after-header` 之前渲染，无图不占位。
7. 节日装扮自动切换（装扮方案 + 时间窗调度）→ [M11.1](M11.1-festival-decor.md)；本期交付插槽设计、
   素材管理与配置引擎地基。

## 范围（做什么）

1. **插槽体系**：表面令牌组 + 页面背景 + 品牌渐变 + 展示字体（纯 CSS）+ Hero 配置位；
   板块卡底纹插槽参数归位 CSS 层并由 qy2010 示范覆盖；顶栏挂件位只留协议（M11.1）。
2. **复刻·青翼2010 主题包**：从 `themes/forum/whitesimple`、`wood_phpwind`、`black_phpwind`、
   `template/kiminitodoke/` 与旧站 logo 采样色板，落成 `themes/qy2010.css`
   （语义令牌覆盖 + 插槽示范：板块卡硬边界无遮罩复古形态 + 复古表面）。⚠️ 需站长提供旧皮肤素材/截图。
3. **主题选择**：用户级主题偏好（外观页签 + 顶栏菜单主题包分组）+ 站点默认（管理员配置）+ 主题↔LOGO 联动。
4. **暗色打磨**：全部页面暗色走查，含门控块（锁卡片 / 「已购买」标签 / 管理员可见标签）的令牌化样式。
5. **视觉回归**：Playwright 截图三主题基线入库（本机运行）+ 换肤 DOM 不变断言。
6. **PWA**：manifest（名称/图标随站点身份与 LOGO 池）、Service Worker 离线壳 + `/offline` 页、
   安装提示（满足 installable）；推送（Web Push）留接口不实现。

## 边界（明确不做什么）

- 不做版块级换肤/用户自定义 CSS（复杂度回退，已否决）。
- 不做旧皮肤 1:1 布局复刻（复刻的是色板与气质，不是 HTML 结构）。
- 推送服务端实现不在本期；装扮方案引擎与时间窗调度、顶栏挂件位 → M11.1。

## 实施步骤（每步完成汇报确认后推进）

- **Step 1 架构地基** ✅：data-mode/data-pack 拆分迁移；令牌扩展与 `--band-*` 归位；
  site-header/bottom-tab-bar/forum-directory 接令牌；`lib/theme-packs.ts` 注册表（先 default）；
  /design 页新增「主题包与插槽」演示区；THEME-SYSTEM.md 设计稿 + 三份里程碑/ROADMAP 文档。
  验证：verify:all 绿 + e2e-dev/theme.spec 适配 + /design 目视。
- **Step 2 偏好持久化 + 主题↔LOGO 联动** ✅：`user_profiles.theme_pack`（v2.5 迁移 0020）+ 读写 action；
  `site.theme` 站点默认；池项 `pack` 字段 + `applyPackLogo` 幂等联动 + 管理页徽标；
  appearance 页主题包选择（含「跟随站点默认」）+ ThemeMenu/用户菜单主题包分组（PATCH 即时切换）+ 服务端直出 data-pack；
  qy2010 先以骨架登记（`themes/qy2010.css` 仅浅色限定选择器，色板 Step 4 填）。
  验证：单测/集成测试（联动幂等、无图不触碰、独立切换、移除后重导入、素材缺失不抛错）+ E2E（外观页/顶栏即时切/后台默认三案）。
- **Step 3 Hero 位** ✅：LOGO 池整体泛化为 brand-pool（DB 核心 / fs 核心 / serveBrandImage 公开输出 /
  动作 schema 与 run 体下沉 pool-actions——两个静态守护要求动作文件保留字面 defineAction+auth，故不做转发导出），
  logo/hero 各留薄壳；管理页泛化 BrandPoolAdmin（logo/hero 共用）+ BrandFileInput；`/brand/hero` + `/admin/hero`
  （含无 JS 回退）+ chrome.heroActive + 首页渲染（无当前项不占位）；PATCH 偏好 fetch 抽 patchPreference。
  验证：hero 单测/集成矩阵（像素上限、与 LOGO 池隔离、审计动作名）+ chrome 集成 + E2E（超限拒绝→上传→首页呈现→移除 404）；
  重复棘轮 1985/211 低于基线（泛化反而下降）。
- **Step 4 qy2010 主题包** ✅（色板落地；站长视觉签字与可选自带 LOGO 待站长输入，见 4c）：
  旧站 webroot 只读考古（`/Volumes/Docker/data/qingyisub/wwwroot/www.qingyisub.top`，PHP 源码与资源俱在），
  `themes/qy2010.css` 按下方「采样对照」落色板 + 插槽示范（板块卡硬边界无遮罩、方角、宋体站名、纸感底纹）。
  验证：三主题 /design 目视 + 首页目视；LOGO 联动的「无图不触碰」分支已有集成测试（qy2010 暂无自带 LOGO）。

### 采样对照（Step 4，只取色值、不搬任何旧站位图/文件）

| 语义令牌 / 插槽 | qy2010 落地值 | 旧站来源 |
|---|---|---|
| `--primary` / `--ring` | `#147ba9` | whitesimple 天蓝链接 `#2197d5`（加深至白字 4.6:1） |
| `--background` / `--page-bg` | `#f6f3e7` + 极淡横纹纸感 | kiminitodoke 米黄系 + wood「固定纹理底」气质（CSS 渐变，不用 bg.jpg 位图） |
| `--card` | `#fffdf4` 暖白 | whitesimple / wood 白色内容卡 `#fff` |
| `--secondary` / `--secondary-foreground` | `#f3edc8` / `#6d4a0f` | kiminitodoke 淡黄表格 `#EFE9B5` + 棕字 `#783E00` |
| `--accent` / `--accent-foreground` | `#e7f1e4` / `#33613f` | kiminitodoke 若叶绿 `#9bcba5` 淡调 |
| `--destructive` | `#a3425b` | kiminitodoke 樱红 |
| `--warning` | `#b8770a` | phpwind 橙按钮 `#ff8800`（加深可读） |
| `--header-bg` / `--header-blur` | `#f8f5e8` / `0px` | kiminitodoke 头部 `#F7F8E0`；旧顶栏不透明无毛玻璃 |
| `--radius` | `var(--fw-radius-sm)` | 旧论坛卡片近直角（情怀方角，全站圆角随之收紧） |
| `--fw-font-display` | 宋体系栈 | 2010 时代宋体标题气质（站名等品牌位） |
| 板块卡插槽 | 硬边界无遮罩：`--band-mask-display:none`、`--band-angle:90deg`、`--band-fade:0%`、图区 8.5rem | 旧站板块图（165×100）完整展示，无渐隐遮罩 |
| 附带考古 | `data/style/*.php` 风格配置（wind8black 黑底先例、wind8green 等）；`data/bbscache/qingyi_qingyi.css` 为 0 字节空壳（自建风格未启用） | — |
- **Step 5 暗色打磨走查**：关键页 × default-dark/qy2010(回退) 走查 + 门控块令牌化核查修复，记录入本文档。
- **Step 6 视觉回归基线**：Playwright `toHaveScreenshot` 三主题 × 关键页面基线入库（本机运行，CI 跳过）
  + DOM 不变断言进常规 E2E。
- **Step 7 PWA**：`app/manifest.ts` + `public/sw.js` 离线壳 + 注册组件 + `/offline` + middleware matcher 核查。
  验证：Lighthouse PWA（installable + offline）达标 + 离线访问 E2E（生产构建）。
- **Step 8 收口**：全量 `verify:all` + 生产/开发 `test:e2e` + 文档定稿（本文档勾选、THEME-SYSTEM、
  ROADMAP、CHANGELOG）+ 站长真机清单 + 合并 main + 合并后 CI 确认（不 force push）。

## 测试规则

- **视觉回归**：三主题 × 关键页面（首页/版块/帖子/个人/管理）Playwright 截图基线——
  基线快照入库，spec 仅本机 macOS 运行（CI 字体渲染差异，跳过）；换肤 DOM 结构断言
  （换主题不改 DOM，仅换 data-mode/data-pack 与变量）进常规 E2E 全平台跑。
- 采样对照：qy2010 主色/背景/链接色与旧站截图色值偏差 ≤ 感知阈值（人工签字）。
- PWA：Lighthouse PWA 检查项（installable/offline 壳）通过；离线访问已缓存路由的 E2E。

## 验收门禁

- [ ] 三主题视觉回归基线建立且通过；DOM 结构不变断言通过
- [ ] qy2010 主题站长视觉验收签字（对照旧站截图）
- [ ] 用户主题偏好持久化 + 全站默认配置生效 E2E
- [ ] 主题↔LOGO 池联动实测（设默认→自带 LOGO 生效；独立切换覆盖）
- [ ] Hero 位管理链路 E2E（上传→设当前→首页呈现→移除）
- [ ] Lighthouse PWA（installable + offline）达标
- [ ] `pnpm verify:all` 全绿；CHANGELOG 记录

## 遗留事项

- Web Push 服务端 → M13 后视需求。
- /design 主题切换 hydration mismatch（M6-carryover O-2 遗留）：Step 1 改造时核查，未复现则维持记录。
