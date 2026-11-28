import { isPublicFeedForum } from "@/lib/feeds/query";
import { getFeedSiteUrl, getFeedUrls } from "@/lib/feeds/urls";

type FeedScope = Parameters<typeof getFeedUrls>[1];

const linkClassName =
  "inline-flex min-h-10 items-center rounded-md px-2 text-sm text-foreground underline-offset-4 hover:bg-accent hover:underline focus-visible:outline-2 focus-visible:outline-ring";

/** 阅读器发现与页内订阅链接共用同一公开资格和规范地址。 */
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
      <span
        role="group"
        aria-label={scope.kind === "latest" ? "全站订阅" : "版块订阅"}
        className="inline-flex shrink-0 items-center gap-1"
      >
        <a href={urls.rss} className={linkClassName}>
          RSS 订阅
        </a>
        <a href={urls.atom} className={linkClassName} aria-label="Atom 订阅">
          Atom
        </a>
      </span>
    </>
  );
}
