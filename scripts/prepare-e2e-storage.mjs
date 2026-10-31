import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareE2eStorage } from "./e2e-storage-utils.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
prepareE2eStorage(repoRoot, process.env.STORAGE_DIR);
