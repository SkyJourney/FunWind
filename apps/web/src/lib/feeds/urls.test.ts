import { describe, expect, it, vi } from "vitest";
import { getSiteIdentity } from "@/lib/chrome/site-chrome";
import { getFeedSiteUrl, getFeedThreadUrl, getFeedUrls } from "./urls";

vi.mock("@/lib/chrome/site-chrome", () => ({ getSiteIdentity: vi.fn() }));

function configureSite(url: string) {
  vi.mocked(getSiteIdentity).mockResolvedValue({ url, name: "测试论坛", tagline: "" });
}

describe("订阅规范 URL", () => {
  it("从站点身份读取 HTTP(S) 对外地址", async () => {
    configureSite("http://Example.Test:3100");
    const site = await getFeedSiteUrl();
    expect(site.href).toBe("http://example.test:3100/");
    expect(getFeedUrls(site, { kind: "latest" })).toEqual({
      rss: "http://example.test:3100/feeds/latest",
      atom: "http://example.test:3100/feeds/latest?format=atom",
      page: "http://example.test:3100/",
    });
  });

  it("为版块和主题保留站点路径前缀", async () => {
    configureSite("https://example.test/community/");
    const site = await getFeedSiteUrl();
    expect(getFeedUrls(site, { kind: "forum", fid: 10 })).toEqual({
      rss: "https://example.test/community/feeds/forum/10",
      atom: "https://example.test/community/feeds/forum/10?format=atom",
      page: "https://example.test/community/f/10",
    });
    expect(getFeedThreadUrl(site, 99)).toBe("https://example.test/community/t/99");
  });

  it.each([
    "https://bad host",
    "ftp://example.test",
    "https://user@example.com",
    "https://:password@example.com",
    "https://example.test/?key=secret",
    "https://example.test/#section",
  ])("拒绝不适合作为订阅基址的站点配置 %s", async (url) => {
    configureSite(url);
    await expect(getFeedSiteUrl()).rejects.toThrow();
  });
});
