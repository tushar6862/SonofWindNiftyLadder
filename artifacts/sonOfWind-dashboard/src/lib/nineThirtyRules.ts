/**
 * 9:30 NIFTY weekly short strangle.
 * Clocks, lots, min, SL%, partner%, Day +, and Day − come from saved parameters.
 * Prices are this contract's live premium. Blank, 0, and index-scale junk are not prices.
 * ALLOW_RESELL is false: one pair, and a strike is done after its own SL.
 */

export const N930 = {
  lotSize: 65,
  strikeStep: 50,
  premiumJunkAt: 1000,
  allowResell: false,
  warmupMin: 1,
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

export type N930Side = "CE" | "PE";

export type N930Params = {
  startMin: number;
  cutoffMin: number;
  eodMin: number;
  lots: number;
  minPremium: number;
  slPct: number;
  partnerPct: number;
  dayPlusPerLot: number;
  dayMinusPerLot: number;
};

/** XTS book saved 9 Nov 2026. Fyers / Upstox is a different save, not this default. */
export function defaultN930Params(): N930Params {
  return {
    startMin: 9 * 60 + 36,
    cutoffMin: 10 * 60 + 30,
    eodMin: 15 * 60 + 14,
    lots: 10,
    minPremium: 100,
    slPct: 25,
    partnerPct: 15,
    dayPlusPerLot: 600,
    dayMinusPerLot: 700,
  };
}

export const N930_FYERS_PARAMS: N930Params = {
  startMin: 9 * 60 + 31,
  cutoffMin: 9 * 60 + 36,
  eodMin: 15 * 60 + 14,
  lots: 1,
  minPremium: 100,
  slPct: 25,
  partnerPct: 15,
  dayPlusPerLot: 700,
  dayMinusPerLot: 700,
};

export type N930Draft = {
  start: string;
  cutoff: string;
  eod: string;
  lots: string;
  minPremium: string;
  slPct: string;
  partnerPct: string;
  dayPlusPerLot: string;
  dayMinusPerLot: string;
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
  lockArmed: boolean;
  lockPct: number;
  closedBy: "sl" | "leftover" | "square" | null;
};

export type N930Action =
  | { type: "ENTER" }
  | { type: "SQUARE"; reason: "EOD" | "DAY_MINUS" | "DAY_PLUS" }
  | { type: "SL"; side: N930Side }
  | { type: "PARTNER"; side: N930Side; slPx: number }
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

export function clockMinutes(clock: Pick<IstClock, "hour" | "minute">): number {
  return clock.hour * 60 + clock.minute;
}

export function formatHm(mins: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.trunc(mins)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function draftFromParams(params: N930Params): N930Draft {
  return {
    start: formatHm(params.startMin),
    cutoff: formatHm(params.cutoffMin),
    eod: formatHm(params.eodMin),
    lots: String(params.lots),
    minPremium: String(params.minPremium),
    slPct: String(params.slPct),
    partnerPct: String(params.partnerPct),
    dayPlusPerLot: String(params.dayPlusPerLot),
    dayMinusPerLot: String(params.dayMinusPerLot),
  };
}

function parseClock(text: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function parsePositive(text: string, max: number): number | null {
  const raw = text.trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

export function parseN930Params(draft: N930Draft): { ok: true; params: N930Params } | { ok: false; error: string } {
  const startMin = parseClock(draft.start);
  const cutoffMin = parseClock(draft.cutoff);
  const eodMin = parseClock(draft.eod);
  if (startMin == null || cutoffMin == null || eodMin == null) return { ok: false, error: "Clocks must be HH:MM." };
  if (startMin >= cutoffMin) return { ok: false, error: "Start must be before Cutoff." };
  if (eodMin < cutoffMin) return { ok: false, error: "Square-off must be at or after Cutoff." };
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
  return {
    ok: true,
    params: { startMin, cutoffMin, eodMin, lots, minPremium, slPct, partnerPct, dayPlusPerLot, dayMinusPerLot },
  };
}

export function readN930Params(raw: unknown): N930Params {
  const base = defaultN930Params();
  if (!raw || typeof raw !== "object") return base;
  const row = raw as Partial<N930Params>;
  const draft: N930Draft = {
    start: formatHm(typeof row.startMin === "number" ? row.startMin : base.startMin),
    cutoff: formatHm(typeof row.cutoffMin === "number" ? row.cutoffMin : base.cutoffMin),
    eod: formatHm(typeof row.eodMin === "number" ? row.eodMin : base.eodMin),
    lots: String(row.lots ?? base.lots),
    minPremium: String(row.minPremium ?? base.minPremium),
    slPct: String(row.slPct ?? base.slPct),
    partnerPct: String(row.partnerPct ?? base.partnerPct),
    dayPlusPerLot: String(row.dayPlusPerLot ?? base.dayPlusPerLot),
    dayMinusPerLot: String(row.dayMinusPerLot ?? base.dayMinusPerLot),
  };
  const parsed = parseN930Params(draft);
  return parsed.ok ? parsed.params : base;
}

export function orderQty(lots: number): number {
  return lots * N930.lotSize;
}

export function dayLine(perLot: number, lots: number): number {
  return perLot * lots;
}

/** A live option premium. Blank, 0, and a print at or above ₹1000 are not prices. */
export function goodPremium(px: number | null | undefined): number | null {
  if (typeof px !== "number" || !Number.isFinite(px) || px <= 0 || px >= N930.premiumJunkAt) return null;
  return px;
}

export function slPrice(sold: number, pct: number): number {
  return sold * (1 + pct / 100);
}

/** Partner stop never moves up. */
export function partnerSl(currentSl: number, sold: number, partnerPct: number): number {
  return Math.min(currentSl, slPrice(sold, partnerPct));
}

export function favPct(sold: number, ltp: number): number {
  if (!(sold > 0)) return 0;
  return ((sold - ltp) / sold) * 100;
}

/**
 * Leftover lock percent once favorable percent is on a rung.
 * 20% favorable is not a lock. After 45%, each extra 1% favorable adds 1% lock.
 */
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

/** Cheapest live premium that is still at or above min. A print under min is skipped. */
export function pickCheapest<T extends PremiumQuote>(quotes: readonly T[], minPremium: number): T | null {
  let best: T | null = null;
  for (const quote of quotes) {
    const ltp = goodPremium(quote.ltp);
    if (ltp == null || ltp < minPremium) continue;
    if (!best || ltp < best.ltp - 1e-9 || (Math.abs(ltp - best.ltp) <= 1e-9 && quote.strike > best.strike)) {
      best = { ...quote, ltp };
    }
  }
  return best;
}

export function entryWindow(mins: number, params: N930Params): boolean {
  return mins >= params.startMin && mins < params.cutoffMin;
}

export function warmupDue(mins: number, params: N930Params): boolean {
  return mins >= params.startMin - N930.warmupMin && mins < params.cutoffMin;
}

export function eodDue(mins: number, params: N930Params): boolean {
  return mins >= params.eodMin;
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
 * Tue weekly only.
 * Wed–Fri trade the nearest Tuesday. Mon–Tue skip that nearby Tuesday and trade the next one.
 * Both weeks are subscribed. Both legs use the trade expiry.
 */
export function pickNiftyWeek(rows: readonly N930ExpiryPick[], clock: Pick<IstClock, "year" | "month" | "day">): WeekPick | null {
  const today = civilKey(clock.year, clock.month, clock.day);
  if (today == null) return null;
  const weekday = new Date(Date.UTC(clock.year, clock.month - 1, clock.day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  const dated: { key: number; pick: N930ExpiryPick; tuesday: boolean }[] = [];
  for (const row of rows) {
    const label = String(row?.label || "").trim();
    const api = String(row?.api || "").trim();
    const key = expiryDayKey(label) ?? expiryDayKey(api);
    if (!label || !api || key == null || key < today) continue;
    dated.push({ key, pick: { label, api }, tuesday: weekdayOfKey(key) === 2 });
  }
  dated.sort((a, b) => a.key - b.key);
  const tuesdays = dated.filter((row) => row.tuesday);
  const book = tuesdays.length >= 2 ? tuesdays : dated;
  if (!book.length) return null;
  const nearby = book[0]!;
  const following = book[1] ?? book[0]!;
  const skipNearby = (weekday === 1 || weekday === 2) && book.length >= 2;
  return skipNearby
    ? { trade: following.pick, thisWeek: nearby.pick, nextWeek: following.pick }
    : { trade: nearby.pick, thisWeek: nearby.pick, nextWeek: following.pick };
}

export type DayMark = { mtm: number; dayPlusReady: boolean };

/** Open mark is (sold − LTP) × qty. A blank leg is unmarked, not ₹0. */
export function dayMtm(legs: readonly N930LegSnap[], realized: number): DayMark {
  let marked = 0;
  let ready = true;
  let anyOpen = false;
  for (const leg of legs) {
    if (!leg.open) continue;
    anyOpen = true;
    if (leg.ltp == null) {
      ready = false;
      continue;
    }
    marked += (leg.sold - leg.ltp) * leg.qty;
  }
  if (!anyOpen) return { mtm: realized, dayPlusReady: true };
  return { mtm: realized + marked, dayPlusReady: ready };
}

/**
 * Same-tick order: entry, EOD, Day −, Day +, per-leg SL, partner tighten, leftover.
 * Both-open has no trail and no leftover. Partner never raises the stop.
 */
export function tickActions(args: {
  entered: boolean;
  squared: boolean;
  inWindow: boolean;
  eod: boolean;
  legs: readonly N930LegSnap[];
  dayPlus: number;
  dayMinus: number;
  partnerPct: number;
  realized: number;
}): N930Action[] {
  if (!args.entered && !args.squared && args.inWindow) return [{ type: "ENTER" }];
  if (!args.entered || args.squared) return [];
  const open = args.legs.filter((leg) => leg.open);
  if (!open.length) return [];
  if (args.eod) return [{ type: "SQUARE", reason: "EOD" }];
  const mark = dayMtm(args.legs, args.realized);
  if (mark.mtm <= -args.dayMinus) return [{ type: "SQUARE", reason: "DAY_MINUS" }];
  if (mark.dayPlusReady && mark.mtm >= args.dayPlus) return [{ type: "SQUARE", reason: "DAY_PLUS" }];

  const actions: N930Action[] = [];
  const slSides = new Set<N930Side>();
  for (const leg of open) {
    if (!leg.slOn || leg.ltp == null) continue;
    if (leg.ltp + 1e-6 >= leg.slPx) {
      slSides.add(leg.side);
      actions.push({ type: "SL", side: leg.side });
    }
  }
  const stillOpen = open.filter((leg) => !slSides.has(leg.side));
  const slBooked =
    slSides.size > 0 || args.legs.some((leg) => !leg.open && leg.closedBy === "sl");
  if (!(slBooked && stillOpen.length === 1)) return actions;
  const leg = stillOpen[0]!;
  const tightened = partnerSl(leg.slPx, leg.sold, args.partnerPct);
  let slPx = leg.slPx;
  if (tightened < slPx - 1e-9) {
    slPx = tightened;
    actions.push({ type: "PARTNER", side: leg.side, slPx });
  }
  if (leg.ltp == null) return actions;
  const rung = leftoverLockPct(favPct(leg.sold, leg.ltp));
  let lockArmed = leg.lockArmed;
  let lockPct = leg.lockPct;
  if (rung != null && (!lockArmed || rung > lockPct + 1e-9)) {
    lockArmed = true;
    lockPct = rung;
    actions.push({ type: "ARM_LOCK", side: leg.side, lockPct });
  }
  if (lockArmed && leg.ltp + 1e-6 >= lockCoverPx(leg.sold, lockPct)) {
    actions.push({ type: "LEFTOVER", side: leg.side });
  }
  return actions;
}

export type LegAck = { filledQty: number; fillPx: number | null };

export type PairPlan =
  | { type: "book"; ceQty: number; cePx: number; peQty: number; pePx: number }
  | { type: "unwind"; side: N930Side }
  | { type: "unwind-both" }
  | { type: "none" };

/** A missing average traded price is not a fill. One filled leg is unwound. sold = 0 is never booked. */
export function pairFillPlan(ce: LegAck, pe: LegAck): PairPlan {
  const state = (ack: LegAck): "book" | "naked" | "none" => {
    if (!(ack.filledQty > 0)) return "none";
    if (ack.fillPx != null && ack.fillPx > 0) return "book";
    return "naked";
  };
  const ceState = state(ce);
  const peState = state(pe);
  if (ceState === "book" && peState === "book") {
    return { type: "book", ceQty: ce.filledQty, cePx: ce.fillPx!, peQty: pe.filledQty, pePx: pe.fillPx! };
  }
  if (ceState === "none" && peState === "none") return { type: "none" };
  if (peState === "none" && ceState !== "none") return { type: "unwind", side: "CE" };
  if (ceState === "none" && peState !== "none") return { type: "unwind", side: "PE" };
  return { type: "unwind-both" };
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

function near(actual: number, expected: number, label: string): void {
  if (Math.abs(actual - expected) > 1e-6) throw new Error(`${label}: ${actual} vs ${expected}`);
}

export function assertNineThirtyRules(): void {
  const xts = defaultN930Params();
  if (dayLine(xts.dayMinusPerLot, 10) !== 7000 || dayLine(xts.dayPlusPerLot, 10) !== 6000) {
    throw new Error("10 lots use the saved per-lot lines");
  }
  if (dayLine(700, 1) !== 700 || orderQty(10) !== 650 || orderQty(1) !== 65) throw new Error("lot 65");
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

  near(slPrice(100, 25), 125, "SL is sold × 1.25");
  near(partnerSl(125, 100, 15), 115, "partner tightens to sold × 1.15");
  near(partnerSl(110, 100, 15), 110, "partner never raises");
  if (leftoverLockPct(20) !== null) throw new Error("20% favorable is not a lock");
  if (leftoverLockPct(25) !== 0 || leftoverLockPct(30) !== 5 || leftoverLockPct(35) !== 10) throw new Error("leftover rungs");
  if (leftoverLockPct(40) !== 25 || leftoverLockPct(45) !== 30 || leftoverLockPct(46) !== 31) throw new Error("45% then +1");
  near(lockCoverPx(100, 0), 100, "cost lock");
  near(lockCoverPx(100, 5), 95, "5% lock");

  const both = (ce: number | null, pe: number | null, qty = 650, patch?: Partial<N930LegSnap>): N930LegSnap[] => [
    {
      side: "CE",
      open: true,
      sold: 100,
      qty,
      ltp: ce,
      slPx: 125,
      slOn: true,
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
      lockArmed: false,
      lockPct: 0,
      closedBy: null,
    },
  ];
  const act = (legs: N930LegSnap[], patch?: Partial<Parameters<typeof tickActions>[0]>) =>
    tickActions({
      entered: true,
      squared: false,
      inWindow: false,
      eod: false,
      legs,
      dayPlus: 6000,
      dayMinus: 7000,
      partnerPct: 15,
      realized: 0,
      ...patch,
    });

  if (act(both(100, 100), { entered: false, inWindow: true })[0]?.type !== "ENTER") throw new Error("entry is first");
  if (act(both(100, 100), { eod: true })[0]?.type !== "SQUARE") throw new Error("EOD squares before the stop");
  const down = act(both(120, 120));
  if (down.length !== 1 || down[0]?.type !== "SQUARE" || (down[0].type === "SQUARE" && down[0].reason !== "DAY_MINUS")) {
    throw new Error("Day − is before the per-leg stop");
  }
  const up = act(both(90, 90));
  if (up[0]?.type !== "SQUARE" || (up[0].type === "SQUARE" && up[0].reason !== "DAY_PLUS")) throw new Error("Day + squares the pair");
  if (act(both(90, null)).some((row) => row.type === "SQUARE")) throw new Error("Day + needs a good LTP on every open leg");
  const sl = act(both(125, 100, 65));
  if (sl[0]?.type !== "SL" || (sl[0].type === "SL" && sl[0].side !== "CE")) throw new Error("25% stop while both are open");
  if (!sl.some((row) => row.type === "PARTNER" && row.side === "PE")) throw new Error("the same tick tightens the survivor");
  if (act(both(80, 100, 65)).length !== 0) throw new Error("both open: no leftover and no trail");

  const afterSl = both(null, 80, 65);
  afterSl[0] = { ...afterSl[0]!, open: false, ltp: null, slOn: false, closedBy: "sl" };
  const partner = act(afterSl);
  const tightened = partner.find((row) => row.type === "PARTNER" && row.side === "PE");
  if (!tightened || tightened.type !== "PARTNER" || Math.abs(tightened.slPx - 115) > 1e-6) {
    throw new Error("one SL tightens the other stop to 15%");
  }
  if (partner.some((row) => row.type === "LEFTOVER")) throw new Error("20% favorable does not cover");

  const giveback = both(null, 95);
  giveback[0] = { ...giveback[0]!, open: false, ltp: null, slOn: false, closedBy: "sl" };
  giveback[1] = { ...giveback[1]!, lockArmed: true, lockPct: 5, slPx: 115 };
  const cover = act(giveback);
  if (!cover.some((row) => row.type === "LEFTOVER" && row.side === "PE")) throw new Error("giveback to the lock covers");
  if (act(both(100, 100), { squared: true, inWindow: true }).length !== 0) throw new Error("no resell after the day is done");

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

  const plan = pairFillPlan({ filledQty: 650, fillPx: 98 }, { filledQty: 650, fillPx: 101 });
  if (plan.type !== "book" || plan.cePx !== 98) throw new Error("a fill under min stays the sold price");
  if (pairFillPlan({ filledQty: 650, fillPx: 100 }, { filledQty: 0, fillPx: null }).type !== "unwind") {
    throw new Error("one side unwinds");
  }
  if (pairFillPlan({ filledQty: 650, fillPx: null }, { filledQty: 650, fillPx: 100 }).type !== "unwind-both") {
    throw new Error("no average price is not a booked fill");
  }

  const round = netPnl(1300, [
    { side: "SELL", premium: 100, qty: 65 },
    { side: "BUY", premium: 80, qty: 65 },
  ]);
  if (round.gross !== 1300 || round.charges !== 62.1 || round.net !== 1237.9) {
    throw new Error(`charges ${round.charges} net ${round.net}`);
  }
  if (roundHalfUpPaise(0.065) !== 0.07 || roundHalfUpPaise(0.325) !== 0.33) throw new Error("half up paise");
}
