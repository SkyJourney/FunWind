# migration · 青翼 phpwind → FunWind 导入指南

> 面向站长的可选路径文档（M12 安装完成页指引的落点）。
> FunWind 默认**零数据部署**（`pnpm db:bootstrap` + 安装向导）；只有要把旧论坛内容搬过来时才需要本指南。

## 1. 这是什么

`migration/` 是一个一次性导入器：把旧站「青翼字幕组（phpwind 9，GBK）」的
用户、版块、主题、帖子、附件、积分、徽章等 11 类实体（约 16.7 万行）导入新库。
旧库**只读**：导入器对旧库只发 SELECT/SHOW/DESC，代码级守卫强制。

不做的事：不迁移垃圾空壳、回收站、屏蔽内容与私信（旧库即归档）；不迁移旧密码
（`password_hash=NULL`，用户走邮件认领/重置流程拿新密码）。

## 2. 前置

1. 新库已按 README「零数据部署」章节准备好 MySQL 8.4 容器（utf8mb4）。
2. 根目录 `.env` 已配置 `OLD_DB_*`（旧库只读连接）与 `NEW_DB_*`（新库连接）。
   模板见 `.env.example`；`ATTACHMENT_DIR` / `EMOTION_DIR` / `BATCH_SIZE` 仅导入使用。
3. 旧站附件与表情目录可读（默认路径见 `docs/BLUEPRINT.md` §9 环境速查）。

## 3. 步骤

```bash
# 0) 演练（强烈建议）：先在临时库把全流程走一遍，不带任何真实数据风险
NEW_DB_NAME=qysub_next_rehearsal pnpm --filter @funwind/db exec tsx scripts/e2e-reset.ts
NEW_DB_NAME=qysub_next_rehearsal pnpm migrate          # 导入
NEW_DB_NAME=qysub_next_rehearsal pnpm verify:migration # 对账（见下）

# 1) 正式导入（一次性全量；检测到线上数据会拒绝重跑，强制需 MIGRATION_FORCE=1）
pnpm migrate

# 2) 对账 + 本地硬门禁（渲染形状 + 旧库原文字符守恒，需旧库可读）
pnpm verify:migration

# 3) 报告入库（docs/reports/）：行数、抽样与对账结果留档
```

导入完成后：

- 旧密码账号走「邮件认领」拿新密码（`PASSWORD-DUAL-TRACK.md`）；
- 首次部署如尚未运行安装向导：注意「先 db:bootstrap 再部署」的约定已由导入
  隐式完成（导入器复用同一 schema 管线）；再跑 `pnpm install:cli` 或安装向导时，
  因数据库已有用户，站点设置与管理员写入会被**防重装保护拒绝**——导入路径的
  管理员账号由旧站特殊组推导（见 `docs/AUTHZ.md`），无需向导创建。

## 4. 对账口径（verify:migration）

- 迁移前后计数对账 110 项（逐实体行数 + 抽样内容比对）；
- `verify:render`：迁移正文的渲染形状守卫；
- `verify:fidelity`：旧库原文**字符守恒**（一个字符都不能多或少）。
- 全部为 0 容忍：任何一项失败都代表导入不完整，修复后重跑（幂等）。

## 5. 红线与回滚

- **旧库只读**：任何写入尝试都会被代码级守卫拒绝。
- 新库是导入的**唯一写入目标**；导入失败重跑即可（幂等），无需手工修数据。
- 出现不可恢复问题时：DROP 新库 → 重建 → 重跑导入（数据源永远是旧库与附件目录）。
