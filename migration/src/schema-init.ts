import { bootstrapDb } from "@funwind/db";

/**
 * 迁移前置：与零数据部署共用同一条 Drizzle 管线（决策 #10 单一事实源）。
 * bootstrapDb 全程幂等（版本化迁移 + 列级补丁 + 系统种子），因此每次迁移都先执行一遍，
 * 保证角色/权限词汇表与代码一致——不再用「migration_state 是否存在」判断是否已初始化。
 */
export async function loadSchemaOnce() {
  await bootstrapDb();
}
