import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withE2eDb } from "../e2e/support/db";
import { USERS, loginAs } from "../e2e/support/session";

/**
 * qy2010 计算样式基线（M11.6 Step 0，docs/milestones/M11.6-theme-semantic-tokens.md）。
 *
 * 作用：qy2010 要从静态 CSS 迁成数据库主题。「迁移后看起来没变」必须有迁移**前**的真实记录作对照，
 * 否则无法证明迁移本身是行为保持的。这里冻结两类事实：
 *   1. 34 个令牌变量在 :root 上的计算值（22 个语义色、圆角、3 档阴影、品牌渐变、展示字体、6 个板块卡参数）；
 *   2. 这些变量的**消费端**的计算样式（页眉、底栏、页脚、页面包装、卡片、主按钮、板块卡等）。
 * 变量对了不等于用上了：--page-bg 由 [data-fw-page] 间接读取，阴影经 Tailwind 工具类 shadow-1..3 读取，
 * 板块卡渐隐由 .forum-card-band__img::after 读取，所以消费端必须单独冻结。
 *
 * 比较的是**规范化后的值**，不是源码字面：静态 CSS 经构建期压缩（rgb(120 100 40 / 0.1) 变成 #7864281a，
 * 0.25rem 变成 .25rem），迁到数据库后由运行时生成，字面必然不同。颜色归一化为 #rrggbb[aa]；阴影、渐变、字体、
 * 长度交给浏览器按对应属性解析后取计算值，才能和数据库 tokens 里的结构化值直接比较。
 *
 * 有意不冻结的变量（原因均已核实）：
 *   --theme-name：没有任何消费方；
 *   --header-bg / --header-blur / --header-border / --tabbar-bg / --tabbar-blur：只作为 themeSurfaceStyle
 *     的回退值（数据库里有对应表面时从不生效），真实外观由「页眉」「底栏」的元素与图层条目验证；
 *   --page-bg：含纸纹（M11.6 D1 决定丢弃），底色由「页面包装.background-color」验证。
 *     「页面包装.background-image」里的纸纹是 Step 5 唯一预期的变化，其余条目必须逐项不变。
 *
 * 用法（仅本机，依赖隔离库，同 pnpm test:visual）：
 *   对账：  默认模式，当前计算值必须等于 fixture；
 *   冻结：  QY2010_BASELINE=write 重新生成 fixture（只在迁移前冻结一次，之后只对账）。
 *
 * 任何元素找不到、任何属性取到空串、任何值无法解析，都**明确失败**：null 或空串混进 fixture 会让对账对该项
 * 永远「通过」，却什么都没验证（首次冻结时「页脚」「卡片」就因所在页面没有它们而抓到 null）。
 */

// Playwright 以 CJS 加载用例，import.meta.dirname 此时为 undefined（tsc 不会报错），沿用项目其他 spec 的 __dirname
/** 桌面与移动各一份 fixture：底栏（tabbar）只在移动视口渲染（md:hidden），两份各自完整，失败时指向明确 */
const fixtureOf = (project: string) =>
  path.join(__dirname, "fixtures", `qy2010-computed.${project}.json`);
const WRITE = process.env.QY2010_BASELINE === "write";

/** 规范化方式：color 归一为十六进制；shadow / image / font / length 由浏览器按对应属性解析；raw 保留原串 */
type VarKind = "color" | "shadow" | "image" | "font" | "length" | "raw";

