import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newQuery } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaFile = join(here, '../schema/schema.sql');
const marker = 'SELECT 1 FROM migration_state LIMIT 1';

/** 首次运行时加载 schema；migration_state 存在则视为已初始化（幂等） */
export async function loadSchemaOnce() {
  try {
    await newQuery(marker);
    return;
  } catch {
    if (!existsSync(schemaFile)) throw new Error(`schema 文件缺失: ${schemaFile}`);
    await newQuery(readFileSync(schemaFile, 'utf8'));
    console.log('✔ qysub_next schema 已初始化');
  }
}
