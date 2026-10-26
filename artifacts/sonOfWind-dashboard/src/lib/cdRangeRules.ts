/**
 * AutoTradeFlow XTS SENSEX Range Flow.
 * Scores and exits come only from these rules.
 */
import type { FlipSide } from "@/lib/niftyFlipRules";

export const CD_RULES = {
  lookback: 4,
  barMinutes: 15,
  minGap: 50,
  targetPct: 10,
  trailArmPct: 5,
  stopPct: 12,
  extraBreak: 0,
  trailLockPct: 0,
  midStop: false,
  lots: 10,
  lotsMin: 1,
  lotsMax: 50,
  lotSize: 20,
  entryFrom: [10, 15] as const,
  entryUntil: [14, 30] as const,
  squareAt: [15, 14] as const,
  dayStop: 2,
  sellRetryMs: 60_000,
  strikeStep: 100,
} as const;

/** Timeframes the parameter box offers. 15 matches the desk default. */
export const CD_TIMEFRAMES = [1, 5, 15, 30] as const;

export type CdParams = {
  barMinutes: number;
  candles: number;
  lots: number;
  minGap: number;
  midStop: boolean;
  stopPct: number;
  trailArmPct: number;
  trailLockPct: number;
  extraBreak: number;
  targetPct: number;
};

/** Values from the parameters form. Lots is 2 until Save stores another number. */
export function defaultCdParams(): CdParams {
  return {
    barMinutes: 15,
    candles: 4,
    lots: 2,
    minGap: 50,
    midStop: false,
    stopPct: 12,
    trailArmPct: 5,
    trailLockPct: 0,
    extraBreak: 0,
    targetPct: 10,
  };
}

function isTimeframe(value: number): boolean {
  return (CD_TIMEFRAMES as readonly number[]).includes(value);
}

function finiteNum(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Keep a stored snapshot inside the boxes. Missing fields stay at the form defaults. */
export function readCdParams(raw: unknown, legacyLots?: unknown): CdParams {
  const base = defaultCdParams();
  const row = raw && typeof raw === "object" ? (raw as Partial<CdParams>) : {};
  const barMinutes = finiteNum(row.barMinutes);
  const candles = finiteNum(row.candles);
  const lots = finiteNum(row.lots ?? legacyLots);
  const minGap = finiteNum(row.minGap);
  const stopPct = finiteNum(row.stopPct);
  const trailArmPct = finiteNum(row.trailArmPct);
  const trailLockPct = finiteNum(row.trailLockPct);
  const extraBreak = finiteNum(row.extraBreak);
  const targetPct = finiteNum(row.targetPct);
  return {
    barMinutes: barMinutes != null && isTimeframe(barMinutes) ? barMinutes : base.barMinutes,
    candles: candles != null ? Math.max(1, Math.min(20, Math.round(candles))) : base.candles,
    lots: lots != null ? Math.max(CD_RULES.lotsMin, Math.min(CD_RULES.lotsMax, Math.round(lots))) : base.lots,
    minGap: minGap != null ? Math.max(0, minGap) : base.minGap,
    midStop: row.midStop === true,
    stopPct: stopPct != null ? Math.max(0, Math.min(100, stopPct)) : base.stopPct,
    trailArmPct: trailArmPct != null ? Math.max(0, Math.min(100, trailArmPct)) : base.trailArmPct,
    trailLockPct: trailLockPct != null ? Math.max(0, Math.min(100, trailLockPct)) : base.trailLockPct,
    extraBreak: extraBreak != null ? Math.max(0, extraBreak) : base.extraBreak,
    targetPct: targetPct != null ? Math.max(0, Math.min(100, targetPct)) : base.targetPct,
  };
}

export type CdParamDraft = {
  barMinutes: string;
  candles: string;
  lots: string;
  minGap: string;
  midStop: boolean;
  stopPct: string;
  trailArmPct: string;
  trailLockPct: string;
  extraBreak: string;
  targetPct: string;
};

export function draftFromParams(params: CdParams): CdParamDraft {
  return {
    barMinutes: String(params.barMinutes),
    candles: String(params.candles),
    lots: String(params.lots),
    minGap: String(params.minGap),
    midStop: params.midStop,
    stopPct: String(params.stopPct),
    trailArmPct: String(params.trailArmPct),
    trailLockPct: String(params.trailLockPct),
    extraBreak: String(params.extraBreak),
    targetPct: String(params.targetPct),
  };
}

function whole(raw: string, lo: number, hi: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < lo || n > hi) return null;
  return n;
}

