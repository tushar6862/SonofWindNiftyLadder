/** Manual NIFTY short rules. Independent of Nifty Ladder and Nifty Snake. */

export const LOT_SIZE = 65;
export const DEFAULT_QTY = 780;
export const UNDERLYING = "NIFTY";

export const SIZE_MULTS = [1, 2, 3] as const;
export type SizeMult = (typeof SIZE_MULTS)[number];

export const FLIP_RATIOS = [
  { id: "80-100", label: "80 - 100", low: 80, high: 100 },
  { id: "60-79", label: "60 - 79", low: 60, high: 79 },
  { id: "45-59", label: "45 - 59", low: 45, high: 59 },
] as const;

export type RatioId = (typeof FLIP_RATIOS)[number]["id"];
export type FlipSide = "CE" | "PE";

const BAND_EPS = 1e-6;

export function isRatioId(value: string): value is RatioId {
  return FLIP_RATIOS.some((row) => row.id === value);
}

export function isSizeMult(value: number): value is SizeMult {
  return value === 1 || value === 2 || value === 3;
}

export function ratioById(id: RatioId) {
  return FLIP_RATIOS.find((row) => row.id === id) ?? FLIP_RATIOS[0];
}

export function oppositeSide(side: FlipSide): FlipSide {
  return side === "PE" ? "CE" : "PE";
}

export function orderQuantity(qty: number, size: SizeMult): number {
  return qty * size;
}

export function parseQty(raw: string): { ok: true; qty: number } | { ok: false; error: string } {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return { ok: false, error: "Qty must be a positive whole number." };
  }
  const qty = Number(text);
  if (!Number.isSafeInteger(qty) || qty <= 0) {
    return { ok: false, error: "Qty must be a positive whole number." };
  }
  if (qty % LOT_SIZE !== 0) {
    return { ok: false, error: "Qty must be a multiple of 65." };
  }
  return { ok: true, qty };
}

/** Inclusive band. 79 is inside 60–79. 80 is inside 80–100. 59 is inside 45–59. */
export function ltpInside(ltp: number, low: number, high: number): boolean {
  if (!Number.isFinite(ltp) || ltp <= 0) return false;
  return ltp >= low - BAND_EPS && ltp <= high + BAND_EPS;
}

function samePremium(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

/** Highest live LTP inside the band. Equal LTP keeps the higher strike. */
export function pickHighestLtp<T extends { strike: number; ltp: number }>(
  quotes: readonly T[],
  low: number,
  high: number,
): T | null {
  const inside: T[] = [];
  for (const quote of quotes) {
    if (!Number.isFinite(quote.strike) || quote.strike <= 0) continue;
    if (!ltpInside(quote.ltp, low, high)) continue;
    inside.push(quote);
  }
  if (!inside.length) return null;
  inside.sort((a, b) => {
    if (!samePremium(a.ltp, b.ltp)) return b.ltp - a.ltp;
    return b.strike - a.strike;
  });
  return inside[0] ?? null;
}

/** Short MTM. Profit when premium falls. */
export function shortMtm(fill: number, live: number, qty: number): number {
  return (fill - live) * qty;
}

export function buttonLabel(
  name: "BULL" | "BEAR",
  side: FlipSide,
  pick: { strike: number; ltp: number } | null,
): string {
  const head = `${name} SELL ${side}`;
  if (!pick) return head;
  return `${head} ${Math.round(pick.strike).toLocaleString("en-IN")} @ ${pick.ltp.toFixed(2)}`;
}