/** 34 个令牌变量（与 qy2010.css 的 41 条声明相比，去掉上文列出的 7 条） */
const VARIABLES: Record<string, VarKind> = {
  "--background": "color",
  "--foreground": "color",
  "--card": "color",
  "--card-foreground": "color",
  "--popover": "color",
  "--popover-foreground": "color",
  "--primary": "color",
  "--primary-foreground": "color",
  "--secondary": "color",
  "--secondary-foreground": "color",
  "--muted": "color",
  "--muted-foreground": "color",
  "--accent": "color",
  "--accent-foreground": "color",
  "--destructive": "color",
  "--destructive-foreground": "color",
  "--success": "color",
  "--warning": "color",
  "--info": "color",
  "--border": "color",
  "--input": "color",
  "--ring": "color",
  "--radius": "length",
  "--shadow-1": "shadow",
  "--shadow-2": "shadow",
  "--shadow-3": "shadow",
  "--gradient-brand": "image",
  "--band-width": "length",
  "--band-angle": "raw",
  "--band-fade": "raw",
  "--band-mask-color": "color",
  "--band-dim-opacity": "raw",
  "--band-mask-display": "raw",
  "--fw-font-display": "font",
};

const PAGES = ["/boards", "/settings/avatar", "/settings/profile"] as const;
type PageUrl = (typeof PAGES)[number];

/** pseudo：读伪元素的计算样式。表面（data-fw-theme-surface）的底色画在 ::before、遮罩画在 ::after，元素自身是透明的 */
type ElementSpec = {
  /** 选择器；用探针（utility）时只作说明文字 */
  selector: string;
  props: string[];
  /** 从哪个页面抓（不同元素出现在不同页面） */
  page: PageUrl;
  pseudo?: "::before" | "::after";
  /** 只在该项目里抓（如底栏只在移动视口渲染） */
  only?: "mobile";
  /** 探针：临时挂一个带这些工具类的元素来读，用于只在交互态才出现的工具类（弹层的 shadow-3、悬停的 shadow-2） */
  utility?: string;
};

/** 代表性元素：标签 → 选择器与要记录的计算样式属性 */
const ELEMENTS: Record<string, ElementSpec> = {
  页面包装: {
    selector: "[data-fw-page]",
    props: ["background-color", "background-image"],
    page: "/boards",
  },
  页眉: {
    selector: "header",
    props: ["background-color", "border-bottom-color", "backdrop-filter"],
    page: "/boards",
  },
  站名展示字体: {
    selector: "header .font-display",
    props: ["font-family", "color"],
    page: "/boards",
  },
  页脚: {
    selector: "footer",
    props: ["background-color", "border-top-color", "color"],
    page: "/boards",
  },
  板块卡: {
    selector: ".forum-card-band",
    props: ["border-top-left-radius", "background-color"],
    page: "/boards",
  },
  板块卡图区: { selector: ".forum-card-band__img", props: ["width"], page: "/boards" },
  // 表面图层：底色 ::before、遮罩 ::after。元素自身 background-color 恒为透明，只读它冻结不到真实外观
  "页眉·底色层": {
    selector: "header[data-fw-theme-surface]",
    props: ["background-color", "background-image", "opacity"],
    page: "/boards",
    pseudo: "::before",
  },
  "页眉·遮罩层": {
    selector: "header[data-fw-theme-surface]",
    props: ["background-color", "background-image", "opacity"],
    page: "/boards",
    pseudo: "::after",
  },
  "底栏·底色层": {
    selector: "nav[data-surface='tabbar'][data-fw-theme-surface]",
    props: ["background-color", "background-image", "opacity"],
    page: "/boards",
    pseudo: "::before",
    only: "mobile",
  },
  "底栏·边框": {
    selector: "nav[data-surface='tabbar'][data-fw-theme-surface]",
    props: ["border-top-color", "backdrop-filter"],
    page: "/boards",
    only: "mobile",
  },
  "页脚·底色层": {
    selector: "footer[data-fw-theme-surface]",
    props: ["background-color", "background-image", "opacity"],
    page: "/boards",
    pseudo: "::before",
  },
  "板块卡·底色层": {
    selector: ".forum-card-band[data-fw-theme-surface]",
    props: ["background-color", "background-image", "opacity"],
    page: "/boards",
    pseudo: "::before",
  },
  "板块卡·遮罩层": {
    selector: ".forum-card-band[data-fw-theme-surface]",
    props: ["background-color", "background-image", "opacity"],
    page: "/boards",
    pseudo: "::after",
  },
  // 板块卡图区右缘的渐隐遮罩：与上面主题表面的 ::after 是两个不同的元素，由 --band-mask-display / -angle / -fade /
  // -mask-color 驱动（globals.css 的 .forum-card-band__img::after）。qy2010 把 display 设为 none，
  // 取不到渐变串时说明这条消费链断了
  "板块卡图区·渐隐遮罩": {
    selector: ".forum-card-band__img",
    props: ["display", "background-image"],
    page: "/boards",
    pseudo: "::after",
  },
  // 无图板块的占位底色：--gradient-brand 的真实消费方（forum-directory.tsx）
  品牌渐变占位: {
    selector: ".forum-card-band__img [class*='gradient-brand']",
    props: ["background-image"],
    page: "/boards",
  },
  // 阴影：--shadow-1/2/3 经 Tailwind 工具类 shadow-1/2/3 被信息流卡片、编辑器外框、弹层、提示、回复悬浮按钮读取。
  // 其中悬停与弹层只在交互态出现，统一用探针元素读工具类的计算结果
  "阴影·shadow-1": {
    selector: ".shadow-1（探针元素）",
    utility: "shadow-1",
    props: ["box-shadow"],
    page: "/boards",
  },
  "阴影·shadow-2": {
    selector: ".shadow-2（探针元素）",
    utility: "shadow-2",
    props: ["box-shadow"],
    page: "/boards",
  },
  "阴影·shadow-3": {
    selector: ".shadow-3（探针元素）",
    utility: "shadow-3",
    props: ["box-shadow"],
    page: "/boards",
  },
  // 卡片的 box-shadow 是 Tailwind 自带的 shadow-sm，与主题无关；冻结它只为证明迁移不会碰到它
  卡片: {
    selector: "[data-slot='card']",
    props: ["background-color", "border-top-left-radius", "box-shadow", "color"],
    page: "/settings/avatar",
  },
  // 主按钮：--primary / --primary-foreground / --radius（rounded-lg）最直接的消费方，M11.6 Step 6 换品牌色改的就是它
  主按钮: {
    selector: "form button[type='submit'].bg-primary",
    props: ["background-color", "color", "border-top-left-radius"],
    page: "/settings/profile",
  },
};

