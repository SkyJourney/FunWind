import type { MotionUpdate } from "./types";

export interface MotionUpdateTicket {
  request(): Promise<void>;
  discard(): void;
}

/** 预留回调的入队顺序，不串行等待业务 Promise：更新内部嵌套 play 不能互相等待成死锁。 */
export function createMotionUpdates() {
  const pending = new Set<() => void>();
  return (update: MotionUpdate): MotionUpdateTicket => {
    let result: Promise<void> | undefined;
    let discarded = false;
    const enqueue = () => {
      result = Promise.resolve().then(update);
      void result.catch(() => {});
    };
    pending.add(enqueue);
    return {
      request() {
        if (discarded) return Promise.reject(new Error("动效更新预约已释放"));
        if (!result) {
          for (const earlier of pending) {
            pending.delete(earlier);
            earlier();
            if (earlier === enqueue) break;
          }
        }
        return result!;
      },
      discard() {
        if (result) return;
        pending.delete(enqueue);
        discarded = true;
      },
    };
  };
}
