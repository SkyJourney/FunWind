import { describe, expect, it } from "vitest";
import { PERMISSION_DEFINITIONS } from "@funwind/db";
import {
  expandManagePermissionSelection,
  MANAGE_ENDPOINTS,
  MANAGE_ENDPOINT_PERMISSIONS,
  parseManagePermissionSnapshot,
  type ManageEndpointDefinition,
} from "./permissions";

describe("管理 REST 授权选择与快照", () => {
  it("端点可挂权限点全部在 authz 词汇表内（防联合类型与词汇表漂移）", () => {
    const vocabKeys = new Set(PERMISSION_DEFINITIONS.map((def) => def.key));
    for (const key of MANAGE_ENDPOINT_PERMISSIONS) {
      expect(vocabKeys.has(key), `${key} 应在 authz 词汇表注册`).toBe(true);
    }
  });

  it("现有端点挂接的权限点都在受控联合内", () => {
    const allowed = new Set<string>(MANAGE_ENDPOINT_PERMISSIONS);
    for (const definition of Object.values(MANAGE_ENDPOINTS) as ManageEndpointDefinition[]) {
      if (definition.permission) {
        expect(allowed.has(definition.permission), definition.path).toBe(true);
      }
    }
  });

  it("只展开被选中的域，不按相同底层权限合并域", () => {
    expect(
      expandManagePermissionSelection({ stats: "read", emails: "none", users: "read" }),
    ).toEqual(["stats", "users", "users.detail"]);
    expect(expandManagePermissionSelection({ identity: "read" })).toEqual(["whoami"]);
  });

  it.each(
    [null, [], {}, { stats: "none" }, { stats: "write" }, { unknown: "read" }, { users: true }].map(
      (selection) => ({ selection }),
    ),
  )("拒绝空集、没有写端点或未知的选择：$selection", ({ selection }) => {
    expect(expandManagePermissionSelection(selection)).toBeNull();
  });

  it("读取精确快照，不展开同域中快照未列出的端点", () => {
    expect(expandManagePermissionSelection({ contents: "read" })).toEqual([
      "contents",
      "contents.detail",
    ]);
    expect(parseManagePermissionSnapshot(["contents"])).toEqual(["contents"]);
  });

  it.each(
    [["stats", "stats"], ["stats", "stats.future"], [7], [], "stats", { stats: "read" }].map(
      (snapshot) => ({ snapshot }),
    ),
  )("拒绝非法快照：$snapshot", ({ snapshot }) =>
    expect(parseManagePermissionSnapshot(snapshot)).toBeNull(),
  );
});
