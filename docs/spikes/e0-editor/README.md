# E0 编辑器选型 spike（存档）

**不是仓库的一部分**：不在 pnpm 工作区内（`pnpm-workspace.yaml` 只含 `apps/*`、`packages/*`、`migration`），不参与 lint / typecheck / 测试 / 构建。
保留它是因为这里的 Tiptap 门控节点与 marked 补丁、CodeMirror 适配器、裁剪组件、往返批量脚本和输入法模拟脚本是 **M6.3 / M6.4 的现成起点**。结论与数据见 [`../E0-editor-selection.md`](../E0-editor-selection.md)。

## 文件

| 路径 | 作用 |
|---|---|
| `src/editors/tiptap.ts` | **入选**：Tiptap v3 + `@tiptap/markdown`；自定义 `gate` 节点（marked 分词器 / 解析 / 序列化 / 节点视图）；覆盖 marked 的 `del`（只放行 `~~`） |
| `src/editors/cm.ts` | **入选**：CodeMirror 6 源码模式 |
| `src/editors/milkdown.ts` | 未选：Milkdown Crepe + `remark-directive` 的 gate 节点、指令降级插件、`singleTilde:false`。留作对照 |
| `src/Crop.tsx` | 两个裁剪库的试用页（**入选 react-image-crop**；输出原图像素坐标） |
| `src/equiv.ts` | 「渲染等价」判定：用站点渲染器与 `splitSource` 比较往返前后 |
| `src/Ime.tsx`、`src/App.tsx` | 测试页：编辑器页签、语料往返、输入法清单、批量接口 `window.__spike` |
| `export-corpus.mts` | 从迁移库导出 244 条语料（结构用例 + 真实帖抽样 + 还原后的门控完整源码，邮箱 / 手机号脱敏）。**语料文件不入库** |
| `batch.mts`、`analyze.mts` | Playwright 批量往返与按首个差异归类 |
| `ime.mts` | 用 CDP `Input.imeSetComposition` 模拟拼音组合输入，测 6 个位置 |
| `sizes.mjs` | 按编辑器统计打包体积（读 vite 构建清单） |

## 复现（临时目录里做，别在仓库里装依赖）

```bash
cp -R docs/spikes/e0-editor /tmp/e0 && cd /tmp/e0
npm install                     # 依赖版本见 package.json
npx tsx export-corpus.mts       # 需要本机迁移库 qysub_next 与仓库根 .env；脚本里的绝对路径按你的环境改
npx vite build && npx vite preview --host 127.0.0.1 --port 5199 &
node --experimental-strip-types batch.mts milkdown   # 或 tiptap / cm / all
node --experimental-strip-types ime.mts
```

注意：脚本里写死了 `/Volumes/Projects/FunWind` 与 playwright-core 的 pnpm 路径，换环境需要改；
`vite.config.ts` 的 `@repo` 别名指向仓库根，用来直接引用 `apps/web/src/lib/markdown.ts` 与 `packages/content`（这样往返判定用的是**站点真实渲染器**）。
测试页如要给手机用，把 `--host` 改成 `0.0.0.0` 并**测完即关**（页面会通过局域网提供语料）。
