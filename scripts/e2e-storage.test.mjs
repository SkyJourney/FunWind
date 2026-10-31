import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { prepareE2eStorage } from "./e2e-storage-utils.mjs";

test("E2E 只清理专用存储目录并拒绝其他路径", () => {
  const root = mkdtempSync(join(tmpdir(), "funwind-e2e-storage-"));
  try {
    const expected = join(root, "storage-e2e-step7");
    mkdirSync(expected);
    writeFileSync(join(expected, "marker"), "remove");
    assert.equal(prepareE2eStorage(root, expected), expected);
    assert.equal(existsSync(expected), false);

    const other = join(root, "storage");
    mkdirSync(other);
    writeFileSync(join(other, "marker"), "preserve");
    assert.throws(() => prepareE2eStorage(root, other), /只能清理仓库专用/);
    assert.equal(readFileSync(join(other, "marker"), "utf8"), "preserve");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
