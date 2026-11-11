// @vitest-environment node
import { expect, it, vi } from "vitest";
import { createMotionUpdates } from "./updates";

it("请求任意一笔更新都会先按预约顺序启动更早的回调，重复请求复用同一 Promise", async () => {
  const reserve = createMotionUpdates();
  const order: string[] = [];
  const a = reserve(() => {
    order.push("A");
  });
  const b = reserve(() => {
    order.push("B");
  });
  const pending = b.request();
  expect(b.request()).toBe(pending);
  await pending;
  await a.request();
  expect(order).toEqual(["A", "B"]);
});
it("丢弃尚未请求的预约后，后续请求不执行它；晚到请求明确拒绝", async () => {
  const reserve = createMotionUpdates();
  const removed = vi.fn();
  const a = reserve(removed);
  a.discard();
  a.discard();
  await reserve(vi.fn()).request();
  await expect(a.request()).rejects.toThrow("预约已释放");
  expect(removed).not.toHaveBeenCalled();
});
it("已入队预约不能被 discard 撤销，仍向所属调用方传播错误", async () => {
  const reserve = createMotionUpdates();
  const error = new Error("业务异常");
  const update = vi.fn(() => {
    throw error;
  });
  const ticket = reserve(update);
  const requested = ticket.request();
  ticket.discard();
  expect(ticket.request()).toBe(requested);
  await expect(requested).rejects.toBe(error);
  expect(update).toHaveBeenCalledOnce();
});
