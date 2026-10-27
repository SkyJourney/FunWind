// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/actions/define-action", () => ({
  defineAction:
    (def: { run: (ctx: unknown, input: unknown) => Promise<void> }) => (input: unknown) =>
      def.run({ subject: { userId: 1 } }, input),
}));
vi.mock("@/lib/pm/service", () => ({
  sendMessage: vi.fn(async () => ({ ok: false, code: "forbidden" })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { sendMessageAction } from "./pm";

describe("私信发送失败回跳", () => {
  it.each([
    ["/messages?to=42", "/messages?to=42&pm=forbidden"],
    ["/messages/3?pm=old#reply", "/messages/3?pm=forbidden#reply"],
    ["//example.com/path", "/messages?to=42&pm=forbidden"],
  ])("保留回跳参数 %s", async (back, expected) => {
    await expect(
      sendMessageAction({ recipientId: 42, body: "x", back } as unknown as FormData),
    ).rejects.toThrow(expected);
  });
});
