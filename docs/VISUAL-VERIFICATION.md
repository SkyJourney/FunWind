# 目视验收规程（Playwright 布局矩阵 + 可读切块）

> 本文是**唯一入口**：做界面目视验收时，沿用仓库里现成的 Playwright 路径，不要另起炉灶试各种截图办法。
> 最后更新：2026-11-04（M11.3 收口时沉淀；所有数字来自当天的盲测，不是推断）。

## 1. 一句话规程

**几何断言管数值，切块目视管观感；只读 `tiles/` 里的切块，不读整页长图。**

- 溢出、越界、按钮多行、控件互相覆盖：交给 `LayoutAudit` 的 DOM 几何断言，写进 `layout-audit.json`。
- 版面是否好看、对齐、遮挡、层次、提示条是否醒目：看切块图。
- 对比度、字号、行数这类能量化的东西，用 DOM 读真实值，不要靠眼睛估。

## 2. 入口与产物

| 项 | 内容 |
|---|---|
| 配置 | `apps/web/playwright.layout.config.ts`：3202 端口生产构建 + 隔离库 `qysub_next_e2e`，六档宽度 320 / 375 / 414 / 768 / 1024 / 1440 |
| 一键 | `pnpm test:layout`（根）：重置并重建隔离库后跑矩阵；**含 `pnpm db:build`，会重建 `packages/*/dist`，3100 开发服务器在跑时跑完要重启** |
| 只跑某个文件 | `LAYOUT_SPEC='文件名正则'`，例如 `LAYOUT_SPEC='responsive-register\.spec\.ts$'`；临时验收用例也走这里 |
| 审计模式 | `LAYOUT_AUDIT_ONLY=1`：逐场景收集而不中断。**此模式下 Playwright 一定显示 ✓，问题只在 JSON 里**，必须再跑 `pnpm layout:summary` |
| 导出截图 | `RUN_LAYOUT_SCREENSHOTS=1`：导出整页原图、区域图与**可读切块** |
| 汇总 | `pnpm layout:summary [目录]`：逐档汇总场景失败 / 几何 findings / 页面异常，有问题退出码 1，找不到产物退出码 2 |
| 产物位置 | `apps/web/test-results/<用例目录>/layout-audit.json` 与 `…/responsive/tiles/*.png`（已被 gitignore） |
| 跳过 `db:build` 的手动准备 | 反复验收时：`node scripts/prepare-e2e-storage.mjs`，设置 `STORAGE_DIR`、`SMTP_URL`、`MAIL_FROM`、`NEW_DB_NAME=qysub_next_e2e`，依次 `e2e-reset` → `db:bootstrap` → `db:seed` → `db:e2e-fixtures`，再在 `apps/web` 下 `pnpm exec playwright test -c playwright.layout.config.ts`（命令链见根 `package.json` 的 `test:visual`） |

跑完后 Next 会改写 `apps/web/tsconfig.json`，`prettier --check` 会因此变红：提交前 `git checkout -- apps/web/tsconfig.json`。

现有两个矩阵用例：`e2e/responsive-management.spec.ts`（后台、帖子页）与 `e2e/responsive-register.spec.ts`（M11.3 的注册页四形态、登录门提示与重发表单、设置页注册策略块）。

## 3. 读图规程（必须遵守）

截图交给多模态模型阅读时，**大图会在送达前被缩小，小字随之变糊**。下面的数字是 2026-11-04 用随机码盲测得到的：往页面或空白画布里注入随机验证码，答案只写进文件，读图转录后再对答案。

| 图片 | 字号 | 结果 |
|---|---|---|
| 420×300、800×520 | 8–20px | 24/24 读对 |
| **800×800** | 9px / 11px，四角加正中 | **10/10** |
| 375×800 原尺寸切片 | 9 / 11 / 14px | 15/15 |
| 1280×900（做了 2 次） | 14px 及以上 | 全对 |
| 1280×900（做了 2 次） | 12px 及以下 | 8px、10px 基本读错；12px 个别字符读错（一次是汉字错 2 个，一次是字母错 1 个） |
| 375×1400 单张 | 14px / 11px / 9px | 3/3，0/3，0/3 |
| **375×2400 单张** | 14px / 11px | **0/5，0/5** |
| Playwright MCP 视口截图 375×800 | 12px | 1/1 |

附件里的系统注记写着 `displayed at 313x2000`（只缩了约 17%），但这张图读出率是 0/10。**注记里的尺寸不能用来判断清晰度。**

### 规则

