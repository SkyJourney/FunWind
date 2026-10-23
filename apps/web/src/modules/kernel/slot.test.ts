import { beforeEach, describe, expect, it } from "vitest";
import { registerModule, resetRegistryForTests } from "./registry";
import { selectSlotRenderers } from "./slot";
import { defineModule } from "./types";

beforeEach(() => resetRegistryForTests());

describe("selectSlotRenderers", () => {
  const renderA = () => "A";
  const renderB = () => "B";

  it("按注册序合并同槽位渲染器", () => {
    registerModule(
      defineModule({ id: "a", description: "", slots: { "home.footer-notice": renderA } }),
    );
    registerModule(
      defineModule({ id: "b", description: "", slots: { "home.footer-notice": renderB } }),
    );
    const out = selectSlotRenderers("home.footer-notice", new Set(["a", "b"]));
    expect(out.map((o) => o.moduleId)).toEqual(["a", "b"]);
  });

  it("禁用模块被过滤", () => {
    registerModule(
      defineModule({ id: "a", description: "", slots: { "home.footer-notice": renderA } }),
    );
    registerModule(
      defineModule({ id: "b", description: "", slots: { "home.footer-notice": renderB } }),
    );
    const out = selectSlotRenderers("home.footer-notice", new Set(["b"]));
    expect(out.map((o) => o.moduleId)).toEqual(["b"]);
  });

  it("其他槽位不串扰", () => {
    registerModule(
      defineModule({ id: "a", description: "", slots: { "home.footer-notice": renderA } }),
    );
    expect(selectSlotRenderers("home.after-header", new Set(["a"]))).toEqual([]);
  });
});
