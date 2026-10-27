# 密码双轨制迁移方案（✅ 站长拍板 2026-10-27，待实施）

> 背景见对话与 migration/src/transform/users.ts:192（原红线「旧哈希不迁移」由本方案替代）。
> 实施排期：S5 阶段 B/C 的用户域切片；本文是唯一设计依据，实施时不得偏离。

## 目标

老账号**可以用旧密码登录**，但登录后**必须立即换用新密码**（argon2id），完成后旧哈希凭据即失效。

## 数据模型（只有迁移系统写入）

- `users` 表新增独立字段（实施时定名，建议两列）：
  - `legacy_password_hash`（TEXT NULL）：旧站哈希材料（phpwind `md5(md5(pwd)+salt)`，含盐，整体存）；
  - `legacy_password_pending`（BOOLEAN NOT NULL DEFAULT false）：双轨登录标记。
- 写入规则：
  1. **唯一写入方 = 迁移管线**（transform/users.ts，替换现行 `passwordHash: null` 红线注释）；
  2. 零数据部署（bootstrap/seed/安装向导）不写这两列 → 默认即「新账号」状态；
  3. 应用层任何代码**不得修改标记位**；唯一合法的清除动作 = 用户完成密码更新（见流程）时
     将 `legacy_password_hash` 置 NULL（标记位可保留为出身证明，不再参与任何判定）。
- 迁移管线同步改动：transform 时保留旧哈希+盐原文；verify.ts 增加「旧哈希可登录」的迁移核验项。

## 登录流程（双轨）

1. 常规：argon2id 校验 `passwordHash` 成功 → 正常会话（与现状一致）。
2. 双轨：`legacy_password_pending = true` 且 argon2 校验失败 → 用旧算法（phpwind 口径）校验
   `legacy_password_hash`：
   - 成功 → 发放**受限会话**（must-change-password 态），强制跳转「设置新密码」页（一次性引导页，
     非 /settings），新 argon2id 落库后 `legacy_password_hash` 置 NULL → 转正常会话；
   - 失败 → 走现有失败路径（频控/文案不变）。
3. 邮件重置/认领（/forgot、/claim）成功设密时同样置空 `legacy_password_hash`（旧凭据即时失效）。
4. 登录频控（10 分钟 5 次）对双轨路径同等生效；旧算法校验必须常数时间比较。

## 安全边界

- 旧 md5 系哈希只作为「首次登录钥匙」，完成换密即销毁；双轨窗口内这些账号仅多一条
  md5 校验路径（可被离线爆破的窗体 = 迁移库本身，与现状风险等同）。
- 旧算法实现放 `lib/auth/password.ts`（phpwind 口径：`md5(md5(pwd).salt)`，以实际旧站代码为准，
  实施前用旧库样本 3–5 条验证）。
- 不做「旧密码直接通过」的静默升级——必须走强制换密页（站长明确要求）。

## 实施清单（届时执行）

- [ ] packages/db schema：两列 + drizzle 迁移（dev 库 push）
- [ ] migration transform：保留旧哈希（删 :192 红线注释）+ verify 项
- [ ] lib/auth/password.ts：phpwind 旧算法 + 单测（真实旧样本）
- [ ] login.ts：双轨分支 + must-change 会话态（session 表加同款标记或 cookie 侧标记，实施时定）
- [ ] 设新密码引导页 + 强制重定向（middleware 或页面级守卫）
- [ ] 重置/认领流程同步清 legacy 字段
- [ ] E2E：老哈希账号登录 → 强制换密 → 旧密码失效 → 新密码可登录
