import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { withE2eDb } from "./support/db";
import { LayoutAudit, LAYOUT_AUDIT_ONLY } from "./support/layout-audit";
import { failOnPageErrors } from "./support/page-errors";
import { LAYOUT_WIDTHS } from "./support/responsive-fixtures";
import { USERS, loginAs } from "./support/session";

/**
 * M11.3 注册策略相关界面的六档宽度布局（几何断言 + 截图/切块导出）。
 *
 * 覆盖 M11.3 新增或改动的界面：/register 的四种形态、/login 的登录门提示与重发表单、
 * /admin/settings 的「注册策略」块（含双关警示）、/admin/users/[uid] 的「邮箱与验证」卡片（管理员代改邮箱）。responsive-management 只管后台与帖子页矩阵，
 * 这些页面此前不在任何跨尺寸检查里（评审规范要求新管理表单必须有几何断言与目视检查）。
 *
 * 策略切换走真实的后台保存动作：既覆盖设置块本身，也让站点框架缓存（30 秒）即时失效。
 * 本用例不提交注册/登录表单，流程正确性由 register-policy.spec 覆盖；收尾复原为默认邀请制。
 * 基线：LAYOUT_AUDIT_ONLY=1 逐场景收集而不中断；RUN_LAYOUT_SCREENSHOTS=1 导出截图与可读切块。
 */
test.use({ screenshot: "off", trace: "off", video: "off" });
if (!LAYOUT_AUDIT_ONLY) failOnPageErrors();
test.beforeAll(() => {
  expect(test.info().config.workers, "注册策略是全站共享状态，布局测试依赖全局单 worker").toBe(1);
});
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== "production", "跨尺寸场景仅属于 production 项目");
});

type Policy = { open: boolean; invite: boolean; verifyEmail: boolean };
const DEFAULT_POLICY: Policy = { open: false, invite: true, verifyEmail: false };
const GATE_ERROR = "请先验证邮箱：点击注册邮件中的链接完成验证后即可登录";
const REGISTERED_MESSAGE = "注册成功——请查收邮箱，点击邮件中的链接完成验证后即可登录";

/** 经真实后台动作保存策略；保存会失效站点框架缓存，访客页顶栏的「注册」入口才与策略同步 */
async function saveRegisterPolicy(page: Page, policy: Policy): Promise<void> {
  await page.goto("/admin/settings");
  for (const [name, on] of Object.entries(policy)) {
    const box = page.locator(`#register input[name="${name}"]`);
    if (on) await box.check();
    else await box.uncheck();
  }
  await page.getByRole("button", { name: "保存注册策略" }).click();
  await page.waitForURL(/\/admin\/settings\?saved=/);
}