type Snapshot = {
  meta: { pack: string | null; mode: string | null };
  variables: Record<string, string>;
  elements: Record<string, Record<string, string>>;
};

type PageData = {
  variables: Record<string, string>;
  elements: Record<string, Record<string, string> | null>;
};

/**
 * 在页面里一次读完变量与元素。变量按种类规范化；元素找不到返回 null，由调用方判失败。
 * 所有探针元素隐藏、不占位、不拦截指针，读完统一移除。
 */
async function readPage(
  page: Page,
  variableKinds: Record<string, VarKind>,
  specs: Record<string, ElementSpec>,
): Promise<PageData> {
  return page.evaluate(
    ({ kinds, entries }) => {
      const created: Element[] = [];
      const makeProbe = (className = ""): HTMLElement => {
        const node = document.createElement("div");
        node.className = className;
        node.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
        document.body.appendChild(node);
        created.push(node);
        return node;
      };
      const probe = makeProbe();

      /** 颜色归一化为 #rrggbb / #rrggbbaa；浏览器无法解析时原样返回 */
      const toHex = (value: string): string => {
        probe.style.color = "";
        probe.style.color = value;
        if (probe.style.color === "") return value;
        const m = getComputedStyle(probe).color.match(/^rgba?\(([^)]+)\)$/);
        if (!m) return value;
        const [r, g, b, a] = m[1]
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number);
        const h = (n: number) => Math.round(n).toString(16).padStart(2, "0");
        return `#${h(r)}${h(g)}${h(b)}${a !== undefined && a < 1 ? h(a * 255) : ""}`;
      };

      /** 把值交给浏览器按 prop 解析后取计算值，与书写方式无关；无法解析时带标记返回，让对账变红而不是被吞掉 */
      const computed = (prop: string, value: string): string => {
        probe.style.removeProperty(prop);
        probe.style.setProperty(prop, value);
        if (probe.style.getPropertyValue(prop) === "") return `⚠无法解析为 ${prop}：${value}`;
        return getComputedStyle(probe).getPropertyValue(prop);
      };
      const propOf: Record<string, string> = {
        shadow: "box-shadow",
        image: "background-image",
        font: "font-family",
        length: "width",
      };

      const root = getComputedStyle(document.documentElement);
      const variables: Record<string, string> = {};
      for (const [name, kind] of Object.entries(kinds)) {
        const raw = root.getPropertyValue(name).trim();
        if (raw === "") variables[name] = "";
        else if (kind === "color") variables[name] = toHex(raw);
        else if (kind === "raw") variables[name] = raw;
        else variables[name] = computed(propOf[kind]!, raw);
      }

      const elements: Record<string, Record<string, string> | null> = {};
      for (const [label, { selector, props, pseudo, utility }] of Object.entries(entries)) {
        const el = utility ? makeProbe(utility) : document.querySelector(selector);
        if (!el) {
          elements[label] = null;
          continue;
        }
        const style = getComputedStyle(el, pseudo ?? null);
        const values: Record<string, string> = {};
        for (const prop of props) {
          const value = style.getPropertyValue(prop).trim();
          values[prop] = /color$/.test(prop) ? toHex(value) : value;
        }
        elements[label] = values;
      }

      for (const node of created) node.remove();
      return { variables, elements };
    },
    { kinds: variableKinds, entries: specs },
  );
}

