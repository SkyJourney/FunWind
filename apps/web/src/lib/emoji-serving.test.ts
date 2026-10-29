import { describe, expect, it } from "vitest";
import { EMOJI_MIME, emojiHeaders, parseEmojiFile, shaOfStorageKey } from "./emoji-serving";

/** 纯函数分支（解析 / 响应头 / storage_key 解析）；全流程的真实库分支见 emoji-serving.int.test.ts */
describe("parseEmojiFile", () => {
  it("合式路径：id + 受控扩展名", () => {
    expect(parseEmojiFile("120.gif")).toEqual({ id: 120, ext: "gif" });
    expect(parseEmojiFile("170.png")).toEqual({ id: 170, ext: "png" });
    expect(parseEmojiFile("171.webp")).toEqual({ id: 171, ext: "webp" });
  });

  it("不合式一律 null（调用方 404）", () => {
    for (const bad of [
      "abc.gif",
      "120.jpeg", // 扩展名不在受控词汇
      "120.GIF", // 大写不放行（后台与迁移写入的都是小写）
      "120", // 没有扩展名
      "0.png", // id 从 1 起
      "-1.png",
      "12 8.png",
      "../../etc/passwd",
      "120.gif.png",
      "120.png%00.gif",
      `${"9".repeat(30)}.png`, // 超出 int unsigned
    ]) {
      expect(parseEmojiFile(bad), bad).toBeNull();
    }
  });
});

describe("emojiHeaders", () => {
  it("对齐 /files：sandbox CSP、nosniff、inline、内容寻址不可变缓存", () => {
    const h = emojiHeaders("a".repeat(64), "png", 1234);
    expect(h["content-type"]).toBe("image/png");
    expect(h["content-length"]).toBe("1234");
    expect(h["content-disposition"]).toBe("inline");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(h["etag"]).toBe(`"${"a".repeat(64)}"`);
    expect(h["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(EMOJI_MIME.gif).toBe("image/gif");
    expect(EMOJI_MIME.webp).toBe("image/webp");
  });
});

describe("shaOfStorageKey", () => {
  // parseFileKey 要求前两级目录等于哈希前缀（防多 URL 形态），测试数据须满足
  const sha = "abcd" + "b".repeat(60);
  it("合法 storage_key 取出内容哈希", () => {
    expect(shaOfStorageKey(`${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.png`)).toBe(sha);
  });
  it("形态不合法返回 null（穿越、错段数、哈希前缀不符）", () => {
    expect(shaOfStorageKey("../etc/passwd")).toBeNull();
    expect(shaOfStorageKey(`${sha.slice(0, 2)}/${sha.slice(2, 4)}/notsha.png`)).toBeNull();
    expect(shaOfStorageKey(`zz/cd/${sha}.png`)).toBeNull();
    expect(shaOfStorageKey(`${sha}.png`)).toBeNull();
  });
});
