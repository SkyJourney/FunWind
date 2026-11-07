import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTER_POLICY,
  applyRegisterWindow,
  chooseRegisterPath,
  pathRequiresVerification,
  policyFromLegacyMode,
  registerAvailability,
  resolveRegisterPolicy,
  type RegisterPolicy,
} from "./register-policy";

const P = (open: boolean, invite: boolean, verifyEmail = false): RegisterPolicy => ({
  open,
  invite,
  verifyEmail,
});

describe("旧 register.mode 兼容映射", () => {
  it("invite / 缺失 / 未知值 → 邀请制；open → 开放且要求验证（旧开放模式本来就强制验证）", () => {
    expect(policyFromLegacyMode({ mode: "invite" })).toEqual(P(false, true, false));
    expect(policyFromLegacyMode(undefined)).toEqual(DEFAULT_REGISTER_POLICY);
    expect(policyFromLegacyMode(null)).toEqual(DEFAULT_REGISTER_POLICY);
    expect(policyFromLegacyMode({ mode: "weird" })).toEqual(DEFAULT_REGISTER_POLICY);
    expect(policyFromLegacyMode({ mode: "open" })).toEqual(P(true, false, true));
  });

  it("默认值就是现状：邀请制、不要求验证", () => {
    expect(DEFAULT_REGISTER_POLICY).toEqual({ open: false, invite: true, verifyEmail: false });
  });
});

describe("策略解析", () => {
  it("新键有效 → 用新键，忽略旧键", () => {
    const r = resolveRegisterPolicy(P(true, true, true), { mode: "invite" });
    expect(r.policy).toEqual(P(true, true, true));
    expect(r.error).toBeUndefined();
  });

  it("新键不存在 → 按旧键映射", () => {
    expect(resolveRegisterPolicy(undefined, { mode: "open" }).policy).toEqual(P(true, false, true));
    expect(resolveRegisterPolicy(null, undefined).policy).toEqual(DEFAULT_REGISTER_POLICY);
  });

  it("新键存在但写坏 → 回落邀请制并带错误说明，**不回头读旧键**（防止把注册意外放开）", () => {
    for (const bad of [
      { open: true },
      { open: "yes", invite: true, verifyEmail: false },
      "x",
      [],
    ]) {
      const r = resolveRegisterPolicy(bad, { mode: "open" });
      expect(r.policy).toEqual(DEFAULT_REGISTER_POLICY);
      expect(r.error).toBeTruthy();
    }
  });

  it("多余字段被拒绝（strict，防拼写错误静默变成默认）", () => {
    const r = resolveRegisterPolicy(
      { open: true, invite: false, verifyEmail: true, extra: 1 },
      null,
    );
    expect(r.policy).toEqual(DEFAULT_REGISTER_POLICY);
    expect(r.error).toBeTruthy();
  });
});

describe("四种开关组合的可用性", () => {
  it("开放/邀请各自独立，两关即 closed", () => {
    expect(registerAvailability(P(false, true)).kind).toBe("invite-only");
    expect(registerAvailability(P(true, false)).kind).toBe("open-only");
    expect(registerAvailability(P(true, true)).kind).toBe("both");
    expect(registerAvailability(P(false, false)).kind).toBe("closed");
  });
});

describe("一次提交走哪条路径（Q7、Q8）", () => {
  it("仅邀请：必须有邀请码，没填给出专门的 invite-required", () => {
    expect(chooseRegisterPath(P(false, true), true)).toEqual({ kind: "invite" });
    expect(chooseRegisterPath(P(false, true), false)).toEqual({ kind: "invite-required" });
  });

  it("仅开放：忽略邀请码，一律开放路径", () => {
    expect(chooseRegisterPath(P(true, false), false)).toEqual({ kind: "open" });
    expect(chooseRegisterPath(P(true, false), true)).toEqual({ kind: "open" });
  });

  it("双开：邀请码选填——填了走邀请，留空走开放", () => {
    expect(chooseRegisterPath(P(true, true), true)).toEqual({ kind: "invite" });
    expect(chooseRegisterPath(P(true, true), false)).toEqual({ kind: "open" });
  });

  it("双关：不论填没填都是 closed", () => {
    expect(chooseRegisterPath(P(false, false), true)).toEqual({ kind: "closed" });
    expect(chooseRegisterPath(P(false, false), false)).toEqual({ kind: "closed" });
  });
});

describe("哪些账号带登录验证门", () => {
  it("只有开放路径且站点要求验证", () => {
    const strict = P(true, true, true);
    expect(pathRequiresVerification(strict, { kind: "open" })).toBe(true);
    expect(pathRequiresVerification(strict, { kind: "invite" })).toBe(false);
    expect(pathRequiresVerification(P(true, true, false), { kind: "open" })).toBe(false);
    expect(pathRequiresVerification(strict, { kind: "closed" })).toBe(false);
    expect(pathRequiresVerification(strict, { kind: "invite-required" })).toBe(false);
  });
});

describe("开放注册窗口叠加（M11.4 Step 2，D3）", () => {
  it("窗口未生效 → 原样返回", () => {
    for (const p of [P(false, true), P(false, false), P(true, false), P(true, true)]) {
      expect(applyRegisterWindow(p, false)).toEqual(p);
    }
  });

  it("站点已开放 → 原样返回（只放开不收紧：验证要求跟随站点设置，不由排期收紧）", () => {
    const openOnly = P(true, false, false);
    expect(applyRegisterWindow(openOnly, true)).toBe(openOnly);
    const both = P(true, true, false);
    expect(applyRegisterWindow(both, true)).toBe(both);
    const verified = P(true, false, true);
    expect(applyRegisterWindow(verified, true)).toBe(verified);
  });

  it("由排期放开的注册强制要求验证邮箱（D3）；「邀请」开关保持不变（双开时邀请码选填）", () => {
    expect(applyRegisterWindow(P(false, true), true)).toEqual(P(true, true, true));
    expect(applyRegisterWindow(P(false, false), true)).toEqual(P(true, false, true));
    expect(applyRegisterWindow(P(false, true, true), true)).toEqual(P(true, true, true));
  });

  it("不修改入参对象（读取链可放心复用同一份站点原值）", () => {
    const p = P(false, true);
    applyRegisterWindow(p, true);
    expect(p).toEqual(P(false, true));
  });
});
