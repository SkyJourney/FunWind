/** MySQL 驱动写入结果的窄类型收口。只允许读取有效的自增主键。 */
export function insertIdOf(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (header === null || typeof header !== "object" || !("insertId" in header)) {
    throw new TypeError("数据库写入结果缺少 insertId");
  }

  const raw = (header as { insertId: unknown }).insertId;
  const insertId = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(insertId) || insertId <= 0) {
    throw new TypeError("数据库写入结果包含无效 insertId");
  }
  return insertId;
}

/** MySQL 写语句影响行数的窄类型收口（UPDATE/DELETE 可为 0）。 */
export function affectedRowsOf(result: unknown): number {
  const header = Array.isArray(result) ? result[0] : result;
  if (header === null || typeof header !== "object" || !("affectedRows" in header)) {
    throw new TypeError("数据库写入结果缺少 affectedRows");
  }
  const raw = (header as { affectedRows: unknown }).affectedRows;
  const affectedRows = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(affectedRows) || affectedRows < 0) {
    throw new TypeError("数据库写入结果包含无效 affectedRows");
  }
  return affectedRows;
}
