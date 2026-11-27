import { describe, expect, it } from "vitest";
import type { FeedData, FeedScope } from "./query";
import { renderFeed } from "./render";

const ATOM = "http://www.w3.org/2005/Atom";
const DC = "http://purl.org/dc/elements/1.1/";
const site = { url: new URL("https://example.test/community&more"), name: "站点 & 论坛" };
const latest: FeedScope = { kind: "latest" };
const forum: FeedScope = { kind: "forum", fid: 9 };
const url = "https://example.test/community&more/t/42";
const input: FeedData = {
  forumName: null,
  entries: [
    {
      id: 42,
      title: `标题<>&"'\t\r\n🌊𠀀\u0000\ud800\u0001\uDFFF\ufffe\uffff`,
      author: "公开作者 & 朋友",
      createdAt: "2026-11-28 09:02:03",
      editedAt: "2026-11-29 11:02:03",
      bodyMd:
        ':::gate{key="locked_01"}\n:::\n\n&#x3c;img src=x onerror=alert(1)&#x3e; &amp;lt; **文字**\u000b\n\n丢弃下一段',
    },
  ],
};

function xml(source: string): Document {
  const parsed = new DOMParser().parseFromString(source, "application/xml");
  expect(parsed.querySelector("parsererror")).toBeNull();
  return parsed;
}

