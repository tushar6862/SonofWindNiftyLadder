/**
 * Flip desk — TASF v1.0 / TRIDENT LION.
 * NIFTY or SENSEX ATM straddle. A short trails down and flips long on the rebound.
 * A long stops 10% under its buy, or books after a 5% pullback from a high that armed at +15%.
 * Only one leg is long at a time. The card price is the broker fill.
 * Slippage 0.20–0.40 is display only and is never added to a fill.
 */

export const FLIP = {
  strikeStep: 50,
  lots: 2,
  lotsMin: 1,
  lotsMax: 50,
  triggerDefault: 15,
  triggerMin: 7,
  triggerMax: 15,
  gapKeep: 60,
  reversalPct: 10,
  longArmPct: 15,
  longPullPct: 5,
  otmPremium: 70,
  maxDailyLoss: 5000,
  dailyTarget: 15000,
  slipLow: 0.2,
  slipHigh: 0.4,
  lotSize: { NIFTY: 65, SENSEX: 20 },
} as const;

export const FLIP_CLOCK = {
  stage: 9 * 3600 + 10 * 60,
  open: 9 * 3600 + 15 * 60,
  shut: 15 * 3600 + 15 * 60,
} as const;

export type FlipIndex = "NIFTY" | "SENSEX";
export type FlipSide = "CE" | "PE";
export type FlipMode = "short" | "long";
export type FlipPhase = "pre" | "stage" | "open" | "shut";

export type FlipClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  date: string;
};

export type ExpiryPick = { label: string; api: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
const EXPIRY_LABEL = /^(\d{2})([A-Za-z]{3})(\d{4})$/;

export function flipIndex(index: string | null | undefined): FlipIndex | null {
  if (index === "NIFTY" || index === "SENSEX") return index;
  return null;
}

export function lotSize(index: FlipIndex): number {
  return FLIP.lotSize[index];
}

/** Default 2 lots is NIFTY 130 and SENSEX 40. A saved lot count replaces the 2. */
export function sellQuantity(index: FlipIndex, lots: number = FLIP.lots): number {
  return lotSize(index) * lots;
}

export function parseFlipLots(text: string): { ok: true; lots: number } | { ok: false; error: string } {
  const raw = text.trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: `Lots must be a whole number from ${FLIP.lotsMin} to ${FLIP.lotsMax}.` };
  const lots = Number(raw);
  if (!Number.isInteger(lots) || lots < FLIP.lotsMin || lots > FLIP.lotsMax) {
    return { ok: false, error: `Lots must be ${FLIP.lotsMin}–${FLIP.lotsMax}.` };
  }
  return { ok: true, lots };
}

/** Twice the short quantity. NIFTY 260. SENSEX 80. */
export function flipBuyQuantity(shortQty: number): number {
  return shortQty * 2;
}

