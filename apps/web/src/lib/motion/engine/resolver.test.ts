// @vitest-environment node
import { expect, it } from "vitest";
import {
  createMotionConfig,
  createMotionRegistry,
  directionBetween,
  MOTION_DEFAULTS,
  MOTION_DIRECTIONS,
  MOTION_ELEMENT_PRESETS,
  MOTION_TOKENS,
  resolveMotionPlan,
  type MotionIntent,
  type MotionPageDeclaration,
} from "..";

const registry = createMotionRegistry([
  { pattern: /^\/$/, page: { preset: "list", level: 0, tabOrder: 0 } },
  { pattern: /^\/boards$/, page: { preset: "list", level: 1, tabOrder: 1 } },
  { pattern: /^\/f\/[^/]+$/, page: { preset: "list", level: 2 } },
  { pattern: /^\/t\/[^/]+$/, page: { preset: "detail", level: 3 } },
  { pattern: /^\/a$/, page: { preset: "list", level: 1 } },
  { pattern: /^\/a\/[^/]+$/, page: { preset: "detail", level: 2 } },
  { pattern: /^\/admin(?:\/|$)/, page: { preset: "admin", level: 2 } },
]);
const config = createMotionConfig();
const intent = (from: string, to: string): MotionIntent => ({ from, to, source: "link" });

it("配置为只读实例快照，不会修改全局默认", () => {
  const custom = createMotionConfig({ enabled: false, safetyTimeoutMs: 300, maxStaggerItems: 0 });
  expect(custom).toMatchObject({ enabled: false, safetyTimeoutMs: 300, maxStaggerItems: 0 });
  expect(MOTION_DEFAULTS).toMatchObject({ enabled: true, maxStaggerItems: 10 });
  expect(Object.isFrozen(custom)).toBe(true);
});
it.each([0, -1, NaN, Infinity])("安全超时 %s 拒绝", (safetyTimeoutMs) => {
  expect(() => createMotionConfig({ safetyTimeoutMs })).toThrow(RangeError);
});
it.each([-1, 1.5, NaN])("进场上限 %s 拒绝", (maxStaggerItems) => {
  expect(() => createMotionConfig({ maxStaggerItems })).toThrow(RangeError);
});
it("预设保留现行七方向与收起层叠语义，元素动画只引用令牌", () => {
  expect(Object.keys(MOTION_DIRECTIONS).sort()).toEqual([
    "collapse",
    "expand",
    "fade",
    "pop",
    "push",
    "tab-next",
    "tab-prev",
  ]);
  expect(MOTION_DIRECTIONS.expand.exit).toBeNull();
  expect(MOTION_DIRECTIONS.expand.enter?.duration).toBe(MOTION_TOKENS.spring);
  expect(MOTION_DIRECTIONS.collapse).toMatchObject({ enter: null, oldOnTop: true });
  expect(MOTION_DIRECTIONS.collapse.exit?.duration).toBe(MOTION_TOKENS.slow);
  expect(MOTION_DIRECTIONS["tab-next"].enter?.delay).toBe("calc(var(--fw-dur-fast) / 2)");
  expect(MOTION_DIRECTIONS["tab-prev"].enter?.name).toBe("vt-tab-in-left");
  expect(MOTION_ELEMENT_PRESETS["list.append"].className).toBe("fw-fade-in");
  for (const preset of Object.values(MOTION_ELEMENT_PRESETS)) {
    expect(preset.duration).toMatch(/^var\(--fw-/);
    expect(preset.easing).toMatch(/^var\(--fw-/);
    expect(Object.isFrozen(preset)).toBe(true);
  }
});

it("注册表按顺序匹配、忽略 query/hash，并复制规则与声明", () => {
  const page: { preset: "detail"; level: number } = { preset: "detail", level: 3 };
  const pattern = /^\/item/;
  const rules = [{ pattern, page }];
  const registered = createMotionRegistry(rules);
  page.level = 9;
  rules.length = 0;
  pattern.compile("^/different");
  expect(registered.resolve("/item/1?page=2#p3")).toEqual({ preset: "detail", level: 3 });
  expect(registered.resolve("/missing")).toBeUndefined();
  expect(Object.isFrozen(registered.resolve("/item/2"))).toBe(true);
});
it.each([/x/g, /x/y])("拒绝有状态正则 %s", (pattern) => {
  expect(() => createMotionRegistry([{ pattern, page: { preset: "list" } }])).toThrow(TypeError);
});
it("重叠规则先具体后分组；声明无匹配时回全局默认", () => {
  const custom = createMotionRegistry([
    { pattern: /^\/admin\/edit$/, page: { preset: "form" } },
    { pattern: /^\/admin/, page: { preset: "admin" } },
  ]);
  expect(custom.resolve("/admin/edit")?.preset).toBe("form");
  expect(resolveMotionPlan(intent("", "?q=1"), custom, config)).toMatchObject({
    preset: "list",
    direction: "fade",
  });
  expect(
    resolveMotionPlan(intent("/", "/unknown"), custom, createMotionConfig({ pagePreset: "form" }))
      .preset,
  ).toBe("form");
});

it.each([
  [undefined, undefined, "fade"],
  [{ preset: "list" }, { preset: "detail", level: 3 }, "fade"],
  [{ preset: "detail", level: 3 }, { preset: "list" }, "fade"],
  [{ preset: "list", tabOrder: 2 }, { preset: "list", tabOrder: 1 }, "tab-prev"],
] as const)("缺失层级时保持 fade，Tab 比较优先于层级", (from, to, expected) => {
  expect(directionBetween(from as MotionPageDeclaration, to as MotionPageDeclaration)).toBe(
    expected,
  );
});
it("目标页声明覆盖注册表、近层 hook 覆写胜过意图，admin 默认克制", () => {
  const input = { ...intent("/", "/t/1"), preset: "detail", direction: "pop" } as const;
  expect(resolveMotionPlan(input, registry, config).direction).toBe("pop");
  expect(
    resolveMotionPlan(input, registry, config, undefined, { direction: "expand", preset: "form" }),
  ).toMatchObject({ direction: "expand", preset: "form" });
  expect(resolveMotionPlan(intent("/", "/admin/ops"), registry, config).direction).toBe("fade");
  expect(
    resolveMotionPlan(intent("/", "/t/1"), registry, config, { preset: "list", level: 1 }),
  ).toMatchObject({ direction: "push", preset: "list" });
});
it("圆心复制不可变，供后续宿主绑定而非内核读 DOM", () => {
  const origin = { x: 100, y: 200, r: 500 };
  const plan = resolveMotionPlan(
    { ...intent("/", "/t/1"), direction: "expand", origin },
    registry,
    config,
  );
  origin.x = 999;
  expect(plan.origin?.x).toBe(100);
  expect(Object.isFrozen(plan.origin)).toBe(true);
  expect(Object.isFrozen(plan)).toBe(true);
});
