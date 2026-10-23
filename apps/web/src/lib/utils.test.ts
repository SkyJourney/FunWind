import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("拼接多个类名", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("过滤假值（条件类名）", () => {
    expect(cn("a", false && "b", undefined, null, "c")).toBe("a c");
  });

  it("tailwind-merge 去冲突：后者覆盖前者", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
  });

  it("不冲突的类名共存", () => {
    expect(cn("px-2", "py-2")).toBe("px-2 py-2");
  });
});
