"use client";

import { useState } from "react";
import { Heart, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { captureTransitionOrigin, withViewTransition } from "@/lib/motion/view-transition";

/**
 * S4 四级动效演示（客户端岛）：仅用令牌时长/曲线；全部只动 transform/opacity。
 */

function Section({
  id,
  title,
  desc,
  children,
}: {
  id: string;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-3">
      <div>
        <h2 className="font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{desc}</p>
      </div>
      {children}
    </section>
  );
}

/** L1：按压与弹跳 */
function MicroDemo() {
  const [liked, setLiked] = useState(false);
  const [count, setCount] = useState(17);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button>按住我（scale 0.97）</Button>
      <Button variant="outline">outline 同款按压</Button>
      <Button
        variant={liked ? "default" : "outline"}
        onClick={() => {
          setLiked((v) => !v);
          setCount((c) => (liked ? c - 1 : c + 1));
        }}
        className="gap-1.5"
        aria-pressed={liked}
      >
        <Heart
          className="size-4 transition-transform duration-spring ease-spring"
          style={{ transform: liked ? "scale(1.25)" : "scale(1)" }}
          fill={liked ? "currentColor" : "none"}
        />
        赞 {count}
      </Button>
      <span className="text-sm text-muted-foreground">
        点「赞」看 spring 过冲回弹；按住任意按钮看按压反馈。
      </span>
    </div>
  );
}

/** L2：页面级方向性过渡（示意：真实作用于路由，见规范 §3.2） */
function DirectionalDemo() {
  const [screen, setScreen] = useState<0 | 1>(0);
  const [anim, setAnim] = useState("");
  const go = (next: 0 | 1, kind: "push" | "pop") => {
    const kf = kind === "push" ? "vt-push-in" : "vt-pop-in";
    setAnim("");
    requestAnimationFrame(() => {
      setScreen(next);
      setAnim(`${kf} var(--fw-dur-slow) var(--fw-ease-out) both`);
    });
  };
  return (
    <div className="flex items-center gap-4">
      <div className="relative h-44 w-64 overflow-hidden rounded-xl border bg-card">
        <div key={`${screen}-${anim}`} style={{ animation: anim || "none" }} className="p-4">
          {screen === 0 ? (
            <div className="space-y-2">
              <p className="font-semibold">列表页</p>
              <div className="h-3 w-3/4 rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted" />
              <div className="h-3 w-1/2 rounded bg-muted" />
            </div>
          ) : (
            <div className="space-y-2">
              <p className="font-semibold">详情页</p>
              <div className="h-20 rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted" />
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Button onClick={() => go(1, "push")}>前进 push（自右切入）</Button>
        <Button variant="outline" onClick={() => go(0, "pop")}>
          返回 pop（自左切入）
        </Button>
        <p className="text-xs text-muted-foreground">
          实际路由使用方向性进场，跨路由扩散尚未接线。
        </p>
      </div>
    </div>
  );
}

/** L3：触点扩散打开（卡片 → 详情，圆形 clip 自点击处展开） */
function ExpandDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card
        className="max-w-sm cursor-pointer transition-shadow duration-fast hover:shadow-2"
        onClick={(e) => {
          captureTransitionOrigin(e.clientX, e.clientY);
          void withViewTransition(() => setOpen(true), "expand");
        }}
      >
        <CardContent className="p-4">
          <p className="text-xs text-muted-foreground">动画·アニメ · 10月新番</p>
          <p className="mt-1 font-semibold">『虫师 续章』第 03 话 [1080p]</p>
          <p className="mt-1 text-sm text-muted-foreground">
            点击这张卡片 —— 从你点击的位置扩散打开详情
          </p>
        </CardContent>
      </Card>
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/95 p-6 backdrop-blur-sm">
          <div className="max-w-md space-y-3 text-center">
            <p className="text-xs text-muted-foreground">动画·アニメ · 10月新番</p>
            <h3 className="text-xl font-bold">『虫师 续章』第 03 话</h3>
            <p className="text-sm text-muted-foreground">
              这层「详情」是经由 View Transitions 从你点击的坐标圆形扩散打开的（clip-path 圆心 =
              --vt-x/--vt-y）。关闭走默认淡出。
            </p>
            <Button
              variant="outline"
              onClick={() => void withViewTransition(() => setOpen(false), "fade")}
            >
              <X className="size-4" /> 关闭
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** L4：进场编排（加速度切入 + stagger 错落） */
function StaggerDemo() {
  const [round, setRound] = useState(0);
  const items = [
    "『虫师 续章』第 03 话发布",
    "一周的朋友 BD 开箱",
    "10月新番吐槽楼",
    "站点维护公告",
    "OST 无损合集",
  ];
  return (
    <div className="space-y-3">
      <Button variant="outline" onClick={() => setRound((r) => r + 1)}>
        重放进场（stagger 50ms）
      </Button>
      <div key={round} className="grid max-w-md gap-2">
        {items.map((t, i) => (
          <div
            key={t}
            className="fw-enter rounded-lg border bg-card px-4 py-2.5 text-sm"
            style={{ animationDelay: `${i * 50}ms` }}
          >
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}

export function MotionDemo() {
  return (
    <div className="space-y-10">
      <Section
        id="l1"
        title="L1 · 微交互（150ms）"
        desc="所有可点元素都有按压反馈；状态切换用 spring 过冲。基类已全局生效（Button active:scale-0.97）。"
      >
        <MicroDemo />
      </Section>
      <Section
        id="l2"
        title="L2 · 页面级方向性过渡（400ms）"
        desc="左切进入、右切返回；实际路由使用 CSS 方向性进场。"
      >
        <DirectionalDemo />
      </Section>
      <Section
        id="l3"
        title="L3 · 触点扩散打开（spring 500ms）"
        desc="详情自点击处圆形展开（需要 Chrome/Edge/Safari 18+；其余浏览器自动降级为直接切换）。"
      >
        <ExpandDemo />
      </Section>
      <Section
        id="l4"
        title="L4 · 进场编排（250ms × stagger 50ms）"
        desc="列表首屏错落切入：fw-enter 类 + animationDelay；只做首屏，翻页不重复播。"
      >
        <StaggerDemo />
      </Section>
    </div>
  );
}
