// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { pageForReplyIndex, postPath } from "./locate-post";
import { REPLIES_PER_PAGE } from "./posts";

describe("pageForReplyIndex（可见回帖序号 → 页码）", () => {
  it("每页 20 条：第 1–20 条在第 1 页，第 21 条起第 2 页", () => {
    expect(REPLIES_PER_PAGE).toBe(20);
    expect(pageForReplyIndex(1)).toBe(1);
    expect(pageForReplyIndex(20)).toBe(1);
    expect(pageForReplyIndex(21)).toBe(2);
    expect(pageForReplyIndex(40)).toBe(2);
    expect(pageForReplyIndex(41)).toBe(3);
  });

  it("防御：0 或负数序号仍是第 1 页", () => {
    expect(pageForReplyIndex(0)).toBe(1);
    expect(pageForReplyIndex(-3)).toBe(1);
  });

  it("对照：楼层连续、无隐藏时，与旧的楼层公式结果一致（楼层 f 的序号是 f-1）", () => {
    for (let floor = 2; floor <= 200; floor++) {
      expect(pageForReplyIndex(floor - 1), `楼层 ${floor}`).toBe(
        Math.max(1, Math.ceil((floor - 1) / 20)),
      );
    }
  });

  it("对照：有隐藏楼层时，旧公式会错（楼层 22 的序号只有 17，应在第 1 页，旧公式给第 2 页）", () => {
    const visibleIndex = 22 - 1 - 4; // 楼层 2–5 被隐藏，楼层 22 的序号 = 21 - 4 = 17
    expect(pageForReplyIndex(visibleIndex)).toBe(1);
    expect(Math.ceil((22 - 1) / 20)).toBe(2);
  });
});

describe("postPath（帖子在主题页里的地址）", () => {
  it("第一页不写 page 参数；其他页写 ?page=；锚点始终是 #p{pid}", () => {
    expect(postPath({ threadId: 7, postId: 99, page: 1 })).toBe("/t/7#p99");
    expect(postPath({ threadId: 7, postId: 99, page: 3 })).toBe("/t/7?page=3#p99");
  });
});

describe("守卫：pageOfFloor / getParentFloors 已删除，不得被重新引入", () => {
  const SRC = join(__dirname, "../..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  it("运行时代码里不再出现旧的楼层分页与父帖查询（它们假定楼层连续，且不做可见性过滤）", () => {
    const offenders = walk(SRC)
      .map((p) => relative(SRC, p).split(sep).join("/"))
      .filter((rel) => !/\.test\.tsx?$/.test(rel))
      .filter((rel) => /pageOfFloor|getParentFloors/.test(readFileSync(join(SRC, rel), "utf8")));
    expect(offenders).toEqual([]);
  });
});
