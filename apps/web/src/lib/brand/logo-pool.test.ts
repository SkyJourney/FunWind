import { describe, expect, it } from "vitest";
import { parseLogoPool } from "./logo-pool";

describe("parseLogoPool（LOGO 池元数据校验）", () => {
  it("合法池：清单 + active 保留", () => {
    expect(
      parseLogoPool({
        items: [{ file: "logo-abc.png", name: "圣诞节版" }],
        active: "logo-abc.png",
      }),
    ).toEqual({ items: [{ file: "logo-abc.png", name: "圣诞节版" }], active: "logo-abc.png" });
  });

  it("非法项被丢弃：文件名不符 SAFE_NAME、超长名称截断、非数组清单", () => {
    expect(
      parseLogoPool({
        items: [
          { file: "../evil.png", name: "x" },
          { file: "logo-ok.png", name: "n".repeat(50) },
        ],
        active: null,
      }),
    ).toEqual({ items: [{ file: "logo-ok.png", name: "n".repeat(40) }], active: null });
  });

  it("active 不在清单中 → 归 null（悬空指针防护）", () => {
    expect(
      parseLogoPool({ items: [{ file: "logo-a.png", name: "A" }], active: "logo-b.png" }),
    ).toEqual({
      items: [{ file: "logo-a.png", name: "A" }],
      active: null,
    });
    expect(parseLogoPool(null)).toEqual({ items: [], active: null });
    expect(parseLogoPool("junk")).toEqual({ items: [], active: null });
  });
});
