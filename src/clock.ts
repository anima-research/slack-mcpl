export const clock = {
  now: (): number => Date.now(),
  sleep: (ms: number, { unref = false }: { unref?: boolean } = {}): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (unref) timer.unref();
    }),
};