1. **只读 `tiles/`**。`LayoutAudit` 导出时把每张截图切成不超过 800×800（含标签条）的块，相邻块重叠 24px，整页原图只给人看。
2. **按标签对位，不按顺序对位。** 并行读多张时，附件到达顺序与调用顺序不一致（实测：调用 A、B、C、D，到达 A、D、B、C；调用 S、M、L，到达 L、M、S）。每块顶部的黄色标签条写着视口宽度、场景名、原图尺寸和块坐标，转录时先抄标签。
3. **一轮读 1 到 3 张。** 这是实践上限，为的是对位不出错，不是实测的模型上限。
4. **描述必须可证伪。** 只写图里读得到的具体文字、数值和位置，不写"看起来正常"。读不清的地方写"读不清"，不补全；之后用 DOM 事实核对。
5. **别读整页长图。** 之前 `/tmp/m113-audit/` 的 124 张里，28 张高于 1400px，最高的是设置页（400×3655），正好是最想看的那块；其余 96 张高 800–1400，14px 正文能读，11px 以下的提示文字不可靠。
6. 区域图优先：访客页、设置块都另存了 `[main]` / `[register-card]` 区域图，桌面端整页切块会把居中的卡片劈成左右两半，区域图才是完整的。

### 自检：我现在能不能读图？

不要靠自己描述"看到了什么"来判断，描述无法证伪。做盲测：

1. 脚本往页面里注入一个随机码（如 `8XGV-MGFV`，12px），把答案**只写进文件**，不打印。
2. 截图并读图，写下转录。
3. 再读答案文件比对。

通道不同结论可能不同：Playwright MCP 的 `browser_take_screenshot`（视口截图，不带 `filename` 时存到 `.playwright-mcp/`，带 `/tmp` 路径会被拒）也做过同样的盲测，1/1。它适合单页即时核对，不适合六档矩阵。

## 4. 新增场景怎么写

沿用 `LayoutAudit`（`e2e/support/layout-audit.ts`）：

```ts
const audit = new LayoutAudit(page, info);
await audit.step("场景名", async () => {
  await page.goto("/路径");
  await expect(page.getByText("关键文案")).toBeVisible(); // 先断言页面真的是想看的状态
  await audit.capture("场景名", {
    roots: "main",                       // 要做边界检查的区域
    required: ["main form"],             // 必须渲染出来的元素；缺失即失败，空采集不算通过
    regions: [{ name: "main", selector: "main" }], // 另存区域图与切块
  });
});
await audit.finish(); // 严格模式下汇总失败；审计模式只写 JSON
```

要点：

- 全局状态（注册策略、站点设置）走**真实的后台保存动作**切换，别直接改库：站点框架有 30 秒进程内缓存，只有走 Action 才会失效。收尾必须复原。
- 身份切换用 `loginAs()` 注入会话，不走界面登录（登录有账号级频控）。
- 不提交有副作用的表单；流程正确性由功能 E2E 覆盖，矩阵只管布局。
- 只靠"页面不横向滚动"判不了对错：按钮被压成竖排、链接被从中间断行、控件互相覆盖，页面照样不溢出。需要时补**专门的几何断言**。例如登录页页脚链接被拆行，用 `getClientRects().length === 1` 判。
- 写完断言要做**变异验证**：临时去掉对应修复，确认断言变红，再还原。

## 5. 已踩过的坑

- **审计模式的 ✓ 不代表通过。** `step()` 会吞掉失败写进 JSON。务必 `pnpm layout:summary`。
- **zsh 没有 `PIPESTATUS`**（要写小写 `pipestatus`），`cmd | tail` 的退出码是 `tail` 的。验证命令不要套管道，直接读 `$?`。
- **编辑和测试不要放在同一个并行块里**，否则测试可能先于编辑执行，拿到的是旧代码的结果。
- **`rm -rf` 会被权限系统拒绝**；需要删除时用不带 `-f` 的命令，或拆成独立步骤。
- **别凭"构建缓存"之类的猜测改方向。** 怀疑旧代码时，先用探针打印元素当前的 class 与计算样式，确认服务的就是新代码。
- 窄屏溢出的常见真因：`flex`/`grid` 子项里的 `<input>` 固定宽度（`w-80`）撑大父轨道。`min-w-0` 加 `max-w-full` 压不住它，要让**标签持有首选宽度**（`w-80 max-w-full min-w-0`），输入框用 `w-full`。
- 按钮必须单行且不收缩（项目契约），所以别把长内容（邮箱）放进按钮文案；动作写在按钮里，长内容放进旁边可换行的说明（`ActionGroup` + `min-w-0 [overflow-wrap:anywhere]`）。

## 6. 边界

- 六个离散宽度不等于所有宽度，也不等于真实设备；连续缩放与真机触控仍属补充验收。
- `pnpm test:visual`（`toHaveScreenshot` 基线）是另一回事：1440×900 / 375×812 单屏视口，只守"主题与关键页面没有整片变化"，**不覆盖**设置页注册块、登录页重发表单等首屏之外的内容，8/8 不能证明新界面没问题。
- 切块上限 800 来自盲测。换模型、换送图通道后，先重做 §3 的盲测再沿用这个数字（`e2e/support/tile-spans.ts` 的 `TILE_MAX` 有单测钉住）。
- 方法来源：`docs/reviews/2026-10-31-deep-responsive-review.md` §5（几何回归与逐张目视互补）。
