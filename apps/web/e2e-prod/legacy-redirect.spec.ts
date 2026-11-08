import { execSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * M13 Step 2 · 旧 phpwind URL 301/410 用例集（≥20 条，验收门禁「301 用例全绿」）。
 *
 * 对象：docker/production/nginx/redirect-map.conf（与生产宝塔 vhost 同一份文件），
 * 用例自起一个临时 nginx 容器加载（nginx.conf：占位域名 www.example.test + 同构 if 结构）。
 * 期望 URL 由探查实录冻结（docs/milestones/M13-launch.md §1 F1/F12）：
 *   · id 恒等（tid/pid/fid/uid = 旧值）→ 纯静态映射
 *   · 页码不透传（旧 read.perpage=10 首帖占位 vs 新站 20 楼/页首帖常驻——口径不同）；
 *     精确到楼走 /p/{pid}（服务端按可见性算页码 + #p{pid} 锚点）
 *   · 410 原则：正文/表情迁移期已改写 /files/**、/emoji/**；旧路径无法反查 → Gone 诚实于 404
 *
 * 应用路由（/t/…、/p/… 等）在本容器无上游 → 502 属预期，用例不断言其状态。
 * 需要 docker（用例自行起/清容器，端口 LEGACY_REDIRECT_PORT 默认 3205）。
 */

const PORT = process.env.LEGACY_REDIRECT_PORT ?? "3205";
const BASE = `http://127.0.0.1:${PORT}`;
// playwright 的 TS 转译走 CJS，import.meta 不可用（M12 安装 E2E 同款教训）：以 apps/web 为 cwd 定位
const NGINX_DIR = join(process.cwd(), "..", "..", "docker", "production", "nginx");
const CONTAINER = "funwind-nginx-301";

test.beforeAll(() => {
  // 幂等起容器：残留先清（上次中断），挂载同一份映射文件
  execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
  execSync(
    `docker run -d --name ${CONTAINER} -p 127.0.0.1:${PORT}:80 ` +
      `-v "${join(NGINX_DIR, "nginx.conf")}:/etc/nginx/nginx.conf:ro" ` +
      `-v "${join(NGINX_DIR, "redirect-map.conf")}:/etc/nginx/conf.d/redirect-map.conf:ro" ` +
      `nginx:alpine`,
    { stdio: "ignore" },
  );
  // 等 nginx 就绪（任意 HTTP 响应即就绪——映射层路径返回 301/410/502 都算）
  for (let i = 0; i < 50; i++) {
    try {
      execSync(`curl -s -o /dev/null ${BASE}/robots.txt`, { stdio: "ignore", timeout: 2000 });
      return;
    } catch {
      execSync("sleep 0.3");
    }
  }
  throw new Error("nginx 验证容器未就绪（3205 端口）");
});

test.afterAll(() => {
  execSync(`docker rm -f ${CONTAINER}`, { stdio: "ignore" });
});

/** 期望 301：request → location（相对）；maxRedirects:0 直接看本跳响应头（默认会跟随到无上游的 502） */
async function expectMovedTo(
  request: import("@playwright/test").APIRequestContext,
  from: string,
  to: string,
) {
  const res = await request.get(`${BASE}${from}`, { maxRedirects: 0 });
  expect(res.status(), `GET ${from} → 301`).toBe(301);
  const location = res.headers()["location"];
  expect(location, `GET ${from} Location`).toBe(to);
}

/** 期望 410 Gone */
async function expectGone(request: import("@playwright/test").APIRequestContext, from: string) {
  const res = await request.get(`${BASE}${from}`, { maxRedirects: 0 });
  expect(res.status(), `GET ${from} → 410`).toBe(410);
}

test.describe("旧 phpwind URL 重定向映射表", () => {
  // ---------- 帖子（301） ----------
  test("read.php?tid=1234 → /t/1234（旧站主力形态）", async ({ request }) => {
    await expectMovedTo(request, "/read.php?tid=1234", "/t/1234");
  });
  test("read.php?tid=1234&fid=91（冗余 fid）→ /t/1234", async ({ request }) => {
    await expectMovedTo(request, "/read.php?tid=1234&fid=91", "/t/1234");
  });
  test("read.php?tid=1234&fid=91&page=3（页码不透传：旧 10 楼/页≠新 20 楼/页口径）", async ({
    request,
  }) => {
    await expectMovedTo(request, "/read.php?tid=1234&fid=91&page=3", "/t/1234");
  });
  test("read.php?tid=0（越界 id）→ 410 兜底", async ({ request }) => {
    await expectGone(request, "/read.php?tid=0");
  });
  test("read.php?tid=abc（非法 id）→ 410 兜底", async ({ request }) => {
    await expectGone(request, "/read.php?tid=abc");
  });

  // ---------- 定位到楼（301 → /p/{pid}，服务端算页码+锚点） ----------
  test("index.php?m=bbs&c=read&a=jump&tid=1234&pid=56789 → /p/56789", async ({ request }) => {
    await expectMovedTo(request, "/index.php?m=bbs&c=read&a=jump&tid=1234&pid=56789", "/p/56789");
  });
  test("?pid=56789（站内跳楼短链）→ /p/56789", async ({ request }) => {
    await expectMovedTo(request, "/?pid=56789", "/p/56789");
  });

  // ---------- 版块（301，?type= 直传：主题分类前缀恒等迁移） ----------
  test("index.php?m=bbs&c=thread&fid=91 → /f/91", async ({ request }) => {
    await expectMovedTo(request, "/index.php?m=bbs&c=thread&fid=91", "/f/91");
  });
  test("index.php?m=bbs&c=thread&fid=91&type=7 → /f/91?type=7", async ({ request }) => {
    await expectMovedTo(request, "/index.php?m=bbs&c=thread&fid=91&type=7", "/f/91?type=7");
  });
  test("thread.php?fid=113（phpwind 8 时代）→ /f/113", async ({ request }) => {
    await expectMovedTo(request, "/thread.php?fid=113", "/f/113");
  });

  // ---------- 用户（301，三种日志实录形态） ----------
  test("?uid=17911 → /u/17911", async ({ request }) => {
    await expectMovedTo(request, "/?uid=17911", "/u/17911");
  });
  test("u.php?uid=17911 → /u/17911", async ({ request }) => {
    await expectMovedTo(request, "/u.php?uid=17911", "/u/17911");
  });
  test("index.php?m=space&c=profile&uid=17911 → /u/17911", async ({ request }) => {
    await expectMovedTo(request, "/index.php?m=space&c=profile&uid=17911", "/u/17911");
  });

  // ---------- phpwind 8 simple 无图模式（301，页码丢弃） ----------
  test("simple/?t1234.html → /t/1234", async ({ request }) => {
    await expectMovedTo(request, "/simple/?t1234.html", "/t/1234");
  });
  test("simple/?f91.html → /f/91", async ({ request }) => {
    await expectMovedTo(request, "/simple/?f91.html", "/f/91");
  });
  test("simple/?t1234-2.html（旧页码丢弃）→ /t/1234", async ({ request }) => {
    await expectMovedTo(request, "/simple/?t1234-2.html", "/t/1234");
  });

  // ---------- 站级入口（301） ----------
  test("index.php?m=bbs&c=forumlist（旧站首页路由）→ /boards（版块目录，语义精确对应）", async ({
    request,
  }) => {
    await expectMovedTo(request, "/index.php?m=bbs&c=forumlist", "/boards");
  });
  test("index.php?c=forumlist&m=bbs（参数倒序变体）→ /boards", async ({ request }) => {
    await expectMovedTo(request, "/index.php?c=forumlist&m=bbs", "/boards");
  });
  test("index.php?m=bbs&c=forum&a=list（旧版块列表）→ /boards", async ({ request }) => {
    await expectMovedTo(request, "/index.php?m=bbs&c=forum&a=list", "/boards");
  });
  test("裸 index.php → /", async ({ request }) => {
    await expectMovedTo(request, "/index.php", "/");
  });
  test("index.php?m=u&c=login → /login", async ({ request }) => {
    await expectMovedTo(request, "/index.php?m=u&c=login", "/login");
  });
  test("index.php?m=u&c=register → /register", async ({ request }) => {
    await expectMovedTo(request, "/index.php?m=u&c=register", "/register");
  });
  test("index.php?m=u&c=findPwd → /forgot", async ({ request }) => {
    await expectMovedTo(request, "/index.php?m=u&c=findPwd", "/forgot");
  });
  test("index.php?m=search&c=s&keyword=青翼 → /search?q=青翼（编码保留）", async ({ request }) => {
    await expectMovedTo(
      request,
      `/index.php?m=search&c=s&keyword=${encodeURIComponent("青翼")}`,
      `/search?q=${encodeURIComponent("青翼")}`,
    );
  });

  // ---------- 410 Gone ----------
  test("/attachment/avatar/001/02/03/17911.jpg（旧头像，uid 可精确换算）→ /u/17911", async ({
    request,
  }) => {
    await expectMovedTo(request, "/attachment/avatar/001/02/03/17911.jpg", "/u/17911");
  });
  test("/attachment/Mon_1004/55_7_hash.jpg（phpwind 月份目录附件）→ 410", async ({ request }) => {
    await expectGone(request, "/attachment/Mon_1004/55_7_hash.jpg");
  });
  test("/attachment/1302/xxx.png（数字目录附件）→ 410", async ({ request }) => {
    await expectGone(request, "/attachment/1302/xxx.png");
  });
  test("/emotion/1.gif（旧表情）→ 410", async ({ request }) => {
    await expectGone(request, "/emotion/1.gif");
  });
  test("/res/css/style.css（旧站皮肤资源）→ 410", async ({ request }) => {
    await expectGone(request, "/res/css/style.css");
  });
  test("/themes/default/bg.png（旧主题资源）→ 410", async ({ request }) => {
    await expectGone(request, "/themes/default/bg.png");
  });
  test("/register.php（旧注册入口）→ 410", async ({ request }) => {
    await expectGone(request, "/register.php");
  });
  test("/post.php?action=reply（旧发帖入口）→ 410", async ({ request }) => {
    await expectGone(request, "/post.php?action=reply");
  });
  test("/rss.php（旧订阅入口）→ 410", async ({ request }) => {
    await expectGone(request, "/rss.php");
  });
  test("/sitemap.php（旧 sitemap 入口）→ 410（新站 sitemap 由 /sitemap.xml 应用路由伺服）", async ({
    request,
  }) => {
    await expectGone(request, "/sitemap.php");
  });

  // ---------- 新站路由透传（不被映射表拦截） ----------
  test("新站 /sitemap.xml 不被旧 .php 410 规则误伤（透传反代）", async ({ request }) => {
    const res = await request.get(`${BASE}/sitemap.xml`);
    expect(res.status()).toBe(502); // 无上游：能到反代即证明未被 map 拦截
  });
  test("新站 /robots.txt 透传反代（旧 robots 语义由应用层接管）", async ({ request }) => {
    const res = await request.get(`${BASE}/robots.txt`);
    expect(res.status()).toBe(502);
  });
});
