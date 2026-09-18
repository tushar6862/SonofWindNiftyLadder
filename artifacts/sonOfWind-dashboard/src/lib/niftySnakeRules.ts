/**
 * NIFTY Snake — short-premium grid on ONE selected CE or PE strike.
 * Independent of Nifty Ladder (T1–T9 / 98–105). Do not import ladder modules.
 */

export const UNDERLYING = "NIFTY";
export const BAND_LOW = 70;
export const BAND_HIGH = 75;
export const BAND_TARGET = 72.5;
export const STEP_PTS = 3;
export const T1_COVER_MULT = 0.7;
export const T1_HARD_SL_MULT = 1.3;
export const ENTRY_MINUTE = 9 * 60 + 16;
export const EOD_MINUTE = 15 * 60 + 15;
export const LOT_SIZE = 65;
export const SIZE_MULTS = [1, 2, 3] as const;
export const TRANCHE_LOTS = [8, 3, 3, 4, 4, 3, 3] as const;
export const TRANCHE_COUNT = TRANCHE_LOTS.length;
export const MAX_PLAN_TICKS = TRANCHE_COUNT * 3;
export const SNAKE_CLOCK_MS = 25;
export const SNAKE_HUNT_WINGS = 8;
export const ROUND_TRIP_COST_PER_LOT = 25;
/** Far-OTM long hedge BUY — off; short-only (SELL entry / BUY cover-exit). */
export const ENABLE_HEDGES = false;
export const HEDGE_PREMIUM_LOW = 3;
export const HEDGE_PREMIUM_HIGH = 4;
export const HEDGE_PREMIUM_TARGET = 3.5;
/** Global MTM Exit All — same window event, no ladder module import. */
export const EV_MTM_FLAT = "sow:nifty_ladder_flat";
export const EV_NIFTY_SNAKE_FLAT = "sow:nifty_snake_flat";
export const SNAKE_STORE_KEY = "sow_nifty_snake_v1";

export type OptionType = "CE" | "PE";
export type SizeMult = (typeof SIZE_MULTS)[number];
export type HedgeWindow = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type EntryMode = "auto" | "manual";
export const MANUAL_STRIKE_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;
export type ManualStrikeOffset = (typeof MANUAL_STRIKE_OFFSETS)[number];

export type SnakeSlot = {
  index: number;
  lots: number;
  open: boolean;
  fill: number | null;
};

export type SnakeHedge = {
  window: HedgeWindow;
  covers: number[];
  lots: number;
  qty: number;
  strike: number | null;
  iid: number | null;
  fill: number | null;
  open: boolean;
};

export type ChainPremiumRow = {
  strike: number;
  call_ltp: number | null;
  put_ltp: number | null;
};

export type HuntPick = {
  strike: number;
  ltp: number;
  optionType: OptionType;
};

export type SnakeEngineState = {
  optionType: OptionType;
  sizeMult: SizeMult;
  entryMode: EntryMode;
  manualStrikeOffset: ManualStrikeOffset;
  armed: boolean;
  awaitRestart: boolean;
  awaitReload: boolean;
  slFlattening: boolean;
  reloadIndices: number[];
  slots: SnakeSlot[];
  hedges: SnakeHedge[];
  t1Fill: number | null;
  strike: number | null;
};

export type SnakeAction =
  | { kind: "enter_t1"; pick: HuntPick }
  | { kind: "add"; index: number; lots: number }
  | { kind: "resell"; indices: number[]; lots: number }
  | { kind: "book"; index: number; lots: number; reason: string }
  | { kind: "exit_hedge"; window: HedgeWindow; lots: number; reason: string }
  | { kind: "stop"; reason: string };

export type PlanTickInput = {
  nowMs: number;
  armed: boolean;
  awaitRestart: boolean;
  awaitReload: boolean;
  reloadIndices: number[];
  t1Fill: number | null;
  slots: SnakeSlot[];
  hedges: SnakeHedge[];
  ltp: number | null;
  huntPick: HuntPick | null;
  brokerShortLots: number | null;
  /** Manual skips premium-band gate; Auto keeps 70–75 filter. */
  entryMode?: EntryMode;
};

const HEDGE_COVERS: { window: HedgeWindow; covers: number[] }[] = [
  { window: 1, covers: [1] },
  { window: 2, covers: [2] },
  { window: 3, covers: [3] },
  { window: 4, covers: [4] },
  { window: 5, covers: [5] },
  { window: 6, covers: [6] },
  { window: 7, covers: [7] },
];

