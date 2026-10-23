# M6 · 发帖与内容生产

- 阶段：二·核心 ｜ 覆盖模块：M01 交互层 ｜ 依赖：M5.5（统一 post 模型、门控、积分核心）
- 状态：⬜ 未开始（细节选型与调研在 M6 开工时进行）

## 目标

论坛的「写」路径：Markdown 编辑器、发帖/回帖、编辑/删除、附件上传、**门控创作与购买交互**，
并把事件总线接上真实业务事件——从此模块注册表有了真实生产者。

## 范围（做什么）

1. **编辑器选型与实现**：开工第一步做选型 spike（候选 Milkdown / Tiptap / CodeMirror 源码+预览，评审维度见
   [GATES.md](../GATES.md) §9），选定后实现：Markdown 往返无损、工具栏、预览、移动端适配、Unicode emoji 直输。
   **不再提供旧式表情面板**（历史表情已在迁移期展开为静态图片）。
2. **发帖/回帖**（统一 post 模型）：选版块与主题前缀（`forum_prefixes`）；回帖楼层在主题级锁内分配（`floor = max+1`，防并发撞号）；
   回帖可指向 `reply_to_post_id`，渲染平铺 + 锚点跳转；@提及发 `post.mentioned` 事件（通知中心在 M8，本期仅发事件）。
3. **门控创作**：编辑器内可视化门控块（条件选择、价格输入）；保存经 `packages/content` 拆分入 `post_gates`；
   创作权限 `gate.points` / `gate.reply`；有购买记录的门控不可删除、改价只影响后续；**购买按钮与 Server Action**
   （消费 M5.5 的 `unlockGate`）；回复可见的「去回复」引导。
4. **编辑/删除**：编辑时限（旧 `post_modify_time` 语义，ABAC 条件）；删除为软删（`state=deleted`，回收站即状态过滤）；
   版主操作带理由（旧 `force_operate_reason` 语义）并写 `audit_log`；`edited_at` 展示。
5. **草稿**：客户端自动保存与恢复（localStorage 为主；是否需要服务端草稿表在选型时评估，旧站草稿仅 48 行，已死）。
6. **文件上传**（`files` 注册表 + `/files/<storage_key>`，见 [DESIGN-MODEL.md](../DESIGN-MODEL.md) §5）：SHA-256 去重、类型白名单、大小配额（旧 `uploads_perday` 语义）；
   正文图片与下载附件同一上传管线（图片内联为 `/files/…`，其余写 `attachments`）；图片缩略；
   **非图片附件下载走带权限校验的路由**（按所属帖子的版块读权限，M5.5 遗留）；孤儿附件在 post 末尾自动列出。
   头像上传同管线（写 `user_profiles.avatar_file_id`）。
6a. **审核提交**：版块 `review_policy` 要求审核时，提交的主题/回帖进入 `pending`，作者看到「待审核」提示；被驳回后可编辑重新提交；发 `content.submitted`（审核队列在 M9）。
7. **频控落地**：`threads_perday` / `post_pertime` / `post_url_num` 等 ABAC 条件的计数实现（M5 仅留了接口）。
8. **事件接入**：`thread.created/replied/edited/deleted`、`content.submitted`、`post.mentioned`、`attachment.uploaded` 真实派发（写 `event_log`），
   demo 消费方（M2）收到真实事件。

## 边界（明确不做什么）

- 不做旧 UBB 语法输入；不做富文本 HTML 编辑器（Markdown 为主是既定决策）。
- 不做投票帖创建（M10）；不做积分奖励规则（M7，本期只产生事件）。
- 不做图片转码/视频处理（仅校验与缩略）。
- 不做服务端 Markdown 实时协同编辑。

## 测试规则

- 组件测试：编辑器（工具栏插入、门控块增删、预览）≥ 90% 覆盖。
- 单测：`packages/content` 往返无损（编辑器序列化 ↔ 存储拆分）；楼层并发分配；频控窗口。
- E2E：发帖→回帖→编辑→软删（回收站可查）全流程；门控创作 → 读者看到锁卡片 → 购买 → 「已购买」标签 → 作者收益入账；
  回复可见：未回复不可见→回复后可见；无权限版块发帖被拒；频控触发限流提示。
- 安全：渲染净化回归（M3 用例集 + `fw-gate`）；上传文件类型伪装拦截；隐藏内容在页面源码与所有 JSON/RSC 载荷中均不出现（未解锁视角专项）。
- 性能：发帖接口 p95 < 300ms（本地基准）。

## 验收门禁

- [ ] 上述 E2E 全绿（含移动视口手工清单）
- [ ] 事件在 `event_log` 可查，demo 消费方收到真实事件
- [ ] 频控各维度有触发用例；门控未解锁视角泄露专项通过
- [ ] 软删数据可恢复（DB 层验证）；版主操作全部出审计
- [ ] 编辑器选型记录（备选方案对比与结论）写入本文档「遗留事项」
- [ ] `pnpm verify:all` 与 `pnpm test:e2e` 全绿；CHANGELOG 记录

## 遗留事项

（开工时填写：编辑器选型结论）
