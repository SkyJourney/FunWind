import { sql } from "drizzle-orm";

/**
 * ON DUPLICATE KEY UPDATE 中引用待插入值。
 * 使用列名字面量（VALUES(`col`)）而非 drizzle 的带表前缀限定名，避免方言兼容问题。
 */
export const incoming = (column: string) => sql.raw(`VALUES(\`${column}\`)`);