function nonNeg(raw: string, hi: number): number | null {
  const text = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > hi) return null;
  return n;
}

/** Read the boxes. A bad box returns an error and does not build a snapshot. */
export function parseCdParams(draft: CdParamDraft): { ok: true; params: CdParams } | { ok: false; error: string } {
  const barMinutes = Number(draft.barMinutes);
  if (!isTimeframe(barMinutes)) return { ok: false, error: "Range timeframe must be 1, 5, 15, or 30." };
  const candles = whole(draft.candles, 1, 20);
  if (candles == null) return { ok: false, error: "Range candles must be a whole number from 1 to 20." };
  const lots = whole(draft.lots, CD_RULES.lotsMin, CD_RULES.lotsMax);
  if (lots == null) return { ok: false, error: "Lots must be a whole number from 1 to 50." };
  const minGap = nonNeg(draft.minGap, 100000);
  if (minGap == null) return { ok: false, error: "Min range gap must be 0 or more." };
  const stopPct = nonNeg(draft.stopPct, 100);
  if (stopPct == null) return { ok: false, error: "SL % must be from 0 to 100." };
  const trailArmPct = nonNeg(draft.trailArmPct, 100);
  if (trailArmPct == null) return { ok: false, error: "Trail arm % must be from 0 to 100." };
  const trailLockPct = nonNeg(draft.trailLockPct, 100);
  if (trailLockPct == null) return { ok: false, error: "Trail lock % must be from 0 to 100." };
  const extraBreak = nonNeg(draft.extraBreak, 100000);
  if (extraBreak == null) return { ok: false, error: "Extra break points must be 0 or more." };
  const targetPct = nonNeg(draft.targetPct, 100);
  if (targetPct == null) return { ok: false, error: "Target % must be from 0 to 100." };
  return {
    ok: true,
    params: {
      barMinutes,
      candles,
      lots,
      minGap,
      midStop: draft.midStop === true,
      stopPct,
      trailArmPct,
      trailLockPct,
      extraBreak,
      targetPct,
    },
  };
}

/** First entry is 09:15 plus one full bar for every range candle. 4×15 stays 10:15. */
export function firstEntryClock(candles: number, barMinutes: number): readonly [number, number] {
  const total = 9 * 60 + 15 + Math.round(candles) * Math.round(barMinutes);
  return [Math.floor(total / 60) % 24, total % 60];
}

export function formatHm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export type CdCloseKind = "TARGET" | "SL" | "TRAIL" | "MID" | "OPPOSITE" | "SQUARE" | "MANUAL";

export type CdAction =
  | { type: "SQUARE" }
  | { type: "OPPOSITE"; next: FlipSide }
  | { type: "MID" }
  | { type: "SL" }
  | { type: "TARGET" }
  | { type: "TRAIL" }
  | { type: "ARM_TRAIL" };

export type IstClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  date: string;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

