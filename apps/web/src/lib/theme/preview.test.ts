import { describe, expect, it } from "vitest";
import {
  THEME_PREVIEW_TTL_SEC,
  signThemePreview,
  themePreviewSecret,
  verifyThemePreview,
} from "./preview";

const SECRET = "test-secret";

describe("全站预览签名 cookie", () => {
  it("签发→校验往返：返回包 id；TTL 为 600 秒", () => {
    const now = 1_700_000_000;
    const cookie = signThemePreview("paper-warm", now, SECRET);
    expect(cookie.split(".")).toHaveLength(3);
    expect(verifyThemePreview(cookie, now, SECRET)).toBe("paper-warm");
    expect(verifyThemePreview(cookie, now + THEME_PREVIEW_TTL_SEC - 1, SECRET)).toBe("paper-warm");
  });

  it("过期 / 篡改 / 坏格式 / 异_secret 拒绝", () => {
    const now = 1_700_000_000;
    const cookie = signThemePreview("paper-warm", now, SECRET);
    expect(verifyThemePreview(cookie, now + THEME_PREVIEW_TTL_SEC, SECRET)).toBeNull();
    const [packId, exp, mac] = cookie.split(".");
    expect(
      verifyThemePreview(`${packId}.${exp}.${"A".repeat(mac.length)}`, now, SECRET),
    ).toBeNull();
    expect(verifyThemePreview(`${packId}.${exp}`, now, SECRET)).toBeNull();
    expect(verifyThemePreview(`bad id.${exp}.${mac}`, now, SECRET)).toBeNull();
    expect(verifyThemePreview(cookie, now, "other-secret")).toBeNull();
    expect(verifyThemePreview(undefined, now, SECRET)).toBeNull();
  });

  it("密钥：env 优先；缺省进程内随机且稳定", () => {
    expect(themePreviewSecret({ THEME_PREVIEW_SECRET: " from-env " })).toBe("from-env");
    const generated = themePreviewSecret({});
    expect(generated).toHaveLength(64);
    expect(themePreviewSecret({})).toBe(generated);
  });
});
