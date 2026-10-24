import { describe, expect, it } from "vitest";
import { APP_URL, SITE_NAME } from "./site";

describe("site", () => {
  it("APP_URL 无尾斜杠（拼邮件链接用）；站点名固定", () => {
    expect(APP_URL.endsWith("/")).toBe(false);
    expect(APP_URL).toMatch(/^https?:\/\//);
    expect(SITE_NAME).toBe("青翼字幕组");
  });
});
