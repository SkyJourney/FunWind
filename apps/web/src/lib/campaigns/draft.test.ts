import { describe, expect, it } from "vitest";
import { decodeCampaignDraft, encodeCampaignDraft, type CampaignDraft } from "./draft";

const DRAFT: CampaignDraft = {
  id: 7,
  revision: 3,
  name: "圣诞装扮 & 新年",
  choice: "theme.pack::xmas-2026",
  startsAt: "2026-12-24T00:00",
  endsAt: "",
  priority: "5",
};

/** 模拟框架：查询参数已被解码一次 */
const roundTrip = (draft: CampaignDraft) =>
  decodeCampaignDraft(decodeURIComponent(encodeCampaignDraft(draft)));

describe("排期表单草稿", () => {
  it("中文、符号与旧 revision 原样往返", () => {
    expect(roundTrip(DRAFT)).toEqual(DRAFT);
  });

  it("新建场景没有 id 与 revision", () => {
    const { id: _id, revision: _revision, ...fresh } = DRAFT;
    expect(roundTrip(fresh)).toEqual(fresh);
  });

  it("空值、乱码、非对象一律忽略", () => {
    for (const raw of [undefined, "", "{bad", "[]", "null", '"x"']) {
      expect(decodeCampaignDraft(raw)).toBeNull();
    }
  });

  it("字段缺失或类型不符被拒绝（草稿不可信）", () => {
    expect(decodeCampaignDraft(JSON.stringify({ ...DRAFT, name: 1 }))).toBeNull();
    expect(decodeCampaignDraft(JSON.stringify({ ...DRAFT, priority: undefined }))).toBeNull();
    expect(decodeCampaignDraft(JSON.stringify({ ...DRAFT, id: "7" }))).toBeNull();
    expect(decodeCampaignDraft(JSON.stringify({ ...DRAFT, revision: 0 }))).toBeNull();
  });

  it("超长字段被拒绝，避免超大查询参数回灌表单", () => {
    expect(decodeCampaignDraft(JSON.stringify({ ...DRAFT, name: "x".repeat(201) }))).toBeNull();
    expect(decodeCampaignDraft(JSON.stringify({ ...DRAFT, choice: "x".repeat(121) }))).toBeNull();
  });
});
