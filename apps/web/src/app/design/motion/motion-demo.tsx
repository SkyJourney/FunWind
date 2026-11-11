"use client";

import { useState } from "react";
import { Heart, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  MotionList,
  MOTION_DIRECTIONS,
  playStateTransition,
  prefersReducedMotion,
} from "@/lib/motion";

/**
 * S4 四级动效演示（客户端岛，M15 Step 3 收编）：全部经引擎公开入口声明式接入，
 * 只动 transform/opacity，时长/曲线/位移/步长一律来自令牌层，不再裸写魔法数。
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

/** L2：页面级方向性过渡（示意：真实路由已由 M15 页面管线接管，见 motion-spec §6.2） */
function DirectionalDemo() {
  const [screen, setScreen] = useState<0 | 1>(0);
  const [anim, setAnim] = useState("");
  const go = (next: 0 | 1, direction: "push" | "pop") => {
    // 方向预设来自引擎单一事实源（关键帧名 + 令牌时长/曲线），不再裸写 vt-push-in 等演示遗留
    const enter = MOTION_DIRECTIONS[direction].enter;
    setAnim("");
    requestAnimationFrame(() => {
      setScreen(next);
      setAnim(
        enter && !prefersReducedMotion()
          ? `${enter.name} ${enter.duration} ${enter.easing} both`
          : "",
      );
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
          方向预设与令牌由引擎提供；真实路由切换见页面管线（/t、/a 试点）。
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
          // 引擎状态级驱动：显式传入触点圆心，reduce / 无 API 自动降级为直接切换
          void playStateTransition(() => setOpen(true), {
            kind: "expand",
            origin: { x: e.clientX, y: e.clientY },
          });
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
              这层「详情」是经由引擎状态级 View Transitions 从你点击的坐标圆形扩散打开的（clip-path
              圆心 = --vt-x/--vt-y）。关闭走默认淡出。
            </p>
            <Button
              variant="outline"
              onClick={() => void playStateTransition(() => setOpen(false), { kind: "fade" })}
            >
              <X className="size-4" /> 关闭
            </Button>
          </div>
        </div>
      )}
    </>
  );
}

/** L4：进场编排（加速度切入 + stagger 错落，声明式 MotionList） */
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
        重放进场（stagger 错落）
      </Button>
      <div key={round} className="grid max-w-md gap-2">
        <MotionList>
          {items.map((t) => (
            <div key={t} className="rounded-lg border bg-card px-4 py-2.5 text-sm">
              {t}
            </div>
          ))}
        </MotionList>
      </div>
    </div>
  );
}

export function MotionDemo() {
  return (
    <div className="space-y-10">
      <Section
        id="l1"
        title="L1 · 微交互（fast）"
        desc="所有可点元素都有按压反馈；状态切换用 spring 过冲。基类已全局生效（Button active:scale-0.97）。"
      >
        <MicroDemo />
      </Section>
      <Section
        id="l2"
        title="L2 · 页面级方向性过渡（slow）"
        desc="左切进入、右切返回；方向预设与令牌由引擎单一事实源提供。"
      >
        <DirectionalDemo />
      </Section>
      <Section
        id="l3"
        title="L3 · 触点扩散打开（spring）"
        desc="详情自点击处圆形展开（需要支持 View Transitions 的浏览器；其余自动降级为直接切换）。"
      >
        <ExpandDemo />
      </Section>
      <Section
        id="l4"
        title="L4 · 进场编排（base × stagger 步长）"
        desc="列表首屏错落切入：<MotionList> 声明式挂 fw-enter 并按令牌步长计算延迟；只做首屏，翻页不重复播。"
      >
        <StaggerDemo />
      </Section>
    </div>
  );
}
