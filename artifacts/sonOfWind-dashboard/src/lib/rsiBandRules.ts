/**
 * NIFTY RSI Band Strategy Rules.
 * Wilder RSI(14) on NIFTY spot closes.
 * Independent CE and PE short positions with live RSI auto-exits.
 */

export const UNDERLYING = "NIFTY";
export const LOT_SIZE = 65;
export const DEFAULT_QTY = 780;
export const RSI_PERIOD = 14;

/** Chart guide lines. Stop sits 3 points outside the outer lines. */
export const RSI_SL_GAP = 3;
export const RSI_ARM_GAP = 0.5;

export type RsiLimitLine = {
  enabled: boolean;
  color: string;
  value: number;
};

export type RsiChartLimits = {
  upper: RsiLimitLine;
  middle: RsiLimitLine;
  lower: RsiLimitLine;
};

export const DEFAULT_RSI_LIMITS: RsiChartLimits = {
  upper: { enabled: true, color: "#ef4444", value: 70 },
  middle: { enabled: true, color: "#94a3b8", value: 50 },
  lower: { enabled: true, color: "#22c55e", value: 30 },
};

export function limitsAreOrdered(limits: RsiChartLimits): boolean {
  return limits.lower.value < limits.middle.value && limits.middle.value < limits.upper.value;
}

export function ceArmFromUpper(upper: number): number {
  return Math.round((upper + RSI_ARM_GAP) * 10) / 10;
}

export function peArmFromLower(lower: number): number {
  return Math.round((lower - RSI_ARM_GAP) * 10) / 10;
}

export function ceSlFromUpper(upper: number): number {
  return Math.round((upper + RSI_SL_GAP) * 10) / 10;
}

export function peSlFromLower(lower: number): number {
  return Math.round((lower - RSI_SL_GAP) * 10) / 10;
}

// Defaults match a 30 / 50 / 70 chart. Live values come from the limit popup.
export const RSI_CE_ARM_THRESHOLD = ceArmFromUpper(DEFAULT_RSI_LIMITS.upper.value);
export const RSI_PE_ARM_THRESHOLD = peArmFromLower(DEFAULT_RSI_LIMITS.lower.value);
export const RSI_CE_CROSS_THRESHOLD = DEFAULT_RSI_LIMITS.upper.value;
export const RSI_PE_CROSS_THRESHOLD = DEFAULT_RSI_LIMITS.lower.value;
export const RSI_CE_AUTO_EXIT = ceSlFromUpper(DEFAULT_RSI_LIMITS.upper.value);
export const RSI_PE_AUTO_EXIT = peSlFromLower(DEFAULT_RSI_LIMITS.lower.value);

export const TIMEFRAMES = [1, 2, 3, 5, 10, 15, 30] as const;
export type RsiTimeframe = (typeof TIMEFRAMES)[number];

export const SIZE_MULTS = [1, 2, 3] as const;
export type SizeMult = (typeof SIZE_MULTS)[number];

export const RSI_RATIOS = [
  { id: "80-100", label: "80 - 100", low: 80, high: 100 },
  { id: "60-79", label: "60 - 79", low: 60, high: 79 },
  { id: "45-59", label: "45 - 59", low: 45, high: 59 },
  { id: "20-44", label: "20 - 44", low: 20, high: 44 },
  { id: "10-25", label: "10 - 25", low: 10, high: 25 },
] as const;

export type RatioId = (typeof RSI_RATIOS)[number]["id"];
export type RsiSide = "CE" | "PE";

const BAND_EPS = 1e-6;

export function isRatioId(value: string): value is RatioId {
  return RSI_RATIOS.some((row) => row.id === value);
}

export function isSizeMult(value: number): value is SizeMult {
  return value === 1 || value === 2 || value === 3;
}

export function isTimeframe(value: number): value is RsiTimeframe {
  return TIMEFRAMES.includes(value as RsiTimeframe);
}

export function ratioById(id: RatioId) {
  return RSI_RATIOS.find((row) => row.id === id) ?? RSI_RATIOS[0];
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
    return { ok: false, error: `Qty must be a multiple of ${LOT_SIZE}.` };
  }
  return { ok: true, qty };
}

