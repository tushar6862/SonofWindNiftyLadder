import type { ChainResolved } from "@/types/market";

/** Index last-price band. A 0.05 print is an option tick, not Nifty/BankNifty/Sensex. */
const SPOT_PX_BOUNDS: Record<string, readonly [number, number]> = {
  NIFTY: [12000, 45000],
  BANKNIFTY: [30000, 90000],
  SENSEX: [40000, 150000],
};

export function plausibleSpotPx(index: string | undefined, px: number | null | undefined): number | undefined {
  if (typeof px !== "number" || !Number.isFinite(px) || px <= 0) return undefined;
  const bounds = SPOT_PX_BOUNDS[String(index || "").trim().toUpperCase()];
  if (!bounds) return px;
  return px >= bounds[0] && px <= bounds[1] ? px : undefined;
}

export function spotPxFloor(index: string | undefined): number {
  const bounds = SPOT_PX_BOUNDS[String(index || "").trim().toUpperCase()];
  return bounds ? bounds[0] : 0;
}

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
