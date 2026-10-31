# 主题系统与插槽体系（M11 设计稿，✅ 站长已确认 2026-10-31）

> 目标：把「节日装扮」「情怀主题」这类运营诉求，拆成**主题包（表现）× 站点配置（内容）**两个正交机制，
> 各自保持简单；插槽位是页面上预留的挂载点，插槽内容由主题包（CSS 表现）与站点配置（素材内容）共同决定。
> 本文档是 M11（[milestones/M11-themes-pwa.md](milestones/M11-themes-pwa.md)）与 M11.1
> （[milestones/M11.1-festival-decor.md](milestones/M11.1-festival-decor.md)）的共同设计基准。

## 1. 分层模型

```
┌ 主题包 Theme Pack（CSS 层）———————————— 长什么样
│   styles/tokens/themes/<id>.css：覆盖语义层变量 + 插槽参数（--band-* 等）
│   注册表 lib/theme-packs.ts：id / 中文标签 / 可选自带 LOGO
│   静态、随代码发布；用户个人偏好或站点默认二选一生效
├ 站点素材位 Site Slots（DB 层）—————————— 挂什么
│   site_settings JSON 键（site.logo 池 / site.hero 池 / …）+ 后台管理页
│   运行时可换；site-chrome TTL 缓存（30s）+ 保存后 invalidate 即时生效
└ 装扮方案 Decor Plan（M11.1）———————————— 打包运营
    site.decor.plan：pack + logo + hero + banner 一次配置，带时间窗自动生效/到期回退
```

**关键不变量**：换主题不换 DOM——只换 `<html>` 上的属性与变量；组件只允许引用语义层
（`semantic.css`）与插槽变量，禁止裸写视觉常量。

## 2. pack × mode 正交架构（M11 定稿）

| 属性 | 含义 | 写入方 | 值域 |
|---|---|---|---|
| `html[data-mode]` | 明暗模式 | next-themes 客户端脚本（attribute 模式，storageKey 保持默认 `"theme"` 不丢用户已选） | `light / dark` |
| `html[data-pack]` | 主题包 | 服务端直出（root layout：用户偏好 → 站点默认 → default），SSR 即正确无闪烁；客户端切换同步 dataset + 持久化 | `default / qy2010 / …` |

- 历史注：`data-mode` 由原 `data-theme` 更名（M11 Step 1 全库迁移）；`data-theme` 一词两义的旧状态废止。
- CSS 选择器层级：语义层默认值在 `:root` → `[data-mode="dark"]` 暗色覆盖 → `[data-pack="<id>"]` 主题包覆盖。
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

原三层令牌已有的非颜色维度（圆角、三档阴影、字阶、间距、动效时长/曲线、页面过渡位移）保持不变。

## 5. 主题包 ↔ LOGO 池联动（✅ 站长定稿 2026-10-31）

**补充关系，非硬绑定**：

1. 主题包可自带一枚 LOGO（`lib/theme-packs.ts` 的 `logo` 字段，素材放 `apps/web/public/logo/`），也可不带。
2. 站长把某主题包**设为全站默认**时，若该包有自带 LOGO：自动导入 LOGO 池（池项带 `pack` 标签去重，
   幂等——已在池则不重复导入）并**设为当前项**；无自带 LOGO 的包不触碰 LOGO 池。
3. 之后站长仍可随时从 LOGO 池独立切换任意一枚；管理页对带 `pack` 标签的池项显示
   「〈主题名〉自带」徽标；被移除后再次设默认主题会重新导入。
4. 联动**只在站长设站点默认主题时触发**；用户个人主题包偏好不改变站点 LOGO
   （LOGO 属站点身份，避免与池内独立切换互相踩）。
5. 审计沿用 `admin.logo.upload` / `admin.logo.activate`，`after` 里记 `via: "theme"` 区分来源。

## 6. 装扮方案引擎（M11.1 展望，本期不做）

`site.decor.plan`（site_settings JSON）：`{ name, pack, logo?, hero?, banner?, schedule?: { startsAt, endsAt } }`。
后台一键「启用圣诞装扮」：按方案切主题默认、切 LOGO、切 Hero；带时间窗时请求侧惰性判断
（命中窗口生效、过期自动回退日常方案），无需 cron。顶栏右侧小挂件位（④）随 M11.1 落地。
节日主题包（如圣诞青翼）自带节日 LOGO，走 §5 同一联动机制。

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
| 池类配置泛化 | logo/hero 共用 brand-pool 核心（parse/校验/事务+审计），薄壳差异 | 防重复棘轮恶化；复用性优先 |
| 装扮自动调度 | M11.1（配置引擎 + 时间窗），本期插槽设计与管理先行 | 站长定稿 2026-10-31 |
| 顶栏挂件位 | 协议预留，M11.1 实现 | 交互/无障碍细节值得单独一轮 |