export function istClock(now = new Date()): IstClock {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  let hour = Number(read("hour"));
  if (hour === 24) hour = 0;
  const year = Number(read("year"));
  const month = Number(read("month"));
  const day = Number(read("day"));
  return {
    year,
    month,
    day,
    hour,
    minute: Number(read("minute")),
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

function hmAtOrBefore(clock: IstClock, hour: number, minute: number): boolean {
  return clock.hour < hour || (clock.hour === hour && clock.minute <= minute);
}

function hmAtOrAfter(clock: IstClock, hour: number, minute: number): boolean {
  return clock.hour > hour || (clock.hour === hour && clock.minute >= minute);
}

/** New sells are allowed from the first closed range through 14:30 IST. */
export function entryWindowOpen(now = new Date(), from: readonly [number, number] = CD_RULES.entryFrom): boolean {
  const clock = istClock(now);
  const [fromH, fromM] = from;
  const [untilH, untilM] = CD_RULES.entryUntil;
  return hmAtOrAfter(clock, fromH, fromM) && hmAtOrBefore(clock, untilH, untilM);
}

/** 15:14 IST square. After this minute the desk sends no new orders today. */
export function squareTime(now = new Date()): boolean {
  const [hour, minute] = CD_RULES.squareAt;
  return hmAtOrAfter(istClock(now), hour, minute);
}

export function clampLots(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return CD_RULES.lots;
  return Math.max(CD_RULES.lotsMin, Math.min(CD_RULES.lotsMax, Math.round(n)));
}

export function orderQty(lots: number): number {
  return clampLots(lots) * CD_RULES.lotSize;
}

function gte(a: number, b: number): boolean {
  return a >= b - 1e-6;
}

function lte(a: number, b: number): boolean {
  return a <= b + 1e-6;
}

function gt(a: number, b: number): boolean {
  return a > b + 1e-6;
}

function lt(a: number, b: number): boolean {
  return a < b - 1e-6;
}

export function levelPx(sold: number, factor: number): number {
  return sold * factor;
}

export function targetPx(sold: number, pct: number = CD_RULES.targetPct): number {
  return levelPx(sold, 1 - pct / 100);
}

export function stopPx(sold: number, pct: number = CD_RULES.stopPct): number {
  return levelPx(sold, 1 + pct / 100);
}

export function trailArmPx(sold: number, pct: number = CD_RULES.trailArmPct): number {
  return levelPx(sold, 1 - pct / 100);
}

/** Trail lock 0 covers at the sell fill. */
export function trailCoverPx(sold: number, pct: number = CD_RULES.trailLockPct): number {
  return levelPx(sold, 1 + pct / 100);
}

/** Spot above HIGH sells PE. Spot below LOW sells CE. Extra break is 0. */
export function breakSide(spot: number, high: number, low: number, extra: number = CD_RULES.extraBreak): FlipSide | null {
  if (gt(spot, high + extra)) return "PE";
  if (lt(spot, low - extra)) return "CE";
  return null;
}

/** A print on HIGH or LOW is inside. A break is the next print past the level. */
export function insideRange(spot: number, high: number, low: number): boolean {
  return gte(spot, low) && lte(spot, high);
}

export function dayStopHit(net: number, limit: number = CD_RULES.dayStop): boolean {
  if (!(limit > 0)) return false;
  return net >= limit;
}

/**
 * Target +1 only when the cover reached the percent, with one point of slack.
 * A target label that comes back near the sell scores 0.
 * Trail scores 0 even when it loses. A losing opposite break scores -0.5.
 * Any other losing exit scores -1. A win that is not a qualifying target scores 0.
 */
export function scoreClose(kind: CdCloseKind, sold: number, cover: number, targetPct: number = CD_RULES.targetPct): number {
  if (kind === "TRAIL") return 0;
  if (kind === "TARGET") {
    const limit = sold * (1 - targetPct / 100) + 1;
    return lte(cover, limit) ? 1 : 0;
  }
  if (gt(cover, sold)) return kind === "OPPOSITE" ? -0.5 : -1;
  return 0;
}

export function addScore(net: number, delta: number): number {
  return Math.round((net + delta) * 10) / 10;
}

export function decideCdAction(input: {
  squareTime: boolean;
  side: FlipSide;
  spot: number | null;
  high: number | null;
  low: number | null;
  mid: number | null;
  midOn: boolean;
  sold: number;
  ltp: number | null;
  trailArmed: boolean;
  extraBreak?: number;
  stopPct?: number;
  targetPct?: number;
  trailArmPct?: number;
  trailLockPct?: number;
}): CdAction | null {
  if (input.squareTime) return { type: "SQUARE" };
  const { spot, high, low, mid, sold, ltp } = input;
  const extra = input.extraBreak ?? CD_RULES.extraBreak;
  const stopPct = input.stopPct ?? CD_RULES.stopPct;
  const targetPct = input.targetPct ?? CD_RULES.targetPct;
  const trailArmPct = input.trailArmPct ?? CD_RULES.trailArmPct;
  const trailLockPct = input.trailLockPct ?? CD_RULES.trailLockPct;
  if (spot != null && high != null && low != null) {
    if (input.side === "CE" && gt(spot, high + extra)) return { type: "OPPOSITE", next: "PE" };
    if (input.side === "PE" && lt(spot, low - extra)) return { type: "OPPOSITE", next: "CE" };
  }
  if (input.midOn && spot != null && mid != null) {
    if (input.side === "CE" && gte(spot, mid)) return { type: "MID" };
    if (input.side === "PE" && lte(spot, mid)) return { type: "MID" };
  }
  if (ltp == null || !(ltp > 0) || !(sold > 0)) return null;
  if (gte(ltp, stopPx(sold, stopPct))) return { type: "SL" };
  if (lte(ltp, targetPx(sold, targetPct))) return { type: "TARGET" };
  if (input.trailArmed && gte(ltp, trailCoverPx(sold, trailLockPct))) return { type: "TRAIL" };
  if (!input.trailArmed && lte(ltp, trailArmPx(sold, trailArmPct))) return { type: "ARM_TRAIL" };
  return null;
}

/** Nearest Thursday, never the same day. True when the chain expiry is today IST. */
export function expiryIsSameIstDay(expiryText: string, now = new Date()): boolean {
  const clock = istClock(now);
  const compact = expiryText.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const mon = MONTHS[clock.month - 1];
  if (!mon) return false;
  const at = compact.indexOf(mon);
  if (at < 0) return false;
  const years = compact.match(/20\d{2}/g);
  if (years && !years.includes(String(clock.year))) return false;
  const before = compact.slice(Math.max(0, at - 2), at);
  const day = String(clock.day);
  const day2 = day.padStart(2, "0");
  return before === day2 || before === day;
}

function assertCdRules(): void {
  const base: Parameters<typeof decideCdAction>[0] = {
    squareTime: false,
    side: "CE",
    spot: 100,
    high: 110,
    low: 90,
    mid: 100,
    midOn: false,
    sold: 100,
    ltp: 100,
    trailArmed: false,
  };
  const act = (patch: Partial<typeof base>) => decideCdAction({ ...base, ...patch });
  if (act({ ltp: 89 })?.type !== "TARGET") throw new Error("a print through 10% is a target");
  if (act({ ltp: 94 })?.type !== "ARM_TRAIL") throw new Error("5% arms the trail");
  if (act({ ltp: 100, trailArmed: true })?.type !== "TRAIL") throw new Error("trail covers at the sell fill");
  if (act({ ltp: 89, trailArmed: true })?.type !== "TARGET") throw new Error("a jump through 10% still targets");
  if (act({ ltp: 112, trailArmed: true })?.type !== "SL") throw new Error("12% stop is before the trail");
  if (act({ ltp: 105, trailArmed: true })?.type !== "TRAIL") throw new Error("trail covers between the fill and the stop");
  if (act({ spot: 111, high: 110, ltp: 80 })?.type !== "OPPOSITE") throw new Error("HIGH break while short CE flips");
  if (act({ squareTime: true, spot: 111, high: 110 })?.type !== "SQUARE") throw new Error("15:14 is first");
  if (act({ spot: 100, mid: 100, midOn: false }) !== null) throw new Error("MID stop is off");
  if (act({ spot: 100, mid: 100, midOn: true })?.type !== "MID") throw new Error("CE covers at spot >= MID when MID is on");
  if (act({ side: "PE", spot: 89, low: 90 })?.type !== "OPPOSITE") throw new Error("LOW break while short PE flips");
  if (act({ spot: 110, high: 110 }) !== null) throw new Error("a print on HIGH is not a break");
  if (scoreClose("TARGET", 772.32, 766.1) !== 0) throw new Error("772.32 covered 766.10 is 0");
  if (scoreClose("TARGET", 100, 90) !== 1 || scoreClose("TARGET", 100, 91) !== 1) throw new Error("target slack");
  if (scoreClose("TARGET", 100, 91.02) !== 0) throw new Error("target past slack");
  if (scoreClose("TRAIL", 100, 101) !== 0) throw new Error("trail scores 0");
  if (scoreClose("OPPOSITE", 100, 101) !== -0.5) throw new Error("losing opposite");
  if (scoreClose("SL", 100, 112) !== -1) throw new Error("losing stop");
  if (scoreClose("SQUARE", 100, 99) !== 0) throw new Error("winning square");
  if (!dayStopHit(2, 2) || dayStopHit(1.5, 2) || dayStopHit(5, 0)) throw new Error("day stop");
  if (breakSide(100, 100, 90) !== null || breakSide(100.01, 100, 90) !== "PE" || breakSide(89.99, 100, 90) !== "CE") {
    throw new Error("break");
  }
  if (!insideRange(90, 110, 90) || insideRange(89.9, 110, 90)) throw new Error("inside");
}

assertCdRules();
