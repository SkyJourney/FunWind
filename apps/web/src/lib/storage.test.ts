import path from "node:path";
import { describe, expect, it } from "vitest";
import { getStorageDir } from "./storage";

describe("getStorageDir", () => {
  it("STORAGE_DIR 设置时取绝对路径；缺省/空串回退到仓库根的 storage/", () => {
    expect(getStorageDir({ STORAGE_DIR: "/data/fw" })).toBe("/data/fw");
    expect(getStorageDir({ STORAGE_DIR: "rel/dir" })).toBe(path.resolve("rel/dir"));
    const fallback = path.resolve(process.cwd(), "../../storage");
    expect(getStorageDir({})).toBe(fallback);
    expect(getStorageDir({ STORAGE_DIR: "" })).toBe(fallback);
  });
});
