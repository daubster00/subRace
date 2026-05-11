import { describe, it, expect, vi } from 'vitest';
import { createSingleFlight } from './single-flight';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSingleFlight', () => {
  it('진행 중인 호출이 있으면 중첩 호출을 즉시 드롭한다', async () => {
    const gate = deferred();
    const task = vi.fn(async () => { await gate.promise; });
    const run = createSingleFlight(task);

    const first = run();
    // 첫 호출 resolve 전에 여러 번 더 호출해도 task는 1번만 시작돼야 한다.
    await run();
    await run();
    await run();
    expect(task).toHaveBeenCalledTimes(1);

    gate.resolve();
    await first;
  });

  it('이전 호출이 끝난 뒤에는 다시 실행할 수 있다', async () => {
    const task = vi.fn(async () => {});
    const run = createSingleFlight(task);

    await run();
    await run();
    await run();

    expect(task).toHaveBeenCalledTimes(3);
  });

  it('task가 throw해도 락이 해제돼서 다음 호출이 실행된다', async () => {
    let shouldThrow = true;
    const task = vi.fn(async () => {
      if (shouldThrow) throw new Error('boom');
    });
    const run = createSingleFlight(task);

    // 래퍼는 reject를 그대로 흘려보낸다 — try/finally는 inFlight만 리셋한다.
    await expect(run()).rejects.toThrow('boom');

    shouldThrow = false;
    await run();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('동시 호출은 같은 in-flight 결과를 기다리지 않고 즉시 반환된다', async () => {
    const gate = deferred();
    let started = 0;
    const task = vi.fn(async () => {
      started += 1;
      await gate.promise;
    });
    const run = createSingleFlight(task);

    const first = run();
    const dropped = run();

    // dropped는 첫 호출 완료를 기다리지 않고 바로 resolve돼야 한다.
    await dropped;
    expect(started).toBe(1);

    gate.resolve();
    await first;
  });
});
