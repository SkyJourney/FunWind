# 主题制作规范（AI 可执行版，M11.1 收口）

> **读者**：AI 助手或开发者，目标是**生成一个完整、能通过校验、前台正确渲染的主题包**。
> 本文是唯一权威口径：字段、取值、约束、素材规格、制作与交付全流程。代码事实源：
> [surface-schema.ts](../apps/web/src/lib/theme/surface-schema.ts)、
> [surface-registry.ts](../apps/web/src/lib/theme/surface-registry.ts)、
> [theme-pack-archive.ts](../apps/web/src/lib/theme/theme-pack-archive.ts)。
> 生成后请对照 §7 的校验清单逐项自查；运行时校验失败即拒绝入库，无警告只有过/不过。

---

## 1. 主题包是什么

一个主题包 = **一份 definition JSON**（结构化外观定义）+ **一组 PNG 素材引用**（不嵌二进制，只引用站内素材池文件名）+ **可选 PWA 颜色**。运行时渲染器把 definition 映射为固定 `--sf-<area>-*` CSS 变量；**任何 CSS 字符串、URL、data URI、未知字段都会被 strict 校验拒绝**——不要尝试注入样式，也不要发明字段。

明暗两档：每个区域可分别定义 `light` / `dark`。**dark 缺省 = 继承 default 包的 dark 档**（SSR 注入与编辑器预览同口径），所以"仅浅色的情怀主题"可以完全不写 dark。

回退链：包值 → default 包 → 内置静态 CSS。包未声明的能力 = 用默认。

---

## 2. Surface 区域与能力矩阵（definition 的骨架）

`surfaces` 的 key 只能是下表 9 个 id；每个区域**只接受「启用能力」列里的字段**，写了未启用能力会被拒绝：

| SurfaceId | 区域 | 启用能力 | 典型用途 |
|---|---|---|---|
| `header` | 顶部导航 | fill / overlay / border / blur / text / contentSlot | 顶栏底纹、渐变、内容图/隐藏站名 |
| `hero-brand` | 首页品牌区（右栏卡） | fill / overlay / text / contentSlot | 品牌卡底色/装饰图 |
| `banner-announce` | 公告横幅 | fill / text / contentSlot | 横幅底色、纯图 banner |
| `forum-band` | 板块卡底纹 | fill / overlay | 板块卡左图区底纹 + 渐隐遮罩 |
| `hero-image` | 首页 Hero 图 | contentSlot | 首页大图（图 + 高度） |
| `tabbar` | 移动端底部 Tab | fill / blur / border | Tab 条表面 |
| `footer` | 页脚 | fill / border / text | 页脚底色与文字 |
| `auth` | 登录/注册壳 | fill / overlay | 登录卡片底 |
| `page` | 全局页面背景 | fill | 整站背景（纯色/渐变/纹理图） |

---

## 3. 字段级定义（唯一合法形态）

### 3.1 通用标量

| 类型 | 约束 | 合法示例 | 非法示例 |
|---|---|---|---|
| 颜色 Color | `#RRGGBB` 严格 6 位十六进制 | `"#147ba9"` | `"red"` / `"#123"` / `"rgba(…)"` / `"var(--x)"` |
| 透明度 alpha | 0–1 数字，**最多两位小数** | `0.75` | `0.123` / `1.5` |
| 角度 angle | 0–359 数字 | `110` | `360` / `"90deg"` |
| 位置 position | 0–100 数字（渐变色标用） | `50` | `-5` / `101` |

### 3.2 背景填充 fill（`type` 判别联合，四选一）

```jsonc
// ① 纯色
{ "type": "solid", "color": "#f8f5e8" }

// ② 线性渐变：angle 0–359；stops 2–8 个，每标 strict { color, alpha, position }
{ "type": "linear", "angle": 110, "stops": [
  { "color": "#1e1b4b", "alpha": 1, "position": 0 },
  { "color": "#4338ca", "alpha": 1, "position": 100 } ] }

// ③ 径向渐变：shape = "circle" | "ellipse"
{ "type": "radial", "shape": "ellipse", "stops": [
  { "color": "#111111", "alpha": 1, "position": 0 },
  { "color": "#eeeeee", "alpha": 0.4, "position": 100 } ] }

// ④ 图片底纹：asset 必须是 decor 池内文件名（见 §5）
{ "type": "image", "asset": "decor-0123abcd0123abcd0123abcd0123abcd.png",
  "position": "50% 50%", "size": "cover", "repeat": "no-repeat",
  "blend": "soft-light", "opacity": 0.7 }
```

