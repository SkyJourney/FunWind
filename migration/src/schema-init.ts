import { bootstrapDb } from "@funwind/db";
import { newQuery } from "./db.js";

const marker = "SELECT 1 FROM migration_state LIMIT 1";

/**
 * 首次运行时初始化 schema：与零数据部署共用同一 Drizzle 管线（决策 #10 单一事实源）。
 * migration_state 存在则视为已初始化（幂等）；P0 期手写的 schema.sql 保留为历史底稿，不再执行。
 */
export async function loadSchemaOnce() {
  try {
    await newQuery(marker);
    return;
  } catch {
    await bootstrapDb();
    console.log("✔ qysub_next schema 已初始化（共享 Drizzle 管线）");
  }
}
