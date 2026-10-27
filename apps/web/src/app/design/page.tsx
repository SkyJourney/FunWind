import { Archive, ArrowRight, Bell, CreditCard, LogOut, Settings, User } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isDevEnv } from "@/lib/dev-only";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Slot } from "@/modules/kernel/slot";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const metadata: Metadata = { title: "设计令牌" };

// Slot 读库（模块横幅），演示页接受动态渲染（M3 建页时统一定缓存策略）
export const dynamic = "force-dynamic";

const BRAND_SCALE = [
  ["50", "#ecfeff"],
  ["100", "#cffafe"],
  ["200", "#a5f3fc"],
  ["300", "#67e8f9"],
  ["400", "#22d3ee"],
  ["500", "#06b6d4"],
  ["600", "#0891b2"],
  ["700", "#0e7490"],
  ["800", "#155e75"],
  ["900", "#164e63"],
  ["950", "#083344"],
] as const;

const GRAY_SCALE = [
  ["50", "#f8fafc"],
  ["100", "#f1f5f9"],
  ["200", "#e2e8f0"],
  ["300", "#cbd5e1"],
  ["400", "#94a3b8"],
  ["500", "#64748b"],
  ["600", "#475569"],
  ["700", "#334155"],
  ["800", "#1e293b"],
  ["900", "#0f172a"],
  ["950", "#020617"],
] as const;

const SEMANTIC_ACCENTS = [
  ["success / green-600", "var(--fw-green-600)"],
  ["warning / amber-600", "var(--fw-amber-600)"],
  ["info / blue-500", "var(--fw-blue-500)"],
  ["destructive / red-600", "var(--fw-red-600)"],
] as const;

const ROLE_COLORS = [
  ["--primary", "品牌青 700：主按钮 / 链接 / 当前态"],
  ["--primary-foreground", "主按钮文字（白）"],
  ["--accent", "选中底 / hover 面（青 50）"],
  ["--secondary", "次要按钮面（灰 100）"],
  ["--muted", "弱化面 / 代码底（灰 100）"],
  ["--muted-foreground", "次要文字（灰 500）"],
  ["--border / --input", "描边 / 输入框边（灰 200）"],
  ["--ring", "焦点环（青 500）"],
  ["--background / --card", "页面底（灰 50）/ 卡片面（白）"],
] as const;

const SPACE_STEPS = [
  ["--fw-space-1", "0.25rem"],
  ["--fw-space-2", "0.5rem"],
  ["--fw-space-3", "0.75rem"],
  ["--fw-space-4", "1rem"],
  ["--fw-space-6", "1.5rem"],
  ["--fw-space-8", "2rem"],
  ["--fw-space-12", "3rem"],
  ["--fw-space-16", "4rem"],
] as const;

const MOTION_TOKENS = [
  ["--fw-dur-fast", "150ms", "L1 微交互（按压/开关）"],
  ["--fw-dur-base", "250ms", "常规淡入位移 / 弹层"],
  ["--fw-dur-slow", "400ms", "页面级方向性过渡"],
  ["--fw-dur-spring", "500ms", "过冲回弹 / 触点扩散"],
  ["--fw-ease-out", "曲线", "进场：加速度切入缓停"],
  ["--fw-ease-spring", "曲线", "刹车过冲回弹"],
  ["--fw-ease-exit", "曲线", "退场加速离场"],
] as const;

const TEXT_SIZES = [
  ["--fw-text-xs", "12px"],
  ["--fw-text-sm", "14px"],
  ["--fw-text-base", "16px"],
  ["--fw-text-lg", "18px"],
  ["--fw-text-xl", "24px"],
  ["--fw-text-2xl", "30px"],
  ["--fw-text-3xl", "36px"],
] as const;

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