function istParts(nowMs: number): { hh: number; mm: number; y: number; mo: number; d: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const num = (t: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((p) => p.type === t)?.value ?? "0");
    return { y: num("year"), mo: num("month"), d: num("day"), hh: num("hour"), mm: num("minute") };
  } catch {
    const d = new Date(nowMs);
    return {
      y: d.getFullYear(),
      mo: d.getMonth() + 1,
      d: d.getDate(),
      hh: d.getHours(),
      mm: d.getMinutes(),
    };
  }
}

export function istMinuteOfDay(nowMs: number = Date.now()): number {
  const { hh, mm } = istParts(nowMs);
  return hh * 60 + mm;
}

export function istCalendarDay(nowMs: number = Date.now()): string {
  const { y, mo, d } = istParts(nowMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}

export function formatIstTime(nowMs: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toLocaleTimeString("en-IN", { hour12: false });
  }
}

export function isEntryWindow(nowMs: number = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= ENTRY_MINUTE;
}

export function isEod(nowMs: number = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= EOD_MINUTE;
}

export function qtyForLots(lots: number): number {
  return Math.max(0, Math.floor(lots)) * LOT_SIZE;
}

export function lotsForMult(mult: SizeMult): number[] {
  const m = SIZE_MULTS.includes(mult) ? mult : 1;
  return TRANCHE_LOTS.map((lots) => lots * m);
}

export function emptySlots(mult: SizeMult = 1): SnakeSlot[] {
  return lotsForMult(mult).map((lots, i) => ({
    index: i + 1,
    lots,
    open: false,
    fill: null,
  }));
}

export function applySizeToEmptySlots(slots: SnakeSlot[], mult: SizeMult): SnakeSlot[] {
  const lots = lotsForMult(mult);
  return slots.map((s, i) => (s.open ? s : { ...s, lots: lots[i] ?? s.lots }));
}

/** 1x/2x/3x. Open legs keep their lots. Empty legs and empty hedges rescale. */
export function applySize(state: SnakeEngineState, mult: SizeMult): SnakeEngineState {
  const slots = applySizeToEmptySlots(state.slots, mult);
  const scaled = buildHedges(slots);
  const hedges = state.hedges.map((h) => {
    if (h.open) return h;
    return scaled.find((n) => n.window === h.window) ?? h;
  });
  return { ...state, sizeMult: mult, slots, hedges };
}

export function buildHedges(slots: SnakeSlot[]): SnakeHedge[] {
  return HEDGE_COVERS.map((w) => {
    const lots = w.covers.reduce((n, idx) => n + (slots.find((s) => s.index === idx)?.lots ?? 0), 0);
    return {
      window: w.window,
      covers: w.covers.slice(),
      lots,
      qty: qtyForLots(lots),
      strike: null,
      iid: null,
      fill: null,
      open: false,
    };
  });
}

export function idleEngineState(
  optionType: OptionType = "CE",
  sizeMult: SizeMult = 1,
  entryMode: EntryMode = "auto",
  manualStrikeOffset: ManualStrikeOffset = 0,
): SnakeEngineState {
  const slots = emptySlots(sizeMult);
  return {
    optionType,
    sizeMult,
    entryMode: sanitizeEntryMode(entryMode),
    manualStrikeOffset: sanitizeManualStrikeOffset(manualStrikeOffset),
    armed: false,
    awaitRestart: false,
    awaitReload: false,
    slFlattening: false,
    reloadIndices: [],
    slots,
    hedges: buildHedges(slots),
    t1Fill: null,
    strike: null,
  };
}

export function cloneSlots(slots: SnakeSlot[]): SnakeSlot[] {
  return slots.map((s) => ({ ...s }));
}

export function cloneHedges(hedges: SnakeHedge[]): SnakeHedge[] {
  return hedges.map((h) => ({ ...h, covers: h.covers.slice() }));
}

export function openLots(slots: SnakeSlot[]): number {
  return slots.reduce((sum, s) => (s.open ? sum + s.lots : sum), 0);
}

export function avgFill(slots: SnakeSlot[]): number | null {
  let lotSum = 0;
  let pxSum = 0;
  for (const s of slots) {
    if (!s.open || s.fill == null || !(s.fill > 0) || s.lots <= 0) continue;
    lotSum += s.lots;
    pxSum += s.fill * s.lots;
  }
  if (lotSum <= 0) return null;
  return pxSum / lotSum;
}

export function isInTrade(slots: SnakeSlot[], t1Fill: number | null): boolean {
  const t1 = slots.find((s) => s.index === 1);
  return Boolean(t1?.open && t1Fill != null && t1Fill > 0);
}

