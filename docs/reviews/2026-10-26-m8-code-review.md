# M8 互动套件与检索：代码审查与整改记录（2026-10-26）

> 对象：M8 全部改动，提交区间 `c000c40..677607d`（S1–S8 共 8 个提交：互动/提及/通知/铃铛/搜索）。
> 方式：4 个只读审查者串行（互动写路径；通知核心；@提及与 outbox 扩面；搜索与数据层/E2E 声明），不带结论只看代码；主审逐条回代码核实，关键项以测试实证。原始发现约 40 条，合并去重后 **P1 × 3、P2 × 11、P3 × 约 25**。
> 本报告不含任何口令、邮箱等敏感值。

## 0. 结论

- **无 P0**。未发现越权读取、受限内容泄露或资金错误路径。
- **P1 × 3、P2 × 11 全部核实后修复**，每项带回归测试或 E2E；P3 修复 12 项，其余记录在案（§4）。
- 审查的两个高价值点：① 三个 P1 全是「集成缝」缺陷（action 层默认值 × service 层缺守卫的乘积、分类参数落空、外部输入直通 SQL 方言解析器）——单层看都合理，缝合处漏；② 「文档声明 vs 实现」类发现（actorIds 截断、E2E 虚报、注释失实）靠交叉比对暴露。
- 整改后验证：`verify:all`（web **1291**、db 66、content 55、migration 251）、`test:e2e`（桌面/移动 **172** + 生产冒烟 10）、覆盖率分支 85.69% 全部通过。

## 1. P1（3 项，全修）

| 编号 | 问题 | 核实 | 处置 |
|---|---|---|---|
| I-1 | **编辑回帖清空整个主题的标签**：`editPostAction` 对 tags 字段 `default("")` 且无条件传入，`editPost` 的替换分支无 `kind === "thread"` 守卫——回帖编辑表单不渲染标签输入，任何回帖编辑都会 `replaceThreadTags(threadId, [])` 删光主题标签（静默数据丢失） | 已核实（mutate.ts 标签分支与标题分支的 kind 守卫不对称） | 修复：替换分支加 `kind === "thread"` 守卫；补「编辑回帖不动主题标签」用例 |
| N-1 | **公告 Tab 混入全部通知**：`listFeed` 的 `notifCategory` 在 `category === "announcement"` 时落为 `undefined`——通知查询无分类过滤返回全分类最新 20 条，公告 Tab 内容被互动/审核通知挤占 | 已核实 | 修复：announcement 时跳过通知查询；补 `cat=announcement` 只含公告的断言 |
| S-1 | **搜索 BOOLEAN MODE 未清洗操作符 → 游客可 500**：`cleanQuery` 只 trim/截断，裸 `@`/`"`/`(` 经参数化仍被 MySQL 布尔解析器当语法（ER_PARSE_ERROR）；`/search?q=@` 即 500——与 `?page=2.5` 旧缺陷同类，且 @提及刚上线「搜 @某人」是高概率输入 | 已核实（InnoDB 布尔解析器行为） | 修复：剥除 `+-><()~*"@` 后重整空白；剥空按空查询引导 |

## 2. P2（11 项，全修）

| 编号 | 问题 | 处置 |
|---|---|---|
| I-2 | **并发双取消双扣计数**：unlike/unfollow 的存在性检查是无锁快照，DELETE 不看 `affectedRows` 无条件 -1——两并发取消第二个扣空（GREATEST 只在 0 处钳位，掩盖漂移）；点赞/关注按钮无防双击把窗口开到最大 | 修复：DELETE `affectedRows === 0` → 按 race 返回不扣减；按钮换 `SubmitButton`（pending 禁用）；补并发取消用例 |
| I-3 | **纯 tag 筛选分页 404**：`basePath` 在 `prefixId=0 && tag` 时拼出 `/f/901&tag=…`（缺 `?`）→ 第 2 页起 404 | 修复：query 数组统一拼接 |
| I-4 | **canAddTags 权限口径矛盾**：action 层按**操作者**判定并传参（注释还声称「editPost 内部会按作者重估」——不存在）；门控/附件同函数内按**作者**——版主可借自己 tag.add 替作者铸标签 | 修复：mutate 内按 author subject 判定（同函数已有现成 `author` 变量），action 传参删除 |
| N-2 | **聚合并发无防护 + 重复行自永续**：无唯一约束，条件 UPDATE-then-INSERT 的 insert-insert 路径不原子；一旦双行，UPDATE 匹配所有同键未读行（无 LIMIT）双份递增永不自愈 | 修复：迁移 **0007** 生成列 `open_group_key`（未读=group_key/已读=NULL）+ 唯一索引 `(user_id,type,open_group_key)`（NULL 不去重正是所需语义；存量去重先行）+ notify 撞键重试整笔（胜者行已提交，FOR UPDATE 聚合命中）；8 路并发同键恰一行 count=8 用例 |
| N-3 | **actorIds 只追加不截断**（注释/文档均称「保留最近 3」——虚假声明），无 actor 分支还会写 `[0]` 假数据；热帖万赞 data 膨胀至几十 KB 且无消费方 | 修复：聚合改为行锁内 JS 合成（count+1、actorIds 前插截断 5 个）；截断回归用例 |
| N-4 | **公告未读数学错误**：已读行不联表有效性——读过 3 条（2 条已过期）后新公告 valid=1-3 被截断为 0，新公告永不显示未读（只漏报不虚报） | 修复：reads JOIN 有效公告计数 |
| N-5 | **`post.reply_to` 模板 `{floor}` 消费者永不提供**——用户看到字面「回复了你的第 {floor} 楼」 | 修复：消费者按 replyToPostId 查楼层传入 |
| N-6 | **`gate.sold` 模板 `{amount}` vs data `{price}` 错配**——收益金额永不显示 | 修复：模板改 `{price}`（此前修复被 prettier 重排吞掉，测试补位后暴露） |
| M-1 | **待审（pending）内容也发提及**：与同事务 `thread.replied` 的 visible 门控不一致——被提及者收到「提到了你」但内容不可见（审核驳回则通知永久指向不存在的内容） | 修复：三处接线均 `state === "visible"` 才发；重提审不提（M9 审核通过路径补发，留档） |
| M-2 | **提及无人数上限**：5 万字正文可携数千 @，逐人事件+不可聚合通知=通知炸弹面，且大 IN 查询在持锁事务内 | 修复：`slice(0, 10)`（上限 10 人，与计划一致） |
| S-2 | **搜索结果作者全部显示「已注销」**：查询恒 `authorName: null` 而 ThreadRow 把 null 渲染为已注销——全站公开页肉眼可见的错误信息 | 修复：补 users join 带出作者名与注销态 |
| S-3 | **E2E 虚报**：M8 文档「测试规则」承诺的互动三闭环与 CHANGELOG「走真实交互」在 e2e/ 目录不存在 | 修复：补 `e2e/interact.spec.ts` 三例（点赞→通知/关注→动态/标签→筛选）；文档措辞与实现对齐（spam 排除改记为结构性） |

