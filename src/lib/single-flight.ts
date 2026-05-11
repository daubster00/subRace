// Wraps an async task so that overlapping calls are dropped instead of
// queued. Returns a no-op promise (resolved with undefined) when a call is
// already in flight. Used by the worker scheduler: yutura/youtube polls can
// take longer than the 60s tick interval, and isDue() only inspects the last
// *finished* poll — without this the next tick would fan out a duplicate run.
export function createSingleFlight(task: () => Promise<void>): () => Promise<void> {
  let inFlight = false;
  return async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await task();
    } finally {
      inFlight = false;
    }
  };
}
