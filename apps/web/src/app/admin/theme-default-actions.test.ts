// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionContext, ActionDef } from "@/lib/actions/define-action";
import { setSetting } from "@/lib/auth/settings";
import { getWebDb } from "@funwind/db";
import { invalidateSiteChrome } from "@/lib/chrome/site-chrome";
import { tryApplyThemePackLogo } from "@/lib/theme/apply-pack-logo";
import { setSiteDefaultThemePack } from "@/lib/theme/packs";
import { saveThemePackAction } from "./settings/actions";
import { setDefaultThemePackAction } from "./themes/actions";

// 仅直测动作业务体；权限、表单解析与真实数据库由各自测试负责。
vi.mock("@/lib/actions/define-action", () => ({
  defineAction: <I>(definition: ActionDef<I>) => definition.run,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string): never => {
    throw Object.assign(new Error("测试重定向"), {
      digest: `NEXT_REDIRECT;replace;${url};303;`,
    });
  }),
}));
vi.mock("@/lib/theme/packs", () => ({
  setSiteDefaultThemePack: vi.fn(),
  copyThemePack: vi.fn(),
  createThemePack: vi.fn(),
  deleteThemePack: vi.fn(),
  getThemePackDecorRefs: vi.fn(),
  setThemePackEnabled: vi.fn(),
  updateThemePack: vi.fn(),
}));
vi.mock("@/lib/theme/apply-pack-logo", () => ({ tryApplyThemePackLogo: vi.fn() }));
vi.mock("@/lib/theme/catalog", () => ({ isKnownPackId: vi.fn() }));
vi.mock("@/lib/brand/decor-pool", () => ({ getDecorPoolRaw: vi.fn() }));
vi.mock("@/lib/chrome/site-chrome", () => ({ invalidateSiteChrome: vi.fn() }));
vi.mock("@/lib/auth/settings", () => ({ setSetting: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/limits/load", () => ({ getLimitsConfig: vi.fn() }));
vi.mock("@/lib/limits/config", () => ({ limitsConfigSchema: { safeParse: vi.fn() } }));
vi.mock("@/lib/mail", () => ({
  getMailBrand: vi.fn(),
  sendMail: vi.fn(),
  testMail: vi.fn(),
}));
vi.mock("@funwind/db", () => ({
  getWebDb: vi.fn(() => {
    throw new Error("动作单测禁止连接数据库");
  }),
  users: {},
}));

const PACK_ID = "e2e-boundary-unit";
const context: ActionContext = {
  userId: 90004,
  ip: "127.0.0.1",
  passwordChangeOnly: false,
  subject: {
    userId: 90004,
    roles: [{ key: "admin", scopeId: 0 }],
    restrictions: [],
    emailVerified: true,
    emailVerificationRequired: false,
    registerMode: "invite",
  },
};
const actor = { userId: context.userId, ip: context.ip, via: "admin" };

/** mock 后导出即 run；此处只补回类型，不执行真实 defineAction 骨架。 */
function runAction<I>(action: (form: FormData) => Promise<void>, input: I) {
  return (action as unknown as ActionDef<I>["run"])(context, input, new FormData());
}

const entrances = [
  {
    name: "主题管理",
    invoke: () => runAction(setDefaultThemePackAction, { id: PACK_ID }),
    path: "/admin/themes",
    saved: "default",
    savedWithLogo: "default_logo",
    rejected: (code: string) => `/admin/themes?err=${code}`,
  },
  {
    name: "站点配置",
    invoke: () => runAction(saveThemePackAction, { pack: PACK_ID }),
    path: "/admin/settings",
    saved: "theme",
    savedWithLogo: "theme_logo",
    rejected: () => "/admin/settings?err=theme",
  },
];

async function expectRedirect(result: Promise<void>, url: string) {
  // redirect 的控制流异常仍须透出，不能被误当成 LOGO 失败或吞掉。
  await expect(result).rejects.toMatchObject({
    digest: `NEXT_REDIRECT;replace;${url};303;`,
  });
  expect(redirect).toHaveBeenCalledExactlyOnceWith(url);
}

function expectSavedSideEffects() {
  expect(setSiteDefaultThemePack).toHaveBeenCalledExactlyOnceWith(PACK_ID, actor);
  expect(tryApplyThemePackLogo).toHaveBeenCalledExactlyOnceWith(PACK_ID, {
    ...actor,
    via: "theme",
  });
  expect(invalidateSiteChrome).toHaveBeenCalledOnce();
  expect(vi.mocked(revalidatePath).mock.calls).toEqual([["/admin/themes"], ["/", "layout"]]);
  expect(setSiteDefaultThemePack).toHaveBeenCalledBefore(vi.mocked(tryApplyThemePackLogo));
  expect(tryApplyThemePackLogo).toHaveBeenCalledBefore(vi.mocked(invalidateSiteChrome));
  expect(invalidateSiteChrome).toHaveBeenCalledBefore(vi.mocked(revalidatePath));
  expect(revalidatePath).toHaveBeenCalledBefore(vi.mocked(redirect));
  expect(setSetting).not.toHaveBeenCalled();
  expect(getWebDb).not.toHaveBeenCalled();
}

function expectNoLogoOrCache() {
  expect(tryApplyThemePackLogo).not.toHaveBeenCalled();
  expect(invalidateSiteChrome).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
  expect(setSetting).not.toHaveBeenCalled();
  expect(getWebDb).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setSiteDefaultThemePack).mockResolvedValue({
    ok: true,
    value: { pack: PACK_ID },
  });
  vi.mocked(tryApplyThemePackLogo).mockResolvedValue({
    status: "unchanged",
    reason: "no-logo",
  });
});

describe.each(entrances)("默认主题动作边界：$name", (entrance) => {
  it.each(["not-found", "protected", "conflict", "enabled-limit"] as const)(
    "主题写服务拒绝 %s 时不联动 LOGO、不刷新缓存",
    async (code) => {
      vi.mocked(setSiteDefaultThemePack).mockResolvedValue({ ok: false, code });
      await expectRedirect(entrance.invoke(), entrance.rejected(code));
      expect(setSiteDefaultThemePack).toHaveBeenCalledExactlyOnceWith(PACK_ID, actor);
      expectNoLogoOrCache();
    },
  );

  it("主题写服务异常时原样失败，不联动 LOGO 或伪造保存成功", async () => {
    const failure = new Error("主题事务失败");
    vi.mocked(setSiteDefaultThemePack).mockRejectedValue(failure);
    await expect(entrance.invoke()).rejects.toBe(failure);
    expect(redirect).not.toHaveBeenCalled();
    expectNoLogoOrCache();
  });

  it("等待主题事务成功完成后才开始附带 LOGO 联动", async () => {
    let resolveTheme!: (value: Awaited<ReturnType<typeof setSiteDefaultThemePack>>) => void;
    vi.mocked(setSiteDefaultThemePack).mockReturnValue(
      new Promise((resolve) => {
        resolveTheme = resolve;
      }),
    );
    const pending = entrance.invoke();
    expect(setSiteDefaultThemePack).toHaveBeenCalledOnce();
    expectNoLogoOrCache();
    resolveTheme({ ok: true, value: { pack: PACK_ID } });
    await expectRedirect(pending, `${entrance.path}?saved=${entrance.saved}`);
    expectSavedSideEffects();
  });

  it("自定义包无 LOGO 属于 unchanged，保存成功且不携带 warning", async () => {
    await expectRedirect(entrance.invoke(), `${entrance.path}?saved=${entrance.saved}`);
    expectSavedSideEffects();
  });

  it.each([true, false])(
    "LOGO 联动 applied（新导入=%s）显示主题与 LOGO 双成功",
    async (imported) => {
      vi.mocked(tryApplyThemePackLogo).mockResolvedValue({
        status: "applied",
        imported,
        file: `logo-${"a".repeat(32)}.png`,
      });
      await expectRedirect(entrance.invoke(), `${entrance.path}?saved=${entrance.savedWithLogo}`);
      expectSavedSideEffects();
    },
  );

  it.each(["missing-asset", "exception"] as const)(
    "LOGO 联动失败 %s 仍保留保存成功与缓存刷新，另带 warn=logo",
    async (reason) => {
      vi.mocked(tryApplyThemePackLogo).mockResolvedValue({ status: "failed", reason });
      await expectRedirect(entrance.invoke(), `${entrance.path}?saved=${entrance.saved}&warn=logo`);
      expectSavedSideEffects();
    },
  );
});