export function isGridLocked(state: Pick<SnakeEngineState, "t1Fill">): boolean {
  return state.t1Fill != null && state.t1Fill > 0;
}

export function hedgeLotsOpen(hedges: SnakeHedge[]): number {
  return hedges.reduce((n, h) => (h.open ? n + h.lots : n), 0);
}

export function isLiveSnake(state: SnakeEngineState): boolean {
  return Boolean(
    state.awaitReload ||
      isInTrade(state.slots, state.t1Fill) ||
      openLots(state.slots) > 0 ||
      hedgeLotsOpen(state.hedges) > 0,
  );
}

export function snakeSessionActive(state: SnakeEngineState): boolean {
  return Boolean(state.armed || state.awaitRestart || state.awaitReload || isLiveSnake(state) || state.t1Fill != null);
}

export function sellLevel(t1Fill: number, index: number): number {
  return t1Fill + STEP_PTS * (index - 1);
}

export function bookLevel(t1Fill: number, index: number): number {
  return sellLevel(t1Fill, index) - STEP_PTS;
}

export function t1CoverPrice(t1Fill: number): number {
  return t1Fill * T1_COVER_MULT;
}

export function t1HardSlPrice(t1Fill: number): number {
  return t1Fill * T1_HARD_SL_MULT;
}

export function inPremiumBand(ltp: number | null | undefined): boolean {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp >= BAND_LOW && ltp <= BAND_HIGH;
}

export function inHedgeBand(ltp: number | null | undefined): boolean {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp >= HEDGE_PREMIUM_LOW && ltp <= HEDGE_PREMIUM_HIGH;
}