export default function TokensPage() {
  // 设计令牌页是内部工具：生产环境不可达（统一守卫见 lib/dev-only.ts）
  if (!isDevEnv()) notFound();
  return (
    <main className="mx-auto max-w-5xl space-y-12 px-4 py-10 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">FunWind 设计令牌</h1>
          <p className="mt-1 text-muted-foreground">
            三层令牌 · M1 基线 —— 原子层（primitives）→ 语义层（semantic）→ 主题包（default /
            dark）·{" "}
            <Link href="/design/motion" className="text-primary hover:underline">
              动效演示（S4）→
            </Link>
          </p>
        </div>
        <ThemeSwitcher />
      </header>

      {/* 槽位宿主：M2 演示（home.after-header 当前无注册渲染器，渲染 null） */}
      <Slot name="home.after-header" />

      <Section
        id="colors"
        title="1. 色彩（S3 定稿）"
        subtitle="品牌青 + 冷调中性灰 + 语义色；组件一律经由语义令牌引用，切主题只换变量"
      >
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-sm font-medium">
              品牌青 · --fw-cyan-*（--primary 取 700，配白字对比 4.8:1）
            </p>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-11">
              {BRAND_SCALE.map(([step, hex]) => (
                <div key={step} className="space-y-1 text-center">
                  <div className="h-10 rounded-md border" style={{ background: hex }} />
                  <div className="text-xs text-muted-foreground">{step}</div>
                  <div className="hidden text-[10px] text-muted-foreground/70 sm:block">{hex}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">
              中性灰 · --fw-gray-*（冷调，页面底 50 / 卡片白 / 暗色端 950）
            </p>
            <div className="grid grid-cols-6 gap-2 sm:grid-cols-11">
              {GRAY_SCALE.map(([step, hex]) => (
                <div key={step} className="space-y-1 text-center">
                  <div className="h-10 rounded-md border" style={{ background: hex }} />
                  <div className="text-xs text-muted-foreground">{step}</div>
                  <div className="hidden text-[10px] text-muted-foreground/70 sm:block">{hex}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">
              语义色（success / warning / info / destructive）
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {SEMANTIC_ACCENTS.map(([name, value]) => (
                <div key={name} className="flex items-center gap-2 rounded-lg border p-2">
                  <span className="size-8 rounded-md" style={{ background: value }} />
                  <span className="text-xs text-muted-foreground">{name}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">
              语义角色（组件唯一允许引用的一层；下方色块即真实变量值）
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ROLE_COLORS.map(([token, usage]) => (
                <div key={token} className="flex items-center gap-3 rounded-lg border p-2.5">
                  <span
                    className="size-8 shrink-0 rounded-md border"
                    style={{ background: `var(${token.split(" /")[0]})` }}
                  />
                  <div className="min-w-0">
                    <code className="text-xs">{token}</code>
                    <p className="truncate text-xs text-muted-foreground">{usage}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section id="type" title="2. 字阶" subtitle="12–36px 六档 + 展示级，中文/日文系统字体栈">
        <div className="space-y-2 rounded-xl border bg-card p-6">
          {TEXT_SIZES.map(([token, px]) => (
            <div key={token} className="flex items-baseline gap-4">
              <code className="w-32 shrink-0 text-xs text-muted-foreground">{token}</code>
              <span style={{ fontSize: `var(${token})`, lineHeight: 1.3 }}>青翼字幕组 FunWind</span>
              <code className="ml-auto hidden text-xs text-muted-foreground sm:inline">{px}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="space"
        title="3. 间距"
        subtitle="4px 基数八档（组件内边距/堆叠间距一律取档，不裸写）"
      >
        <div className="space-y-2 rounded-xl border bg-card p-6">
          {SPACE_STEPS.map(([token, size]) => (
            <div key={token} className="flex items-center gap-4">
              <code className="w-32 shrink-0 text-xs text-muted-foreground">{token}</code>
              <div className="h-3 rounded bg-primary/70" style={{ width: `var(${token})` }} />
              <code className="ml-auto text-xs text-muted-foreground">{size}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="radius"
        title="4. 圆角与阴影"
        subtitle="4/8/12/16 圆角阶 + 三档阴影（静止 1 / 悬浮 2 / 弹层 3）"
      >
        <div className="flex flex-wrap gap-4">
          {["sm", "md", "lg", "xl"].map((r) => (
            <div key={r} className="text-center">
              <div
                className="size-16 border bg-card"
                style={{ borderRadius: `var(--fw-radius-${r})` }}
              />
              <code className="text-xs text-muted-foreground">radius-{r}</code>
            </div>
          ))}
          {["1", "2", "3"].map((s) => (
            <div key={s} className="text-center">
              <div
                className="size-16 rounded-lg bg-card"
                style={{ boxShadow: `var(--shadow-${s})` }}
              />
              <code className="text-xs text-muted-foreground">shadow-{s}</code>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="motion"
        title="5. 动效令牌"
        subtitle="时长四档 + 曲线三支（S4 定稿）；可玩示例见 /design/motion"
      >
        <div className="rounded-xl border bg-card">
          {MOTION_TOKENS.map(([token, value, usage]) => (
            <div
              key={token}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b px-4 py-2.5 last:border-b-0"
            >
              <code className="w-36 shrink-0 text-xs">{token}</code>
              <span className="w-16 shrink-0 text-xs text-muted-foreground">{value}</span>
              <span className="text-sm text-muted-foreground">{usage}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="components"
        title="6. 组件样例（shadcn/ui 首批 10 件）"
        subtitle="全部经由语义令牌着色，随主题即时切换"
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>按钮与徽章</CardTitle>
              <CardDescription>Button 全变体 · Badge 语义色</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button>主要操作</Button>
                <Button variant="secondary">次要</Button>
                <Button variant="outline">描边</Button>
                <Button variant="ghost">幽灵</Button>
                <Button variant="destructive">危险</Button>
                <Button variant="link">链接</Button>
                <Button disabled>禁用</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm">小号</Button>
                <Button size="lg">大号</Button>
                <Button size="icon" aria-label="通知">
                  <Bell className="size-4" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge>默认</Badge>
                <Badge variant="secondary">次要</Badge>
                <Badge variant="outline">描边</Badge>
                <Badge variant="destructive">危险</Badge>
              </div>
            </CardContent>
            <CardFooter className="text-sm text-muted-foreground">
              输入框 → <Input className="ml-2 w-40" placeholder="请输入…（Input）" />
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>弹层组件</CardTitle>
              <CardDescription>Dialog / DropdownMenu / Tabs（Radix 行为）</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline">打开 Dialog</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>确认重置密码？</DialogTitle>
                    <DialogDescription>
                      旧论坛密码不可迁移，重置链接将发送到注册邮箱。
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="ghost">取消</Button>
                    <Button>发送邮件</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline">
                    <Avatar className="size-5">
                      <AvatarFallback>翼</AvatarFallback>
                    </Avatar>
                    账户菜单
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  <DropdownMenuLabel>我的账户</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem>
                    <User className="mr-2 size-4" />
                    个人资料
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Settings className="mr-2 size-4" />
                    设置
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <CreditCard className="mr-2 size-4" />
                    青翼币
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Archive className="mr-2 size-4" />
                    存档
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive">
                    <LogOut className="mr-2 size-4" />
                    退出登录
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Tabs defaultValue="hot">
                <TabsList>
                  <TabsTrigger value="hot">热门</TabsTrigger>
                  <TabsTrigger value="new">最新</TabsTrigger>
                  <TabsTrigger value="digest">精华</TabsTrigger>
                </TabsList>
                <TabsContent value="hot">
                  <Skeleton className="h-16 w-full" />
                </TabsContent>
                <TabsContent value="new">
                  <Skeleton className="h-16 w-full" />
                </TabsContent>
                <TabsContent value="digest">
                  <Skeleton className="h-16 w-full" />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Slot name="home.footer-notice" />

      <footer className="flex items-center justify-between border-t pt-6 text-sm text-muted-foreground">
        <span>
          M10.5 · S3 色彩定稿 —— 主题包 <code className="text-xs">default</code> 与{" "}
          <code className="text-xs">dark</code> 已就绪，「复刻·青翼2010」于 M11 交付
        </span>
        <a
          className="inline-flex items-center gap-1 text-primary hover:underline"
          href="https://github.com/shadcn-ui/ui"
          target="_blank"
          rel="noreferrer"
        >
          docs <ArrowRight className="size-3" />
        </a>
      </footer>
    </main>
  );
}