export function istNow(now = new Date()): FlipClock {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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
    second: Number(read("second")),
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

export function clockPhase(clock: Pick<FlipClock, "hour" | "minute" | "second">): FlipPhase {
  const secs = clock.hour * 3600 + clock.minute * 60 + clock.second;
  if (secs >= FLIP_CLOCK.shut) return "shut";
  if (secs >= FLIP_CLOCK.open) return "open";
  if (secs >= FLIP_CLOCK.stage) return "stage";
  return "pre";
}

/** Half-up to a paise. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  const sign = n < 0 ? -1 : 1;
  const [whole, frac = ""] = Math.abs(n).toFixed(8).split(".");
  const digits = `${frac}000`;
  let paise = Number(whole) * 100 + Number(digits.slice(0, 2));
  if (digits[2]! >= "5") paise += 1;
  return (sign * paise) / 100;
}

export function stageAtm(spot: number, step = FLIP.strikeStep): number | null {
  if (!Number.isFinite(spot) || !(spot > 0)) return null;
  return Math.round(spot / step) * step;
}

/** Keep the staged ATM while the live spot is within 60 points. Past that, round the live spot. */
export function entryStrike(stagedAtm: number, liveSpot: number, step = FLIP.strikeStep): number {
  if (Math.abs(liveSpot - stagedAtm) <= FLIP.gapKeep) return stagedAtm;
  return Math.round(liveSpot / step) * step;
}

export function atmBracket(atm: number, step = FLIP.strikeStep): [number, number, number] {
  return [atm - step, atm, atm + step];
}

export function syntheticFuture(strike: number, ce: number, pe: number): number | null {
  if (!(strike > 0) || !(ce > 0) || !(pe > 0)) return null;
  return strike + ce - pe;
}

/** Blank, zero, or a print that is not a live trade is not a quote. */
export function tradableQuote(px: number | null | undefined, live: boolean): number | null {
  if (!live) return null;
  if (typeof px !== "number" || !Number.isFinite(px) || !(px > 0)) return null;
  return px;
}

export function bothQuoted(ce: number | null | undefined, pe: number | null | undefined): boolean {
  return typeof ce === "number" && ce > 0 && typeof pe === "number" && pe > 0;
}

export function triggerPx(trailLow: number, triggerPct: number): number {
  return round2(trailLow * (1 + triggerPct / 100));
}

/** Trailing low moves down only. A zero print is ignored. Trigger is recomputed from the low. */
export function nextTrail(
  trailLow: number,
  ltp: number,
  triggerPct: number,
): { trailLow: number; trigger: number } {
  if (ltp > 0 && ltp < trailLow) {
    return { trailLow: ltp, trigger: triggerPx(ltp, triggerPct) };
  }
  return { trailLow, trigger: triggerPx(trailLow, triggerPct) };
}

export function shouldFlip(mode: FlipMode, ltp: number | null, trigger: number): boolean {
  return mode === "short" && ltp != null && ltp > 0 && trigger > 0 && ltp >= trigger;
}

export function splitFlipBuy(shortQty: number, filledQty: number): { cover: number; longQty: number; shortLeft: number } {
  const got = Math.max(0, Math.floor(filledQty));
  const cover = Math.min(got, shortQty);
  return { cover, longQty: Math.max(0, got - shortQty), shortLeft: shortQty - cover };
}

/** A long's stop. Buy 100 with a 10% reversal is 90. */
export function reversalTrigger(buyAvg: number): number {
  return round2(buyAvg * (1 - FLIP.reversalPct / 100));
}

export function shouldReverse(mode: FlipMode, ltp: number | null, reversal: number): boolean {
  return mode === "long" && ltp != null && ltp > 0 && reversal > 0 && ltp <= reversal;
}

/** Same split as the flip buy: the open quantity closes first, the rest opens the other side. */
export function splitFlipSell(longQty: number, filledQty: number): { cover: number; shortQty: number; longLeft: number } {
  const split = splitFlipBuy(longQty, filledQty);
  return { cover: split.cover, shortQty: split.longQty, longLeft: split.shortLeft };
}

/** Trailing high stays empty until the long is 15% above its buy. After that it only rises. */
export function nextLongTrail(buyAvg: number, trailHigh: number | null, ltp: number): number | null {
  const held = trailHigh != null && trailHigh > 0 ? trailHigh : null;
  if (!(buyAvg > 0) || !(ltp > 0)) return held;
  if (held == null && ltp < round2(buyAvg * (1 + FLIP.longArmPct / 100))) return null;
  return held == null ? ltp : Math.max(held, ltp);
}

/** Profit exit is 5% under the trailing high. */
export function longExitPx(trailHigh: number | null): number | null {
  if (trailHigh == null || !(trailHigh > 0)) return null;
  return round2(trailHigh * (1 - FLIP.longPullPct / 100));
}

export function shouldBookLong(ltp: number | null, exitPx: number | null): boolean {
  return ltp != null && ltp > 0 && exitPx != null && exitPx > 0 && ltp <= exitPx;
}

export type DayHalt = "loss" | "target";
export type FlipEntryMode = "timer" | "normal";

/** Day target still closes the card. A loss does not. The next START is allowed after a loss. */
export function dayHaltTick(dayMtm: number | null): DayHalt | null {
  if (dayMtm == null || !Number.isFinite(dayMtm)) return null;
  if (dayMtm >= FLIP.dailyTarget) return "target";
  return null;
}

/** Timer clock is HH:MM, 24 hour. Seconds on the end are ignored. 09:15 is 33300 seconds. */
export function parseEntryClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 3600 + minute * 60;
}