function sideLtp(row: ChainPremiumRow, optionType: OptionType): number | null {
  const raw = optionType === "CE" ? row.call_ltp : row.put_ltp;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

function sortNearTarget(a: HuntPick, b: HuntPick, optionType: OptionType): number {
  const da = Math.abs(a.ltp - BAND_TARGET);
  const db = Math.abs(b.ltp - BAND_TARGET);
  if (da !== db) return da - db;
  return optionType === "CE" ? b.strike - a.strike : a.strike - b.strike;
}

export function pickNear72(rows: ChainPremiumRow[], optionType: OptionType): HuntPick | null {
  const candidates: HuntPick[] = [];
  for (const row of rows) {
    const ltp = sideLtp(row, optionType);
    if (ltp == null || !inPremiumBand(ltp)) continue;
    candidates.push({ strike: row.strike, ltp, optionType });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => sortNearTarget(a, b, optionType));
  return candidates[0] ?? null;
}

export function formatAtmOffsetLabel(offset: ManualStrikeOffset): string {
  if (offset === 0) return "ATM";
  return offset > 0 ? `ATM + ${offset}` : `ATM − ${Math.abs(offset)}`;
}

export function atmOffsetTag(offset: ManualStrikeOffset): string {
  if (offset === 0) return "ATM";
  return offset > 0 ? `ATM+${offset}` : `ATM−${Math.abs(offset)}`;
}

export function resolveManualStrike(atm: number, offset: ManualStrikeOffset, step: number): number {
  const s = typeof step === "number" && step > 0 ? step : 50;
  return atm + offset * s;
}

/** Manual entry: fixed ATM±offset strike — any live print (no band filter). */
export function pickManualStrike(
  rows: ChainPremiumRow[],
  optionType: OptionType,
  atm: number,
  offset: ManualStrikeOffset,
  step: number,
): HuntPick | null {
  if (!(typeof atm === "number" && Number.isFinite(atm) && atm > 0)) return null;
  const strike = resolveManualStrike(atm, offset, step);
  const row = rows.find((r) => r.strike === strike);
  if (!row) return null;
  const ltp = sideLtp(row, optionType);
  if (ltp == null) return null;
  return { strike, ltp, optionType };
}

export function sanitizeEntryMode(raw: unknown): EntryMode {
  return raw === "manual" ? "manual" : "auto";
}

export function sanitizeManualStrikeOffset(raw: unknown): ManualStrikeOffset {
  const n = typeof raw === "number" ? raw : Number(raw);
  return MANUAL_STRIKE_OFFSETS.includes(n as ManualStrikeOffset) ? (n as ManualStrikeOffset) : 0;
}

export function closestTo72(rows: ChainPremiumRow[], optionType: OptionType): HuntPick | null {
  const candidates: HuntPick[] = [];
  for (const row of rows) {
    const ltp = sideLtp(row, optionType);
    if (ltp == null) continue;
    candidates.push({ strike: row.strike, ltp, optionType });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => sortNearTarget(a, b, optionType));
  return candidates[0] ?? null;
}

export function pickHedgePremium<T extends { ltp: number; strike: number }>(
  rows: T[],
  optionType: OptionType,
): T | null {
  const band = rows.filter((r) => inHedgeBand(r.ltp));
  if (!band.length) return null;
  band.sort((a, b) => {
    const da = Math.abs(a.ltp - HEDGE_PREMIUM_TARGET);
    const db = Math.abs(b.ltp - HEDGE_PREMIUM_TARGET);
    if (da !== db) return da - db;
    if (a.ltp !== b.ltp) return a.ltp - b.ltp;
    return optionType === "CE" ? b.strike - a.strike : a.strike - b.strike;
  });
  return band[0] ?? null;
}

function slotByIndex(slots: SnakeSlot[], index: number): SnakeSlot | undefined {
  return slots.find((s) => s.index === index);
}

function highestOpen(slots: SnakeSlot[]): SnakeSlot | null {
  let best: SnakeSlot | null = null;
  for (const s of slots) {
    if (!s.open) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best;
}

function highestOpenExtra(slots: SnakeSlot[]): SnakeSlot | null {
  let best: SnakeSlot | null = null;
  for (const s of slots) {
    if (!s.open || s.index <= 1) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best;
}

function nextEmptyExtra(slots: SnakeSlot[], t1Fill: number, ltp: number): SnakeSlot | null {
  const t1 = slotByIndex(slots, 1);
  if (!t1?.open) return null;
  const extras = slots.filter((s) => s.index >= 2).sort((a, b) => a.index - b.index);
  for (const s of extras) {
    if (s.open) continue;
    if (ltp >= sellLevel(t1Fill, s.index)) return s;
    return null;
  }
  return null;
}

function validLtp(ltp: number | null | undefined): ltp is number {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0;
}

function bookAction(slot: SnakeSlot, reason: string): SnakeAction {
  return { kind: "book", index: slot.index, lots: slot.lots, reason };
}

export function isHardSlReason(reason: string): boolean {
  return reason.toUpperCase().includes("HARD SL");
}

export function isEodReason(reason: string): boolean {
  return reason.toUpperCase().includes("EOD");
}

export function isCoverStopReason(reason: string): boolean {
  return reason.toUpperCase().includes("COVER") || reason.toUpperCase().includes("−30%") || reason.includes("-30%");
}

function highestOpenHedge(hedges: SnakeHedge[]): SnakeHedge | null {
  let best: SnakeHedge | null = null;
  for (const h of hedges) {
    if (!h.open) continue;
    if (!best || h.window > best.window) best = h;
  }
  return best;
}

function shortsFlat(slots: SnakeSlot[]): boolean {
  return !slots.some((s) => s.open);
}

/**
 * ONE next action. Caller loops until null.
 * Priority: EOD, hard SL, T1 cover, extra book, add, re-SELL, stop-while-flat.
 * Hedge buys are the panel's job (live quotes). Hedge sells ride EOD / square-all.
 */
export function planTick(input: PlanTickInput): SnakeAction | null {
  const {
    nowMs,
    armed,
    awaitRestart,
    awaitReload,
    reloadIndices,
    t1Fill,
    slots,
    hedges,
    ltp,
    huntPick,
    brokerShortLots,
    entryMode = "auto",
  } = input;
  const gridLocked = t1Fill != null && t1Fill > 0;
  const anyOpen = slots.some((s) => s.open);

  if (isEod(nowMs)) {
    const hi = highestOpen(slots);
    if (hi) return bookAction(hi, `EOD 15:15 · T${hi.index}`);
    const hedge = highestOpenHedge(hedges);
    if (hedge) return { kind: "exit_hedge", window: hedge.window, lots: hedge.lots, reason: "EOD 15:15 · hedge" };
    return null;
  }

  if (gridLocked && validLtp(ltp) && ltp >= t1HardSlPrice(t1Fill) && anyOpen) {
    const hi = highestOpen(slots);
    if (hi) return bookAction(hi, `HARD SL +30% · flatten T${hi.index}`);
  }

  if (awaitReload && !anyOpen && gridLocked && validLtp(ltp) && ltp <= t1CoverPrice(t1Fill)) {
    return { kind: "stop", reason: "T1 −30% reached while flat — no re-SELL" };
  }

  if (gridLocked && validLtp(ltp) && ltp <= t1CoverPrice(t1Fill)) {
    const extra = highestOpenExtra(slots);
    if (extra) return bookAction(extra, `T1 −30% path · book T${extra.index} first`);
    const t1 = slotByIndex(slots, 1);
    if (t1?.open) return bookAction(t1, "T1 −30% cover");
    return null;
  }

  const highestExtra = highestOpenExtra(slots);
  if (gridLocked && validLtp(ltp) && highestExtra && ltp <= bookLevel(t1Fill, highestExtra.index)) {
    return bookAction(highestExtra, `T${highestExtra.index} −3`);
  }

  if (armed && gridLocked && validLtp(ltp)) {
    const extra = nextEmptyExtra(slots, t1Fill, ltp);
    if (extra) return { kind: "add", index: extra.index, lots: extra.lots };
  }

  if (awaitReload && armed && !anyOpen && gridLocked && validLtp(ltp)) {
    if (ltp < t1HardSlPrice(t1Fill) && brokerShortLots != null && brokerShortLots <= 0) {
      const indices = reloadIndices
        .filter((idx) => {
          const slot = slotByIndex(slots, idx);
          return slot && !slot.open && slot.lots > 0;
        })
        .sort((a, b) => a - b);
      if (!indices.length) return { kind: "stop", reason: "Re-SELL list empty" };
      const lots = indices.reduce((n, idx) => n + (slotByIndex(slots, idx)?.lots ?? 0), 0);
      return { kind: "resell", indices, lots };
    }
  }

  if (!anyOpen && !gridLocked && !awaitReload) {
    if (!armed || awaitRestart) return null;
    if (!isEntryWindow(nowMs)) return null;
    if (!huntPick) return null;
    if (entryMode !== "manual" && !inPremiumBand(huntPick.ltp)) return null;
    return { kind: "enter_t1", pick: huntPick };
  }

  return null;
}

export function nextSquareAllAction(state: SnakeEngineState): SnakeAction | null {
  const hi = highestOpen(state.slots);
  if (hi) return bookAction(hi, "SQUARE ALL");
  const hedge = highestOpenHedge(state.hedges);
  if (hedge) return { kind: "exit_hedge", window: hedge.window, lots: hedge.lots, reason: "SQUARE ALL · hedge" };
  return null;
}

export function hedgesNeeded(state: SnakeEngineState): SnakeHedge[] {
  if (!ENABLE_HEDGES || isEod()) return [];
  const out: SnakeHedge[] = [];
  for (const h of state.hedges) {
    if (h.open) continue;
    const trigger = slotByIndex(state.slots, h.window);
    if (trigger?.open) out.push(h);
  }
  return out;
}

function closeAllKeepLots(slots: SnakeSlot[]): SnakeSlot[] {
  return slots.map((s) => ({ ...s, open: false, fill: null }));
}

function closeHedges(hedges: SnakeHedge[]): SnakeHedge[] {
  return hedges.map((h) => ({ ...h, open: false, fill: null, strike: null, iid: null }));
}

function afterShortFlat(state: SnakeEngineState, slots: SnakeSlot[], reason: string): SnakeEngineState {
  if (!shortsFlat(slots)) return { ...state, slots };
  if (isHardSlReason(reason) && state.t1Fill != null && state.t1Fill > 0 && state.strike != null) {
    const remembered = Array.from(new Set(state.reloadIndices)).sort((a, b) => a - b);
    return {
      ...state,
      slots: closeAllKeepLots(slots),
      awaitReload: remembered.length > 0,
      awaitRestart: false,
      slFlattening: false,
      reloadIndices: remembered,
    };
  }
  if (isEodReason(reason)) {
    return {
      ...state,
      slots: closeAllKeepLots(slots),
      t1Fill: null,
      strike: null,
      armed: false,
      awaitReload: false,
      awaitRestart: false,
      slFlattening: false,
      reloadIndices: [],
    };
  }
  return {
    ...state,
    slots: closeAllKeepLots(slots),
    t1Fill: null,
    strike: null,
    armed: false,
    awaitReload: false,
    awaitRestart: true,
    slFlattening: false,
    reloadIndices: [],
  };
}

export function applyFilledAction(
  state: SnakeEngineState,
  action: SnakeAction,
  fillPx: number,
): SnakeEngineState {
  const slots = cloneSlots(state.slots);
  const hedges = cloneHedges(state.hedges);

  if (action.kind === "enter_t1") {
    const t1 = slots.find((s) => s.index === 1);
    const print = fillPx > 0 ? fillPx : action.pick.ltp;
    if (t1) {
      t1.open = true;
      t1.fill = print;
    }
    return {
      ...state,
      t1Fill: print,
      strike: action.pick.strike,
      optionType: action.pick.optionType,
      slots,
      hedges,
      awaitReload: false,
      awaitRestart: false,
      slFlattening: false,
      reloadIndices: [],
    };
  }

  if (action.kind === "add") {
    const slot = slots.find((s) => s.index === action.index);
    if (slot && !slot.open) {
      slot.open = true;
      slot.fill = fillPx;
    }
    return { ...state, slots, hedges };
  }

  if (action.kind === "resell") {
    for (const idx of action.indices) {
      const slot = slots.find((s) => s.index === idx);
      if (slot) {
        slot.open = true;
        slot.fill = fillPx;
      }
    }
    const still = state.reloadIndices.some((idx) => {
      const slot = slots.find((s) => s.index === idx);
      return slot && !slot.open;
    });
    return {
      ...state,
      slots,
      hedges,
      awaitReload: still,
      slFlattening: false,
    };
  }

  if (action.kind === "exit_hedge") {
    const hedge = hedges.find((h) => h.window === action.window);
    if (hedge) {
      hedge.open = false;
      hedge.fill = null;
    }
    return { ...state, slots, hedges };
  }

  if (action.kind === "stop") {
    return {
      ...state,
      slots: closeAllKeepLots(slots),
      hedges,
      t1Fill: null,
      strike: null,
      armed: false,
      awaitReload: false,
      awaitRestart: true,
      slFlattening: false,
      reloadIndices: [],
    };
  }

  const slot = slots.find((s) => s.index === action.index);
  let reloadIndices = state.reloadIndices.slice();
  let slFlattening = state.slFlattening;
  if (isHardSlReason(action.reason)) {
    if (!slFlattening) {
      reloadIndices = [];
      slFlattening = true;
    }
    if (slot?.open && !reloadIndices.includes(action.index)) reloadIndices.push(action.index);
  }
  if (slot) {
    slot.open = false;
    slot.fill = null;
  }
  return afterShortFlat({ ...state, reloadIndices, slFlattening, hedges }, slots, action.reason);
}

export function markHedgeOpen(
  state: SnakeEngineState,
  window: HedgeWindow,
  strike: number,
  iid: number,
  fill: number,
): SnakeEngineState {
  const hedges = cloneHedges(state.hedges);
  const hedge = hedges.find((h) => h.window === window);
  if (hedge) {
    hedge.open = true;
    hedge.strike = strike;
    hedge.iid = iid;
    hedge.fill = fill;
  }
  return { ...state, hedges };
}

export function shortBookedPnl(entryFill: number, exitFill: number, lots: number): number {
  return (entryFill - exitFill) * lots * LOT_SIZE;
}

export function longBookedPnl(entryFill: number, exitFill: number, lots: number): number {
  return (exitFill - entryFill) * lots * LOT_SIZE;
}

export function bookExpense(lots: number): number {
  return ROUND_TRIP_COST_PER_LOT * Math.max(0, Math.floor(lots));
}

export function openMtm(avg: number | null, liveLtp: number | null, lots: number): number | null {
  if (avg == null || liveLtp == null || !(avg > 0) || !(liveLtp > 0) || lots <= 0) return null;
  return (avg - liveLtp) * lots * LOT_SIZE;
}

export type ReconcileResult = {
  state: SnakeEngineState;
  phantomClosed: number[];
  brokerFlat: boolean;
};

export function reconcileBrokerShortLots(state: SnakeEngineState, brokerShortLots: number): ReconcileResult {
  const trading = isInTrade(state.slots, state.t1Fill) || openLots(state.slots) > 0;
  const brokerLots = Math.max(0, Math.floor(brokerShortLots));
  if (state.awaitReload && brokerLots <= 0) {
    return { state, phantomClosed: [], brokerFlat: true };
  }
  if (trading && brokerLots <= 0) {
    return {
      state: {
        ...idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset),
        awaitRestart: true,
        hedges: cloneHedges(state.hedges),
      },
      phantomClosed: [],
      brokerFlat: true,
    };
  }
  const uiLots = openLots(state.slots);
  if (uiLots <= brokerLots) return { state, phantomClosed: [], brokerFlat: false };
  const slots = cloneSlots(state.slots);
  let extra = uiLots - brokerLots;
  const phantomClosed: number[] = [];
  const extras = slots.filter((s) => s.open && s.index > 1).sort((a, b) => b.index - a.index);
  for (const s of extras) {
    if (extra <= 0) break;
    s.open = false;
    s.fill = null;
    extra -= s.lots;
    phantomClosed.push(s.index);
  }
  return { state: { ...state, slots }, phantomClosed, brokerFlat: false };
}

export function localNewDayReset(state: SnakeEngineState): SnakeEngineState {
  return idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset);
}

export function uiReset(state: SnakeEngineState): SnakeEngineState {
  return idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset);
}

