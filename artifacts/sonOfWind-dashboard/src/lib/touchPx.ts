/** Shared by SSE ingest and ladder LIVE — no React imports. */
export type TouchTick = {
  ltp: number;
  bid: number | null;
  ask: number | null;
  ltpAt?: number;
  bookAt?: number;
};

/**
 * XTS Snap Quote ``LTP`` only (last traded). Never bid/ask mid — that was
 * painting 82.60 when Snap Quote LTP was 82.80.
 */
export function touchPxFromTick(
  tick: TouchTick | null | undefined,
  fallback?: number | null,
): number | null {
  if (tick?.ltp && tick.ltp > 0) return tick.ltp;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback > 0) return fallback;
  return null;
}
