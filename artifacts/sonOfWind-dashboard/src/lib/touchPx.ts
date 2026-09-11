/** Shared by SSE ingest and ladder LIVE — no React imports. */
export type TouchTick = {
  ltp: number;
  bid: number | null;
  ask: number | null;
  ltpAt?: number;
  bookAt?: number;
};

/**
 * Match XTS Snap Quote ``LTP`` (last traded), not bid/ask mid.
 * Mid is only a hole-fill when no print exists yet.
 */
export function touchPxFromTick(
  tick: TouchTick | null | undefined,
  fallback?: number | null,
): number | null {
  if (tick?.ltp && tick.ltp > 0) return tick.ltp;
  const bid = tick?.bid != null && tick.bid > 0 ? tick.bid : null;
  const ask = tick?.ask != null && tick.ask > 0 ? tick.ask : null;
  if (bid != null && ask != null && ask >= bid) {
    const mid = (bid + ask) / 2;
    if (mid > 0) return mid;
  }
  if (bid != null) return bid;
  if (ask != null) return ask;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  return null;
}
