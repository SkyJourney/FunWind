# 主题系统与插槽体系（M11 设计稿，✅ 站长已确认 2026-10-31）

> 目标：把「节日装扮」「情怀主题」这类运营诉求，拆成**主题包（表现）× 站点配置（内容）**两个正交机制，
> 各自保持简单；插槽位是页面上预留的挂载点，插槽内容由主题包（CSS 表现）与站点配置（素材内容）共同决定。
> 本文档是 M11（[milestones/M11-themes-pwa.md](milestones/M11-themes-pwa.md)）与 M11.1
> （[milestones/M11.1-theme-engine.md](milestones/M11.1-theme-engine.md) 与 [milestones/M11.2-theme-switching.md](milestones/M11.2-theme-switching.md)）的共同设计基准。
> **要制作/生成主题包（AI 或人工），直接读字段级制作规范 [THEME-AUTHORING.md](THEME-AUTHORING.md)**。

## 1. 分层模型

```
┌ 主题包 Theme Pack（表现层）———————————— 长什么样
│   内置：default 为 styles/tokens/themes/default.css 静态兜底，qy2010 已改为数据驱动（M11.6 Step 5c）
│   外源：theme_packages.definition（版本化 Surface JSON）+ assets（装饰/LOGO ZIP 资源）
│   目录 = 静态注册表 ∪ DB 启用包；用户偏好或站点默认二选一生效
├ 站点素材位 Site Slots（DB 层）—————————— 挂什么
│   site_settings JSON 键（site.logo 池 / site.hero 池 / site.decor 池 / …）+ 后台管理页
│   运行时可换；目录与 site-chrome TTL 缓存（30s）+ 写后失效
└ 运营排期 Campaigns（M11.2）———————————— 限时覆盖
    campaigns 表：effect（主题包/LOGO/Hero）+ 时间窗 + 优先级，自动生效/到期回退（见 §6）
```

**关键不变量**：换主题不换 DOM——只换 `<html>` 上的属性与变量；组件只允许引用语义层
（`semantic.css`）与插槽变量，禁止裸写视觉常量。

## 2. pack × mode 正交架构（M11 定稿）

| 属性 | 含义 | 写入方 | 值域 |
|---|---|---|---|
| `html[data-mode]` | 明暗模式 | next-themes 客户端脚本（attribute 模式，storageKey 保持默认 `"theme"` 不丢用户已选） | `light / dark` |
| `html[data-pack]` | 主题包 | 服务端直出（root layout：动态用户偏好 → 动态站点默认 → default），SSR 即正确无闪烁；客户端切换同步 dataset + 持久化 | 静态内置 ID + `theme_packages` 中启用的 DB ID |

- 历史注：`data-mode` 由原 `data-theme` 更名（M11 Step 1 全库迁移）；`data-theme` 一词两义的旧状态废止。
- CSS 选择器层级：语义层默认值在 `:root` → `[data-mode="dark"]` 暗色覆盖 → 内置包静态 CSS → 通过 Surface 渲染器安全生成的 `[data-pack="<id>"]` 变量；DB definition 只生成固定 `--sf-*` 键，不允许任意 CSS/JS。
- **仅浅色主题包**（如 qy2010）用 `:root[data-pack="qy2010"]:not([data-mode="dark"])` 限定，
  暗色模式自动回退默认暗色；预留 `[data-pack="…"][data-mode="dark"]` 适配档，需要时再启用。

## 3. 页面插槽位置全景（v1）

```
┌────────────────────────────────────────────────┐
│ ① 运营横幅位（✅公告横幅已有时间窗/受众；M11.1 可扩展纯图banner）│
├────────────────────────────────────────────────┤
│ ② 顶栏表面（✅M11 令牌化：--header-bg/-blur/-border）        │
│   ③ 品牌LOGO位✅（池+主题联动）  ④ 右侧小挂件位（M11.1 落地）    │
├────────────────────────────────────────────────┤
│ ⑤ 首页 Hero 位（✅M11 配置插槽，无图不占位）                   │
│ ┌─────────────┐ ┌─────────────────────────┐   │
│ │ ⑥ 板块卡底纹✅ │ │ ⑦ 右栏品牌卡✅（LOGO 96px）  │   │
│ │ (--band-*)   │ │                         │   │
│ └─────────────┘ └─────────────────────────┘   │
├────────────────────────────────────────────────┤
│ ⑧ 页脚（✅友链+页脚文字；⑨ 上方细分隔装饰线——按需再启用）       │
├────────────────────────────────────────────────┤
│ ⑩ 底部 Tab 表面（✅M11 令牌化：--tabbar-bg/-blur，移动端）      │
└────────────────────────────────────────────────┘
  ⑪ 全局页面背景（✅M11 令牌化：--page-bg，节日可给纹理/图案）
```