## 3. P3（修复 12 项，摘录）

- recount 的 like_count 补 `kind='like'` 过滤（与写路径口径锁死，防未来多 kind 漂移）
- `backPath` 剥 query + 拒 `//`（revalidatePath 隐式 tag 按无 search 路径生成；注释失实一并修正）
- 标签名匹配归一化对齐（SQL `_ai_ci` vs JS Map 大小写分裂导致「大小写变体误报无权」）
- @解析 PREV_OK 补半角 `(` 与全角逗号句号（中文多提及分隔的自然写法此前大面积漏报）
- 铃铛 `listFeed` 增 `onlyUnread`（「先取 10 再滤已读」会把未读挤掉，与徽标自相矛盾）
- 铃铛随通知模块停用消失（layout 服务端判 `getEnabledModuleIds`）
- 游客获得搜索入口（原仅登录分支可见）
- 公告行按钮文案改「标记所有公告已读」（单条按钮实为全清，消除误导）
- 搜索 int 补 deleted 态排除用例；`notify:storm` 场景清理（见 §4）
- follows-feed 补 int 测试（覆盖率 0% → 达标）+ render 纯函数补测
- schema 守卫 `no-nullable-unique` 豁免 `notifications.open_group_key`（生成列 NULL 语义是机制本体，白名单附理由）
- 提及通知的 targetType/targetId 已入库但当前无链接——M9 通知中心加跳转时必须补可见性过滤（预警留档）

## 4. 设计取舍与残留（不修，留档）

| 项 | 说明 |
|---|---|
| notify × outbox at-least-once 无幂等键 | 重放窗口（标记失败/并发 drain）重复通知/聚合 count 虚增——爆炸半径小（非资金），M9 完整通知中心一并加幂等 |
| 编辑差集只比上一版（删→再加同人会重发） | 产品语义选择，留档 |
| 受限版块提及的信息面 | 被提及者知道「被提及」但无位置信息（无链接）——当前无泄露；M9 加链接前须过滤 |
| bell GET 无限流 | 登录用户可高频轮询（每次 6 查询）——成本型，M9 前若现实再加 |
| 0006 迁移部分失败需手工恢复（无 IF NOT EXISTS） | 运维路径风险，记录处理方式（DROP 已建索引后重跑） |
| FULLTEXT ADD INDEX 在存量大表上阻塞写（无 FTS_DOC_ID） | 实际部署主路径（空库 bootstrap→导数据）无此窗口；「对已灌数据的库补 0006」场景有写停摆，记录 |
| 单字搜索词 ngram 无 token（结果恒空） | 引导文案承担；注释更正 |
| 搜索 body 命中无相关度信号（EXISTS 折叠） | 设计取舍：title score → lastPostedAt；「相关度」对正文命中的语义为时间序 |
| 代码块内 @ 误候选 | 解析器无 markdown 结构感知（`@Injectable` 类标识符）；英文标识符风格用户名风险最高——记录，量级取决于用户名词表 |
| notification_preferences 无写入 UI | 偏好短路逻辑就位，设置页归完整通知中心 |
| follows 无 forum 可读性校验（存在性探测） | 与 404 策略的张力记录；follow 本身无害 |

## 5. 测试与门禁（整改后实测）

- `verify:all`：content 55 + db 66 + web **1291** + migration 251，exit=0；覆盖率分支 85.69%（阈值 85）。
- `test:e2e`：桌面/移动 **172** 项（净增 interact.spec 3 例）+ 生产冒烟 10 项，exit=0。
- 迁移 0007 应用 dev 库实测（生成列与唯一索引就位）；`db:verify` 全过。

## 6. 提交索引

| 提交 | 内容 |
|---|---|
| `0f7642e`–`677607d` | M8 S1–S8（8 个提交） |
| `9c5c18d` | 审查整改第一批（P1×3 + P2×11 + P3 精选 + interact E2E） |
| 本次收尾提交 | schema 守卫豁免、follows-feed/render 补测、文档对齐（27 类型实数）与本审查记录 |
