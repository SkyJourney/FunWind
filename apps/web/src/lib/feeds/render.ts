import { parseDbDateTime } from "@/lib/datetime";
import type { FeedData, FeedScope } from "./query";
import { cleanXmlText, summarizeFeedBody } from "./summary";
import { getFeedThreadUrl, getFeedUrls } from "./urls";

export type FeedFormat = "rss" | "atom";

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
const ATOM_NS = "http://www.w3.org/2005/Atom";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const EMPTY_ATOM_UPDATED = "1970-01-01T00:00:00Z";

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "\t": "&#9;",
  "\n": "&#10;",
  "\r": "&#13;",
};

/** 元素文字和双引号属性共用编码，数字引用防止 XML 解析时改写空白。 */
function escapeXml(value: string): string {
  return cleanXmlText(value).replace(/[&<>"'\t\n\r]/gu, (char) => XML_ENTITIES[char]!);
}

function element(name: string, text: string, attributes: Record<string, string> = {}): string {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
  return `<${name}${attrs}>${escapeXml(text)}</${name}>`;
}

/** RSS 阅读器可以把 XML 解码后的描述当 HTML，所以先编码 HTML 文本。 */
function rssDescription(text: string): string {
  return element("description", escapeXml(text));
}

function atomLink(rel: string, href: string, type: string, prefix = ""): string {
  return `<${prefix}link rel="${escapeXml(rel)}" href="${escapeXml(href)}" type="${escapeXml(type)}"/>`;
}

function atomAuthor(name: string): string {
  return `<author>${element("name", name)}</author>`;
}

function feedDate(value: string): Date {
  const date = parseDbDateTime(value);
  if (!Number.isFinite(date.getTime())) throw new Error("无效的订阅条目时间");
  return date;
}

/** 以已经按发布时间排序的游客数据生成确定性的 RSS 2.0 或 Atom 1.0。 */
export function renderFeed(
  format: FeedFormat,
  site: { url: URL; name: string },
  scope: FeedScope,
  data: FeedData,
): string {
  const urls = getFeedUrls(site.url, scope);
  const siteName = cleanXmlText(site.name).trim() || "论坛";
  const forumName = data.forumName === null ? "" : cleanXmlText(data.forumName).trim();
  const title = `${forumName || siteName} · 最新主题`;
  const description = `来自${forumName || siteName}的公开新主题`;
  let latestUpdate: Date | undefined;
  const items = data.entries.map((entry) => {
    const url = getFeedThreadUrl(site.url, entry.id);
    const published = feedDate(entry.createdAt);
    const edited = entry.editedAt === null ? published : feedDate(entry.editedAt);
    const updated = edited > published ? edited : published;
    if (!latestUpdate || updated > latestUpdate) latestUpdate = updated;
    const author = cleanXmlText(entry.author).trim() || "未知用户";
    const summary = summarizeFeedBody(entry.bodyMd);
    if (format === "rss") {
      return [
        "<item>",
        element("title", entry.title),
        element("link", url),
        element("guid", url, { isPermaLink: "true" }),
        element("pubDate", published.toUTCString()),
        element("dc:creator", author),
        rssDescription(summary),
        "</item>",
      ].join("\n");
    }
    return [
      "<entry>",
      element("id", url),
      element("title", entry.title, { type: "text" }),
      atomLink("alternate", url, "text/html"),
      element("published", published.toISOString()),
      element("updated", updated.toISOString()),
      atomAuthor(author),
      element("summary", summary, { type: "text" }),
      "</entry>",
    ].join("\n");
  });

  if (format === "rss") {
    return [
      XML_DECLARATION,
      `<rss version="2.0" xmlns:atom="${ATOM_NS}" xmlns:dc="${DC_NS}">`,
      "<channel>",
      element("title", title),
      element("link", urls.page),
      rssDescription(description),
      atomLink("self", urls.rss, "application/rss+xml", "atom:"),
      ...(latestUpdate ? [element("lastBuildDate", latestUpdate.toUTCString())] : []),
      ...items,
      "</channel>",
      "</rss>",
    ].join("\n");
  }
  return [
    XML_DECLARATION,
    `<feed xmlns="${ATOM_NS}">`,
    element("id", urls.atom),
    element("title", title, { type: "text" }),
    element("subtitle", description, { type: "text" }),
    // 空源同样需要更新时间，使用固定值保持重复拉取的表示一致。
    element("updated", latestUpdate?.toISOString() ?? EMPTY_ATOM_UPDATED),
    atomAuthor(siteName),
    atomLink("self", urls.atom, "application/atom+xml"),
    atomLink("alternate", urls.page, "text/html"),
    ...items,
    "</feed>",
  ].join("\n");
}
