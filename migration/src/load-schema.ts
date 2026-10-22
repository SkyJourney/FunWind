import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { newQuery } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, '../schema/schema.sql'), 'utf8');

await newQuery(sql);
console.log('✔ schema 已加载（CREATE TABLE IF NOT EXISTS，幂等）');
process.exit(0);
