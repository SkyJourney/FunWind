import path from "node:path";

/**
 * 文件存储根目录（STORAGE_DIR；默认 <仓库根>/storage/，已 gitignore）。
 * next 的 cwd 是 apps/web，所以默认值回退两级。可平移到对象存储时只需替换读取实现。
 */
export function getStorageDir(env: Record<string, string | undefined> = process.env): string {
  // STORAGE_DIR 是部署时外置目录，不应作为构建文件追踪。
  return env.STORAGE_DIR
    ? path.resolve(/*turbopackIgnore: true*/ env.STORAGE_DIR)
    : path.resolve(process.cwd(), "../../storage");
}