/** Keeps each key. 0915 and 09:15 both become 09:15. */
export function entryClockDraft(text: string): string {
  const digits = text.replace(/[^\d]/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

/**
 * Normal sells as soon as START is on, until 15:15.
 * Timer waits until the set clock, then sells. After 15:15 neither sells.
 */
export function entryDue(
  clock: { hour: number; minute: number; second: number },
  mode: FlipEntryMode,
  timer: string,
): boolean {
  if (clockPhase(clock) === "shut") return false;
  if (mode === "normal") return true;
  const fire = parseEntryClock(timer);
  if (fire == null) return false;
  return clock.hour * 3600 + clock.minute * 60 + clock.second >= fire;
}

/**
 * Far OTM on this side whose live premium is closest to ₹70.
 * CE looks above the anchor. PE looks below it. A tie picks the further strike.
 */
export function pickOtmStrike(
  rows: readonly { strike: number; px: number | null }[],
  side: FlipSide,
  anchor: number,
  target = FLIP.otmPremium,
): number | null {
  let best: { strike: number; dist: number } | null = null;
  for (const row of rows) {
    if (!(row.px != null && row.px > 0) || !(row.strike > 0)) continue;
    if (side === "CE" && !(row.strike > anchor)) continue;
    if (side === "PE" && !(row.strike < anchor)) continue;
    const dist = Math.abs(row.px - target);
    const further =
      best != null &&
      Math.abs(dist - best.dist) <= 1e-9 &&
      (side === "CE" ? row.strike > best.strike : row.strike < best.strike);
    if (!best || dist < best.dist - 1e-9 || further) best = { strike: row.strike, dist };
  }
  return best?.strike ?? null;
}

/** Both legs long is refused by the engine. The name is only a label. */
export function flipStateName(ce: FlipMode | null, pe: FlipMode | null): string {
  if (ce === "short" && pe === "short") return "STATE_A_SIDEWAYS";
  if (ce === "long" && pe === "short") return "STATE_B_BULLISH";
  if (ce === "short" && pe === "long") return "STATE_C_BEARISH";
  if (ce === "long" && pe == null) return "CE long. PE is flat.";
  if (pe === "long" && ce == null) return "PE long. CE is flat.";
  if (ce === "long" && pe === "long") return "Both long. Squaring one.";
  return "";
}

export function shortMark(sellFill: number, ltp: number, qty: number): number | null {
  if (!(sellFill > 0) || !(ltp > 0) || !(qty > 0)) return null;
  return (sellFill - ltp) * qty;
}

export function longMark(buyAvg: number, ltp: number, qty: number): number | null {
  if (!(buyAvg > 0) || !(ltp > 0) || !(qty > 0)) return null;
  return (ltp - buyAvg) * qty;
}

export function bookedShort(sellFill: number, buyFill: number, qty: number): number {
  return (sellFill - buyFill) * qty;
}

export function bookedLong(sellFill: number, buyAvg: number, qty: number): number {
  return (sellFill - buyAvg) * qty;
}

export function parseFlipTrigger(text: string): { ok: true; trigger: number } | { ok: false; error: string } {
  const raw = text.trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: "Flip trigger must be a whole number from 7 to 15." };
  const trigger = Number(raw);
  if (!Number.isInteger(trigger) || trigger < FLIP.triggerMin || trigger > FLIP.triggerMax) {
    return { ok: false, error: "Flip trigger must be 7 to 15." };
  }
  return { ok: true, trigger };
}

function civilKey(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 2000) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return year * 10000 + month * 100 + day;
}

export function expiryDayKey(text: string): number | null {
  const raw = String(text || "").trim();
  const match = EXPIRY_LABEL.exec(raw.replace(/[\s\-_/]/g, ""));
  if (!match) return null;
  const month = MONTHS.indexOf(match[2].toLowerCase() as (typeof MONTHS)[number]) + 1;
  return civilKey(Number(match[3]), month, Number(match[1]));
}

