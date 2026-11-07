import Link from "next/link";
import { AdminFlash } from "@/components/admin/admin-flash";
import { SubmitButton } from "@/components/ui/submit-button";
import { requireNotInstalled } from "@/lib/install/guard";
import {
  installProgress,
  nodeVersionOk,
  storageWritable,
  REQUIRED_NODE_MAJOR,
  stepOfProgress,
} from "@/lib/install/progress";
import { installConfigFromEnv, INSTALL_THEME_PACKS } from "@/lib/install/schema";
import { decodeInstallDraft, type InstallDraft } from "./draft";
import { installAdminAction, installDatabaseAction, installSiteAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "安装向导" };

const FIELD = "w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-sm";
const LABEL = "grid min-w-0 gap-1 text-sm";

const STEP_TITLES = ["环境与数据库", "站点设置", "管理员账号", "完成"] as const;

/** 错误码 ↔ 文案成对（G-15）：键类型取自管线的失败码集合；漏配靠 install-entry/page 测试约束 */
const ERR_TEXT: Record<string, string> = {
  "db-unreachable": "无法连接数据库：请核对主机、端口、用户与口令后重试。",
  "db-create-denied": "创建数据库失败（多为账号缺少 CREATE 权限）：请手动创建数据库后重试。",
  "bootstrap-failed": "建表或系统种子失败：请查看服务端日志后重试（可安全重跑）。",
  "users-exist": "数据库已有用户，拒绝写入（防重装保护）：如需重装请先清空用户数据或用 CLI。",
  "already-installed": "站点已完成安装：本向导已关闭（刷新将回到首页）。",
  "invalid-config": "提交的配置有格式问题：请按下方字段提示修正后重试。",
};