export type SnakeLogKind = "info" | "entry" | "exit" | "warn";

export type SnakePersistedLog = {
  id: number;
  ts: number;
  text: string;
  kind: SnakeLogKind;
};

export type SnakePersisted = {
  v: 1;
  day: string;
  iid: number | null;
  engine: SnakeEngineState;
  logs: SnakePersistedLog[];
  nextLogId: number;
  gross: number;
  expense: number;
  trips: number;
  seenShort?: boolean;
};

const LOG_KINDS = new Set<SnakeLogKind>(["info", "entry", "exit", "warn"]);

function sanitizeIid(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function sanitizeSlots(raw: unknown): SnakeSlot[] | null {
  if (!Array.isArray(raw) || raw.length !== TRANCHE_COUNT) return null;
  const slots: SnakeSlot[] = [];
  for (let i = 0; i < TRANCHE_COUNT; i++) {
    const row = raw[i];
    if (!row || typeof row !== "object") return null;
    const rec = row as Record<string, unknown>;
    if (Number(rec.index) !== i + 1) return null;
    const lots = Number(rec.lots);
    if (!Number.isFinite(lots) || lots <= 0) return null;
    const open = Boolean(rec.open);
    const fillRaw = rec.fill;
    const fill = typeof fillRaw === "number" && Number.isFinite(fillRaw) && fillRaw > 0 ? fillRaw : null;
    if (open && fill == null) return null;
    slots.push({ index: i + 1, lots: Math.floor(lots), open, fill: open ? fill : null });
  }
  return slots;
}

function sanitizeHedges(raw: unknown, slots: SnakeSlot[]): SnakeHedge[] {
  const base = buildHedges(slots);
  if (!Array.isArray(raw)) return base;
  return base.map((h) => {
    const row = raw.find((r) => r && typeof r === "object" && Number((r as { window?: unknown }).window) === h.window);
    if (!row || typeof row !== "object") return h;
    const rec = row as Record<string, unknown>;
    const open = Boolean(rec.open);
    const strike = typeof rec.strike === "number" && rec.strike > 0 ? rec.strike : null;
    const iid = sanitizeIid(rec.iid);
    const fill = typeof rec.fill === "number" && rec.fill > 0 ? rec.fill : null;
    if (open && (strike == null || iid == null || fill == null)) return h;
    return { ...h, open, strike: open ? strike : strike, iid: open ? iid : iid, fill: open ? fill : null };
  });
}

function sanitizeLogs(raw: unknown): SnakePersistedLog[] {
  if (!Array.isArray(raw)) return [];
  const out: SnakePersistedLog[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = Number(rec.id);
    const ts = Number(rec.ts);
    const text = typeof rec.text === "string" ? rec.text : "";
    const kind = LOG_KINDS.has(rec.kind as SnakeLogKind) ? (rec.kind as SnakeLogKind) : "info";
    if (!Number.isFinite(id) || !Number.isFinite(ts) || !text) continue;
    out.push({ id, ts, text, kind });
    if (out.length >= 80) break;
  }
  return out;
}

export function sanitizeSnakeEngine(raw: unknown): SnakeEngineState | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const optionType: OptionType | null = rec.optionType === "CE" || rec.optionType === "PE" ? rec.optionType : null;
  if (!optionType) return null;
  const slots = sanitizeSlots(rec.slots);
  if (!slots) return null;
  const hedges = sanitizeHedges(rec.hedges, slots);
  const t1 = slots.find((s) => s.index === 1);
  const t1FillRaw = rec.t1Fill;
  const t1Fill =
    typeof t1FillRaw === "number" && Number.isFinite(t1FillRaw) && t1FillRaw > 0
      ? t1FillRaw
      : t1?.open && t1.fill != null
        ? t1.fill
        : null;
  const strikeRaw = rec.strike;
  const strike = typeof strikeRaw === "number" && Number.isFinite(strikeRaw) && strikeRaw > 0 ? strikeRaw : null;
  const reloadIndices = Array.isArray(rec.reloadIndices)
    ? rec.reloadIndices
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= TRANCHE_COUNT)
        .map((n) => Math.floor(n))
    : [];
  const awaitReload = Boolean(rec.awaitReload) && t1Fill != null && strike != null && reloadIndices.length > 0;
  const sizeMult: SizeMult = SIZE_MULTS.includes(rec.sizeMult as SizeMult) ? (rec.sizeMult as SizeMult) : 1;
  const engine: SnakeEngineState = {
    optionType,
    sizeMult,
    entryMode: sanitizeEntryMode(rec.entryMode),
    manualStrikeOffset: sanitizeManualStrikeOffset(rec.manualStrikeOffset),
    armed: Boolean(rec.armed),
    awaitRestart: Boolean(rec.awaitRestart),
    awaitReload,
    slFlattening: false,
    reloadIndices: awaitReload ? Array.from(new Set(reloadIndices)).sort((a, b) => a - b) : [],
    slots,
    hedges,
    t1Fill,
    strike,
  };
  if (isInTrade(engine.slots, engine.t1Fill) && (engine.strike == null || engine.t1Fill == null)) return null;
  return engine;
}