/** Inclusive premium band check. */
export function ltpInside(ltp: number, low: number, high: number): boolean {
  if (!Number.isFinite(ltp) || ltp <= 0) return false;
  return ltp >= low - BAND_EPS && ltp <= high + BAND_EPS;
}

function samePremium(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001;
}

/**
 * Selects highest live LTP inside the premium range.
 * Ties go to the higher strike.
 */
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

/**
 * Fallback when no quote is inside the target band.
 * Selects candidate quote closest to the band midpoint.
 */
export function pickClosestLtp<T extends { strike: number; ltp: number }>(
  quotes: readonly T[],
  low: number,
  high: number,
): T | null {
  if (!quotes.length) return null;
  const target = (low + high) / 2;
  const valid = [...quotes].filter(
    (q) => Number.isFinite(q.strike) && q.strike > 0 && Number.isFinite(q.ltp) && q.ltp > 0,
  );
  if (!valid.length) return null;
  valid.sort((a, b) => {
    const da = Math.abs(a.ltp - target);
    const db = Math.abs(b.ltp - target);
    if (Math.abs(da - db) > 0.001) return da - db;
    return b.strike - a.strike;
  });
  return valid[0] ?? null;
}

/** Short MTM: profit when premium falls. */
export function shortMtm(fill: number, liveLtp: number, qty: number): number {
  return (fill - liveLtp) * qty;
}

/** Entry enable checks based on live RSI and position status */
/** Both START CE and START PE arm while live RSI is inside the selected chart limits. */
export function rsiInsideLimits(liveRsi: number | null, lower: number, upper: number): boolean {
  if (liveRsi == null || !Number.isFinite(liveRsi)) return false;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper) return false;
  return liveRsi >= lower && liveRsi <= upper;
}

export function canSellCe(liveRsi: number | null, hasCePosition: boolean, arm = RSI_CE_ARM_THRESHOLD): boolean {
  if (hasCePosition) return false;
  if (liveRsi == null || !Number.isFinite(liveRsi)) return false;
  return liveRsi <= arm;
}

export function canSellPe(liveRsi: number | null, hasPePosition: boolean, arm = RSI_PE_ARM_THRESHOLD): boolean {
  if (hasPePosition) return false;
  if (liveRsi == null || !Number.isFinite(liveRsi)) return false;
  return liveRsi >= arm;
}

/** Auto-exit checks on live/projected RSI */
export function shouldAutoExitCe(liveRsi: number | null, hasCePosition: boolean, stop = RSI_CE_AUTO_EXIT): boolean {
  if (!hasCePosition || liveRsi == null || !Number.isFinite(liveRsi)) return false;
  return liveRsi > stop;
}

export function shouldAutoExitPe(liveRsi: number | null, hasPePosition: boolean, stop = RSI_PE_AUTO_EXIT): boolean {
  if (!hasPePosition || liveRsi == null || !Number.isFinite(liveRsi)) return false;
  return liveRsi < stop;
}

/** Client-side Wilder RSI calculation helper for projection */
export function calculateWilderRsi(
  closes: number[],
  period: number = RSI_PERIOD,
): { rsi: number | null; avgGain: number; avgLoss: number } {
  if (closes.length <= period) {
    return { rsi: null, avgGain: 0, avgLoss: 0 };
  }
  let sumGain = 0;
  let sumLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) sumGain += diff;
    else sumLoss -= diff;
  }
  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) {
    return { rsi: avgGain > 0 ? 100 : 50, avgGain, avgLoss };
  }
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return { rsi: Math.round(rsi * 100) / 100, avgGain, avgLoss };
}

export function projectRsiWithSpot(
  avgGain: number,
  avgLoss: number,
  lastClose: number,
  liveSpot: number,
  period: number = RSI_PERIOD,
): number | null {
  if (lastClose <= 0 || liveSpot <= 0) return null;
  const diff = liveSpot - lastClose;
  const gain = diff > 0 ? diff : 0;
  const loss = diff < 0 ? -diff : 0;
  const projGain = (avgGain * (period - 1) + gain) / period;
  const projLoss = (avgLoss * (period - 1) + loss) / period;
  if (projLoss === 0) return projGain > 0 ? 100 : 50;
  const rs = projGain / projLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}
