/**
 * 批量任务调度器：固定并发数 + 单任务取消。
 *
 * 与 Electron 无关，主进程与 CLI 都能用。
 */

export interface BatchTask<T> {
  id: string;
  /** 真正的工作函数，收到本任务专属的 AbortSignal */
  run: (signal: AbortSignal) => Promise<T>;
}

export interface BatchHooks<T> {
  onStart?(id: string): void;
  onDone?(id: string, result: T): void;
  onError?(id: string, error: Error): void;
  onCancelled?(id: string): void;
  /** 每个任务结束（成功/失败/取消）后触发，便于刷新整体进度 */
  onSettled?(): void;
}

export class BatchRunner<T> {
  private pending: BatchTask<T>[] = [];
  private readonly active = new Map<string, AbortController>();
  private concurrency = 2;

  constructor(private readonly hooks: BatchHooks<T> = {}) {}

  /** 当前排队 + 运行中的任务数。 */
  get size(): number {
    return this.pending.length + this.active.size;
  }

  get running(): number {
    return this.active.size;
  }

  /** 追加任务并开始调度。 */
  start(tasks: BatchTask<T>[], concurrency?: number): void {
    if (concurrency && concurrency > 0) {
      this.concurrency = Math.min(8, Math.max(1, Math.floor(concurrency)));
    }
    this.pending.push(...tasks);
    this.pump();
  }

  /** 取消单个任务（排队中的直接移出，运行中的中止）。 */
  cancel(id: string): boolean {
    const controller = this.active.get(id);
    if (controller) {
      controller.abort();
      return true;
    }
    const idx = this.pending.findIndex((task) => task.id === id);
    if (idx >= 0) {
      this.pending.splice(idx, 1);
      this.hooks.onCancelled?.(id);
      this.hooks.onSettled?.();
      return true;
    }
    return false;
  }

  /** 取消全部。 */
  cancelAll(): void {
    const queued = this.pending;
    this.pending = [];
    for (const task of queued) this.hooks.onCancelled?.(task.id);
    for (const controller of this.active.values()) {
      try {
        controller.abort();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 调整并发数（立即生效）。 */
  setConcurrency(value: number): void {
    if (!value || value <= 0) return;
    this.concurrency = Math.min(8, Math.max(1, Math.floor(value)));
    this.pump();
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length) {
      const task = this.pending.shift();
      if (!task) break;

      const controller = new AbortController();
      this.active.set(task.id, controller);
      this.hooks.onStart?.(task.id);

      void Promise.resolve()
        .then(() => task.run(controller.signal))
        .then(
          (result) => {
            this.active.delete(task.id);
            try {
              this.hooks.onDone?.(task.id, result);
            } catch (err) {
              console.error('任务完成回调异常：', err);
            }
          },
          (error: unknown) => {
            this.active.delete(task.id);
            if (controller.signal.aborted) {
              this.hooks.onCancelled?.(task.id);
            } else {
              this.hooks.onError?.(task.id, error as Error);
            }
          },
        )
        .finally(() => {
          try {
            this.hooks.onSettled?.();
          } catch {
            /* 忽略 */
          }
          this.pump();
        });
    }
  }
}
