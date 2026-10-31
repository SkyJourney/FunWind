import { rmSync } from "node:fs";
import { resolve } from "node:path";

export function prepareE2eStorage(repoRoot, configuredPath) {
  const expectedPath = resolve(repoRoot, "storage-e2e-step7");
  if (configuredPath && resolve(repoRoot, configuredPath) !== expectedPath) {
    throw new Error("E2E 只能清理仓库专用的 storage-e2e-step7 目录");
  }
  rmSync(expectedPath, { recursive: true, force: true });
  return expectedPath;
}
