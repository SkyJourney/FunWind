# 前端与主题系统方案（✅ 已确认：现代主 + 情怀包首发；shadcn/ui 模式）

> 原则：**把旧时代「整套模板级主题」降维成现代的「设计令牌 + 组件变体」**——
> 旧 phpwind 一套主题=整站 HTML/CSS 复制品（`themes/forum/` 有 10 套，维护即灾难）；
> 新版主题=一组 CSS 变量 + 少量组件变体，换主题不换结构。

## 1. 视觉方向（已确认）

**现代简洁 + ACG 社区气质**为默认主题：浅色为主、留白充足、卡片化信息层、圆角适中、
一个青翼品牌强调色（从旧站 logo/复刻色板提取，如青蓝/若叶绿）、字重对比清晰。
**首发即带「复刻·青翼2010」主题包**（色板从 whitesimple/wood_phpwind + kiminitodoke 采样）。
暗色模式全套（骨架预留 token）。

## 2. 三层令牌架构（主题系统的全部秘密）

```
tokens/
  primitives.css   # 原子层：色板（青、灰阶、语义色）、字号阶、间距阶、圆角阶、阴影
  semantic.css     # 语义层：--bg / --surface / --text-1,2,3 / --accent / --border
                   #          / --danger / --code-bg ...（组件只允许用这一层）
  themes/          # 主题包 = 覆盖 semantic 层的变量表
    default.css    # 现代浅色
    dark.css       # 暗色
    qy2010.css     # 「复刻·青翼情怀」：从旧皮肤 whitesimple/wood_phpwind + kiminitodoke 提取色板
```

- 切换主题 = `<html data-theme="qy2010">`，零重建、可运行时切、可让用户自选（存 profile）。
- 新主题包 = 一个 CSS 变量文件（约 30 行），这是「现代轻量主题」的具体形态。
- 密度（紧凑/舒适）与圆角也做成 token，管理后台可用高密度。

## 3. 组件策略（建议 shadcn/ui 模式）

| 选项 | 评价 |
|------|------|
| **shadcn/ui 模式（推荐）** | 组件源码进仓库（Radix 行为 + Tailwind 样式），可任意深度改样式接令牌；无黑盒、无升级绑架；社区生态大 |
| Ant Design 等成品库 | 快，但视觉强绑定、深度主题定制要 fighting，与"可换主题"目标冲突 |
| 纯自建 | 最自由但慢，表单/弹层/下拉的行为细节（a11y、焦点管理）容易踩坑 |

核心组件清单（第一批）：Button / Input / Card / Dialog / Dropdown / Tabs / Avatar /
Badge / Table / Pagination / Toast / Skeleton / Editor（MD，含表情面板）/ 楼层列表。

## 4. 前台与管理后台

- **同一令牌体系，两套布局 shell**：前台（内容优先）；`/admin`（侧边导航、高密度、表格化）。
- 管理后台不做独立仓库/独立设计语言——权限隔离靠 authz（M03），视觉隔离靠密度 token。

## 5. 响应式与移动端

- 移动优先断点（`sm 640 / md 768 / lg 1024 / xl 1280`）。
- 论坛移动端惯例：底部 Tab 栏（首页/版块/发帖/消息/我的）、帖子列表单列大卡片、
  楼层视图替代分页滚动、编辑器唤起原生键盘适配。
- PWA（manifest + 离线壳 + 推送）在 P3 阶段叠加，不影响本轮结构。

## 6. 主题包用户可见度（需站长定）

A. 仅管理员定全站主题（轻量，推荐起步）
B. 用户可在个人设置里自选主题（default/dark/qy2010 起步）
C. 版块级换肤（旧站 behaviors，不推荐——复杂度回到旧时代）

## 7. 复刻主题包素材（已完成考古）

- `themes/forum/whitesimple`、`wood_phpwind`（清爽白/木纹绿）、`black_phpwind`（暗色先例）
- `template/kiminitodoke/`（好想告诉你定制阅读页——主色与排版可直接采样）
- 旧站 logo.gif、sidebar_weibo/weixin 配图
