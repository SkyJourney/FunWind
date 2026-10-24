import { describe, expect, it } from "vitest";
import { fileUrl } from "./files";

describe("fileUrl", () => {
  it("storage_key 映射到 /files/ 路由（取代旧 /attachment/**）", () => {
    expect(fileUrl("ab/cd/abcd.png")).toBe("/files/ab/cd/abcd.png");
  });
});