function weekdayOfKey(key: number): number {
  const year = Math.floor(key / 10000);
  const month = Math.floor((key % 10000) / 100);
  const day = key % 100;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Nearest listed weekday expiry on or after today. Saturday and Sunday contracts are skipped. */
export function pickFlipExpiry(
  rows: readonly { label?: string; api?: string }[],
  clock: Pick<FlipClock, "year" | "month" | "day">,
): ExpiryPick | null {
  const today = civilKey(clock.year, clock.month, clock.day);
  if (today == null) return null;
  const listed: { key: number; pick: ExpiryPick }[] = [];
  for (const row of rows) {
    const label = String(row?.label || "").trim();
    const api = String(row?.api || "").trim();
    if (!label || !api) continue;
    const key = expiryDayKey(label);
    if (key == null || key < today) continue;
    const weekday = weekdayOfKey(key);
    if (weekday === 0 || weekday === 6) continue;
    listed.push({ key, pick: { label, api } });
  }
  listed.sort((a, b) => a.key - b.key);
  return listed[0]?.pick ?? null;
}

export type FlipLockParams = {
  step1PerLot: number;
  lockPerLot: number;
  trailPerLot: number;
  trailPercent: number;
};

export type FlipLockDraft = {
  step1PerLot: string;
  lockPerLot: string;
  trailPerLot: string;
  trailPercent: string;
};

/** Boxes are rupees per lot. Trail percent is never multiplied by lots. */
export function defaultFlipLock(): FlipLockParams {
  return { step1PerLot: 1500, lockPerLot: 1000, trailPerLot: 1700, trailPercent: 80 };
}

export function draftFromLock(params: FlipLockParams): FlipLockDraft {
  return {
    step1PerLot: String(params.step1PerLot),
    lockPerLot: String(params.lockPerLot),
    trailPerLot: String(params.trailPerLot),
    trailPercent: String(params.trailPercent),
  };
}

function parseRupeePerLot(text: string): number | null {
  const raw = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return n;
}

export function parseFlipLock(draft: FlipLockDraft): { ok: true; params: FlipLockParams } | { ok: false; error: string } {
  const step1PerLot = parseRupeePerLot(draft.step1PerLot);
  if (step1PerLot == null) return { ok: false, error: "Step 1 trigger must be rupees per lot." };
  const lockPerLot = parseRupeePerLot(draft.lockPerLot);
  if (lockPerLot == null) return { ok: false, error: "Step 1 lock must be rupees per lot." };
  const trailPerLot = parseRupeePerLot(draft.trailPerLot);
  if (trailPerLot == null) return { ok: false, error: "Trail trigger must be rupees per lot." };
  const pctRaw = draft.trailPercent.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(pctRaw)) return { ok: false, error: "Trail percent must be from 1 to 100." };
  const trailPercent = Number(pctRaw);
  if (!Number.isFinite(trailPercent) || trailPercent < 1 || trailPercent > 100) {
    return { ok: false, error: "Trail percent must be from 1 to 100." };
  }
  return { ok: true, params: { step1PerLot, lockPerLot, trailPerLot, trailPercent } };
}

export function readFlipLock(raw: unknown): FlipLockParams {
  const base = defaultFlipLock();
  if (!raw || typeof raw !== "object") return base;
  const row = raw as Partial<FlipLockParams>;
  const parsed = parseFlipLock({
    step1PerLot: String(row.step1PerLot ?? base.step1PerLot),
    lockPerLot: String(row.lockPerLot ?? base.lockPerLot),
    trailPerLot: String(row.trailPerLot ?? base.trailPerLot),
    trailPercent: String(row.trailPercent ?? base.trailPercent),
  });
  return parsed.ok ? parsed.params : base;
}

/**
 * Lots for the lock is one leg's quantity ÷ the index lot size.
 * Two open legs of 2 lots stay 2. They are not added into 4.
 */
export function openLots(qtys: readonly number[], index: FlipIndex): number {
  const size = lotSize(index);
  let lots = 0;
  for (const qty of qtys) {
    if (!(qty > 0) || !(size > 0)) continue;
    lots = Math.max(lots, qty / size);
  }
  return lots;
}

export function liveLockLevels(params: FlipLockParams, lots: number) {
  return {
    step1: params.step1PerLot * lots,
    lock: params.lockPerLot * lots,
    trail: params.trailPerLot * lots,
    trailPercent: params.trailPercent,
  };
}

export type ProfitLockStep = {
  floor: number;
  peak: number | null;
  square: boolean;
};

/**
 * Cycle MTM is passed in. A null MTM is a missing price: the floor stays and nothing squares.
 * The floor only rises. Trail percent applies to the peak, not to lots.
 */
export function profitLockTick(args: {
  mtm: number | null;
  lots: number;
  floor: number;
  peak: number | null;
  params: FlipLockParams;
}): ProfitLockStep {
  const floorNow = Number.isFinite(args.floor) && args.floor > 0 ? args.floor : 0;
  const peakNow = args.peak != null && Number.isFinite(args.peak) ? args.peak : null;
  if (args.mtm == null || !(args.lots > 0)) return { floor: floorNow, peak: peakNow, square: false };
  const levels = liveLockLevels(args.params, args.lots);
  let floor = floorNow;
  let peak = peakNow;
  if (args.mtm >= levels.step1) floor = Math.max(floor, levels.lock);
  if (args.mtm >= levels.trail) {
    peak = peak == null ? args.mtm : Math.max(peak, args.mtm);
    floor = Math.max(floor, round2((peak * levels.trailPercent) / 100));
  }
  return { floor, peak, square: floor > 0 && args.mtm <= floor };
}

