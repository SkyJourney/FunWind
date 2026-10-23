import { Archive, ArrowRight, Bell, CreditCard, LogOut, Settings, User } from "lucide-react";
import type { Metadata } from "next";
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

const PRIMITIVES = [
  { label: "cyan 500", value: "var(--fw-cyan-500)" },
  { label: "cyan 700", value: "var(--fw-cyan-700)" },
  { label: "teal 500", value: "var(--fw-teal-500)" },
  { label: "green 500", value: "var(--fw-green-500)" },
  { label: "amber 500", value: "var(--fw-amber-500)" },
  { label: "red 500", value: "var(--fw-red-500)" },
  { label: "blue 500", value: "var(--fw-blue-500)" },
  { label: "gray 100", value: "var(--fw-gray-100)" },
  { label: "gray 500", value: "var(--fw-gray-500)" },
  { label: "gray 900", value: "var(--fw-gray-900)" },
];

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
  return (
    <main className="mx-auto max-w-5xl space-y-12 px-4 py-10 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">FunWind 设计令牌</h1>
          <p className="mt-1 text-muted-foreground">
            三层令牌 · M1 基线 —— 原子层（primitives）→ 语义层（semantic）→ 主题包（default / dark）
          </p>
        </div>
        <ThemeSwitcher />
      </header>

      {/* 槽位宿主：M2 演示（home.after-header 当前无注册渲染器，渲染 null） */}
      <Slot name="home.after-header" />

      <Section id="colors" title="1. 色彩" subtitle="原子层色板采样；组件经由语义令牌引用（下排）">
        <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
          {PRIMITIVES.map((c) => (
            <div key={c.label} className="space-y-1 text-center">
              <div className="h-10 rounded-md border" style={{ background: c.value }} />
              <div className="text-xs text-muted-foreground">{c.label}</div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {[
            ["primary", "bg-primary text-primary-foreground"],
            ["secondary", "bg-secondary text-secondary-foreground"],
            ["muted", "bg-muted text-muted-foreground"],
            ["accent", "bg-accent text-accent-foreground"],
            ["destructive", "bg-destructive text-destructive-foreground"],
            ["card / 边框", "bg-card text-card-foreground border"],
            ["background", "bg-background text-foreground border"],
          ].map(([name, cls]) => (
            <div key={name} className={`rounded-lg px-3 py-4 text-center text-sm ${cls}`}>
              {name}
            </div>
          ))}
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

      <Section id="radius" title="3. 圆角与阴影" subtitle="4/8/12/16 圆角阶 + 三档阴影">
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
        id="components"
        title="4. 组件样例（shadcn/ui 首批 10 件）"
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
          M1 · 工程骨架 —— 主题包 <code className="text-xs">default</code> 与{" "}
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
