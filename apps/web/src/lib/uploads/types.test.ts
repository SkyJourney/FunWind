import { describe, expect, it } from "vitest";
import {
  AVATAR_SIZE,
  EXTENSION_TYPES,
  IMAGE_TYPES,
  MAX_ATTACHMENTS_PER_POST,
  MAX_BYTES,
  MAX_INLINE_REFS_PER_POST,
  MAX_PIXELS,
  MIME_OF,
  MIN_CROP,
  PURPOSE_TYPES,
  STORED_EXT,
  THUMB_WIDTHS,
} from "./types";

/**
 * 上传类型与限制常量（M6.4a；M9.5 补覆盖）：这些常量被嗅探/校验/处理/路由四处共用，
 * 用不变量测试锁住跨表一致性（扩展名 ↔ 嗅探类型 ↔ MIME ↔ 存储扩展名），防止单边修改漂移。
 */
describe("lib/uploads/types 不变量", () => {
  it("EXTENSION_TYPES 的每个值都有对应的 STORED_EXT 与 MIME_OF 条目", () => {
    for (const t of Object.values(EXTENSION_TYPES)) {
      expect(STORED_EXT[t]).toBeTruthy();
      expect(MIME_OF[t]).toMatch(/^\w+\/[\w.+-]+$/);
    }
  });

  it("IMAGE_TYPES 的存储扩展名都不是可脚本化类型", () => {
    for (const t of IMAGE_TYPES) {
      expect(["svg", "html", "js"]).not.toContain(STORED_EXT[t]);
    }
  });

  it("PURPOSE_TYPES：inline/avatar 只接受图片；attachment 是扩展名全集", () => {
    for (const t of PURPOSE_TYPES.inline) expect(IMAGE_TYPES.has(t)).toBe(true);
    for (const t of PURPOSE_TYPES.avatar) expect(IMAGE_TYPES.has(t)).toBe(true);
    // jpg/jpeg 同映射 jpeg：唯一类型数 = 键数 − 1
    expect(PURPOSE_TYPES.attachment.size).toBe(new Set(Object.values(EXTENSION_TYPES)).size);
  });

  it("字节上限有序：avatar < inline < attachment", () => {
    expect(MAX_BYTES.avatar).toBeLessThan(MAX_BYTES.inline);
    expect(MAX_BYTES.inline).toBeLessThan(MAX_BYTES.attachment);
  });

  it("数值型限制在合理区间", () => {
    expect(MAX_PIXELS).toBeGreaterThan(1_000_000);
    expect(MIN_CROP).toBeGreaterThanOrEqual(1);
    expect(AVATAR_SIZE).toBeGreaterThanOrEqual(MIN_CROP);
    expect(THUMB_WIDTHS).toEqual([...THUMB_WIDTHS].sort((a, b) => a - b));
    expect(MAX_ATTACHMENTS_PER_POST).toBeGreaterThan(0);
    expect(MAX_INLINE_REFS_PER_POST).toBeGreaterThanOrEqual(MAX_ATTACHMENTS_PER_POST);
  });
});
