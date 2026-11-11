import type { MotionEngine } from "./runtime";
import { motionPathname } from "./resolver";
import type { MotionUpdateTicket } from "./updates";
import type {
  MotionDriver,
  MotionIntent,
  MotionPageDeclaration,
  MotionSkipReason,
  MotionTarget,
  MotionUpdate,
} from "./types";

export interface MotionPlayOptions {
  readonly driver?: MotionDriver;
  readonly reducedMotion?: boolean;
  readonly page?: MotionPageDeclaration;
  readonly target?: MotionTarget;
}
export type MotionPlayResult =
  | { readonly id: number; readonly status: "finished" }
  | { readonly id: number; readonly status: "skipped"; readonly reason: MotionSkipReason };

export async function playMotion(
  engine: MotionEngine,
  update: MotionUpdate,
  intent: MotionIntent,
  options: MotionPlayOptions,
  reserveUpdate: (update: MotionUpdate) => MotionUpdateTicket,
  begin: (claim: (id: number) => void, handoff: () => void) => number,
): Promise<MotionPlayResult> {
  let id = 0;
  let reason: MotionSkipReason | undefined;
  let endPlay!: () => void;
  const terminal = new Promise<void>((resolve) => {
    endPlay = resolve;
  });
  const unregister = engine.register(
    { level: "global" },
    {
      onSkip(context, skipped) {
        if (context.id === id) {
          reason = skipped;
          endPlay();
        }
      },
      onFinish(context) {
        if (context.id === id) endPlay();
      },
    },
  );
  const ticket = reserveUpdate(update);
  let updated: Promise<void> | undefined;
  function updateOnce(): Promise<void> {
    updated ??= ticket.request().catch((error: unknown) => {
      engine.skip(id, "update-error");
      throw error;
    });
    // 驱动可能丢弃更新的 Promise，但业务错误仍须由 play 的调用方接收。
    void updated.catch(() => {});
    return updated;
  }
  const result = (): MotionPlayResult =>
    reason ? { id, status: "skipped", reason } : { id, status: "finished" };

  try {
    id = begin(
      (claimed) => {
        id = claimed;
      },
      () => {
        void updateOnce();
      },
    );
    const session = engine.current;
    if (session?.id !== id) reason = "interrupted";
    else if (!engine.config.enabled) reason = "disabled";
    else if (session.cancelled) reason = "cancelled";
    else if (intent.source === "history") reason = "history";
    else if (motionPathname(intent.from) === motionPathname(intent.to)) reason = "same-page";
    else if (options.reducedMotion) reason = "reduced-motion";
    else if (!options.driver) reason = "no-api";
    if (reason) {
      engine.skip(id, reason);
      await updateOnce();
      return result();
    }

    const plan = engine.commit(id, options.page);
    if (!plan) {
      reason ??= "interrupted";
      await updateOnce();
      return result();
    }
    try {
      const transition = options.driver!.start(updateOnce, plan);
      const ready = Promise.resolve(transition.ready).then(
        () => engine.ready(id),
        () => engine.skip(id, "transition-error"),
      );
      const finished = Promise.resolve(transition.finished).catch(() => {
        engine.skip(id, "transition-error");
      });
      await Promise.race([Promise.all([ready, finished]), terminal]);
    } catch {
      engine.skip(id, "transition-error");
    }
    await updateOnce();
    if (!reason) engine.finish(id);
    return result();
  } catch (error) {
    // 开始或定稿失败时先移除未执行预约，后续导航不得重放这个已拒绝的操作。
    ticket.discard();
    engine.skip(id, "transition-error");
    throw error;
  } finally {
    ticket.discard();
    unregister();
  }
}
