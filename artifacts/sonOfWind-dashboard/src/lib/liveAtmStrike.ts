import type { ChainResolved } from "@/types/market";

/** ATM strike from live spot (same rounding as backend resolve); falls back to chain snapshot / nearest resolved strike. */
export function liveAtmStrikeForChain(chain: ChainResolved, spotPx: number | undefined): number {
  const step = Number(chain.step) || 50;
  const strikes = Object.keys(chain.instrumentMap || {})
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n));
  if (!strikes.length) return chain.atmStrike;

  const spot =
    typeof spotPx === "number" && Number.isFinite(spotPx) && spotPx > 0
      ? spotPx
      : typeof chain.spotLtp === "number" && Number.isFinite(chain.spotLtp) && chain.spotLtp > 0
        ? chain.spotLtp
        : null;
  if (spot == null) return chain.atmStrike;

  const rounded = Math.round(spot / step) * step;
  if (strikes.includes(rounded)) return rounded;
  return strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]!);
}
