import { describe, expect, it } from "vitest";
import { selectMigrationSteps, STEPS } from "./pipeline.js";

describe("legacy-password 迁移步骤接线", () => {
  it("默认完整管线在 users 后立即回填旧密码材料", () => {
    const names = STEPS.map((step) => step.name);
    expect(names.indexOf("legacy-password")).toBe(names.indexOf("users") + 1);
    expect(selectMigrationSteps([]).map((step) => step.name)).toEqual(names);
  });

  it("单独重跑 users 时自动附加 legacy-password，并保留 users→回填顺序", () => {
    const names = selectMigrationSteps(["users"]).map((step) => step.name);
    expect(names).toContain("users");
    expect(names).toContain("legacy-password");
    expect(names.indexOf("legacy-password")).toBe(names.indexOf("users") + 1);
    expect(names).toContain("content"); // users 与 content/badges/files 的文件组联动仍保留
    expect(names).toContain("files");
  });

  it("允许只选 legacy-password，在已恢复目标库补回填而不重跑其他步骤", () => {
    expect(selectMigrationSteps(["legacy-password"]).map((step) => step.name)).toEqual([
      "legacy-password",
    ]);
  });
});
