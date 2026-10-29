// @vitest-environment jsdom
/**
 * 最近使用的存储格式（M10.9）：条目带类型（c=Unicode / i=图片 URL）；
 * M10.8 的旧格式是纯字符串数组——读取按 Unicode 解释，写回自然迁移。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { pushRecent, readRecent, RECENT_MAX, type RecentEntry } from "./recent";

beforeEach(() => localStorage.clear());

describe("readRecent / pushRecent", () => {
  it("新格式：类型条目原样读回；同类型同值去重、置顶、截断", () => {
    localStorage.setItem(
      "funwind:emoji:recent",
      JSON.stringify([
        { t: "i", v: "/emoji/171.png" },
        { t: "c", v: "😀" },
      ] satisfies RecentEntry[]),
    );
    expect(readRecent()).toEqual([
      { t: "i", v: "/emoji/171.png" },
      { t: "c", v: "😀" },
    ]);
    pushRecent({ t: "c", v: "😀" }); // 已存在 → 置顶（不重复）
    expect(readRecent()).toEqual([
      { t: "c", v: "😀" },
      { t: "i", v: "/emoji/171.png" },
    ]);
    pushRecent({ t: "i", v: "/emoji/999.png" }); // 同 URL 不同类型视为不同条目
    expect(readRecent()[0]).toEqual({ t: "i", v: "/emoji/999.png" });
    expect(readRecent()).toHaveLength(3);
  });

  it("旧格式兼容：纯字符串读成 Unicode 条目；pushRecent 写回新格式（一次性迁移）", () => {
    localStorage.setItem("funwind:emoji:recent", JSON.stringify(["😀", "👍"]));
    expect(readRecent()).toEqual([
      { t: "c", v: "😀" },
      { t: "c", v: "👍" },
    ]);
    pushRecent({ t: "i", v: "/emoji/120.gif" });
    const stored = JSON.parse(localStorage.getItem("funwind:emoji:recent")!) as RecentEntry[];
    expect(stored[0]).toEqual({ t: "i", v: "/emoji/120.gif" });
    expect(stored.slice(1)).toEqual([
      { t: "c", v: "😀" },
      { t: "c", v: "👍" },
    ]);
  });

  it("垃圾数据（非数组 / 未知类型 / 非字符串值）过滤掉；损坏 JSON 返回空", () => {
    localStorage.setItem("funwind:emoji:recent", "不是 JSON");
    expect(readRecent()).toEqual([]);
    localStorage.setItem(
      "funwind:emoji:recent",
      JSON.stringify([42, { t: "x", v: "?" }, { t: "i" }, null, { t: "c", v: "😀" }]),
    );
    expect(readRecent()).toEqual([{ t: "c", v: "😀" }]);
  });

  it("超过上限从尾部截断", () => {
    for (let i = 0; i < RECENT_MAX + 3; i++) pushRecent({ t: "c", v: `字符${i}` });
    expect(readRecent()).toHaveLength(RECENT_MAX);
    expect(readRecent()[0]!.v).toBe(`字符${RECENT_MAX + 2}`);
  });
});
