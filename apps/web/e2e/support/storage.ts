import path from "node:path";

/**
 * E2E 存储根目录：与被测服务器同一个 STORAGE_DIR（根 test:e2e 编排固定指向 <仓库根>/storage-e2e，
 * 与开发目录隔离）。直接单跑 spec 时回退到同一目录，保持 E2E 存储隔离。
 */
export const STORAGE_E2E = process.env.STORAGE_DIR
  ? path.resolve(process.env.STORAGE_DIR)
  : path.resolve(__dirname, "../../../storage-e2e");
