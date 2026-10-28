/** 批量调度器：并发上限、单任务取消、全部取消、并发数热调整。 */
import { describe, expect, it, vi } from 'vitest';

import { BatchRunner } from '../src/core/pipeline/batch.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BatchRunner', () => {
  it('同时运行的任务数不超过并发上限', async () => {
    let concurrent = 0;
    let peak = 0;
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();

    const runner = new BatchRunner<number>();
    const tasks = Array.from({ length: 6 }, (_, i) => {
      const gate = deferred<void>();
      gates.set(`t${i}`, gate);
      return {
        id: `t${i}`,
        run: async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await gate.promise;
          concurrent -= 1;
          return i;
        },
      };
    });

    runner.start(tasks, 2);
    await tick();
    expect(runner.running).toBe(2);
    expect(peak).toBe(2);

    // 逐个放行，并发始终不超过 2
    for (let i = 0; i < 6; i += 1) {
      gates.get(`t${i}`)?.resolve();
      await tick();
      await tick();
    }
    expect(peak).toBe(2);
    expect(runner.size).toBe(0);
  });

  it('按顺序回调 onStart / onDone', async () => {
    const events: string[] = [];
    const runner = new BatchRunner<string>({
      onStart: (id) => events.push(`start:${id}`),
      onDone: (id, value) => events.push(`done:${id}:${value}`),
    });

    runner.start(
      [
        { id: 'a', run: async () => 'A' },
        { id: 'b', run: async () => 'B' },
      ],
      1,
    );
    await tick();
    await tick();
    expect(events).toEqual(['start:a', 'done:a:A', 'start:b', 'done:b:B']);
  });

  it('取消运行中的任务会触发 onCancelled 而不是 onError', async () => {
    const onError = vi.fn();
    const onCancelled = vi.fn();
    const gate = deferred<void>();

    const runner = new BatchRunner<void>({ onError, onCancelled });
    runner.start(
      [
        {
          id: 'slow',
          run: async (signal) => {
            await new Promise<void>((resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')));
              gate.promise.then(resolve);
            });
          },
        },
      ],
      1,
    );
    await tick();
    expect(runner.cancel('slow')).toBe(true);
    await tick();
    await tick();
    expect(onCancelled).toHaveBeenCalledWith('slow');
    expect(onError).not.toHaveBeenCalled();
  });

  it('取消排队中的任务不会真正执行', async () => {
    const ran: string[] = [];
    const onCancelled = vi.fn();
    const gate = deferred<void>();

    const runner = new BatchRunner<void>({ onCancelled });
    runner.start(
      [
        { id: 'first', run: async () => { await gate.promise; } },
        { id: 'second', run: async () => { ran.push('second'); } },
      ],
      1,
    );
    await tick();
    expect(runner.cancel('second')).toBe(true);
    gate.resolve();
    await tick();
    await tick();
    expect(ran).toEqual([]);
    expect(onCancelled).toHaveBeenCalledWith('second');
  });

  it('cancelAll 会清空队列并中止运行中的任务', async () => {
    const onCancelled = vi.fn();
    const runner = new BatchRunner<void>({ onCancelled });
    runner.start(
      Array.from({ length: 4 }, (_, i) => ({
        id: `t${i}`,
        run: async (signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      })),
      2,
    );
    await tick();
    runner.cancelAll();
    await tick();
    await tick();
    expect(onCancelled).toHaveBeenCalledTimes(4);
    expect(runner.size).toBe(0);
  });

  it('任务抛错时走 onError', async () => {
    const onError = vi.fn();
    const runner = new BatchRunner<void>({ onError });
    runner.start([{ id: 'bad', run: async () => { throw new Error('boom'); } }], 1);
    await tick();
    await tick();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![1].message).toBe('boom');
  });

  it('并发数可热调整', async () => {
    let concurrent = 0;
    let peak = 0;
    const gates: ReturnType<typeof deferred<void>>[] = [];

    const runner = new BatchRunner<void>();
    const tasks = Array.from({ length: 4 }, (_, i) => {
      const gate = deferred<void>();
      gates.push(gate);
      return {
        id: `t${i}`,
        run: async () => {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          await gate.promise;
          concurrent -= 1;
        },
      };
    });

    runner.start(tasks, 1);
    await tick();
    expect(peak).toBe(1);
    runner.setConcurrency(3);
    await tick();
    expect(peak).toBe(3);
    gates.forEach((g) => g.resolve());
    await tick();
    await tick();
  });
});
