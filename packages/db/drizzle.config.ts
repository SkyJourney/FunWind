import { defineConfig } from "drizzle-kit";
import { join } from "node:path";
import { newDbConfig, repoRoot } from "./src/env.js";

const c = newDbConfig();

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database,
  },
  // 迁移文件表（版本化迁移的 journal 落库位置）
  migrations: {
    table: "__drizzle_migrations",
  },
  verbose: true,
  strict: false,
});

export const drizzleFolder = join(repoRoot, "packages/db/drizzle");