M11.1 将上图中可见区域统一注册为 Surface（`header/hero-brand/banner-announce/forum-band/hero-image/tabbar/footer/auth/page`）；每个区域只消费自身 `--sf-<area>-*` 变量组。静态 `--band-*` 在 forum-band 保留兼容兜底。

插槽协议（以 ⑥ 为样板，`globals.css` 的 `.forum-card-band`）：**组件只挂类名 +
消费变量，变量默认值在 `themes/default.css`，主题包整组覆盖即可换形态**
（渐隐 / 硬边界 `data-band-mask="none"` / 压暗 `dim`）。组件内联变量默认值是禁手——
内联优先级会压过主题包（M11 Step 1 已把 `--band-*` 归位 CSS 层）。

## 4. 令牌扩展清单（颜色之外，M11 落地）

| 令牌 | 默认值 | 消费方 | 主题包玩法 |
|---|---|---|---|
| `--header-bg / --header-blur / --header-border` | `background/80` + `8px` + `--border` | `site-header.tsx` | 情怀米白纸纹顶栏、节日渐变顶栏 |
| `--tabbar-bg / --tabbar-blur` | `background/95` + `8px` | `bottom-tab-bar.tsx` | 与顶栏成套 |
| `--page-bg` | `--background` | body 与 `[data-fw-page]`（`globals.css`） | 木纹/纸纹/雪花图案多层背景 |
| `--gradient-brand` | primary→accent→secondary 渐变 | 无图板块水印（`forum-directory.tsx`） | 品牌渐变统一收口 |
| `--fw-font-display`（primitives） | 回退 `--fw-font-sans` | 站名等品牌展示位（`font-display` 工具类） | 情怀衬线/圆体标题 |

M11.1 的 Surface 运行时通过固定变量组消费填充、遮罩、描边、文字、blur 与 contentSlot；theme JSON 不携带 CSS 选择器或属性文本。PWA 的 `themeColor` / `backgroundColor` 是 definition 中单独校验的 hex 元数据，不从渐变或图片背景猜值。

原三层令牌已有的非颜色维度（圆角、三档阴影、字阶、间距、动效时长/曲线、页面过渡位移）保持不变。

## 5. 主题包 ↔ LOGO 池联动（✅ 站长定稿 2026-10-31）

**补充关系，非硬绑定**：

1. 内置包可声明 `lib/theme-packs.ts` 的 `logo`（素材放 `apps/web/public/logo/`）；DB 包在 `theme_packages.assets` 引用 LOGO 池文件，均可不带。
2. 站长把某主题包**设为全站默认**时，若 DB 包引用池内 LOGO 则设为当前项；内置包（qy2010 已改为数据驱动、default 仍为静态）仍自动从 public 目录幂等导入并设为当前项。无自带 LOGO 的包不触碰 LOGO 池。
3. 之后站长仍可随时从 LOGO 池独立切换任意一枚；管理页对带 `pack` 标签的池项显示
   「〈主题名〉自带」徽标；被移除后再次设默认主题会重新导入。
4. 联动**只在站长设站点默认主题时触发**；用户个人主题包偏好不改变站点 LOGO
   （LOGO 属站点身份，避免与池内独立切换互相踩）。
5. 审计沿用 `admin.logo.upload` / `admin.logo.activate`，`after` 里记 `via: "theme"` 区分来源。
6. 主题保存与 LOGO 联动是两个独立结果：两处默认主题入口均先经 `setSiteDefaultThemePack` 提交主题，再尽力联动 LOGO。无 LOGO 属正常不联动；缺素材、激活未生效或异常均记录上下文，并显示“主题已保存，但 LOGO 未切换”警告，不回滚已保存的主题。