/** 逐项比较成「一行一条」的差异：失败时直接看到哪个变量、哪个元素的哪个属性变了，而不是一整块对象 diff */
function diffRecords(
  prefix: string,
  expected: Record<string, string>,
  actual: Record<string, string>,
): string[] {
  const lines: string[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[key] !== actual[key]) {
      lines.push(
        `${prefix}${key}｜期望 ${expected[key] ?? "（无）"}｜实际 ${actual[key] ?? "（无）"}`,
      );
    }
  }
  return lines;
}

function diffElements(
  expected: Record<string, Record<string, string>>,
  actual: Record<string, Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(expected), ...Object.keys(actual)])].flatMap((label) =>
    diffRecords(`${label} › `, expected[label] ?? {}, actual[label] ?? {}),
  );
}

async function gotoSettled(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator("html")).toHaveAttribute("data-pack", "qy2010");
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
}

test("qy2010 浅色：计算样式与冻结的基线逐项一致", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  // 与 visual.spec 同口径：用 DB 把用户偏好设为 qy2010，SSR 直出 html[data-pack]
  await withE2eDb((q) =>
    q.exec(
      "INSERT INTO user_profiles (user_id, theme_pack) VALUES (?, 'qy2010') ON DUPLICATE KEY UPDATE theme_pack = 'qy2010'",
      [USERS.member],
    ),
  );
  // 页脚只有站点配了友链才渲染，隔离库默认没有。站点框架有 30 秒进程内缓存，测试进程够不到服务进程里的缓存，
  // 而 webServer 的就绪探测一定先访问过首页，缓存早已预热成「无友链」——直接写库要等 30 秒才生效。
  // 所以走真实的后台保存动作（它会 invalidateSiteChrome()，在服务进程内即时生效），做法同 register-policy.spec
  const admin = await browser.newContext({ ...testInfo.project.use });
  await loginAs(admin, USERS.admin);
  const setFooterLinks = async (links: { label: string; href: string }[]) => {
    const adminPage = await admin.newPage();
    try {
      await adminPage.goto("/admin/announcements");
      const form = adminPage
        .locator("form")
        .filter({ has: adminPage.locator('input[name="linksRaw"]') });
      // 先清空现有行，再按需添加
      while ((await form.getByRole("button", { name: /^删除第 \d+ 行$/ }).count()) > 0) {
        await form
          .getByRole("button", { name: /^删除第 \d+ 行$/ })
          .first()
          .click();
      }
      for (const [i, link] of links.entries()) {
        await form.getByRole("button", { name: /添加友链/ }).click();
        await form.getByLabel(`第 ${i + 1} 行名称`).fill(link.label);
        await form.getByLabel(`第 ${i + 1} 行路径`).fill(link.href);
      }
      await form.getByRole("button", { name: "保存友链" }).click();
      await adminPage.waitForURL(/[?&]links=1/);
    } finally {
      await adminPage.close();
    }
  };
  await setFooterLinks([{ label: "基线友链", href: "https://example.com/" }]);
  const ctx = await browser.newContext({ ...testInfo.project.use });
  await ctx.addInitScript(() => localStorage.setItem("theme", "light"));
  await loginAs(ctx, USERS.member);
  const page = await ctx.newPage();
  try {
    const elements: Record<string, Record<string, string>> = {};
    let variables: Record<string, string> = {};
    for (const url of PAGES) {
      await gotoSettled(page, url);
      const specs = Object.fromEntries(
        Object.entries(ELEMENTS).filter(
          ([, spec]) =>
            spec.page === url && (spec.only === undefined || spec.only === testInfo.project.name),
        ),
      );
      // 变量是 :root 级的，与页面无关，只在第一个页面读一次
      const data = await readPage(page, url === PAGES[0] ? VARIABLES : {}, specs);
      if (url === PAGES[0]) variables = data.variables;
      for (const [label, values] of Object.entries(data.elements)) {
        expect(
          values,
          `「${label}」（${ELEMENTS[label]!.selector}）在 ${url} 上找不到——找不到就无法冻结，不允许用 null 蒙混`,
        ).not.toBeNull();
        const empty = Object.entries(values!)
          .filter(([, v]) => v === "")
          .map(([k]) => k);
        expect(empty, `「${label}」的这些属性取到空串，冻结它等于什么都没验证`).toEqual([]);
        elements[label] = values!;
      }
    }
    // 空串 = 变量根本没定义；以 ⚠ 开头 = 浏览器无法按对应属性解析。两者都不能冻结
    const broken = Object.entries(variables)
      .filter(([, v]) => v === "" || v.startsWith("⚠"))
      .map(([k, v]) => `${k} = ${v || "（空）"}`);
    expect(broken, "这些变量在 :root 上没有值或无法解析").toEqual([]);

    const actual: Snapshot = { meta: { pack: "qy2010", mode: "light" }, variables, elements };
    if (WRITE) {
      writeFileSync(fixtureOf(testInfo.project.name), `${JSON.stringify(actual, null, 2)}\n`);
      console.log(`已冻结基线：${fixtureOf(testInfo.project.name)}`);
      return;
    }
    const expected = JSON.parse(readFileSync(fixtureOf(testInfo.project.name), "utf8")) as Snapshot;
    // 变量与消费端分开断言并用 soft：失败时同时看到两边各自哪里变了，不会被第一处失败遮住第二处
    expect
      .soft(diffRecords("", expected.variables, actual.variables), "CSS 变量的计算值与基线不一致")
      .toEqual([]);
    expect
      .soft(diffElements(expected.elements, actual.elements), "消费端的计算样式与基线不一致")
      .toEqual([]);
  } finally {
    await ctx.close();
    // 清理也走真实动作：直接删库不会让服务进程的缓存失效，页脚会残留到后续视觉用例
    await setFooterLinks([]).catch(() => undefined);
    await admin.close();
    await withE2eDb((q) =>
      q.exec(
        "INSERT INTO user_profiles (user_id, theme_pack) VALUES (?, NULL) ON DUPLICATE KEY UPDATE theme_pack = NULL",
        [USERS.member],
      ),
    );
  }
});
