import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getForum, HEAD as headForum } from "@/app/feeds/forum/[fid]/route";
import { GET as getLatest, HEAD as headLatest } from "@/app/feeds/latest/route";
import { loadFeed, type FeedData } from "./query";
import { renderFeed } from "./render";
import { getFeedSiteIdentity } from "./urls";

vi.mock("./query", () => ({ loadFeed: vi.fn() }));
vi.mock("./render", { spy: true });
vi.mock("./urls", { spy: true });

const site = { url: new URL("https://public.example.test"), name: "公开站点" };
const entry = {
  id: 7,
  title: "当前可见主题",
  author: "公开作者",
  createdAt: "2026-11-28 16:00:00",
  editedAt: null,
  bodyMd: "公开内容",
};
const data: FeedData = { forumName: null, entries: [entry] };
const query = vi.mocked(loadFeed);
const renderer = vi.mocked(renderFeed);
const identity = vi.mocked(getFeedSiteIdentity);

function request(path = "/feeds/latest", method = "GET", etag?: string): Request {
  return new Request(`http://request-host.example.test${path}`, {
    method,
    headers: etag === undefined ? undefined : { "If-None-Match": etag },
  });
}

function forumContext(fid: string) {
  return { params: Promise.resolve({ fid }) };
}

async function expectFailure(response: Response, status: number, expectedBody: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("etag")).toBeNull();
  expect(await response.text()).toBe(expectedBody);
}

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue(data);
  identity.mockResolvedValue(site);
});

describe("订阅路由", () => {
  it("GET、HEAD 共用 RSS 表示、缓存策略和 ETag，规范地址只读站点配置", async () => {
    const get = await getLatest(request());
    const head = await headLatest(request("/feeds/latest", "HEAD"));
    const explicit = await getLatest(request("/feeds/latest?format=rss"));
    expect(get.status).toBe(200);
    expect(head.status).toBe(200);
    expect(explicit.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(get.headers.get("cache-control")).toBe("public, no-cache");
    expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
    expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
    expect(get.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(explicit.headers.get("etag")).toBe(get.headers.get("etag"));
    expect(head.body).toBeNull();
    const body = await get.text();
    expect(body).toContain("https://public.example.test/t/7");
    expect(body).not.toContain("request-host.example.test");
    expect(await explicit.text()).toBe(body);
    expect(query.mock.calls).toEqual([
      [{ kind: "latest" }],
      [{ kind: "latest" }],
      [{ kind: "latest" }],
    ]);
  });

  it("Atom 有独立媒体类型和验证器，版块路径使用异步参数", async () => {
    const path = "/feeds/forum/15";
    const context = forumContext("15");
    query.mockResolvedValue({ ...data, forumName: "版块" });
    const rss = await getForum(request(path), context);
    const atom = await getForum(
      request(`${path}?format=atom`, "GET", rss.headers.get("etag")!),
      context,
    );
    expect(atom.status).toBe(200);
    expect(atom.headers.get("content-type")).toBe("application/atom+xml; charset=utf-8");
    expect(atom.headers.get("etag")).not.toBe(rss.headers.get("etag"));
    expect(await atom.text()).toContain("https://public.example.test/feeds/forum/15?format=atom");
    expect(query).toHaveBeenLastCalledWith({ kind: "forum", fid: 15 });
  });

  it.each(["", "json", "ATOM", "atom&format=atom", "rss&format=atom"])(
    "非法或重复的格式参数 %s 返回 400 且不查询",
    async (format) => {
      const path = `/feeds/latest?format=${format}`;
      await expectFailure(await getLatest(request(path)), 400, "订阅格式无效");
      await expectFailure(await headLatest(request(path, "HEAD")), 400, "");
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "-1", "1.2", "0x10", "1e2", "9007199254740993", "invalid"])(
    "非法版块 ID %s 返回通用 404 且不查询",
    async (fid) => {
      const path = `/feeds/forum/${fid}`;
      await expectFailure(await getForum(request(path), forumContext(fid)), 404, "未找到订阅源");
      await expectFailure(await headForum(request(path, "HEAD"), forumContext(fid)), 404, "");
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("支持弱标签、带逗号的标签列表和通配符，每次先查询", async () => {
    const path = "/feeds/latest";
    const etag = (await getLatest(request())).headers.get("etag")!;
    for (const value of [
      etag,
      `W/${etag}`,
      `"ÿ,tag",${etag}`,
      `,, W/"other,tag", W/${etag}, `,
      " * ",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const result = await (method === "GET" ? getLatest : headLatest)(
          request(path, method, value),
        );
        expect(result.status).toBe(304);
        expect(result.headers.get("etag")).toBe(etag);
        expect(result.headers.get("cache-control")).toBe("public, no-cache");
        expect(result.body).toBeNull();
      }
    }
    expect(query).toHaveBeenCalledTimes(11);
  });

  it("标签大小写敏感，忽略畸形条件及不匹配的列表", async () => {
    const path = "/feeds/latest";
    const etag = (await getLatest(request())).headers.get("etag")!;
    for (const value of [
      etag.toUpperCase(),
      `w/${etag}`,
      `*, ${etag}`,
      `${etag}, broken`,
      `"x,y", "z"`,
    ]) {
      expect((await getLatest(request(path, "GET", value))).status).toBe(200);
    }
  });

  it("权限撤回后旧 ETag 与通配符都得到同形的 404", async () => {
    const path = "/feeds/forum/15";
    const context = forumContext("15");
    const etag = (await getForum(request(path), context)).headers.get("etag")!;
    query.mockResolvedValue(null);
    await expectFailure(await getForum(request(path, "GET", etag), context), 404, "未找到订阅源");
    await expectFailure(await headForum(request(path, "HEAD", "*"), context), 404, "");
    expect(renderer).toHaveBeenCalledTimes(1);
  });

  it("内容撤回后旧 ETag 取得当前空源，压缩前正文变化导致验证器更新", async () => {
    const path = "/feeds/latest";
    const etag = (await getLatest(request())).headers.get("etag")!;
    query.mockResolvedValue({ forumName: null, entries: [] });
    const current = await getLatest(request(path, "GET", etag));
    expect(current.status).toBe(200);
    expect(current.headers.get("etag")).not.toBe(etag);
    expect(await current.text()).not.toContain(entry.title);
  });

  it.each(["授权查询", "内容查询", "站点配置", "序列化"])(
    "%s故障返回 503 且不泄露",
    async (stage) => {
      const path = "/feeds/latest";
      const etag = (await getLatest(request())).headers.get("etag")!;
      const failure = new Error(`${stage}秘密标记`);
      function injectFailure() {
        if (stage === "授权查询" || stage === "内容查询") query.mockRejectedValueOnce(failure);
        else if (stage === "站点配置") identity.mockRejectedValueOnce(failure);
        else
          renderer.mockImplementationOnce(() => {
            throw failure;
          });
      }
      injectFailure();
      await expectFailure(await getLatest(request(path, "GET", etag)), 503, "订阅源暂不可用");
      injectFailure();
      await expectFailure(await headLatest(request(path, "HEAD", "*")), 503, "");
    },
  );
});