**image 字段约束**：
- `asset`：正则 `^decor-[a-f0-9]{32}\.png$`（素材池分配的文件名，见 §5）；引用不存在/未上传的文件会在保存与导入时被拒（missing-assets）。
- `position`：九宫格关键词 `"top" | "bottom" | "left" | "right" | "center" | "top left" | "top center" | "top right" | "center left" | "center center" | "center right" | "bottom left" | "bottom center" | "bottom right"`，或 `"X% Y%"`（X/Y 各 0–100 整数）。
- `size`：`"cover" | "contain" | "auto"` 或 `"1%"–"100%"` 整数百分比。
- `repeat`：`"no-repeat" | "repeat" | "repeat-x" | "repeat-y"`。
- `blend`：`"normal" | "multiply" | "screen" | "overlay" | "soft-light" | "luminosity"`。
- `opacity`：图片自身透明度（独立变量，不拼入 background 简写）。

### 3.3 覆盖遮罩 overlay

= fill 同构（四型任一）+ 可选整层 `overlayOpacity`（alpha）。渲染为区域上方的独立图层；图片遮罩的 `blend`/`opacity` 走独立变量，前台以 `calc(overlayOpacity × 图片opacity)` 合成。典型用法：图片底纹上盖一层渐隐渐变，或半透明纯色压暗。

### 3.4 边框 border / 文字 text / 毛玻璃 blur

```jsonc
"border": { "color": "#ddd5b4", "width": 1, "style": "solid" }   // width 仅 0|1|2|3；style 仅 "solid"|"dashed"
"text":   { "primary": "#33332f", "muted": "#8a8265", "link": "#147ba9" }  // 三色必填
"blur":   8   // 0–24 整数（px），header/tabbar 的毛玻璃
```

### 3.5 内容插槽 contentSlot

```jsonc
"contentSlot": {
  "image": "decor-0123abcd….png",   // 可选，decor 池引用
  "imageHeightPx": 240,             // 可选，120–480 整数（hero-image / banner 类内容槽的高度）
  "hideText": true                  // 可选，隐藏区域自有文字（纯图 banner / 纯图品牌卡）
}
```

### 3.6 PWA 颜色（definition 顶层，可选）

```jsonc
"pwa": { "themeColor": "#147ba9", "backgroundColor": "#f6f3e7" }
```

站点默认包的这两个色驱动浏览器地址栏（viewport themeColor）、manifest 两色与 PWA 图标底色。**必须是严格 hex**；不要用渐变/图片"猜色"。

### 3.7 整体结构

```jsonc
{
  "pwa": { "themeColor": "…", "backgroundColor": "…" },   // 可选
  "surfaces": {
    "<SurfaceId>": {
      "light": { /* 能力字段，见 §3.2–3.5 */ },
      "dark":  { /* 同上，可选；缺省继承 default 包 dark */ }
    }
  }
}
```

所有对象都是 **strict**：未知字段（含 `"css": "…"` 之类）一律拒绝。空 `surfaces` 合法（= 全默认）。

---

## 4. 能力 → 前台效果对照（生成时选型的依据）

| 能力 | 前台变量（`--sf-<area>-*`） | 视觉效果 |
|---|---|---|
| fill.solid | `-bg` | 区域纯色底 |
| fill.linear/radial | `-bg`（color-mix 合成 alpha） | 渐变底 |
| fill.image | `-bg` + `-bg-image-opacity` + `-bg-blend-mode` | 图片底纹（透明度/混合独立控制） |
| overlay.* | `-overlay-bg` + `-overlay-opacity`（图片遮罩另有 `-overlay-bg-image-opacity`/`-overlay-bg-blend-mode`） | 覆盖在填充上的第二层（渐隐/压暗/纹理叠加） |
| border | `-border-color/width/style` | 描边 |
| text | `-text` / `-text-muted` / `-text-link` | 区域内正文/弱化/链接色 |
| blur | `-blur` | 毛玻璃（header/tabbar） |
| contentSlot | `-content-image` / `-content-image-height` / `-content-hide-text` | 区域装饰图 / 高度 / 隐藏文字 |

