# 密码双轨与旧密码回填（✅ 已实施，2026-11-01）

> 原方案由站长于 2026-10-27 拍板；新账号只使用 Argon2id，迁移老账号可短期用旧密码登录，但首次成功后必须改设新密码。
> 旧数据库 `qingyisub` 保持只读；哈希回填只写新库 `qysub_next`。

## 目标与数据模型

老账号可以用旧密码登录一次，登录成功后进入受限会话并强制改设 Argon2id 新密码；不能静默升级继续使用旧密码。

`users` 表现有两列（schema v2 / migration 0010）：

- `legacy_password_hash`（TEXT NULL）：旧站材料，格式 `md5$<旧库 32 位 MD5>$<salt>`。
- `legacy_password_pending`（BOOLEAN NOT NULL DEFAULT false）：是否允许旧算法作为首次登录凭据。

现代 `password_hash` 始终只存 Argon2id。账号成功改设新密码、完成 claim/reset 后，应用会清空 legacy hash 并关闭 pending 标志。

## 默认迁移顺序（M11 修正，已接入）

`pnpm migrate` 的步骤顺序现在为 `users → legacy-password → restrictions …`。因此默认全量迁移会：

1. 导入用户基础资料；transform 保持 `password_hash = NULL`，绝不把旧算法伪装成 Argon2。
2. `legacy-password` 从旧库 `nw_windid_user` 只读分页取 `uid/password/salt`，调用可注入的 `backfillLegacyPasswordHashes`，将有效材料写入新库两列。
3. UPDATE 只允许目标用户为 active、`password_hash IS NULL` 且 `legacy_password_hash IS NULL`；没有有效旧材料、目标不存在/非 active、已有新密码或已回填账号都会跳过。每条写入原子且幂等，中断后可安全重跑。

部分重跑 `pnpm migrate users` 会自动附带 `legacy-password`，不会因漏选步骤留下无双轨材料的旧账号；也可单独选择 `pnpm migrate legacy-password` 补回填。兼容保留独立恢复命令：

```sh
pnpm --filter @funwind/migration exec tsx src/backfill-legacy-password.ts
```

回填命令不可与其他迁移并发运行。旧库连接由 `migration/src/db.ts:oldQuery` 强制只允许 SELECT/SHOW/DESC。

### 已认领账号保护（重跑安全）

目标库已存在非空 Argon2 `password_hash` 的 uid 会从 users/profile/avatar 的旧资料 UPSERT 中排除，但仍保留在 `ctx.userIds` 供内容迁移引用；`legacy-password` 的 WHERE 条件也会跳过这些账号。这样重跑不会把已认领用户的新密码、profile 或头像回退成旧站状态，也不会重新打开旧密码入口。

## 登录与强制换密流程

1. 先验证现代 Argon2id；成功即正常会话。
2. 若现代验证失败且 `legacy_password_pending = true`、旧 hash 非空，则按 phpwind 口径 `md5(md5(password) + salt)` 校验。
3. 旧密码匹配时建立受限会话并跳强制换密页；其他普通页面/API 被门控。用户设置新密码后，写 Argon2id、清 legacy hash、撤销其他会话并签发正常会话。
4. 旧密码失败继续走原登录失败话术与频控；不做“旧密码验证成功后静默留在站内”的路径。
5. 邮件 claim/reset 是另一条入口：成功设密后也清除旧凭据；不要在验证双轨流程前先消费 claim link，否则会直接创建新密码并绕过本次旧密码登录测试。

应用层双轨实现位于 `apps/web/src/lib/auth/password.ts`、`login.ts`、`session.ts`、`middleware.ts`；迁移回填核心位于 `migration/src/backfill-legacy-password.ts`，默认步骤定义见 `migration/src/steps.ts` / `pipeline.ts`。

## 测试与操作

- migration fake-query 单测验证有效/无效材料、旧库只读、目标状态保护、重复执行幂等和 uid 分页；用户转换单测验证已设置 Argon2 的用户/profile/avatar 不进入旧资料 UPSERT；pipeline 单测验证默认顺序及 `users` 单步联动。
- 应用 E2E `apps/web/e2e/dual-track-auth.spec.ts` 验证旧 hash 登录 → 强制换密 → 旧密码失效 → 新密码登录；旧站真密码不写入测试日志或文档。
- 恢复空目标库：先 `NEW_DB_NAME=qysub_next pnpm db:bootstrap`，再 `NEW_DB_NAME=qysub_next pnpm migrate`。已导入但只需补回填时，使用 `NEW_DB_NAME=qysub_next pnpm migrate legacy-password`；若迁移守卫检测到 live data，应停下核对，不要用 `MIGRATION_FORCE=1` 绕过。
