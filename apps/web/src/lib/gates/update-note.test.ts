import { describe, expect, it } from "vitest";
import { contentUpdateNote } from "./update-note";

const T1 = "2026-10-20 10:00:00";
const T2 = "2026-10-25 09:30:00";

describe("contentUpdateNote", () => {
  it("从未更新：不显示", () => {
    expect(contentUpdateNote({ contentUpdatedAt: null, seeLatest: false })).toBeNull();
  });

  it("作者与版主：不显示", () => {
    expect(contentUpdateNote({ contentUpdatedAt: T2, seeLatest: true })).toBeNull();
  });

  it("已解锁且解锁不早于更新：不显示（读者已看到最新版本）", () => {
    expect(
      contentUpdateNote({ contentUpdatedAt: T1, unlockedAt: T2, seeLatest: false }),
    ).toBeNull();
    expect(
      contentUpdateNote({ contentUpdatedAt: T2, unlockedAt: T2, seeLatest: false }),
    ).toBeNull();
  });

  it("已解锁但解锁早于更新：显示更新时间（精确到分钟）", () => {
    expect(contentUpdateNote({ contentUpdatedAt: T2, unlockedAt: T1, seeLatest: false })).toBe(
      "内容更新于 2026-10-25 09:30",
    );
  });

  it("未解锁（锁卡片）：有更新就显示", () => {
    expect(contentUpdateNote({ contentUpdatedAt: T2, seeLatest: false })).toBe(
      "内容更新于 2026-10-25 09:30",
    );
    expect(contentUpdateNote({ contentUpdatedAt: T2, unlockedAt: null, seeLatest: false })).toBe(
      "内容更新于 2026-10-25 09:30",
    );
  });
});
