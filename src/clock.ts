export const clock = {
  monotonic: (): number => performance.now(),
  now: (): number => Date.now(),
  sleep: (ms: number, { unref = false, signal }: { unref?: boolean; signal?: AbortSignal } = {}): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
      if (unref) timer.unref();
    }),
};
