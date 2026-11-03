import { describe, expect, it } from "vitest";
import { parseDecorPool } from "./decor-pool";

describe("parseDecorPool（装饰素材池元数据校验）", () => {
  it("合法池：清单 + active 保留", () => {
    expect(
      parseDecorPool({
        items: [{ file: "decor-abc.png", name: "纸纹底" }],
        active: "decor-abc.png",
      }),
    ).toEqual({
      items: [{ file: "decor-abc.png", name: "纸纹底" }],
      active: "decor-abc.png",
    });
  });

  it("非法项丢弃：文件名不符 decor- 前缀、路径穿越、超长名称截断", () => {
    expect(
      parseDecorPool({
        items: [
          { file: "../evil.png", name: "x" },
          { file: "logo-abc.png", name: "别的池" },
          { file: "decor-ok.png", name: "n".repeat(50) },
        ],
        active: null,
      }),
    ).toEqual({ items: [{ file: "decor-ok.png", name: "n".repeat(40) }], active: null });
  });

  it("active 不在清单 → null（悬空指针防护）", () => {
    expect(
      parseDecorPool({ items: [{ file: "decor-a.png", name: "A" }], active: "decor-b.png" }),
    ).toEqual({ items: [{ file: "decor-a.png", name: "A" }], active: null });
  });

  it("包标签 pack 合法才保留（主题包归属标记）", () => {
    expect(
      parseDecorPool({
        items: [
          { file: "decor-a.png", name: "A", pack: "qy2010" },
          { file: "decor-b.png", name: "B", pack: "../x" },
        ],
        active: null,
      }).items,
    ).toEqual([
      { file: "decor-a.png", name: "A", pack: "qy2010" },
      { file: "decor-b.png", name: "B" },
    ]);
  });

  it("空值 / 坏结构回空池", () => {
    expect(parseDecorPool(null)).toEqual({ items: [], active: null });
    expect(parseDecorPool("junk")).toEqual({ items: [], active: null });
  });
});
