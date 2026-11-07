import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

/** M12 安装 E2E 的存储准备：只允许清理两个专用目录（向导 / CLI），仓库其余目录一律不碰。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sanctioned = ["storage-e2e-install", "storage-e2e-install-cli"];
for (const name of sanctioned) {
  rmSync(resolve(repoRoot, name), { recursive: true, force: true });
}
console.log(`✔ 安装 E2E 存储就绪：${sanctioned.join("、")}（已清空）`);