消费方式：组件挂 `data-surface="<id>" data-fw-theme-surface`，CSS 图层消费变量；**换肤不换 DOM**。

---

## 5. 图片素材：规格、上传与引用

### 5.1 统一规格（硬性）

| 项 | decor（底纹/装饰/内容图） | logo（主题自带 LOGO） |
|---|---|---|
| 格式 | PNG（魔数 + sharp 解码验真，伪装拒绝） | PNG 同左 |
| 大小 | ≤ 4 MB | ≤ 512 KB |
| 像素 | ≤ 3840 × 2160 | 不限（前台 28/36/96px 渲染，建议 ≥ 512×512 正方形） |
| 文件名 | **上传时由素材池分配** `decor-<32位hex>.png`，不可自定 | 同左，`logo-<32位hex>.png` |

**推荐尺寸（生成图片时按此出图，保证观感统一且不超限）**：

| 用途 | 建议尺寸 | 说明 |
|---|---|---|
| 全页背景 `page` | 1920×1200 或 512×512 可平铺tile | `size:"cover"` 或 `repeat:"repeat"` |
| 顶栏/横幅纹理 `header`/`banner-announce` | 1920×300–600 横幅 | `cover` |
| 板块卡底纹 `forum-band` | 480×360（4:3） | 左图区固定宽（约 7rem），`cover` 裁切 |
| 首页 Hero `hero-image` | 1200×675（16:9）起，最高 3840×2160 | 高度由 `imageHeightPx`（120–480px 显示高）控制 |
| 品牌卡装饰 `hero-brand` | 512×512 | 卡内 `cover` |

### 5.2 上传与获取文件名（两种途径）

1. **后台 UI**（人工或 AI 走浏览器自动化）：「站点管理 → 主题素材」上传，或主题编辑工作区内嵌素材库上传；URL `?added=decor-….png` / 卡片上可读文件名。
2. **ZIP 导入**（机器对机器最顺）：把 PNG 放入包内 `assets/decor/<你的命名>.png`，manifest 里登记；导入时系统重新验图、**重映射为站内新文件名**并自动改写 definition 引用——所以 ZIP 内文件名可读即可（如 `assets/decor/paper-texture.png`），最终以导入后回显的 `decor-<hex>.png` 为准。

### 5.3 引用规则

definition 里**只写池内文件名**（`decor-<hex>.png`）。引用不存在的文件：后台保存报 `missing-assets`、ZIP 导入报缺素材；被引用的素材不可从池中删除（删除会返回 409 + 引用清单）。

---

## 6. 交付三条路（AI 按场景选）

### 路线 A：definition JSON + 已有素材（最常用）

1. 通过 UI 或 API 向 decor 池上传图片，记录每张的 `decor-<hex>.png` 文件名。
2. 按 §3 组装 definition（引用这些文件名）。
3. 后台「主题管理」新建包（id 规则 `^[a-z0-9][a-z0-9_-]{1,31}$`，保留字 `default/dark/system` 不可用）→ 编辑页粘贴 JSON 保存；或直接调用包创建/更新服务（严格校验 + revision 乐观锁 + 审计）。
4. 用编辑页「全站预览」核对（10 分钟签名 cookie，整站按该包渲染、不落库），保存后「设为全站默认」或让用户自选。

### 路线 B：完整资源包 ZIP（含图片、可分享/迁移）

```
theme.zip
├── theme.json                    # { format:"funwind-theme-pack", formatVersion:1, package:{…} }
│   └── package: { id, name, description, schemaVersion:1, definition, assets:[{kind,poolFile,sha256,bytes}] }
└── assets/
    ├── decor/<可读名>.png        # ≤4MB ≤3840×2160
    └── logo/<可读名>.png         # ≤512KB
```

