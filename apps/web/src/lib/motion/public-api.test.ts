// @vitest-environment node
import { expect, expectTypeOf, it } from "vitest";
import * as motion from ".";
import type {
  MotionEngine,
  MotionLifecycle,
  MotionListProps,
  MotionPageProps,
  MotionPlayResult,
} from ".";

it("唯一公开入口只暴露配置、预设、纯解析与实例工厂，不泄露旧兼容链或内部调度器", () => {
  expect(Object.keys(motion).sort()).toEqual(
    [
      "MOTION_DEFAULTS",
      "MOTION_DIRECTIONS",
      "MOTION_ELEMENT_PRESETS",
      "MOTION_PAGE_PRESETS",
      "MOTION_TOKENS",
      "createMotionConfig",
      "createMotionEngine",
      "createMotionRegistry",
      "directionBetween",
      "resolveMotionPlan",
    ].sort(),
  );
  expect(typeof document).toBe("undefined");
  const engine = motion.createMotionEngine();
  expect(engine.current).toBeUndefined();
  engine.dispose();
});
it("接入 API 类型骨架不包含假组件；取消表示跳过动效而非取消业务更新", () => {
  expectTypeOf<MotionPageProps["motionKey"]>().toEqualTypeOf<string | number>();
  expectTypeOf<MotionPageProps["preset"]>().toEqualTypeOf<motion.MotionPagePreset | undefined>();
  expectTypeOf<MotionListProps["preset"]>().toEqualTypeOf<
    "list.enter" | "list.append" | undefined
  >();
  expectTypeOf<ReturnType<MotionEngine["play"]>>().toEqualTypeOf<Promise<MotionPlayResult>>();
  expectTypeOf<ReturnType<NonNullable<MotionLifecycle["onIntent"]>>>().toEqualTypeOf<
    | { readonly direction?: motion.MotionDirection; readonly preset?: motion.MotionPagePreset }
    | false
    | void
  >();
});