for (const width of LAYOUT_WIDTHS) {
  test.describe(`注册策略界面 ${width}px`, () => {
    test(`注册页四形态、登录门提示与设置块 @register-${width}`, async ({ page, context }, info) => {
      test.setTimeout(240_000);
      page.setDefaultTimeout(8_000);
      page.setDefaultNavigationTimeout(20_000);
      await page.setViewportSize({ width, height: 900 });
      const audit = new LayoutAudit(page, info);
      const sessions: string[] = [];
      const signIn = async (userId: number | null) => {
        await context.clearCookies();
        if (userId === null) return;
        const token = await loginAs(context, userId);
        sessions.push(createHash("sha256").update(token).digest("hex"));
      };

      /** 访客页场景：打开 → 断言文案 → 采集几何与截图 */
      const guestPage = (
        label: string,
        url: string,
        required: string[],
        expectations: () => Promise<void>,
      ) =>
        audit.step(label, async () => {
          expect((await page.goto(url))?.status()).toBe(200);
          await expectations();
          // 访客页另存 main 区域图：桌面宽度下整页切块会把居中的卡片劈成左右两半，区域图才是完整的
          await audit.capture(label, { required, regions: [{ name: "main", selector: "main" }] });
        });

      /** 设置页「注册策略」块：只审计该块，并另存块的区域截图 */
      const settingsCard = (label: string, expectations: () => Promise<void>) =>
        audit.step(label, async () => {
          await page.goto("/admin/settings");
          await expect(page.locator("#register")).toBeVisible();
          await expectations();
          await audit.capture(label, {
            roots: "#register",
            buttons: "#register button",
            required: ['#register input[name="open"]', "#register button"],
            regions: [{ name: "register-card", selector: "#register" }],
          });
        });

      /** 保存策略并采集保存后的设置块（页面顶部带保存提示） */
      const saveAndCapture = (label: string, policy: Policy, expectations: () => Promise<void>) =>
        audit.step(label, async () => {
          await saveRegisterPolicy(page, policy);
          await expectations();
          await audit.capture(label, {
            roots: "#register",
            buttons: "#register button",
            required: ['#register input[name="open"]', "#register button"],
            regions: [{ name: "register-card", selector: "#register" }],
          });
        });

      const main = () => page.getByRole("main");
      try {
        // 状态 0：键不存在，等价旧 register.mode = invite
        await withE2eDb((q) => q.exec("DELETE FROM site_settings WHERE `key` = 'register.policy'"));
        await signIn(null);
        await guestPage(
          "guest-register-invite-only",
          "/register",
          ['main form input[name="invite"]'],
          async () => {
            await expect(page.getByText("当前注册方式：邀请制。")).toBeVisible();
          },
        );
        await guestPage("guest-login", "/login", ["main form"], async () => {
          await expect(main().getByRole("link", { name: "注册", exact: true })).toBeVisible();
          // 页脚链接整体不换行，只允许在「 · 」分隔处折行：行内元素跨行会产生多个 client rect。
          // 375px 下「注销申请」曾被从中间断成「注 / 销申请」，页面不溢出所以溢出类检查发现不了
          for (const href of ["/forgot", "/appeal", "/closure"]) {
            const rects = await main()
              .locator(`a[href="${href}"]`)
              .evaluate((el) => el.getClientRects().length);
            expect(rects, `页脚链接 ${href} 被拆成多行`).toBe(1);
          }
          // 「显示密码」按钮视觉 32px，点击热区须外扩到至少 40px（伪元素）：按钮四角外 3px 处命中的仍是按钮本身。
          // 热区不改变布局，几何类检查看不到，所以单独断言
          const reach = await page.getByRole("button", { name: "显示密码" }).evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hits = (x: number, y: number) => document.elementFromPoint(x, y) === el;
            return [
              hits(r.left - 3, r.top - 3),
              hits(r.right + 3, r.top - 3),
              hits(r.left - 3, r.bottom + 3),
              hits(r.right + 3, r.bottom + 3),
            ];
          });
          expect(reach, "显示密码按钮的点击热区未外扩").toEqual([true, true, true, true]);
        });
        await signIn(USERS.admin);
        await settingsCard("admin-settings-register-default", async () => {
          await expect(page.locator('#register input[name="invite"]')).toBeChecked();
          await expect(page.locator('#register input[name="open"]')).not.toBeChecked();
        });

        // 状态 1：仅开放，要求验证邮箱
        await saveAndCapture(
          "admin-settings-register-open-verify",
          { open: true, invite: false, verifyEmail: true },
          async () => {
            await expect(page.getByText("注册策略已保存。")).toBeVisible();
            await expect(page.locator('#register input[name="verifyEmail"]')).toBeChecked();
          },
        );
        await signIn(null);
        await guestPage(
          "guest-register-open-verify",
          "/register",
          ['main form input[name="username"]'],
          async () => {
            await expect(page.getByText(/注册后需先验证邮箱才能登录/)).toBeVisible();
            await expect(page.getByLabel(/邀请码/)).toHaveCount(0);
          },
        );
        // 登录门拦下后的页面：红色提示 + 重发表单（action 实际跳转的就是这个 URL）
        await guestPage(
          "guest-login-unverified",
          `/login?unverified=1&error=${encodeURIComponent(GATE_ERROR)}`,
          ['[data-testid="resend-verification"]', "main form"],
          async () => {
            await expect(page.getByText(/请先验证邮箱/)).toBeVisible();
            await expect(page.getByTestId("resend-verification")).toBeVisible();
          },
        );
        await guestPage(
          "guest-login-resent",
          "/login?resent=1",
          ['[data-testid="resend-verification"]'],
          async () => {
            await expect(page.getByText("若该邮箱有待验证的账号")).toBeVisible();
          },
        );
        await guestPage(
          "guest-login-registered-message",
          `/login?message=${encodeURIComponent(REGISTERED_MESSAGE)}`,
          ["main form"],
          async () => {
            await expect(page.getByText(/请查收邮箱/)).toBeVisible();
            await expect(page.getByTestId("resend-verification")).toHaveCount(0);
          },
        );

        // 状态 2：双开，邀请码选填
        await signIn(USERS.admin);
        await saveAndCapture(
          "admin-settings-register-both-verify",
          { open: true, invite: true, verifyEmail: true },
          async () => {
            await expect(page.locator('#register input[name="invite"]')).toBeChecked();
          },
        );
        await signIn(null);
        await guestPage(
          "guest-register-both",
          "/register",
          ['main form input[name="invite"]'],
          async () => {
            await expect(page.getByLabel("邀请码（选填）")).toBeVisible();
            await expect(page.getByText(/不填邀请码时/)).toBeVisible();
          },
        );
        await guestPage(
          "guest-register-both-error-echo",
          `/register?error=${encodeURIComponent("邀请码无效或已被使用")}`,
          ['main form input[name="invite"]'],
          async () => {
            await expect(page.getByText("邀请码无效或已被使用")).toBeVisible();
          },
        );

        // 用户详情页的「邮箱与验证」卡片：只审计该卡片并另存区域图；不提交（改邮箱的流程由 admin-user-email.spec 覆盖）
        await signIn(USERS.admin);
        await audit.step("admin-user-email-panel", async () => {
          await page.goto(`/admin/users/${USERS.alice}`);
          await expect(page.getByTestId("user-email-panel")).toBeVisible();
          await expect(page.getByRole("button", { name: "修改邮箱并发送验证邮件" })).toBeVisible();
          await audit.capture("admin-user-email-panel", {
            roots: "#email",
            buttons: "#email button",
            required: ['#email input[name="email"]', "#email button"],
            regions: [{ name: "email-panel", selector: "#email" }],
          });
        });

        // 状态 3：双关，不开放注册
        await signIn(USERS.admin);
        await saveAndCapture(
          "admin-settings-register-closed",
          { open: false, invite: false, verifyEmail: false },
          async () => {
            // 保存提示（顶部）与页内常驻警示是两个元素，文案分隔符不同，分别断言
            await expect(
              page.getByText("注册策略已保存：当前开放注册与邀请注册均已关闭"),
            ).toBeVisible();
            await expect(page.getByTestId("register-closed-warning")).toBeVisible();
          },
        );
        await signIn(null);
        await guestPage(
          "guest-register-closed",
          "/register",
          ['[data-testid="register-closed"]'],
          async () => {
            await expect(page.getByTestId("register-closed")).toBeVisible();
            await expect(page.getByLabel("用户名")).toHaveCount(0);
          },
        );
        await guestPage("guest-login-registration-closed", "/login", ["main form"], async () => {
          await expect(main().getByRole("link", { name: "注册", exact: true })).toHaveCount(0);
          await expect(page.getByText("没有账号？")).toHaveCount(0);
        });
      } finally {
        try {
          // 经界面复原：失效站点框架缓存；失败时下面的库直写兜底
          await signIn(USERS.admin);
          await saveRegisterPolicy(page, DEFAULT_POLICY);
        } catch {
          /* 兜底见下 */
        }
        try {
          await withE2eDb(async (q) => {
            await q.exec("DELETE FROM site_settings WHERE `key` = 'register.policy'");
            if (sessions.length) await q.exec("DELETE FROM sessions WHERE id IN (?)", [sessions]);
          });
        } finally {
          await audit.finish();
        }
      }
    });
  });
}