export function parseSnakeSession(raw: unknown, today: string): SnakePersisted | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== 1) return null;
  if (typeof rec.day !== "string" || rec.day !== today) return null;
  const engine = sanitizeSnakeEngine(rec.engine);
  if (!engine || !snakeSessionActive(engine)) return null;
  const logs = sanitizeLogs(rec.logs);
  const nextLogIdRaw = Number(rec.nextLogId);
  const maxLogId = logs.reduce((m, l) => Math.max(m, l.id), 0);
  const nextLogId = Number.isFinite(nextLogIdRaw) && nextLogIdRaw > maxLogId ? Math.floor(nextLogIdRaw) : maxLogId + 1;
  const gross = typeof rec.gross === "number" && Number.isFinite(rec.gross) ? rec.gross : 0;
  const expense = typeof rec.expense === "number" && Number.isFinite(rec.expense) ? rec.expense : 0;
  const trips = typeof rec.trips === "number" && Number.isFinite(rec.trips) ? rec.trips : 0;
  return {
    v: 1,
    day: rec.day,
    iid: sanitizeIid(rec.iid),
    engine,
    logs,
    nextLogId,
    gross,
    expense,
    trips,
    seenShort: Boolean(rec.seenShort),
  };
}

function readStore(): string | null {
  // localStorage survives a closed project/tab. sessionStorage is the same-tab fallback.
  try {
    const local = localStorage.getItem(SNAKE_STORE_KEY);
    if (local) return local;
  } catch {
    /* ignore */
  }
  try {
    return sessionStorage.getItem(SNAKE_STORE_KEY);
  } catch {
    return null;
  }
}