约束：ZIP ≤ 20 MB、资源 ≤ 32 个；每资源带 sha256 与字节数；`poolFile` 命名 `decor-<32hex>.png` / `logo-<32hex>.png` 且与 kind 前缀一致；definition 引用的 decor 必须都在包内。导入时需**提供一个新的包 id**（不覆盖现有包）；系统验 CRC/SHA → 重验 PNG → 入池重映射文件名 → 建包。恶意内容（非法路径、加密条目、ZIP64、外链、坏 JSON、未知字段）一律拒绝。

### 路线 C：后台编辑器人工调配

新建包（definition 起步 = default 包副本）→ 逐区域用表单控件调整 → 实时预览 → 保存。适合微调，不适合从零生成。

**容量与失败反馈**：全站启用主题包最多 **5 个（含内置包）**。新建、复制、导入及重新启用都走同一容量检查；满额报 `enabled-limit`，需先停用一个包，不能靠换入口绕过。停用不删除包或用户偏好。ZIP 导入素材通过 `preserveActive` 非激活入池，不切换当前素材，也不恢复旧 active 快照。失败补偿逐项清理本次新增素材；若新素材已被另一位管理员并发设为 active，则拒绝删除、保留素材并显示 `warn=import-cleanup`，清理异常也记录日志并告警。`saved=imported` 表示包已创建，不能因警告重复导入。同样，设默认后 LOGO 联动失败只告警，不撤销成功的主题保存。

**并发保存**：`ThemePackEditorForm` 按 `userId + packId` 隔离完整草稿，保留名称、说明、definition 和原 `expectedRevision`。冲突后禁用保存；须明确确认放弃当前草稿并载入最新版本后才能重新编辑，不能自动提高 revision 后把旧草稿再提交。浏览器存储不可用时页面会提示，当前内存草稿仍保留，但离开页面后的恢复无法保证。纠错依据见 [本轮深度复审](reviews/2026-10-31-deep-responsive-review.md)。

---

## 7. 生成后自查清单（提交/入库前逐项过）

1. [ ] 每个 `surfaces` key 都在 §2 的 9 个 id 里；每块只用了该区域「启用能力」的字段。
2. [ ] 所有颜色 `#RRGGBB`；所有 alpha ≤ 两位小数；渐变 stops 2–8 且 position 0–100。
3. [ ] 图片 `asset` 全部匹配 `decor-<32hex>.png` 且文件已在池中（或 ZIP 内已登记）。
4. [ ] `pwa.themeColor/backgroundColor` 是严格 hex，且与包的整体色调一致（浅色包给浅 background）。
5. [ ] 浅色主题不写 `dark`（继承 default 暗色）；深浅双主题分别给出两档，且暗色档文字对比度足够。
6. [ ] 无任何未知字段（strict 拒绝）、无 CSS/URL 字符串、无 `var()`/函数。
7. [ ] 保存或导入通过；「全站预览」下首页/板块/帖子/登录页目视核对；明暗各一遍。
8. [ ] 设为默认后 `manifest.webmanifest` 的两色 = 包 `pwa` 值。

**参考实现**：完整字段示例见集成测试夹具
[packs.int.test.ts](../apps/web/src/lib/theme/packs.int.test.ts) 与视觉矩阵定义
[visual.spec.ts](../apps/web/e2e-visual/visual.spec.ts)（`visual-surface` 包：线性渐变 header + 图片底纹 forum-band + PWA 色）；拒绝矩阵见
[surface.test.ts](../apps/web/src/lib/theme/surface.test.ts)。

## 8. 边界（生成时不要做）

- 不做版块级换肤、用户自定义 CSS、远程主题源（URL 拉取）——引擎从设计上拒绝。
- 不支持字体文件上传（展示字体仅系统栈枚举，暂缓）。
- 不支持动画/JS 挂件（静态图挂件归 M11.2 装扮方案）。
- 透明度一律用结构化 alpha 字段表达；`rgba()`/CSS 函数进不了定义。