function stepBadge(n: number, current: number, done: boolean) {
  const cls =
    n === current
      ? "bg-primary text-primary-foreground"
      : done
        ? "bg-success/10 text-success"
        : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex size-6 items-center justify-center rounded text-xs font-medium ${cls}`}
    >
      {n}
    </span>
  );
}

export default async function InstallPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string; err?: string; draft?: string; issues?: string }>;
}) {
  await requireNotInstalled(); // 入口守卫（D2）：已安装即 404——必须是本页第一个 await（见 install-entry-guard）

  const sp = await searchParams;
  const progress = await installProgress();
  const current = (() => {
    const requested = Number(sp.step);
    if (requested >= 1 && requested <= 4) return requested as 1 | 2 | 3 | 4;
    return stepOfProgress(progress);
  })();
  const draft: InstallDraft = decodeInstallDraft(sp.draft);
  let fieldIssues: Record<string, string> = {};
  try {
    if (sp.issues)
      fieldIssues = JSON.parse(decodeURIComponent(sp.issues)) as Record<string, string>;
  } catch {
    fieldIssues = {};
  }
  const errText = sp.err ? ERR_TEXT[sp.err] : undefined;
  const envDb = installConfigFromEnv().db;
  const nodeOk = nodeVersionOk();
  const storageOk = await storageWritable();

  const dbDraft = {
    host: draft.db?.host ?? envDb.host,
    port: draft.db?.port ?? String(envDb.port),
    user: draft.db?.user ?? envDb.user,
    password: draft.db?.password ?? envDb.password,
    name: draft.db?.name ?? envDb.name,
  };
  const issueOf = (key: string) => fieldIssues[key];

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="text-xl font-bold tracking-tight">FunWind 安装向导</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        零数据从零安装：连接数据库 → 建表 → 站点设置 → 创建管理员。安装完成后本向导自动关闭。
      </p>
      <ol className="mt-4 flex flex-wrap items-center gap-2 text-sm">
        {STEP_TITLES.map((title, i) => (
          <li key={title} className="flex items-center gap-1.5">
            {stepBadge(i + 1, current, i + 1 < current)}
            <span className={i + 1 === current ? "font-medium" : "text-muted-foreground"}>
              {title}
            </span>
            {i < STEP_TITLES.length - 1 && <span className="text-muted-foreground">→</span>}
          </li>
        ))}
      </ol>

      {sp.err && (
        <div className="mt-4">
          <AdminFlash kind="error">{errText ?? "安装失败，请重试。"}</AdminFlash>
        </div>
      )}

      {current === 1 && (
        <section className="mt-6 grid gap-4">
          <div className="rounded-xl border bg-card p-4 text-sm">
            <h2 className="font-semibold">环境自检</h2>
            <ul className="mt-2 grid gap-1 text-muted-foreground">
              <li>
                Node 版本：{process.version}
                {nodeOk
                  ? "（满足要求）"
                  : `（低于要求的 v${REQUIRED_NODE_MAJOR}，可继续但不受支持）`}
              </li>
              <li>数据目录可写：{storageOk ? "是" : "否——请检查 STORAGE_DIR 的磁盘权限"}</li>
              <li>
                数据目录：
                {process.env.STORAGE_DIR ? "已由 STORAGE_DIR 指定" : "默认（仓库根 storage/）"}
              </li>
            </ul>
          </div>
          <form action={installDatabaseAction} className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              数据库连接信息预填自
              .env（NEW_DB_*）。安装只能写入本实例配置的库——修改连接信息会校验失败。
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={LABEL}>
                主机
                <input name="host" defaultValue={dbDraft.host} className={FIELD} />
                {issueOf("db.host") && (
                  <span className="text-destructive">{issueOf("db.host")}</span>
                )}
              </label>
              <label className={LABEL}>
                端口
                <input
                  name="port"
                  inputMode="numeric"
                  defaultValue={dbDraft.port}
                  className={FIELD}
                />
                {issueOf("db.port") && (
                  <span className="text-destructive">{issueOf("db.port")}</span>
                )}
              </label>
              <label className={LABEL}>
                用户
                <input name="user" defaultValue={dbDraft.user} className={FIELD} />
              </label>
              <label className={LABEL}>
                口令
                <input
                  name="password"
                  type="password"
                  defaultValue={dbDraft.password}
                  className={FIELD}
                />
              </label>
              <label className={`${LABEL} sm:col-span-2`}>
                数据库名
                <input name="name" defaultValue={dbDraft.name} className={FIELD} />
                {issueOf("db.name") && (
                  <span className="text-destructive">{issueOf("db.name")}</span>
                )}
              </label>
            </div>
            {issueOf("db") && (
              <p role="alert" className="text-sm [overflow-wrap:anywhere] text-destructive">
                {issueOf("db")}
              </p>
            )}
            <div>
              <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                测试连接并建表
              </SubmitButton>
            </div>
          </form>
        </section>
      )}

      {current === 2 && (
        <form action={installSiteAction} className="mt-6 grid gap-3">
          <label className={LABEL}>
            站点名称
            <input
              name="name"
              required
              maxLength={40}
              defaultValue={draft.site?.name ?? ""}
              className={FIELD}
            />
            {issueOf("site.name") && (
              <span className="text-destructive">{issueOf("site.name")}</span>
            )}
          </label>
          <label className={LABEL}>
            一句话介绍
            <input
              name="tagline"
              maxLength={80}
              defaultValue={draft.site?.tagline ?? ""}
              className={FIELD}
            />
          </label>
          <label className={LABEL}>
            站点 URL
            <input
              name="url"
              inputMode="url"
              defaultValue={draft.site?.url ?? "http://127.0.0.1:3100"}
              className={FIELD}
            />
            <span className="text-xs text-muted-foreground">
              与 .env 的 APP_URL 保持一致（影响 Cookie Secure 与邮件链接）。
            </span>
            {issueOf("site.url") && <span className="text-destructive">{issueOf("site.url")}</span>}
          </label>
          <label className={LABEL}>
            默认主题
            <select name="themePack" defaultValue={draft.themePack ?? "default"} className={FIELD}>
              {INSTALL_THEME_PACKS.map((id) => (
                <option key={id} value={id}>
                  {id === "default" ? "现代浅色（default）" : "复刻·青翼2010（qy2010）"}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="grid gap-2 text-sm">
            <legend className="mb-1 font-medium">注册模式</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="registrationMode"
                value="invite"
                defaultChecked={(draft.registration?.mode ?? "invite") === "invite"}
              />
              仅邀请——持有效邀请码可注册（默认）
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="registrationMode"
                value="open"
                defaultChecked={draft.registration?.mode === "open"}
              />
              开放注册——任何人凭邮箱注册
            </label>
            <label className="flex items-center gap-2 pl-6">
              <input
                type="checkbox"
                name="verifyEmail"
                defaultChecked={draft.registration?.verifyEmail === true}
              />
              开放注册需验证邮箱
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="registrationMode"
                value="closed"
                defaultChecked={draft.registration?.mode === "closed"}
              />
              暂不开放——双关（安装后可在后台再开）
            </label>
          </fieldset>
          <div>
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              保存站点设置
            </SubmitButton>
          </div>
        </form>
      )}

      {current === 3 && (
        <form action={installAdminAction} className="mt-6 grid gap-3">
          <p className="text-sm text-muted-foreground">
            管理员创建后立即可登录（不要求邮箱验证）；请妥善保管口令。
          </p>
          <label className={LABEL}>
            用户名
            <input
              name="username"
              required
              maxLength={20}
              defaultValue={draft.admin?.username ?? ""}
              className={FIELD}
            />
            <span className="text-xs text-muted-foreground">
              2-20 位（中文/字母/数字/下划线），管理员相关词被保留
            </span>
            {issueOf("admin.username") && (
              <span className="text-destructive">{issueOf("admin.username")}</span>
            )}
          </label>
          <label className={LABEL}>
            邮箱
            <input
              name="email"
              type="email"
              required
              defaultValue={draft.admin?.email ?? ""}
              className={FIELD}
            />
            {issueOf("admin.email") && (
              <span className="text-destructive">{issueOf("admin.email")}</span>
            )}
          </label>
          <label className={LABEL}>
            密码（至少 8 位）
            <input
              name="password"
              type="password"
              required
              minLength={8}
              defaultValue={draft.admin?.password ?? ""}
              className={FIELD}
            />
            {issueOf("admin.password") && (
              <span className="text-destructive">{issueOf("admin.password")}</span>
            )}
          </label>
          <div>
            <SubmitButton className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
              创建管理员并完成安装
            </SubmitButton>
          </div>
        </form>
      )}

      {current === 4 && (
        <section className="mt-6 grid gap-4 text-sm">
          <div className="rounded-xl border border-success/30 bg-success/10 p-4" role="status">
            <h2 className="font-semibold text-success">安装完成 🎉</h2>
            <p className="mt-1">站点已就绪：用刚才创建的管理员登录，即可创建版块并开始发帖。</p>
          </div>
          <ul className="grid gap-2">
            <li>
              <Link
                href="/login?message=安装完成——请用管理员账号登录"
                className="text-primary underline underline-offset-2"
              >
                前往登录 →
              </Link>
            </li>
            <li>
              <a
                href="https://github.com/SkyJourney/FunWind/blob/main/migration/README.md"
                className="text-primary underline underline-offset-2"
              >
                从青翼 phpwind 导入存量论坛（可选，migration/ 指南）→
              </a>
            </li>
            <li>
              <a
                href="https://github.com/SkyJourney/FunWind#零数据部署"
                className="text-primary underline underline-offset-2"
              >
                部署后检查清单（README「零数据部署」章节）→
              </a>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
