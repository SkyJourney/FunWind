import { describe, expect, it } from "vitest";
import {
  joinChoice,
  splitChoice,
  toWallTime,
  validateCampaignFields,
  type CampaignFields,
} from "./input";

const OK: CampaignFields = {
  name: "圣诞装扮",
  effect: "theme.pack",
  target: "xmas-2026",
  startsAt: "2026-12-24 00:00:00",
  endsAt: "2026-12-27 00:00:00",
  priority: 0,
};

const code = (over: Partial<CampaignFields>) => {
  const result = validateCampaignFields({ ...OK, ...over });
  return result.ok ? "ok" : result.code;
};

describe("效果与目标的合并选项", () => {
  it("拼接与拆分可逆", () => {
    expect(splitChoice(joinChoice("theme.pack", "xmas-2026"))).toEqual({
      effect: "theme.pack",
      target: "xmas-2026",
    });
  });

  it("缺少分隔符、缺效果或缺目标一律拒绝", () => {
    for (const bad of ["", "theme.pack", "::x", "theme.pack::"]) {
      expect(splitChoice(bad)).toBeNull();
    }
  });
});

describe("datetime-local 转换", () => {
  it("补秒；空串原样；带秒或非法格式原样透出交给校验", () => {
    expect(toWallTime("2026-12-24T08:30")).toBe("2026-12-24 08:30:00");
    expect(toWallTime("")).toBe("");
    expect(toWallTime("2026-12-24T08:30:15")).toBe("2026-12-24 08:30:15");
    expect(toWallTime("明天")).toBe("明天");
  });
});

describe("方案字段校验", () => {
  it("合法输入通过，并组装出配置", () => {
    const result = validateCampaignFields(OK);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.config).toEqual({ pack: "xmas-2026" });
  });

  it("名称：去空白后为空 / 超过 60 个字符 → bad-name；emoji 按一个字符计", () => {
    expect(code({ name: "   " })).toBe("bad-name");
    expect(code({ name: "名".repeat(61) })).toBe("bad-name");
    expect(code({ name: "名".repeat(60) })).toBe("ok");
    expect(code({ name: "🎄".repeat(60) })).toBe("ok");
  });

  it("未注册的效果 → bad-effect；非法目标 → bad-target", () => {
    expect(code({ effect: "site.decor" })).toBe("bad-effect");
    expect(code({ target: "BAD ID" })).toBe("bad-target");
    expect(code({ effect: "site.logo", target: "hero-aaaa.png" })).toBe("bad-target");
  });

  it("起止时间：格式或日历非法分别报 bad-start / bad-end", () => {
    expect(code({ startsAt: "" })).toBe("bad-start");
    expect(code({ startsAt: "2026-02-30 00:00:00" })).toBe("bad-start");
    expect(code({ endsAt: "2026-13-01 00:00:00" })).toBe("bad-end");
  });

  it("结束不晚于开始 → bad-window；结束留空 = 长期", () => {
    expect(code({ endsAt: OK.startsAt })).toBe("bad-window");
    expect(code({ endsAt: "2026-12-01 00:00:00" })).toBe("bad-window");
    const open = validateCampaignFields({ ...OK, endsAt: null });
    expect(open.ok && open.value.endsAt).toBeNull();
    expect(code({ endsAt: "" })).toBe("ok");
  });

  it("优先级：负数 / 小数 / 超过 smallint 上限 → bad-priority", () => {
    expect(code({ priority: -1 })).toBe("bad-priority");
    expect(code({ priority: 1.5 })).toBe("bad-priority");
    expect(code({ priority: 65536 })).toBe("bad-priority");
    expect(code({ priority: 65535 })).toBe("ok");
  });
});

describe("行为类必须有结束时间（M11.4 D6）", () => {
  const WINDOW: CampaignFields = {
    name: "开放注册窗口",
    effect: "register.open",
    target: "on",
    startsAt: "2026-11-08 00:00:00",
    endsAt: "2026-11-09 00:00:00",
    priority: 0,
  };

  it("结束时间留空（null / 空串）→ behavior-needs-end", () => {
    expect(code({ effect: "register.open", target: "on", endsAt: null })).toBe(
      "behavior-needs-end",
    );
    expect(code({ effect: "register.open", target: "on", endsAt: "" })).toBe("behavior-needs-end");
  });

  it("填写了结束时间 → 通过", () => {
    const result = validateCampaignFields({ ...WINDOW });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.config).toEqual({});
  });

  it("视觉类不受此限：结束留空仍是长期（M11.2 语义不变）", () => {
    expect(code({ effect: "theme.pack", target: "default", endsAt: null })).toBe("ok");
    expect(code({ effect: "theme.pack", target: "default", endsAt: "" })).toBe("ok");
  });

  it("bad-window 优先于 D6：结束早于开始先报窗口错", () => {
    expect(code({ effect: "register.open", target: "on", endsAt: "2026-11-07 00:00:00" })).toBe(
      "bad-window",
    );
  });
});