/** This order's own fill, within max(1 point, 25 percent) of the live quote. Slippage is not added. */
export function flipFillCounts(fillPx: number | null | undefined, rate: number | null | undefined): boolean {
  if (typeof fillPx !== "number" || !Number.isFinite(fillPx) || !(fillPx > 0)) return false;
  if (typeof rate !== "number" || !Number.isFinite(rate) || !(rate > 0)) return false;
  const band = Math.max(1, rate * 0.25);
  return Math.abs(fillPx - rate) <= band + 1e-9;
}

export function assertFlipRules(): void {
  if (sellQuantity("NIFTY") !== 130 || sellQuantity("SENSEX") !== 40) throw new Error("sell qty");
  if (sellQuantity("NIFTY", 1) !== 65 || sellQuantity("SENSEX", 3) !== 60) throw new Error("lot box changes the sell qty");
  if (!parseFlipLots("2").ok || parseFlipLots("0").ok || parseFlipLots("51").ok) throw new Error("lots save");
  if (flipBuyQuantity(130) !== 260 || flipBuyQuantity(40) !== 80) throw new Error("flip buy qty");
  if (flipIndex("BANKNIFTY") !== null || flipIndex("NIFTY") !== "NIFTY") throw new Error("index gate");
  if (stageAtm(24326.4) !== 24350) throw new Error("stage round");
  if (entryStrike(24300, 24360) !== 24300) throw new Error("gap 60 keeps staged ATM");
  if (entryStrike(24300, 24361) !== 24350) throw new Error("gap past 60 rerounds");
  const bracket = atmBracket(24300);
  if (bracket[0] !== 24250 || bracket[1] !== 24300 || bracket[2] !== 24350) throw new Error("bracket");
  if (syntheticFuture(24300, 120.5, 110.25) !== 24310.25) throw new Error("synthetic");
  if (syntheticFuture(24300, 0, 10) !== null) throw new Error("synthetic needs both quotes");
  if (triggerPx(100, 15) !== 115 || triggerPx(100, 7) !== 107) throw new Error("trigger percent");
  if (triggerPx(80.1, 15) !== 92.12) throw new Error("trigger paise");
  const held = nextTrail(100, 101, 15);
  if (held.trailLow !== 100 || held.trigger !== 115) throw new Error("trail does not move up");
  const down = nextTrail(100, 99, 15);
  if (down.trailLow !== 99 || down.trigger !== 113.85) throw new Error("trail moves down");
  if (nextTrail(100, 0, 15).trailLow !== 100) throw new Error("zero print ignored");
  if (!shouldFlip("short", 115, 115) || shouldFlip("short", 114.99, 115) || shouldFlip("long", 200, 115)) {
    throw new Error("flip trigger");
  }
  const full = splitFlipBuy(130, 260);
  if (full.cover !== 130 || full.longQty !== 130 || full.shortLeft !== 0) throw new Error("full flip split");
  const partial = splitFlipBuy(130, 100);
  if (partial.cover !== 100 || partial.longQty !== 0 || partial.shortLeft !== 30) throw new Error("partial cover");
  if (shortMark(100, 90, 130) !== 1300) throw new Error("short mark");
  if (longMark(100, 110, 130) !== 1300) throw new Error("long mark");
  if (bookedShort(100, 110, 130) !== -1300) throw new Error("short booked");
  if (bookedLong(120, 100, 130) !== 2600) throw new Error("long booked");
  if (shortMark(100, 90, 130) !== (100 - 90) * 130) throw new Error("slippage must not enter the mark");
  if (tradableQuote(10, false) !== null || tradableQuote(0, true) !== null || tradableQuote(10, true) !== 10) {
    throw new Error("quote");
  }
  if (!bothQuoted(1, 1) || bothQuoted(1, 0) || bothQuoted(null, 1)) throw new Error("both quotes");
  const saveOk = parseFlipTrigger("7");
  const saveHi = parseFlipTrigger("15");
  if (!saveOk.ok || saveOk.trigger !== 7 || !saveHi.ok || saveHi.trigger !== 15) throw new Error("save 7 to 15");
  if (parseFlipTrigger("6").ok || parseFlipTrigger("16").ok || parseFlipTrigger("15.5").ok) throw new Error("save rejects outside 7 to 15");
  const monday = { year: 2026, month: 11, day: 23 };
  const picked = pickFlipExpiry(
    [
      { label: "22Nov2026", api: "past" },
      { label: "23Nov2026", api: "today" },
      { label: "28Nov2026", api: "saturday" },
      { label: "30Nov2026", api: "next" },
    ],
    monday,
  );
  if (picked?.api !== "today") throw new Error("nearest weekday expiry");
  const skipSat = pickFlipExpiry([{ label: "28Nov2026", api: "saturday" }, { label: "30Nov2026", api: "monday" }], monday);
  if (skipSat?.api !== "monday") throw new Error("weekend expiry skipped");
  if (clockPhase({ hour: 9, minute: 9, second: 59 }) !== "pre") throw new Error("before 09:10");
  if (clockPhase({ hour: 9, minute: 10, second: 0 }) !== "stage") throw new Error("09:10 stages");
  if (clockPhase({ hour: 9, minute: 14, second: 59 }) !== "stage") throw new Error("before 09:15 waits");
  if (clockPhase({ hour: 9, minute: 15, second: 0 }) !== "open") throw new Error("09:15 sells");
  if (clockPhase({ hour: 15, minute: 14, second: 59 }) !== "open") throw new Error("before 15:15 still open");
  if (clockPhase({ hour: 15, minute: 15, second: 0 }) !== "shut") throw new Error("15:15 flattens");
  if (!flipFillCounts(100, 100) || !flipFillCounts(100.4, 100)) throw new Error("broker fill counts, slippage is not added");
  if (flipFillCounts(140, 100)) throw new Error("a far print is not this fill");

  const lock = defaultFlipLock();
  if (lock.step1PerLot !== 1500 || lock.lockPerLot !== 1000 || lock.trailPerLot !== 1700 || lock.trailPercent !== 80) {
    throw new Error("profit lock defaults");
  }
  if (openLots([130, 130], "NIFTY") !== 2 || openLots([40, 40], "SENSEX") !== 2 || openLots([130], "NIFTY") !== 2) {
    throw new Error("open lots stay at the leg size");
  }
  const levels = liveLockLevels(lock, 2);
  if (levels.step1 !== 3000 || levels.lock !== 2000 || levels.trail !== 3400 || levels.trailPercent !== 80) {
    throw new Error("2 lot levels");
  }
  const none = profitLockTick({ mtm: 2999, lots: 2, floor: 0, peak: null, params: lock });
  if (none.floor !== 0 || none.square) throw new Error("2999 locks nothing");
  const armed = profitLockTick({ mtm: 3000, lots: 2, floor: 0, peak: null, params: lock });
  if (armed.floor !== 2000 || armed.square) throw new Error("3000 locks 2000 and stays open");
  const back = profitLockTick({ mtm: 2000, lots: 2, floor: armed.floor, peak: armed.peak, params: lock });
  if (!back.square || back.floor !== 2000) throw new Error("2000 squares");
  const peaked = profitLockTick({ mtm: 10000, lots: 2, floor: 0, peak: null, params: lock });
  if (peaked.peak !== 10000 || peaked.floor !== 8000 || peaked.square) throw new Error("10000 locks 80 percent, not 80 percent times lots");
  const heldPeak = profitLockTick({ mtm: 8500, lots: 2, floor: peaked.floor, peak: peaked.peak, params: lock });
  if (heldPeak.floor !== 8000 || heldPeak.peak !== 10000 || heldPeak.square) throw new Error("dip keeps the floor");
  const trailSquare = profitLockTick({ mtm: 8000, lots: 2, floor: heldPeak.floor, peak: heldPeak.peak, params: lock });
  if (!trailSquare.square || trailSquare.floor < 8000) throw new Error("8000 squares");
  const loss = profitLockTick({ mtm: -4000, lots: 2, floor: 0, peak: null, params: lock });
  if (loss.square || loss.floor !== 0) throw new Error("a loss before the lock does not square");
  const gap = profitLockTick({ mtm: null, lots: 2, floor: 2000, peak: 10000, params: lock });
  if (gap.square || gap.floor !== 2000 || gap.peak !== 10000) throw new Error("a missing price does not move the lock");
  if (parseFlipLock(draftFromLock(lock)).ok !== true) throw new Error("default lock saves");
  if (parseFlipLock({ ...draftFromLock(lock), trailPercent: "0" }).ok) throw new Error("trail percent rejects 0");

  if (reversalTrigger(100) !== 90 || reversalTrigger(140) !== 126) throw new Error("reversal is 10 percent under the buy");
  if (!shouldReverse("long", 90, 90) || shouldReverse("long", 90.01, 90) || shouldReverse("short", 80, 90)) {
    throw new Error("reversal fires only for a long at the stop");
  }
  const sold = splitFlipSell(130, 260);
  if (sold.cover !== 130 || sold.shortQty !== 130 || sold.longLeft !== 0) throw new Error("reversal sell splits 2x");
  if (nextLongTrail(100, null, 114.99) !== null) throw new Error("long trail waits for +15 percent");
  if (nextLongTrail(100, null, 115) !== 115) throw new Error("long trail arms at +15 percent");
  const armedHigh = nextLongTrail(100, 115, 130);
  if (armedHigh !== 130 || longExitPx(armedHigh) !== 123.5) throw new Error("trailing high rises and exits 5 percent under it");
  if (nextLongTrail(100, 130, 120) !== 130) throw new Error("trailing high does not fall");
  if (nextLongTrail(100, 130, 0) !== 130) throw new Error("a zero print does not clear the high");
  if (!shouldBookLong(123.5, 123.5) || shouldBookLong(123.51, 123.5) || shouldBookLong(100, null)) {
    throw new Error("long books on the pullback");
  }
  if (dayHaltTick(-5000) !== null || dayHaltTick(-20000) !== null) throw new Error("a loss does not close the day");
  if (dayHaltTick(14999) !== null || dayHaltTick(15000) !== "target") throw new Error("day target");
  if (parseEntryClock("09:15") !== 9 * 3600 + 15 * 60 || parseEntryClock("9:05") !== 9 * 3600 + 5 * 60) {
    throw new Error("entry clock");
  }
  if (parseEntryClock("09:15:00") !== 9 * 3600 + 15 * 60) throw new Error("entry clock ignores seconds");
  if (entryClockDraft("0915") !== "09:15" || entryClockDraft("09:1") !== "09:1") throw new Error("keyboard clock draft");
  if (parseEntryClock("24:00") !== null || parseEntryClock("09:60") !== null) throw new Error("entry clock rejects a bad time");
  const morning = { hour: 9, minute: 13, second: 0 };
  const open = { hour: 9, minute: 15, second: 0 };
  if (entryDue(morning, "timer", "09:15") || !entryDue(open, "timer", "09:15")) throw new Error("timer waits until the set time");
  if (!entryDue(morning, "normal", "09:15")) throw new Error("normal sells before the timer");
  if (entryDue({ hour: 15, minute: 15, second: 0 }, "normal", "09:15")) throw new Error("15:15 blocks a new sell");
  if (dayHaltTick(null) !== null) throw new Error("a missing day price does not exit");
  const otm = pickOtmStrike(
    [
      { strike: 25200, px: 130 },
      { strike: 25300, px: 90 },
      { strike: 25400, px: 68 },
      { strike: 25500, px: 40 },
      { strike: 25100, px: 70 },
    ],
    "CE",
    25200,
  );
  if (otm !== 25400) throw new Error("CE OTM nearest 70 and above the anchor");
  const putOtm = pickOtmStrike(
    [
      { strike: 25200, px: 140 },
      { strike: 25100, px: 80 },
      { strike: 25000, px: 72 },
      { strike: 24900, px: 60 },
    ],
    "PE",
    25200,
  );
  if (putOtm !== 25000) throw new Error("PE OTM nearest 70 and below the anchor");
  if (pickOtmStrike([{ strike: 25200, px: 70 }], "CE", 25200) !== null) throw new Error("the anchor itself is not OTM");
  if (flipStateName("short", "short") !== "STATE_A_SIDEWAYS") throw new Error("sideways");
  if (flipStateName("long", "short") !== "STATE_B_BULLISH") throw new Error("bullish");
  if (flipStateName("short", "long") !== "STATE_C_BEARISH") throw new Error("bearish");
  if (flipStateName("long", "long") !== "Both long. Squaring one.") throw new Error("two longs are named so the engine can square one");
}
