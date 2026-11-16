/**
 * 9:30 NIFTY weekly short strangle.
 * Lots, Min, SL%, Partner%, Day +, and Day − come from Save.
 * Day + and Day − are rupees per lot, then × lots. The live minimum is ₹100.
 * Start, cutoff, and square-off are stored. The live card is immediate, so those clocks do not block.
 * Orders are MARKET, price 0. One sell per START. A leg stop does not sell again.
 */

export const N930 = {
  lotSize: 65,
  strikeStep: 50,
  liveMin: 100,
  premiumJunkAt: 1000,
  allowResell: false,
  lotsMin: 1,
  lotsMax: 50,
  brokeragePerOrder: 20,
  sttSell: 0.0015,
  stampBuy: 0.00003,
  exchange: 0.000355299,
  sebi: 10 / 1e7,
  ipft: 50 / 1e7,
  gst: 0.18,
} as const;

export const N930_MIDDAY = {
  lots: 1,
  dayPlusPerLot: 600,
  dayMinusPerLot: 700,
  from: { hour: 12, minute: 45 },
  until: { hour: 13, minute: 0 },
} as const;

export type N930Side = "CE" | "PE";

export type N930Clock = { hour: number; minute: number };

export type N930Params = {
  lots: number;
  minPremium: number;
  slPct: number;
  partnerPct: number;
  dayPlusPerLot: number;
  dayMinusPerLot: number;
  start: N930Clock;
  cutoff: N930Clock;
  squareOff: N930Clock;
};

/** Built-in save before the user saves. The live card still sells at ₹100 on the live tick. */
export function defaultN930Params(): N930Params {
  return {
    lots: 10,
    minPremium: 100,
    slPct: 25,
    partnerPct: 15,
    dayPlusPerLot: 600,
    dayMinusPerLot: 700,
    start: { hour: 9, minute: 36 },
    cutoff: { hour: 10, minute: 30 },
    squareOff: { hour: 15, minute: 14 },
  };
}

export const N930_FYERS_PARAMS: N930Params = {
  lots: 1,
  minPremium: 100,
  slPct: 25,
  partnerPct: 15,
  dayPlusPerLot: 700,
  dayMinusPerLot: 700,
  start: { hour: 9, minute: 36 },
  cutoff: { hour: 10, minute: 30 },
  squareOff: { hour: 15, minute: 14 },
};

export type N930Draft = {
  lots: string;
  minPremium: string;
  slPct: string;
  partnerPct: string;
  dayPlusPerLot: string;
  dayMinusPerLot: string;
  start: string;
  cutoff: string;
  squareOff: string;
};

export type IstClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  date: string;
};

export type N930ExpiryPick = { label: string; api: string };

export type PremiumQuote = { strike: number; ltp: number };

export type N930LegSnap = {
  side: N930Side;
  open: boolean;
  sold: number;
  qty: number;
  ltp: number | null;
  slPx: number;
  slOn: boolean;
  lowPx: number | null;
  lockArmed: boolean;
  lockPct: number;
  closedBy: "sl" | "leftover" | "square" | null;
};

export type N930Action =
  | { type: "ENTER" }
  | { type: "SQUARE"; reason: "DAY_MINUS" | "DAY_PLUS" }
  | { type: "SL"; side: N930Side; via?: "partner" }
  | { type: "PARTNER"; side: N930Side; slPx: number }
  | { type: "MARK_LOW"; side: N930Side; lowPx: number }
  | { type: "ARM_LOCK"; side: N930Side; lockPct: number }
  | { type: "LEFTOVER"; side: N930Side };

export type N930Fill = { side: "BUY" | "SELL"; premium: number; qty: number };

