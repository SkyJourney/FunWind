import { describe, expect, it } from "vitest";
import { expandManagePermissionSelection, parseManagePermissionSnapshot } from "./permissions";

describe("管理 REST 授权选择与快照", () => {
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