## 6. 运营排期引擎（M11.2，已实现）

原设想的 `site.decor.plan` 单键 JSON 已改为通用排期：表 `campaigns`，一个方案 = 一个 effect + 配置 + 时间窗
`[starts_at, ends_at)`（`ends_at` 为空 = 长期）。本期 effect：`theme.pack` / `site.logo` / `site.hero`。
后台入口 `/admin/campaigns`（site.admin）。

- **请求侧惰性判定，无 cron**：到期不需要写回，读侧不再命中即回到常态。边界沿用 `getSiteChrome` 的 30 秒缓存，
  最多延迟 30 秒；后台保存会即时失效本进程缓存。
- **只覆盖站点默认，不覆盖用户偏好**：回退链为 用户自选 → 排期 → `site.theme` → `default`。
- **冲突**：按 effect 分区，分区内 `priority` 大者生效，相等取后创建；不同 effect 互不压制。
- **失效回退**：排期引用的包被停用、素材被移出池时，逐项回退常态，不影响其他字段。
- **与门控的方向相反**：门控遇到未知条件封闭（安全边界，宁可锁死）；排期遇到未知 effect 或坏配置只忽略该行
  （可选的运营增强，不能因一条坏数据让站点读不到主题）。这是有意的，不是漏了防护。
- **LOGO / Hero 输出地址**：`/brand/logo`、`/brand/hero` 不带 `?file=` 只读池当前项，所以读取链输出
  `chrome.logoUrl` / `chrome.heroUrl`，排期命中时带 `?file=`；调用方不得自己拼路径。
- **扩展方式**：新增 effect = 在 `lib/campaigns/effects.ts` 注册 + 在读取链接上消费 + 补键清单测试；
  只加注册表而没有消费者会被判定为「名义可插拔」（见 GATES.md 对已删除的 gateConditions 的记录）。
- **不覆盖到点副作用**：活动结束发奖这类需要 pending 行 + 批处理 + 幂等键，不属于读取覆盖。

节日主题包（如圣诞青翼）自带节日 LOGO 时，仍走 §5 的「设为全站默认」联动；排期只切换读取，不改池当前项。

## 7. 决策记录

| 决策 | 结论 | 依据 |
|---|---|---|
| 版块级换肤 / 用户自定义 CSS | 不做 | M11 边界（复杂度回退旧时代模板主题） |
| data-theme 一词两义 | 拆分为 data-mode × data-pack | 组合爆炸防护；SSR 直出 data-pack 无闪烁 |
| 明暗模式存储键 | next-themes storageKey 保持 `"theme"` | 不丢既有用户已选模式 |
| 主题包暗色支持 | qy2010 仅浅色，暗色回退默认暗色 | 情怀包为浅色设计；适配档预留 |
| 主题↔LOGO | 补充关系：设默认时一次性切换、池内可再独立切 | 站长定稿 2026-10-31 |
| 个人偏好改包 | 不改站点 LOGO | LOGO 属站点身份 |
| Hero 素材管线 | 复刻 LOGO 池：PNG-only 直存 `STORAGE_DIR/site/`，不进 files 表 | 模式已验证、链路最短；上限 ≤1920×1080 / ≤2MB |
| 池类配置泛化 | brand-pool 核心（DB 事务+审计 / fs 验真落盘 / 公开输出 / 动作骨架）logo/hero 共用薄壳 | 已落地（lib/brand/brand-pool*）；use-server-exports 守护要求动作文件保留字面 defineAction+auth，故动作不做转发导出 |
| PWA 离线缓存 | 只缓存通用 offline.html 与不可变公共静态资源；不缓存 HTML/RSC/API/files/brand；manifest 图标动态读取 LOGO 池当前项、空池回退静态图；themeColor/backgroundColor 读取站点默认包的显式 PWA 元数据 | 页面动态且包含用户态数据；避免登出/换号后读到旧账号缓存；用户个人主题不改变站点级 PWA 色值 |
| 装扮自动调度 | M11.2（配置引擎 + 时间窗），M11.1 先完成主题包引擎与 Surface 接线 | 站长定稿 2026-10-31 |
| 视觉回归基线 | 仅本机 macOS 跑（`pnpm test:visual`），容差 3% 吸收字形 AA 抖动；换基线须人工核对 | CI 字体渲染差异不可跨平台对比 |
| 顶栏挂件位 | 协议预留，M11.1 实现 | 交互/无障碍细节值得单独一轮 |

