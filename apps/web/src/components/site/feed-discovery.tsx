import { isPublicFeedForum } from "@/lib/feeds/query";
import { getFeedSiteUrl, getFeedUrls } from "@/lib/feeds/urls";

type FeedScope = Parameters<typeof getFeedUrls>[1];

/** 由 React 将原生 alternate link 提升至首份 HTML 的 head，不依赖 Next 的流式元数据。 */
export async function FeedDiscovery({ scope }: { scope: FeedScope }) {
  let urls: ReturnType<typeof getFeedUrls>;
  try {
    if (scope.kind === "forum" && !(await isPublicFeedForum(scope.fid))) return null;
    urls = getFeedUrls(await getFeedSiteUrl(), scope);
  } catch {
    // 无法确认游客资格或构造可信地址时，只省略发现链接。
    return null;
  }
  return (
    <>
      <link rel="alternate" type="application/rss+xml" title="RSS 订阅" href={urls.rss} />
      <link rel="alternate" type="application/atom+xml" title="Atom 订阅" href={urls.atom} />
    </>
  );
}
