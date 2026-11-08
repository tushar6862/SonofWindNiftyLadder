/**
 * 9:30 desk. Entries and exits come only from these rules.
 * START sells immediately. There is no clock window.
 */
import { expiryDayKey, istClock, type CdExpiryPick } from "@/lib/cdRangeRules";
import type { FlipSide } from "@/lib/niftyFlipRules";

export const N930 = {
  premiumMin: 100,
  lotsMin: 1,
  lotsMax: 50,
  lotsDefault: 1,
  sellRetryMs: 3_000,
  dayWinPerLot: 500,
  dayLossPerLot: 700,
  loserFactor: 1.25,
  maxStopFactor: 1.15,
  trailArmFactor: 0.6,
  trailGivebackFactor: 1.15,
  wings: 24,
} as const;

export const N930_NO_EXPIRY = "No expiry on or after today. No entry.";

export type CloseReason = "DAY" | "LOSS125" | "STOP15" | "TRAIL" | "STOP";

/** A leg booked at 125%, at the 15% stop, or by the trail is not sold again today. */
export function closeBlocksResell(reason: CloseReason | null): boolean {
  return reason === "LOSS125" || reason === "STOP15" || reason === "TRAIL";
}

const EXPIRY_LABEL = /^(\d{2})([A-Za-z]{3})(\d{4})$/;

function atOrAbove(value: number, level: number): boolean {
  return value >= level - 1e-6;
}

function atOrBelow(value: number, level: number): boolean {
  return value <= level + 1e-6;
}

function px2(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

export function sellQty(lotSize: number, lots: number): number | null {
  if (!Number.isInteger(lots) || lots < N930.lotsMin || lots > N930.lotsMax) return null;
  if (!Number.isInteger(lotSize) || lotSize <= 0) return null;
  const qty = lots * lotSize;
  if (!Number.isSafeInteger(qty) || qty <= 0) return null;
  return qty;
}

export function parseLots(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  return sellQty(1, Number(text)) != null ? Number(text) : null;
}

/**
 * Nearest broker expiry on or after today's IST date. The same day counts.
 * Labels must look like 12Nov2026. Earlier dates are dropped.
 */
export function pickNearestExpiry(rows: readonly CdExpiryPick[], now = new Date()): CdExpiryPick | null {
  const clock = istClock(now);
  const today = clock.year * 10000 + clock.month * 100 + clock.day;
  let bestKey = 0;
  let best: CdExpiryPick | null = null;
  for (const row of rows) {
    const label = String(row?.label || "").trim();
    const api = String(row?.api || "").trim();
    if (!EXPIRY_LABEL.test(label) || !api) continue;
    const key = expiryDayKey(label);
    if (key == null || key < today) continue;
    if (best == null || key < bestKey) {
      bestKey = key;
      best = { label, api };
    }
  }
  return best;
}

export type PremiumQuote = { strike: number; premium: number; iid: number };

/**
 * Cheapest live premium at or above 100. A premium of 99.99 is not a sell.
 * The same premium sells the lower strike.
 */
export function pickSellStrike(quotes: readonly PremiumQuote[], floor = N930.premiumMin): PremiumQuote | null {
  let best: PremiumQuote | null = null;
  for (const row of quotes) {
    if (!Number.isFinite(row.strike) || row.strike <= 0) continue;
    if (!Number.isFinite(row.premium) || !Number.isFinite(row.iid) || !(row.iid > 0)) continue;
    if (!atOrAbove(row.premium, floor)) continue;
    const same = best != null && Math.abs(row.premium - best.premium) <= 0.001;
    if (!best || row.premium < best.premium - 0.001 || (same && row.strike < best.strike)) {
      best = { strike: row.strike, premium: row.premium, iid: row.iid };
    }
  }
  return best;
}

/** Dust under 0.50 against a real sold premium is a missing tape. */
export function liveMark(sold: number, ltp: number | null): number | null {
  if (ltp == null || !Number.isFinite(ltp) || !(ltp > 0)) return null;
  if (sold >= 5 && ltp < 0.5) return null;
  return ltp;
}

export type MtmLeg = { sold: number; mark: number | null; qty: number; open: boolean };

/** Rupee sum of every open and closed leg. A missing open tape returns null. */
export function dayMtm(legs: readonly MtmLeg[]): number | null {
  let sum = 0;
  for (const leg of legs) {
    if (!(leg.qty > 0) || !(leg.sold > 0)) continue;
    if (leg.mark == null || !Number.isFinite(leg.mark) || !(leg.mark > 0)) {
      if (leg.open) return null;
      continue;
    }
    sum += (leg.sold - leg.mark) * leg.qty;
  }
  return sum;
}

export type BookLeg = {
  side: FlipSide;
  qty: number;
  lotSize: number;
  open: boolean;
  openedAt: number;
};

/**
 * Lots are the larger of the CE quantity and the PE quantity, divided by lot size.
 * An open side uses its open quantity. A flat side uses its latest closed quantity.
 */
export function bookLots(legs: readonly BookLeg[]): number {
  let ce = 0;
  let pe = 0;
  for (const side of ["CE", "PE"] as const) {
    const rows = legs.filter((leg) => leg.side === side && leg.qty > 0 && leg.lotSize > 0);
    const opens = rows.filter((leg) => leg.open);
    const chosen = opens.length ? opens : [...rows].sort((a, b) => b.openedAt - a.openedAt).slice(0, 1);
    const lots = chosen.reduce((sum, leg) => sum + leg.qty / leg.lotSize, 0);
    if (side === "CE") ce = lots;
    else pe = lots;
  }
  return Math.max(ce, pe);
}

export function dayBookHit(mtm: number, lots: number): "win" | "loss" | null {
  if (!(lots > 0) || !Number.isFinite(mtm)) return null;
  const win = N930.dayWinPerLot * lots;
  const loss = N930.dayLossPerLot * lots;
  if (atOrAbove(mtm, win)) return "win";
  if (atOrBelow(mtm, -loss)) return "loss";
  return null;
}

export function loserPx(sold: number): number {
  return sold * N930.loserFactor;
}

export function maxStopPx(sold: number): number {
  return sold * N930.maxStopFactor;
}

export function trailArmPx(sold: number): number {
  return sold * N930.trailArmFactor;
}

export function trailCoverPx(low: number): number {
  return low * N930.trailGivebackFactor;
}

export function loserHit(sold: number, ltp: number): boolean {
  return sold > 0 && atOrAbove(ltp, loserPx(sold));
}

export function maxStopHit(sold: number, ltp: number): boolean {
  return sold > 0 && atOrAbove(ltp, maxStopPx(sold));
}

export function trailStep(
  sold: number,
  ltp: number,
  armed: boolean,
  low: number | null,
): { armed: boolean; low: number | null; justArmed: boolean; cover: boolean } {
  let nextArmed = armed;
  let nextLow = low;
  let justArmed = false;
  if (!nextArmed && sold > 0 && atOrBelow(ltp, trailArmPx(sold))) {
    nextArmed = true;
    nextLow = px2(ltp);
    justArmed = true;
  } else if (nextArmed && nextLow != null && px2(ltp) < nextLow - 1e-9) {
    nextLow = px2(ltp);
  }
  const cover = nextArmed && nextLow != null && atOrAbove(ltp, trailCoverPx(nextLow));
  return { armed: nextArmed, low: nextLow, justArmed, cover };
}