function writeStore(raw: string): void {
  try {
    sessionStorage.setItem(SNAKE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(SNAKE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

function removeStore(): void {
  try {
    sessionStorage.removeItem(SNAKE_STORE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(SNAKE_STORE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadSnakeSession(nowMs: number = Date.now()): SnakePersisted | null {
  try {
    const raw = readStore();
    if (!raw) return null;
    const parsed = parseSnakeSession(JSON.parse(raw), istCalendarDay(nowMs));
    if (!parsed) {
      removeStore();
      return null;
    }
    return parsed;
  } catch {
    removeStore();
    return null;
  }
}

export function saveSnakeSession(snap: SnakePersisted): void {
  if (!snakeSessionActive(snap.engine)) {
    clearSnakeSession();
    return;
  }
  try {
    writeStore(
      JSON.stringify({
        ...snap,
        engine: {
          ...snap.engine,
          slots: snap.engine.slots.map((s) => ({ ...s })),
          hedges: snap.engine.hedges.map((h) => ({ ...h, covers: h.covers.slice() })),
        },
        logs: snap.logs.slice(0, 80),
        seenShort: Boolean(snap.seenShort),
      } satisfies SnakePersisted),
    );
  } catch {
    /* ignore */
  }
}

export function clearSnakeSession(): void {
  removeStore();
}

export function hedgeWindowLabel(window: HedgeWindow): string {
  return `T${window}`;
}

export function windowLabel(nowMs: number): string {
  const m = istMinuteOfDay(nowMs);
  if (m < ENTRY_MINUTE) return "Wait 09:16 IST";
  if (m >= EOD_MINUTE) return "EOD 15:15 — no new snake";
  return "Hunt window open";
}