describe("订阅 XML", () => {
  it("RSS 频道、稳定 GUID、日期、作者和编码正确，描述可作为安全 HTML 文本解释", () => {
    const document = xml(renderFeed("rss", site, latest, input));
    expect(document.documentElement.getAttribute("version")).toBe("2.0");
    expect(document.querySelector("channel > title")?.textContent).toBe("站点 & 论坛 · 最新主题");
    expect(document.querySelector("channel > link")?.textContent).toBe(`${site.url.href}/`);
    expect(document.querySelector("channel > description")?.textContent).toBe(
      "来自站点 &amp; 论坛的公开新主题",
    );
    expect(document.getElementsByTagNameNS(ATOM, "link")[0]?.getAttribute("href")).toBe(
      `${site.url.href}/feeds/latest`,
    );
    expect(document.querySelector("item > title")?.textContent).toBe(`标题<>&"'\t\r\n🌊𠀀`);
    expect(document.querySelector("item > link")?.textContent).toBe(url);
    expect(document.querySelector("guid")?.textContent).toBe(url);
    expect(document.querySelector("guid")?.getAttribute("isPermaLink")).toBe("true");
    expect(document.querySelector("pubDate")?.textContent).toBe("Sat, 28 Nov 2026 01:02:03 GMT");
    expect(document.querySelector("lastBuildDate")?.textContent).toBe(
      "Sun, 29 Nov 2026 03:02:03 GMT",
    );
    expect(document.getElementsByTagNameNS(DC, "creator")[0]?.textContent).toBe("公开作者 & 朋友");
    expect(document.querySelector("author, email")).toBeNull();

    const description = document.querySelector("item > description")!;
    expect(description.children).toHaveLength(0);
    const interpreted = new DOMParser().parseFromString(description.textContent!, "text/html");
    expect(interpreted.body.children).toHaveLength(0);
    expect(interpreted.body.textContent).toBe("<img src=x onerror=alert(1)> &lt; 文字");
  });

  it("RSS 频道描述按 HTML 解释时，版块名只产生文字", () => {
    const forumName = '<img src="x" onerror="alert(1)"> &lt;';
    const document = xml(renderFeed("rss", site, forum, { forumName, entries: [] }));
    const description = document.querySelector("channel > description")!;
    expect(description.children).toHaveLength(0);
    const interpreted = new DOMParser().parseFromString(description.textContent!, "text/html");
    expect(interpreted.body.children).toHaveLength(0);
    expect(interpreted.body.textContent).toBe(`来自${forumName}的公开新主题`);
  });

  it("Atom 使用规范命名空间、纯文本字段、名称作者及跨范围、格式稳定的主题 ID", () => {
    const document = xml(renderFeed("atom", site, forum, { ...input, forumName: "版块 <名>" }));
    expect(document.documentElement.namespaceURI).toBe(ATOM);
    expect(document.querySelector("feed > id")?.textContent).toBe(
      `${site.url.href}/feeds/forum/9?format=atom`,
    );
    expect(document.querySelector("feed > title")?.textContent).toBe("版块 <名> · 最新主题");
    expect(document.querySelector('feed > link[rel="self"]')?.getAttribute("type")).toBe(
      "application/atom+xml",
    );
    expect(document.querySelector('feed > link[rel="alternate"]')?.getAttribute("href")).toBe(
      `${site.url.href}/f/9`,
    );
    expect(document.querySelector("feed > updated")?.textContent).toBe("2026-11-29T03:02:03.000Z");
    const entry = document.querySelector("entry")!;
    expect(entry.querySelector("id")?.textContent).toBe(url);
    expect(entry.querySelector("published")?.textContent).toBe("2026-11-28T01:02:03.000Z");
    expect(entry.querySelector("updated")?.textContent).toBe("2026-11-29T03:02:03.000Z");
    expect(entry.querySelector("link")?.getAttribute("href")).toBe(url);
    expect(entry.querySelector("author > name")?.textContent).toBe("公开作者 & 朋友");
    expect(document.querySelector("email")).toBeNull();
    expect(entry.querySelector("summary")?.getAttribute("type")).toBe("text");
    expect(entry.querySelector("summary")?.textContent).toBe(
      "<img src=x onerror=alert(1)> &lt; 文字",
    );
  });

  it("空源有效且输出稳定，Atom 提供源作者及固定更新时间", () => {
    const data = { forumName: "空版块", entries: [] };
    const rss = renderFeed("rss", site, forum, data);
    const atom = renderFeed("atom", site, forum, data);
    expect(rss).toBe(renderFeed("rss", site, forum, data));
    expect(atom).toBe(renderFeed("atom", site, forum, data));
    const channel = xml(rss).querySelector("channel")!;
    expect(channel.querySelector("title")?.textContent).toBe("空版块 · 最新主题");
    expect(channel.querySelectorAll("item, lastBuildDate")).toHaveLength(0);
    const feed = xml(atom).querySelector("feed")!;
    expect(feed.querySelectorAll("entry")).toHaveLength(0);
    expect(feed.querySelector("author > name")?.textContent).toBe("站点 & 论坛");
    expect(feed.querySelector("updated")?.textContent).toBe("1970-01-01T00:00:00Z");
  });

  it("按源内所有可见条目的时间取更新时间，异常的早期编辑不覆盖发布时间", () => {
    const entry = input.entries[0]!;
    const document = xml(
      renderFeed("atom", site, latest, {
        forumName: null,
        entries: [
          { ...entry, id: 43, createdAt: "2026-11-29 12:00:00", editedAt: "2026-11-21 10:00:00" },
          { ...entry, editedAt: "2026-11-30 12:00:00" },
          { ...entry, id: 41, editedAt: null },
        ],
      }),
    );
    expect(document.querySelector("feed > updated")?.textContent).toBe("2026-11-30T04:00:00.000Z");
    expect(
      Array.from(document.querySelectorAll("entry > updated"), (el) => el.textContent),
    ).toEqual(["2026-11-29T04:00:00.000Z", "2026-11-30T04:00:00.000Z", "2026-11-28T01:02:03.000Z"]);
  });

  it("条目时间非法时拒绝输出畸形日期", () => {
    expect(() =>
      renderFeed("rss", site, latest, {
        forumName: null,
        entries: [{ ...input.entries[0]!, createdAt: "非法时间" }],
      }),
    ).toThrow("无效的订阅条目时间");
  });
});
