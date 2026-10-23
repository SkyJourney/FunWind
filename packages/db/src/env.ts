import { config as dotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// packages/db/src → 仓库根
export const repoRoot = join(here, "../../..");

/**
 * 环境加载（单一来源）：优先仓库根 .env；兼容 migration/.env（P0 遗留路径）。
 * 已加载则跳过，防重复注入。
 */
export function loadRootEnv(): NodeJS.ProcessEnv {
  const rootEnv = join(repoRoot, ".env");
  const legacyEnv = join(repoRoot, "migration/.env");
  const target = existsSync(rootEnv) ? rootEnv : existsSync(legacyEnv) ? legacyEnv : null;
  if (target) dotenv({ path: target, override: false });
  return process.env;
}

export function newDbConfig(env: NodeJS.ProcessEnv = loadRootEnv()) {
  if (process.env.FUNWIND_DEBUG_DB === "1") {
    console.log("[db] NEW_DB_NAME =", env.NEW_DB_NAME ?? "(default qysub_next)");
  }
  return {
    host: env.NEW_DB_HOST ?? "127.0.0.1",
    port: Number(env.NEW_DB_PORT ?? 33621),
    user: env.NEW_DB_USER ?? "root",
    password: env.NEW_DB_PASSWORD ?? "",
    database: env.NEW_DB_NAME ?? "qysub_next",
  };
}
