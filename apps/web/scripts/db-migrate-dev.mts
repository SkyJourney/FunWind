/**
 * 对 dev/已迁移库应用 drizzle 版本化迁移（幂等，按 journal 推进）。
 * 用法：pnpm exec tsx scripts/db-migrate-dev.mts
 * 背景：bootstrap 只管空库；存量库（如 dev）在 schema 变更后用本脚本推进，
 * 与 packages/db/drizzle/*.sql 一一对应（勿手改列，避免 journal 与实际结构脱节）。
 */
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createDb, getWebPool } from "@funwind/db";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
config({ path: "../../.env", override: false });

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "../../../packages/db/drizzle");

const db = createDb(getWebPool());
await migrate(db, { migrationsFolder });
console.log("✔ 版本化迁移已应用（幂等）");
process.exit(0);