## 8. 主题管理闭环（M11.1 Step 7，站长工作区）

后台「站点管理 → 主题管理」是主题域的集中管理入口；主题编辑页是集中工作区，站点配置保留默认主题快捷设置：

- **启用容量**：全站最多启用 **5 个**主题包，包含内置 `default` 与已启用的 `qy2010`。新建、复制、ZIP 导入均创建启用包，重新启用也受同一服务层上限约束。事务先锁不可删除的 `default` 行，再锁目标包，在 READ COMMITTED 下计数与写入；失败不写包或成功审计。停用包可保留、编辑，不自动清理既有包或用户偏好。
- **导入补偿**：导入素材通过 `preserveActive` 非激活入池，不切换 active，也不恢复旧 active 快照，避免覆盖并发管理员的选择。失败逐项清理本次新增素材；若新素材已被并发设为 active，则拒绝删除并保留。清理被拒或异常记录包、操作者、阶段、素材和原因，并显示 `warn=import-cleanup`；某项失败不阻断后续补偿，建包已成功时保留成功状态。这仍不是跨文件与数据库的原子事务。
- **编辑草稿与并发**：`ThemePackEditorForm` 按 `userId + packId` 隔离完整草稿，包含名称、说明、definition 与原 `expectedRevision`。冲突保留旧锁并禁用保存，须明确确认放弃草稿、载入服务端最新快照后才能重新编辑，不自动升 revision。恢复遵守 SSR/水合与 StrictMode 语义，不因无关 props 引用变化清档；存储不可用时保留当前页面内存草稿并提示，离开页面后的恢复无法保证。历史 effect 计数及并发用例的结论更正见 [深度复审报告](reviews/2026-10-31-deep-responsive-review.md)。


1. **编辑工作区三区**：左 = Surface 区域导航 + 该区域可用能力的属性表单（浅/深档独立编辑）；
   右上 = 按真实组件结构渲染的预览（消费与实站相同的 `--sf-*` 草稿变量，支持桌面/移动宽度切换）；
   右下 = 内嵌素材库（上传 / 缩略图预览 / 删除 / 一键「用作底纹或内容图」）。
2. **素材契约**：底纹与内容图引用 decor 池（`decorUrl` = `/brand/decor?file=<poolFile>`）；
   被引用的素材在素材库与 `/admin/decor` 都显示引用徽标且拒绝删除；上传走同一 PNG 验真管线。
3. **主题自带 LOGO**：工作区内上传（自动带本包 pack 标签入 LOGO 池）/ 从池换绑 / 解绑；
   设为全站默认时自动设为当前 LOGO，之后可在「LOGO 管理」独立切换（补充关系，非绑定）。
4. **全站预览**：编辑页「全站预览此主题」写入 HMAC 签名 cookie（`fw_theme_preview`，
   `THEME_PREVIEW_SECRET` env 或进程内随机密钥），10 分钟内本人浏览器整站按该包渲染；
   顶部条「退出预览」即清。不落库、不影响其他访客；cookie 失效/包停用自动回正常链。
5. **站长真机验收清单**（历史验收范围；2026-10-31 站长已原则性确认 M11.1 收口，本轮不将原则性确认改写为新增真人/真机执行记录）：
   - [ ] 后台侧栏出现「主题管理」并能进入列表/编辑工作区
   - [ ] 工作区内上传底纹 → 素材库出现 → 一键用作板块卡底纹 → 预览可见图片
   - [ ] 浅/深档切换、桌面/移动宽度切换的预览均符合预期
   - [ ] 「全站预览」逛首页/板块/帖子/登录页，退出后恢复
   - [ ] 保存 → 设为全站默认 → 游客/未自选用户跟随；PWA manifest 两色正确
   - [ ] 导出 ZIP → 删除包 → 重新导入，配置与素材完整还原
   - [ ] 主题自带 LOGO 上传/换绑/解绑；设默认时 LOGO 联动、独立切换正常
   - [ ] 被引用素材的移除被拒且显示引用主题清单
