import { describe, expect, it } from "vitest";
import { RUM_MAX_SAMPLES, RUM_VALUE_MAX, rumPayloadSchema } from "./schema";

const vital = (over: Record<string, unknown> = {}) => ({
  kind: "vital",
  name: "LCP",
  value: 1234,
  route: "/t/6621",
  ...over,
});
const payload = (samples: unknown[]) => ({ v: 1, samples });

describe("RUM 载荷契约", () => {
  it("三个 vital 指标都合法", () => {
    for (const name of ["LCP", "CLS", "INP"]) {
      expect(rumPayloadSchema.safeParse(payload([vital({ name })])).success).toBe(true);
    }
  });

  it("两类 error 都合法，且 value 必须是 0", () => {
    for (const name of ["js-error", "unhandled-rejection"]) {
      const ok = rumPayloadSchema.safeParse(
        payload([{ kind: "error", name, value: 0, route: "/x", detail: "boom" }]),
      );
      expect(ok.success).toBe(true);
    }
    expect(
      rumPayloadSchema.safeParse(
        payload([{ kind: "error", name: "js-error", value: 1, route: "/x" }]),
      ).success,
    ).toBe(false);
  });

  it("kind 与 name 必须匹配（vital 不能叫 js-error，error 不能叫 LCP）", () => {
    expect(rumPayloadSchema.safeParse(payload([vital({ name: "js-error" })])).success).toBe(false);
    expect(
      rumPayloadSchema.safeParse(payload([{ kind: "error", name: "LCP", value: 0, route: "/x" }]))
        .success,
    ).toBe(false);
  });

  it("样本数 1..20；空数组与超限都拒", () => {
    expect(rumPayloadSchema.safeParse(payload([])).success).toBe(false);
    const many = Array.from({ length: RUM_MAX_SAMPLES }, () => vital());
    expect(rumPayloadSchema.safeParse(payload(many)).success).toBe(true);
    expect(rumPayloadSchema.safeParse(payload([...many, vital()])).success).toBe(false);
  });

  it("value 边界：0 与上限合法，负数/超上限/非整数拒", () => {
    expect(rumPayloadSchema.safeParse(payload([vital({ value: 0 })])).success).toBe(true);
    expect(rumPayloadSchema.safeParse(payload([vital({ value: RUM_VALUE_MAX })])).success).toBe(
      true,
    );
    for (const value of [-1, RUM_VALUE_MAX + 1, 1.5]) {
      expect(rumPayloadSchema.safeParse(payload([vital({ value })])).success).toBe(false);
    }
  });

  it("版本号必须是 1（将来改形状时老客户端不被误读）", () => {
    expect(rumPayloadSchema.safeParse({ v: 2, samples: [vital()] }).success).toBe(false);
    expect(rumPayloadSchema.safeParse({ samples: [vital()] }).success).toBe(false);
  });

  it("route 必填且有长度上限；detail 可省略但有上限", () => {
    expect(rumPayloadSchema.safeParse(payload([vital({ route: "" })])).success).toBe(false);
    expect(rumPayloadSchema.safeParse(payload([vital({ route: "a".repeat(501) })])).success).toBe(
      false,
    );
    expect(
      rumPayloadSchema.safeParse(
        payload([
          { kind: "error", name: "js-error", value: 0, route: "/x", detail: "a".repeat(501) },
        ]),
      ).success,
    ).toBe(false);
  });

  it("vital 不接受 detail（指标没有消息语义，避免夹带任意文本）", () => {
    const parsed = rumPayloadSchema.safeParse(payload([vital({ detail: "夹带" })]));
    expect(parsed.success).toBe(true); // 多余键被 zod 剥掉，不报错
    if (parsed.success) {
      expect("detail" in parsed.data.samples[0]!).toBe(false);
    }
  });
});
