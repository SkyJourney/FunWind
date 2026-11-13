import { describe, expect, it } from "vitest";
import { parsePushLogFilter } from "./log-query";

describe("parsePushLogFilter（纯函数，非法值回退）", () => {
  it("status 仅认 sent/failed，其余忽略", () => {
    expect(parsePushLogFilter({ status: "sent" }).status).toBe("sent");
    expect(parsePushLogFilter({ status: "failed" }).status).toBe("failed");
    expect(parsePushLogFilter({ status: "bogus" }).status).toBeUndefined();
  });

  it("scene 仅认登记场景，其余忽略", () => {
    expect(parsePushLogFilter({ scene: "pm-received" }).scene).toBe("pm-received");
    expect(parsePushLogFilter({ scene: "post-replied" }).scene).toBe("post-replied");
    expect(parsePushLogFilter({ scene: "not-a-scene" }).scene).toBeUndefined();
  });

  it("q 去空白并截断 120", () => {
    expect(parsePushLogFilter({ q: "  push.example  " }).q).toBe("push.example");
    expect(parsePushLogFilter({ q: "a".repeat(300) }).q).toHaveLength(120);
    expect(parsePushLogFilter({ q: "   " }).q).toBeUndefined();
  });

  it("页码非正整数回退 1", () => {
    expect(parsePushLogFilter({ page: "3" }).page).toBe(3);
    for (const page of ["0", "-2", "abc", "1.5", ""]) {
      expect(parsePushLogFilter({ page }).page).toBe(1);
    }
  });
});