export type ChargeBreakup = {
  brokerage: number;
  stt: number;
  stamp: number;
  exchange: number;
  sebi: number;
  ipft: number;
  gst: number;
  total: number;
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;
const EXPIRY_LABEL = /^(\d{2})([A-Za-z]{3})(\d{4})$/;

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

export function formatClock(clock: N930Clock): string {
  return `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
}

export function draftFromParams(params: N930Params): N930Draft {
  return {
    lots: String(params.lots),
    minPremium: String(params.minPremium),
    slPct: String(params.slPct),
    partnerPct: String(params.partnerPct),
    dayPlusPerLot: String(params.dayPlusPerLot),
    dayMinusPerLot: String(params.dayMinusPerLot),
    start: formatClock(params.start),
    cutoff: formatClock(params.cutoff),
    squareOff: formatClock(params.squareOff),
  };
}

function parseClock(text: string): N930Clock | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function clockMinute(clock: N930Clock): number {
  return clock.hour * 60 + clock.minute;
}

/** Stored clocks do not block. The live card is immediate. */
export function clocksBlockEntry(): boolean {
  return false;
}

function parsePositive(text: string, max: number): number | null {
  const raw = text.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

export function parseN930Params(draft: N930Draft): { ok: true; params: N930Params } | { ok: false; error: string } {
  if (!/^\d+$/.test(draft.lots.trim())) return { ok: false, error: "Lots must be a whole number." };
  const lots = Number(draft.lots);
  if (!Number.isInteger(lots) || lots < N930.lotsMin || lots > N930.lotsMax) {
    return { ok: false, error: `Lots must be ${N930.lotsMin}–${N930.lotsMax}.` };
  }
  const minPremium = parsePositive(draft.minPremium, 999);
  if (minPremium == null) return { ok: false, error: "Min premium must be above 0 and below 1000." };
  const slPct = parsePositive(draft.slPct, 100);
  const partnerPct = parsePositive(draft.partnerPct, 100);
  if (slPct == null || partnerPct == null) return { ok: false, error: "SL% and partner% must be above 0 and at most 100." };
  if (partnerPct > slPct) return { ok: false, error: "Partner% cannot be above SL%." };
  const dayPlusPerLot = parsePositive(draft.dayPlusPerLot, 1_000_000);
  const dayMinusPerLot = parsePositive(draft.dayMinusPerLot, 1_000_000);
  if (dayPlusPerLot == null || dayMinusPerLot == null) return { ok: false, error: "Day + and Day − must be rupees per lot." };
  const start = parseClock(draft.start);
  const cutoff = parseClock(draft.cutoff);
  const squareOff = parseClock(draft.squareOff);
  if (!start || !cutoff || !squareOff) return { ok: false, error: "Start, cutoff, and square-off must be HH:MM." };
  if (clockMinute(start) >= clockMinute(cutoff)) return { ok: false, error: "Start must be before cutoff." };
  if (clockMinute(squareOff) < clockMinute(cutoff)) return { ok: false, error: "Square-off must be at or after cutoff." };
  return {
    ok: true,
    params: { lots, minPremium, slPct, partnerPct, dayPlusPerLot, dayMinusPerLot, start, cutoff, squareOff },
  };
}

export function readN930Params(raw: unknown): N930Params {
  const base = defaultN930Params();
  if (!raw || typeof raw !== "object") return base;
  const row = raw as Partial<N930Params>;
  const rawStart = row.start ?? base.start;
  const rawCutoff = row.cutoff ?? base.cutoff;
  const rawSquare = row.squareOff ?? base.squareOff;
  const draft: N930Draft = {
    lots: String(row.lots ?? base.lots),
    minPremium: String(row.minPremium ?? base.minPremium),
    slPct: String(row.slPct ?? base.slPct),
    partnerPct: String(row.partnerPct ?? base.partnerPct),
    dayPlusPerLot: String(row.dayPlusPerLot ?? base.dayPlusPerLot),
    dayMinusPerLot: String(row.dayMinusPerLot ?? base.dayMinusPerLot),
    start: typeof rawStart === "string" ? rawStart : formatClock(rawStart),
    cutoff: typeof rawCutoff === "string" ? rawCutoff : formatClock(rawCutoff),
    squareOff: typeof rawSquare === "string" ? rawSquare : formatClock(rawSquare),
  };
  const parsed = parseN930Params(draft);
  return parsed.ok ? parsed.params : base;
}

export function orderQty(lots: number): number {
  return lots * N930.lotSize;
}

/** Saved rupees per lot × lots. One open leg keeps the same per-lot line. */
export function dayLine(perLot: number, lots: number): number {
  return perLot * lots;
}

export function slPrice(sold: number, pct: number): number {
  return sold * (1 + pct / 100);
}

/** Partner stop never loosens. */
export function partnerSl(currentSl: number, sold: number, partnerPct: number): number {
  return Math.min(currentSl, slPrice(sold, partnerPct));
}

export function favPct(sold: number, lowPx: number): number {
  if (!(sold > 0)) return 0;
  return ((sold - lowPx) / sold) * 100;
}

/** Best favorable fall. Under 25 there is no lock. The lock only tightens. */
export function leftoverLockPct(fav: number): number | null {
  if (!(fav >= 25)) return null;
  if (fav >= 45) return 30 + Math.floor(fav - 45 + 1e-9);
  if (fav >= 40) return 25;
  if (fav >= 35) return 10;
  if (fav >= 30) return 5;
  return 0;
}

export function lockCoverPx(sold: number, lockPct: number): number {
  return sold * (1 - lockPct / 100);
}

/** 12:45 inclusive through 12:59. 13:00 is outside. */
export function middaySlot(clock: Pick<IstClock, "hour" | "minute">): boolean {
  const mins = clock.hour * 60 + clock.minute;
  const from = N930_MIDDAY.from.hour * 60 + N930_MIDDAY.from.minute;
  const until = N930_MIDDAY.until.hour * 60 + N930_MIDDAY.until.minute;
  return mins >= from && mins < until;
}

/** A live option premium. Blank, 0, and a print at or above ₹1000 are not prices. */
export function goodPremium(px: number | null | undefined): number | null {
  if (typeof px !== "number" || !Number.isFinite(px) || px <= 0 || px >= N930.premiumJunkAt) return null;
  return px;
}

/** Cheapest live premium at or above min. A print under min is skipped. Equal rates keep the lower strike. */
export function pickCheapest<T extends PremiumQuote>(quotes: readonly T[], minPremium: number): T | null {
  let best: T | null = null;
  for (const quote of quotes) {
    const ltp = goodPremium(quote.ltp);
    if (ltp == null || ltp < minPremium) continue;
    if (!best || ltp < best.ltp - 1e-9 || (Math.abs(ltp - best.ltp) <= 1e-9 && quote.strike < best.strike)) {
      best = { ...quote, ltp };
    }
  }
  return best;
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

export type WeekPick = {
  trade: N930ExpiryPick;
  thisWeek: N930ExpiryPick;
  nextWeek: N930ExpiryPick;
};

/**
 * Listed expiries on or after today. The top bar expiry is not used.
 * Wed–Fri sell the nearest listed expiry. Mon–Tue skip that nearby expiry and sell the next one.
 * Saturday and Sunday are not contracts. A Tuesday holiday is already the previous trading day
 * in the broker list, so that date is the next expiry. If that expiry is not listed, there is no entry.
 */
export function pickNiftyWeek(rows: readonly N930ExpiryPick[], clock: Pick<IstClock, "year" | "month" | "day">): WeekPick | null {
  const today = civilKey(clock.year, clock.month, clock.day);
  if (today == null) return null;
  const weekday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  const listed: { key: number; pick: N930ExpiryPick }[] = [];
  for (const row of rows) {
    const label = String(row?.label || "").trim();
    const api = String(row?.api || "").trim();
    if (!EXPIRY_LABEL.test(label.replace(/[\s\-_/]/g, ""))) continue;
    const key = expiryDayKey(label);
    if (!label || !api || key == null || key < today) continue;
    const expiryWeekday = weekdayOfKey(key);
    if (expiryWeekday === 0 || expiryWeekday === 6) continue;
    listed.push({ key, pick: { label, api } });
  }
  listed.sort((a, b) => a.key - b.key);
  if (!listed.length) return null;
  const skipNearby = weekday === 1 || weekday === 2;
  if (skipNearby) {
    if (listed.length < 2) return null;
    return { trade: listed[1]!.pick, thisWeek: listed[0]!.pick, nextWeek: listed[1]!.pick };
  }
  const nearby = listed[0]!;
  const following = listed[1] ?? nearby;
  return { trade: nearby.pick, thisWeek: nearby.pick, nextWeek: following.pick };
}

export type DayMark = { mtm: number | null; ready: boolean };

/** Open mark is (sold − LTP) × qty plus booked legs. A blank open leg makes the whole mark blank. */
export function dayMtm(legs: readonly N930LegSnap[], realized: number): DayMark {
  let marked = 0;
  let anyOpen = false;
  for (const leg of legs) {
    if (!leg.open) continue;
    anyOpen = true;
    if (leg.ltp == null) return { mtm: null, ready: false };
    marked += (leg.sold - leg.ltp) * leg.qty;
  }
  if (!anyOpen) return { mtm: realized, ready: true };
  return { mtm: realized + marked, ready: true };
}

/**
 * Day −, then Day +, and only when every open leg has a live premium.
 * A 25% stop does not run on the tick that squares the day.
 * After one leg stop, the survivor uses the partner stop. Leftover cover does not
 * fire on the same tick as that 25% stop or the partner stop.
 */
export function tickActions(args: {
  entered: boolean;
  squared: boolean;
  legs: readonly N930LegSnap[];
  dayPlus: number;
  dayMinus: number;
  slPct: number;
  partnerPct: number;
  realized: number;
}): N930Action[] {
  if (!args.entered && !args.squared) return [{ type: "ENTER" }];
  if (!args.entered || args.squared) return [];
  const open = args.legs.filter((leg) => leg.open);
  if (!open.length) return [];
  const mark = dayMtm(args.legs, args.realized);
  if (mark.ready && mark.mtm != null && mark.mtm <= -args.dayMinus) return [{ type: "SQUARE", reason: "DAY_MINUS" }];
  if (mark.ready && mark.mtm != null && mark.mtm >= args.dayPlus) return [{ type: "SQUARE", reason: "DAY_PLUS" }];

  const siblingStopped = args.legs.some((leg) => !leg.open && leg.closedBy === "sl");
  if (!siblingStopped) {
    const stops: N930Action[] = [];
    for (const leg of open) {
      if (!leg.slOn || leg.ltp == null) continue;
      if (leg.ltp + 1e-6 >= slPrice(leg.sold, args.slPct)) stops.push({ type: "SL", side: leg.side });
    }
    return stops;
  }
  if (open.length !== 1) return [];
  const leg = open[0]!;
  const actions: N930Action[] = [];
  const current = leg.slOn ? slPrice(leg.sold, args.slPct) : leg.slPx;
  const tightened = partnerSl(current, leg.sold, args.partnerPct);
  let slPx = current;
  if (tightened < slPx - 1e-9) {
    slPx = tightened;
    actions.push({ type: "PARTNER", side: leg.side, slPx });
  }
  if (leg.ltp == null) return actions;
  if (leg.ltp + 1e-6 >= slPx) {
    actions.push({ type: "SL", side: leg.side, via: "partner" });
    return actions;
  }
  const low = leg.lowPx == null ? leg.ltp : Math.min(leg.lowPx, leg.ltp);
  if (leg.lowPx == null || low < leg.lowPx - 1e-9) actions.push({ type: "MARK_LOW", side: leg.side, lowPx: low });
  const rung = leftoverLockPct(favPct(leg.sold, low));
  if (rung != null && (!leg.lockArmed || rung > leg.lockPct + 1e-9)) {
    actions.push({ type: "ARM_LOCK", side: leg.side, lockPct: rung });
  }
  if (
    leg.lockArmed &&
    leg.lowPx != null &&
    leg.ltp > leg.lowPx + 1e-9 &&
    leg.ltp + 1e-6 >= lockCoverPx(leg.sold, leg.lockPct)
  ) {
    actions.push({ type: "LEFTOVER", side: leg.side });
  }
  return actions;
}

export type LegAck = { filledQty: number; fillPx: number | null; rate: number | null };

export type PairPlan =
  | { type: "book"; ceQty: number; cePx: number; peQty: number; pePx: number }
  | { type: "unwind"; side: N930Side }
  | { type: "none" };

/** This order's fill counts only within max(1 point, 25 percent) of that strike's live rate. */
export function fillCounts(fillPx: number | null | undefined, rate: number | null | undefined): boolean {
  if (typeof fillPx !== "number" || !Number.isFinite(fillPx) || !(fillPx > 0)) return false;
  const live = goodPremium(rate);
  if (live == null) return false;
  const band = Math.max(1, live * 0.25);
  return Math.abs(fillPx - live) <= band + 1e-9;
}

export type SellAck = LegAck & { rejected: boolean };

export type EntryPlan =
  | { type: "book"; ceQty: number; cePx: number; peQty: number; pePx: number }
  | { type: "retry"; side: N930Side }
  | { type: "keep"; side: N930Side; qty: number; px: number }
  | { type: "none" };

/** Both fills book. A confirmed reject retries once. No confirmation keeps the filled short. */
export function entryPlan(ce: SellAck, pe: SellAck): EntryPlan {
  const own = (ack: SellAck) => ack.filledQty > 0 && fillCounts(ack.fillPx, ack.rate);
  const ceOwn = own(ce);
  const peOwn = own(pe);
  if (ceOwn && peOwn) {
    return { type: "book", ceQty: ce.filledQty, cePx: ce.fillPx!, peQty: pe.filledQty, pePx: pe.fillPx! };
  }
  if (ceOwn && pe.rejected) return { type: "retry", side: "PE" };
  if (peOwn && ce.rejected) return { type: "retry", side: "CE" };
  if (ceOwn) return { type: "keep", side: "CE", qty: ce.filledQty, px: ce.fillPx! };
  if (peOwn) return { type: "keep", side: "PE", qty: pe.filledQty, px: pe.fillPx! };
  return { type: "none" };
}

/** A price from another contract is not a fill. One leg at its own rate is bought back. Neither is not a position. */
export function pairFillPlan(ce: LegAck, pe: LegAck): PairPlan {
  const own = (ack: LegAck) => ack.filledQty > 0 && fillCounts(ack.fillPx, ack.rate);
  const ceOwn = own(ce);
  const peOwn = own(pe);
  if (ceOwn && peOwn) {
    return { type: "book", ceQty: ce.filledQty, cePx: ce.fillPx!, peQty: pe.filledQty, pePx: pe.fillPx! };
  }
  if (ceOwn) return { type: "unwind", side: "CE" };
  if (peOwn) return { type: "unwind", side: "PE" };
  return { type: "none" };
}

/** ROUND_HALF_UP to a paise, then the caller sums. */
export function roundHalfUpPaise(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const [whole, frac = ""] = Math.abs(n).toFixed(8).split(".");
  const digits = `${frac}000`;
  let paise = Number(whole) * 100 + Number(digits.slice(0, 2));
  if (digits[2]! >= "5") paise += 1;
  return (sign * paise) / 100;
}

export function chargeBreakup(fills: readonly N930Fill[]): ChargeBreakup {
  let brokerage = 0;
  let stt = 0;
  let stamp = 0;
  let exchange = 0;
  let sebi = 0;
  let ipft = 0;
  for (const fill of fills) {
    if (!(fill.premium > 0) || !(fill.qty > 0)) continue;
    const turnover = fill.premium * fill.qty;
    brokerage += N930.brokeragePerOrder;
    exchange += turnover * N930.exchange;
    sebi += turnover * N930.sebi;
    ipft += turnover * N930.ipft;
    if (fill.side === "SELL") stt += turnover * N930.sttSell;
    else stamp += turnover * N930.stampBuy;
  }
  brokerage = roundHalfUpPaise(brokerage);
  stt = roundHalfUpPaise(stt);
  stamp = roundHalfUpPaise(stamp);
  exchange = roundHalfUpPaise(exchange);
  sebi = roundHalfUpPaise(sebi);
  ipft = roundHalfUpPaise(ipft);
  const gst = roundHalfUpPaise((brokerage + exchange + sebi + ipft) * N930.gst);
  const total = roundHalfUpPaise(stt + stamp + exchange + sebi + ipft + gst + brokerage);
  return { brokerage, stt, stamp, exchange, sebi, ipft, gst, total };
}

export function netPnl(gross: number, fills: readonly N930Fill[]): { gross: number; charges: number; net: number } {
  const charges = chargeBreakup(fills).total;
  const booked = roundHalfUpPaise(gross);
  return { gross: booked, charges, net: roundHalfUpPaise(booked - charges) };
}

export function assertNineThirtyRules(): void {
  const xts = defaultN930Params();
  if (dayLine(xts.dayPlusPerLot, 10) !== 6000 || dayLine(xts.dayMinusPerLot, 10) !== 7000 || dayLine(700, 1) !== 700) {
    throw new Error("Day + and Day − are rupees per lot");
  }
  if (clocksBlockEntry()) throw new Error("stored clocks do not block the live card");
  if (!middaySlot({ hour: 12, minute: 45 }) || middaySlot({ hour: 12, minute: 44 }) || middaySlot({ hour: 13, minute: 0 })) {
    throw new Error("midday slot is 12:45 until 13:00");
  }
  const badPartner = parseN930Params({ ...draftFromParams(xts), partnerPct: "30", slPct: "25" });
  if (badPartner.ok) throw new Error("partner cannot be above SL");
  const badClock = parseN930Params({ ...draftFromParams(xts), start: "11:00", cutoff: "10:30" });
  if (badClock.ok) throw new Error("start must be before cutoff");
  if (xts.start.hour !== 9 || xts.start.minute !== 36 || xts.squareOff.hour !== 15) throw new Error("built-in clocks");
  if (orderQty(10) !== 650 || orderQty(1) !== 65) throw new Error("lot 65");
  if (goodPremium(null) !== null || goodPremium(0) !== null || goodPremium(1000) !== null || goodPremium(24500) !== null) {
    throw new Error("junk is not a price");
  }
  if (goodPremium(100) !== 100) throw new Error("100 is a price");

  const book = [
    { strike: 24000, ltp: 87 },
    { strike: 23950, ltp: 100 },
    { strike: 23900, ltp: 140 },
  ];
  const picked = pickCheapest(book, 100);
  if (!picked || picked.strike !== 23950 || picked.ltp !== 100) throw new Error("87 is skipped; cheapest at min is 100");
  if (pickCheapest([{ strike: 1, ltp: 0 }], 100) !== null) throw new Error("blank is not zero and is not a sell");
  const tied = pickCheapest(
    [
      { strike: 25700, ltp: 108 },
      { strike: 25650, ltp: 108 },
    ],
    100,
  );
  if (tied?.strike !== 25650) throw new Error("equal rates keep the lower strike");

  const both = (ce: number | null, pe: number | null, qty = 650, patch?: Partial<N930LegSnap>): N930LegSnap[] => [
    {
      side: "CE",
      open: true,
      sold: 100,
      qty,
      ltp: ce,
      slPx: 125,
      slOn: true,
      lowPx: null,
      lockArmed: false,
      lockPct: 0,
      closedBy: null,
      ...patch,
    },
    {
      side: "PE",
      open: true,
      sold: 100,
      qty,
      ltp: pe,
      slPx: 125,
      slOn: true,
      lowPx: null,
      lockArmed: false,
      lockPct: 0,
      closedBy: null,
    },
  ];
  const act = (legs: N930LegSnap[], patch?: Partial<Parameters<typeof tickActions>[0]>) =>
    tickActions({
      entered: true,
      squared: false,
      legs,
      dayPlus: 6000,
      dayMinus: 7000,
      slPct: 25,
      partnerPct: 15,
      realized: 0,
      ...patch,
    });

  if (act(both(100, 100), { entered: false })[0]?.type !== "ENTER") throw new Error("entry is first");
  if (act(both(100, 100)).some((row) => row.type === "SQUARE")) throw new Error("no clock square");
  const down = act(both(120, 120));
  if (down.length !== 1 || down[0]?.type !== "SQUARE" || (down[0].type === "SQUARE" && down[0].reason !== "DAY_MINUS")) {
    throw new Error("Day − books both legs");
  }
  const up = act(both(90, 90));
  if (up[0]?.type !== "SQUARE" || (up[0].type === "SQUARE" && up[0].reason !== "DAY_PLUS")) throw new Error("Day + squares the pair");
  if (act(both(90, null)).some((row) => row.type === "SQUARE")) throw new Error("Day + needs a good LTP on every open leg");
  if (act(both(124, null)).length !== 0) throw new Error("a missing premium blocks the day square");
  const sl = act(both(125, 100, 65));
  if (sl.length !== 1 || sl[0]?.type !== "SL" || (sl[0].type === "SL" && sl[0].via === "partner")) {
    throw new Error("25% stop closes only that leg");
  }
  if (act(both(80, 100, 65)).length !== 0) throw new Error("both open: no leftover and no partner");
  if (act(both(100, 100), { squared: true }).length !== 0) throw new Error("no resell after the day is done");

  const afterSl = both(null, 100, 65);
  afterSl[0] = { ...afterSl[0]!, open: false, ltp: null, slOn: false, closedBy: "sl" };
  const partner = act(afterSl);
  const tightened = partner.find((row) => row.type === "PARTNER" && row.side === "PE");
  if (!tightened || tightened.type !== "PARTNER" || Math.abs(tightened.slPx - 115) > 1e-6) {
    throw new Error("one SL tightens the other stop to 15%");
  }
  if (partner.some((row) => row.type === "LEFTOVER" || row.type === "SL")) throw new Error("the partner tick does not cover at cost");

  const partnerHit = both(null, 115, 65);
  partnerHit[0] = { ...partnerHit[0]!, open: false, ltp: null, slOn: false, closedBy: "sl" };
  const hit = act(partnerHit);
  if (!hit.some((row) => row.type === "SL" && row.via === "partner")) throw new Error("partner stop covers at sold × 1.15");
  if (hit.some((row) => row.type === "LEFTOVER")) throw new Error("partner stop does not also fire leftover");

  const deep = both(null, 70, 65);
  deep[0] = { ...deep[0]!, open: false, ltp: null, slOn: false, closedBy: "sl" };
  const locked = act(deep);
  const arm = locked.find((row) => row.type === "ARM_LOCK");
  if (!arm || arm.type !== "ARM_LOCK" || arm.lockPct !== 5) throw new Error("30% favorable locks 5");
  if (locked.some((row) => row.type === "LEFTOVER")) throw new Error("the new low does not cover");

  const giveback = both(null, 95, 65);
  giveback[0] = { ...giveback[0]!, open: false, ltp: null, slOn: false, closedBy: "sl" };
  giveback[1] = { ...giveback[1]!, slOn: false, slPx: 115, lowPx: 70, lockArmed: true, lockPct: 5 };
  if (!act(giveback).some((row) => row.type === "LEFTOVER" && row.side === "PE")) throw new Error("price back to the lock covers");
  if (leftoverLockPct(24) !== null || leftoverLockPct(25) !== 0 || leftoverLockPct(45) !== 30 || leftoverLockPct(46) !== 31) {
    throw new Error("leftover rungs");
  }

  const kept = entryPlan(
    { filledQty: 65, fillPx: 110, rate: 110, rejected: false },
    { filledQty: 0, fillPx: null, rate: 108, rejected: false },
  );
  if (kept.type !== "keep" || kept.side !== "CE") throw new Error("an unconfirmed sell keeps the filled short");
  const retry = entryPlan(
    { filledQty: 65, fillPx: 110, rate: 110, rejected: false },
    { filledQty: 0, fillPx: null, rate: 108, rejected: true },
  );
  if (retry.type !== "retry" || retry.side !== "PE") throw new Error("a confirmed reject retries the missing sell");

  const underBook = act(both(110, 100, 130), { dayPlus: 1200, dayMinus: 1400 });
  if (underBook.some((row) => row.type === "SQUARE")) throw new Error("−1300 does not book a 1400 combined loss");
  const combinedLoss = act(both(111, 100, 130), { dayPlus: 1200, dayMinus: 1400 });
  if (
    combinedLoss.length !== 1 ||
    combinedLoss[0]?.type !== "SQUARE" ||
    (combinedLoss[0].type === "SQUARE" && combinedLoss[0].reason !== "DAY_MINUS")
  ) {
    throw new Error("−1430 books both legs at the 1400 combined loss");
  }
  const underProfit = act(both(91, 100, 130), { dayPlus: 1200, dayMinus: 1400 });
  if (underProfit.some((row) => row.type === "SQUARE")) throw new Error("1170 does not book a 1200 combined profit");
  const combinedProfit = act(both(90, 100, 130), { dayPlus: 1200, dayMinus: 1400 });
  if (
    combinedProfit[0]?.type !== "SQUARE" ||
    (combinedProfit[0].type === "SQUARE" && combinedProfit[0].reason !== "DAY_PLUS")
  ) {
    throw new Error("1300 books both legs at the 1200 combined profit");
  }

  const monday = pickNiftyWeek(
    [
      { label: "10Nov2026", api: "10" },
      { label: "17Nov2026", api: "17" },
      { label: "24Nov2026", api: "24" },
    ],
    { year: 2026, month: 11, day: 9 },
  );
  if (monday?.trade.label !== "17Nov2026" || monday.thisWeek.label !== "10Nov2026") {
    throw new Error("Monday skips the nearby Tuesday");
  }
  const friday = pickNiftyWeek(
    [
      { label: "10Nov2026", api: "10" },
      { label: "17Nov2026", api: "17" },
    ],
    { year: 2026, month: 11, day: 6 },
  );
  if (friday?.trade.label !== "10Nov2026" || friday.nextWeek.label !== "17Nov2026") {
    throw new Error("Friday takes the nearest Tuesday");
  }
  const tuesday = pickNiftyWeek(
    [
      { label: "10Nov2026", api: "10" },
      { label: "17Nov2026", api: "17" },
    ],
    { year: 2026, month: 11, day: 10 },
  );
  if (tuesday?.trade.label !== "17Nov2026") throw new Error("Tuesday does not sell the same-day weekly");
  const wednesday = pickNiftyWeek(
    [
      { label: "17Nov2026", api: "17" },
      { label: "24Nov2026", api: "24" },
    ],
    { year: 2026, month: 11, day: 11 },
  );
  if (wednesday?.trade.label !== "17Nov2026") throw new Error("Wednesday 11 Nov 2026 selects 17Nov2026");
  const mondayLater = pickNiftyWeek(
    [
      { label: "17Nov2026", api: "17" },
      { label: "24Nov2026", api: "24" },
    ],
    { year: 2026, month: 11, day: 16 },
  );
  if (mondayLater?.trade.label !== "24Nov2026") throw new Error("Monday 16 Nov 2026 skips 17Nov2026");
  const holidayShift = pickNiftyWeek(
    [
      { label: "17Nov2026", api: "17" },
      { label: "23Nov2026", api: "23" },
      { label: "01Dec2026", api: "01" },
    ],
    { year: 2026, month: 11, day: 16 },
  );
  if (holidayShift?.trade.label !== "23Nov2026" || holidayShift.thisWeek.label !== "17Nov2026") {
    throw new Error("Monday 16 Nov 2026 skips 17 Nov and takes 23 Nov, not 1 Dec");
  }
  const expiryDay = pickNiftyWeek(
    [
      { label: "17Nov2026", api: "17" },
      { label: "24Nov2026", api: "24" },
    ],
    { year: 2026, month: 11, day: 17 },
  );
  if (expiryDay?.trade.label !== "24Nov2026") throw new Error("Tuesday 17 Nov 2026 skips 17Nov2026");
  if (pickNiftyWeek([{ label: "17Nov2026", api: "17" }], { year: 2026, month: 11, day: 17 }) !== null) {
    throw new Error("no expiry after the nearby one means no entry");
  }
  const fridayListed = pickNiftyWeek([{ label: "13Nov2026", api: "13" }], { year: 2026, month: 11, day: 11 });
  if (fridayListed?.trade.label !== "13Nov2026") throw new Error("a listed Friday expiry is the contract");
  if (pickNiftyWeek([{ label: "14Nov2026", api: "14" }], { year: 2026, month: 11, day: 13 }) !== null) {
    throw new Error("Saturday is not an expiry");
  }

  if (fillCounts(4.55, 108) || fillCounts(4.05, 108)) throw new Error("4.55 against 108 is not a fill");
  if (!fillCounts(108.4, 108) || !fillCounts(81, 108) || fillCounts(80, 108)) {
    throw new Error("fill must sit within max(1, 25 percent) of the live rate");
  }
  const plan = pairFillPlan(
    { filledQty: 650, fillPx: 98, rate: 100 },
    { filledQty: 650, fillPx: 101, rate: 100 },
  );
  if (plan.type !== "book" || plan.cePx !== 98) throw new Error("a fill under min stays the sold price");
  const oneSide = pairFillPlan(
    { filledQty: 650, fillPx: 100, rate: 100 },
    { filledQty: 0, fillPx: null, rate: 100 },
  );
  if (oneSide.type !== "unwind" || oneSide.side !== "CE") throw new Error("one side at its own rate is bought back");
  const missingPx = pairFillPlan(
    { filledQty: 650, fillPx: null, rate: 100 },
    { filledQty: 650, fillPx: 100, rate: 100 },
  );
  if (missingPx.type !== "unwind" || missingPx.side !== "PE") throw new Error("no average price is not a booked fill");
  const sensex = pairFillPlan(
    { filledQty: 650, fillPx: 4.55, rate: 108 },
    { filledQty: 650, fillPx: 4.05, rate: 108 },
  );
  if (sensex.type !== "none") throw new Error("a SENSEX fill is not booked and is not bought back");
  const mixed = pairFillPlan(
    { filledQty: 650, fillPx: 108.4, rate: 108 },
    { filledQty: 650, fillPx: 4.55, rate: 102 },
  );
  if (mixed.type !== "unwind" || mixed.side !== "CE") throw new Error("only the leg at its own rate is bought back");

  const round = netPnl(1300, [
    { side: "SELL", premium: 100, qty: 65 },
    { side: "BUY", premium: 80, qty: 65 },
  ]);
  if (round.gross !== 1300 || round.charges !== 62.1 || round.net !== 1237.9) {
    throw new Error(`charges ${round.charges} net ${round.net}`);
  }
  if (roundHalfUpPaise(0.065) !== 0.07 || roundHalfUpPaise(0.325) !== 0.33) throw new Error("half up paise");
}
