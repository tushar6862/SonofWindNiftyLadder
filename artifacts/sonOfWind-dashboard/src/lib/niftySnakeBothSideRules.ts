/**
 * NIFTY Snake Both Side (profile id: bothside70) — OptFlow short-premium grid on ONE CE or PE.
 * Same both-way engine as Ladder Both Side, with Ladder-70 size table and T1 band 70–75.
 * Independent of Nifty Ladder, Nifty Snake, and Nifty Ladder Both Side — do not import those.
 */

export const PROFILE_ID = "bothside70";
export const UNDERLYING = "NIFTY";
export const BAND_LOW = 70;
export const BAND_HIGH = 75;
export const BAND_TARGET = 72.5;
export const STEP_PTS = 3;
/** T-B books at entry − (G + this). Gap 3 → book −4. */
export const TB_BOOK_EXTRA = 1;
export const T1_COVER_MULT = 0.7;
export const HARD_SL_MULT = 1.3;
export const ENTRY_MINUTE = 9 * 60 + 16;
export const EOD_MINUTE = 15 * 60 + 15;
export const LOT_SIZE = 65;
export const SIZE_MULTS = [1, 2, 3] as const;
/** T1 lots at 1x. */
export const T1_LOTS = 8;
/** Extra leg lots at 1x by k-index (1-based). Past 6 → last (3) repeats. Ladder-70 T2…T7. */
export const EXTRA_LOTS_BY_K = [3, 3, 4, 4, 3, 3] as const;
export const UI_EXTRA_ALWAYS = 4;
export const HARD_CAP_LOTS_1X = 30;
export const MAX_EXTRA_K = 24;
export const MAX_PLAN_TICKS = 40;
export const BOTHSIDE_CLOCK_MS = 25;
export const BOTHSIDE_HUNT_WINGS = 10;
export const ROUND_TRIP_COST_PER_LOT = 25;
export const ENABLE_HEDGES = false;
export const HEDGE_PREMIUM_LOW = 3;
export const HEDGE_PREMIUM_HIGH = 4;
export const HEDGE_PREMIUM_TARGET = 3.5;
export const EV_MTM_FLAT = "sow:nifty_ladder_flat";
export const EV_NIFTY_BOTHSIDE_FLAT = "sow:nifty_snake_bothside_flat";
export const BOTHSIDE_STORE_KEY = "sow_nifty_snake_bothside_v1";

export type OptionType = "CE" | "PE";
export type SizeMult = (typeof SIZE_MULTS)[number];
export type EntryMode = "auto" | "manual";
export type OpenDriveBias = "UP" | "DOWN" | "FLAT";
export type LegSide = "T1" | "A" | "B";
export const MANUAL_STRIKE_OFFSETS = [-3, -2, -1, 0, 1, 2, 3] as const;
export type ManualStrikeOffset = (typeof MANUAL_STRIKE_OFFSETS)[number];

export type BothSlot = {
  id: string;
  side: LegSide;
  /** 0 for T1; 1+ for T-Ak / T-Bk. */
  k: number;
  lots: number;
  open: boolean;
  fill: number | null;
};

export type BothHedge = {
  id: string;
  /** Trigger leg id that arms this hedge window. */
  triggerId: string;
  covers: string[];
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

export type BothEngineState = {
  optionType: OptionType;
  sizeMult: SizeMult;
  entryMode: EntryMode;
  manualStrikeOffset: ManualStrikeOffset;
  gap: number;
  armed: boolean;
  awaitRestart: boolean;
  awaitReload: boolean;
  slFlattening: boolean;
  reloadIds: string[];
  /** Hard-SL price used while awaiting re-SELL (cheapest-open × 1.30 at flatten). */
  hardSlPx: number | null;
  slots: BothSlot[];
  hedges: BothHedge[];
  t1Fill: number | null;
  strike: number | null;
};

export type BothAction =
  | { kind: "enter_t1"; pick: HuntPick }
  | { kind: "add"; id: string; lots: number }
  | { kind: "resell"; ids: string[]; lots: number }
  | { kind: "book"; id: string; lots: number; reason: string }
  | { kind: "exit_hedge"; hedgeId: string; lots: number; reason: string }
  | { kind: "stop"; reason: string };

export type PlanTickInput = {
  nowMs: number;
  armed: boolean;
  awaitRestart: boolean;
  awaitReload: boolean;
  reloadIds: string[];
  hardSlPx: number | null;
  t1Fill: number | null;
  slots: BothSlot[];
  hedges: BothHedge[];
  ltp: number | null;
  huntPick: HuntPick | null;
  brokerShortLots: number | null;
  entryMode?: EntryMode;
  gap?: number;
  sizeMult?: SizeMult;
};

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

export function hardCapLots(mult: SizeMult): number {
  const m = SIZE_MULTS.includes(mult) ? mult : 1;
  return HARD_CAP_LOTS_1X * m;
}

export function extraLotsAt(k: number, mult: SizeMult): number {
  const m = SIZE_MULTS.includes(mult) ? mult : 1;
  if (k <= 0) return T1_LOTS * m;
  const idx = Math.min(k, EXTRA_LOTS_BY_K.length) - 1;
  const base = EXTRA_LOTS_BY_K[Math.max(0, idx)] ?? 3;
  return base * m;
}

export function t1Lots(mult: SizeMult): number {
  const m = SIZE_MULTS.includes(mult) ? mult : 1;
  return T1_LOTS * m;
}

export function slotId(side: LegSide, k: number): string {
  if (side === "T1") return "T1";
  return `${side}${k}`;
}

export function legLabel(slot: Pick<BothSlot, "side" | "k" | "id">): string {
  if (slot.side === "T1") return "T1";
  return `T-${slot.side}${slot.k}`;
}

function makeSlot(side: LegSide, k: number, mult: SizeMult): BothSlot {
  return {
    id: slotId(side, k),
    side,
    k: side === "T1" ? 0 : k,
    lots: side === "T1" ? t1Lots(mult) : extraLotsAt(k, mult),
    open: false,
    fill: null,
  };
}

export function emptySlots(mult: SizeMult = 1): BothSlot[] {
  const slots: BothSlot[] = [makeSlot("T1", 0, mult)];
  for (let k = 1; k <= UI_EXTRA_ALWAYS; k++) {
    slots.push(makeSlot("A", k, mult));
    slots.push(makeSlot("B", k, mult));
  }
  return slots;
}

export function ensurePlanningSlots(slots: BothSlot[], mult: SizeMult): BothSlot[] {
  const out = cloneSlots(slots);
  const has = (id: string) => out.some((s) => s.id === id);
  if (!has("T1")) out.unshift(makeSlot("T1", 0, mult));
  for (let k = 1; k <= UI_EXTRA_ALWAYS; k++) {
    if (!has(slotId("A", k))) out.push(makeSlot("A", k, mult));
    if (!has(slotId("B", k))) out.push(makeSlot("B", k, mult));
  }
  for (const side of ["A", "B"] as const) {
    const maxK = out.filter((s) => s.side === side).reduce((m, s) => Math.max(m, s.k), 0);
    const nextK = Math.min(MAX_EXTRA_K, Math.max(UI_EXTRA_ALWAYS, maxK) + 1);
    for (let k = 1; k <= nextK; k++) {
      if (!has(slotId(side, k))) out.push(makeSlot(side, k, mult));
    }
  }
  return sortSlots(out);
}

function sortSlots(slots: BothSlot[]): BothSlot[] {
  const rank = (s: BothSlot) => {
    if (s.side === "T1") return 0;
    if (s.side === "A") return 1000 + s.k;
    return 2000 + s.k;
  };
  return slots.slice().sort((a, b) => rank(a) - rank(b));
}

export function applySizeToEmptySlots(slots: BothSlot[], mult: SizeMult): BothSlot[] {
  return slots.map((s) => {
    if (s.open) return s;
    const lots = s.side === "T1" ? t1Lots(mult) : extraLotsAt(s.k, mult);
    return { ...s, lots };
  });
}

export function applySize(state: BothEngineState, mult: SizeMult): BothEngineState {
  const slots = applySizeToEmptySlots(state.slots, mult);
  const scaled = buildHedges(slots);
  const hedges = state.hedges.map((h) => {
    if (h.open) return h;
    return scaled.find((n) => n.id === h.id) ?? h;
  });
  return { ...state, sizeMult: mult, slots, hedges };
}

/** Hedge windows: T1→T1+A1+A2; A4/A7/… → that + next 2 A; B4/B7/… → that + next 2 B. */
export function hedgeWindowSpecs(slots: BothSlot[]): { id: string; triggerId: string; covers: string[] }[] {
  const out: { id: string; triggerId: string; covers: string[] }[] = [];
  const aMax = Math.max(UI_EXTRA_ALWAYS, ...slots.filter((s) => s.side === "A").map((s) => s.k), 0);
  const bMax = Math.max(UI_EXTRA_ALWAYS, ...slots.filter((s) => s.side === "B").map((s) => s.k), 0);
  out.push({ id: "H-T1", triggerId: "T1", covers: ["T1", "A1", "A2"] });
  for (let k = 4; k <= aMax + 2; k += 3) {
    out.push({
      id: `H-A${k}`,
      triggerId: slotId("A", k),
      covers: [slotId("A", k), slotId("A", k + 1), slotId("A", k + 2)],
    });
  }
  for (let k = 4; k <= bMax + 2; k += 3) {
    out.push({
      id: `H-B${k}`,
      triggerId: slotId("B", k),
      covers: [slotId("B", k), slotId("B", k + 1), slotId("B", k + 2)],
    });
  }
  return out;
}

export function buildHedges(slots: BothSlot[]): BothHedge[] {
  return hedgeWindowSpecs(slots).map((w) => {
    const lots = w.covers.reduce((n, id) => n + (slots.find((s) => s.id === id)?.lots ?? 0), 0);
    return {
      id: w.id,
      triggerId: w.triggerId,
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
  gap: number = STEP_PTS,
): BothEngineState {
  const slots = emptySlots(sizeMult);
  return {
    optionType,
    sizeMult,
    entryMode: sanitizeEntryMode(entryMode),
    manualStrikeOffset: sanitizeManualStrikeOffset(manualStrikeOffset),
    gap: sanitizeGap(gap),
    armed: false,
    awaitRestart: false,
    awaitReload: false,
    slFlattening: false,
    reloadIds: [],
    hardSlPx: null,
    slots,
    hedges: buildHedges(slots),
    t1Fill: null,
    strike: null,
  };
}

export function cloneSlots(slots: BothSlot[]): BothSlot[] {
  return slots.map((s) => ({ ...s }));
}

export function cloneHedges(hedges: BothHedge[]): BothHedge[] {
  return hedges.map((h) => ({ ...h, covers: h.covers.slice() }));
}

export function openLots(slots: BothSlot[]): number {
  return slots.reduce((sum, s) => (s.open ? sum + s.lots : sum), 0);
}

export function avgFill(slots: BothSlot[]): number | null {
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

export function isInTrade(slots: BothSlot[], t1Fill: number | null): boolean {
  const t1 = slots.find((s) => s.id === "T1");
  return Boolean(t1?.open && t1Fill != null && t1Fill > 0);
}

export function isGridLocked(state: Pick<BothEngineState, "t1Fill">): boolean {
  return state.t1Fill != null && state.t1Fill > 0;
}

export function hedgeLotsOpen(hedges: BothHedge[]): number {
  return hedges.reduce((n, h) => (h.open ? n + h.lots : n), 0);
}

export function isLiveBoth(state: BothEngineState): boolean {
  return Boolean(
    state.awaitReload ||
      isInTrade(state.slots, state.t1Fill) ||
      openLots(state.slots) > 0 ||
      hedgeLotsOpen(state.hedges) > 0,
  );
}

/** Persist armed / live / hard-SL reload. Bare awaitRestart (position booked) is UI-only — clear storage. */
export function bothSessionActive(state: BothEngineState): boolean {
  return Boolean(state.armed || state.awaitReload || isLiveBoth(state) || state.t1Fill != null);
}

export function sanitizeGap(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return STEP_PTS;
  return Math.round(n * 100) / 100;
}

export function taEntry(t1Fill: number, k: number, gap: number = STEP_PTS): number {
  return t1Fill + gap * k;
}

export function tbEntry(t1Fill: number, k: number, gap: number = STEP_PTS): number {
  return t1Fill - gap * k;
}

export function sellLevel(t1Fill: number, slot: Pick<BothSlot, "side" | "k">, gap: number = STEP_PTS): number {
  if (slot.side === "T1") return t1Fill;
  if (slot.side === "A") return taEntry(t1Fill, slot.k, gap);
  return tbEntry(t1Fill, slot.k, gap);
}

export function bookLevelForSlot(
  slot: Pick<BothSlot, "side" | "k" | "fill">,
  t1Fill: number,
  gap: number = STEP_PTS,
): number {
  if (slot.side === "T1") return t1CoverPrice(t1Fill);
  const entry = slot.fill != null && slot.fill > 0 ? slot.fill : sellLevel(t1Fill, slot, gap);
  if (slot.side === "A") return entry - gap;
  return entry - (gap + TB_BOOK_EXTRA);
}

export function t1CoverPrice(t1Fill: number): number {
  return t1Fill * T1_COVER_MULT;
}

/** Hard SL from cheapest OPEN fill (T-B can be cheaper than T1). */
export function cheapestOpenFill(slots: BothSlot[]): number | null {
  let best: number | null = null;
  for (const s of slots) {
    if (!s.open || s.fill == null || !(s.fill > 0)) continue;
    if (best == null || s.fill < best) best = s.fill;
  }
  return best;
}

export function hardSlFromBase(base: number): number {
  return base * HARD_SL_MULT;
}

export function hardSlPrice(slots: BothSlot[], fallbackT1: number | null): number | null {
  const cheap = cheapestOpenFill(slots);
  if (cheap != null) return hardSlFromBase(cheap);
  if (fallbackT1 != null && fallbackT1 > 0) return hardSlFromBase(fallbackT1);
  return null;
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
  // Tie → more OTM
  return optionType === "CE" ? b.strike - a.strike : a.strike - b.strike;
}

export function pickNear100(rows: ChainPremiumRow[], optionType: OptionType): HuntPick | null {
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

export function closestTo100(rows: ChainPremiumRow[], optionType: OptionType): HuntPick | null {
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

export function openDriveFromBar(
  open: number,
  close: number,
): { bias: OpenDriveBias; suggest: OptionType | null } {
  if (!(Number.isFinite(open) && Number.isFinite(close))) {
    return { bias: "FLAT", suggest: null };
  }
  if (close > open) return { bias: "UP", suggest: "PE" };
  if (close < open) return { bias: "DOWN", suggest: "CE" };
  return { bias: "FLAT", suggest: null };
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

function slotById(slots: BothSlot[], id: string): BothSlot | undefined {
  return slots.find((s) => s.id === id);
}

/** Extras rank: higher k first; same k → A before B. T1 last for EOD. */
function extraRank(s: BothSlot): number {
  if (s.side === "T1") return -1;
  const sideBoost = s.side === "A" ? 0.5 : 0;
  return s.k + sideBoost;
}

function highestOpen(slots: BothSlot[]): BothSlot | null {
  let best: BothSlot | null = null;
  for (const s of slots) {
    if (!s.open) continue;
    if (!best || extraRank(s) > extraRank(best)) best = s;
  }
  return best;
}

function highestOpenExtra(slots: BothSlot[]): BothSlot | null {
  let best: BothSlot | null = null;
  for (const s of slots) {
    if (!s.open || s.side === "T1") continue;
    if (!best || extraRank(s) > extraRank(best)) best = s;
  }
  return best;
}

function nextEmptySide(slots: BothSlot[], side: "A" | "B"): BothSlot | null {
  const list = slots.filter((s) => s.side === side).sort((a, b) => a.k - b.k);
  for (const s of list) {
    if (!s.open) return s;
  }
  return null;
}

function validLtp(ltp: number | null | undefined): ltp is number {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0;
}

function bookAction(slot: BothSlot, reason: string): BothAction {
  return { kind: "book", id: slot.id, lots: slot.lots, reason };
}

export function isHardSlReason(reason: string): boolean {
  return reason.toUpperCase().includes("HARD SL");
}

export function isEodReason(reason: string): boolean {
  return reason.toUpperCase().includes("EOD");
}

function highestOpenHedge(hedges: BothHedge[]): BothHedge | null {
  let best: BothHedge | null = null;
  for (const h of hedges) {
    if (!h.open) continue;
    if (!best || h.id.localeCompare(best.id) > 0) best = h;
  }
  return best;
}

function shortsFlat(slots: BothSlot[]): boolean {
  return !slots.some((s) => s.open);
}

function capOk(slots: BothSlot[], addLots: number, mult: SizeMult): boolean {
  return openLots(slots) + addLots <= hardCapLots(mult);
}

/**
 * ONE next action. Caller loops until null.
 * Priority: EOD → hard SL → T1 −30% path → highest-extra book → T-A add → T-B add → re-SELL → hunt.
 */
export function planTick(input: PlanTickInput): BothAction | null {
  const {
    nowMs,
    armed,
    awaitRestart,
    awaitReload,
    reloadIds,
    hardSlPx,
    t1Fill,
    hedges,
    ltp,
    huntPick,
    brokerShortLots,
    entryMode = "auto",
    gap = STEP_PTS,
    sizeMult = 1,
  } = input;
  const slots = ensurePlanningSlots(input.slots, sizeMult);
  const gridLocked = t1Fill != null && t1Fill > 0;
  const anyOpen = slots.some((s) => s.open);
  const g = sanitizeGap(gap);

  if (isEod(nowMs)) {
    const hi = highestOpen(slots);
    if (hi) return bookAction(hi, `EOD 15:15 · ${legLabel(hi)}`);
    const hedge = highestOpenHedge(hedges);
    if (hedge) return { kind: "exit_hedge", hedgeId: hedge.id, lots: hedge.lots, reason: "EOD 15:15 · hedge" };
    return null;
  }

  // Hedges held until Square all / T1 exit / hard SL / EOD — dump when shorts are flat.
  if (!anyOpen) {
    const hedge = highestOpenHedge(hedges);
    if (hedge) {
      const reason = awaitReload ? "HARD SL · hedge" : "T1 exit · hedge";
      return { kind: "exit_hedge", hedgeId: hedge.id, lots: hedge.lots, reason };
    }
  }

  const liveHardSl = hardSlPrice(slots, t1Fill);
  if (gridLocked && validLtp(ltp) && liveHardSl != null && ltp >= liveHardSl && anyOpen) {
    const hi = highestOpen(slots);
    if (hi) return bookAction(hi, `HARD SL +30% · flatten ${legLabel(hi)}`);
  }

  const reloadSl = hardSlPx != null && hardSlPx > 0 ? hardSlPx : liveHardSl;
  if (awaitReload && !anyOpen && gridLocked && validLtp(ltp) && reloadSl != null && ltp <= t1CoverPrice(t1Fill)) {
    return { kind: "stop", reason: "T1 −30% reached while flat — no re-SELL" };
  }

  if (gridLocked && validLtp(ltp) && ltp <= t1CoverPrice(t1Fill)) {
    const extra = highestOpenExtra(slots);
    if (extra) return bookAction(extra, `T1 −30% path · book ${legLabel(extra)} first`);
    const t1 = slotById(slots, "T1");
    if (t1?.open) return bookAction(t1, "T1 −30% cover");
    return null;
  }

  const highestExtra = highestOpenExtra(slots);
  if (gridLocked && validLtp(ltp) && highestExtra) {
    const bookPx = bookLevelForSlot(highestExtra, t1Fill, g);
    if (ltp <= bookPx) return bookAction(highestExtra, `${legLabel(highestExtra)} book`);
  }

  if (armed && gridLocked && validLtp(ltp)) {
    const nextA = nextEmptySide(slots, "A");
    if (nextA && ltp >= taEntry(t1Fill, nextA.k, g) && capOk(slots, nextA.lots, sizeMult)) {
      return { kind: "add", id: nextA.id, lots: nextA.lots };
    }
    const nextB = nextEmptySide(slots, "B");
    if (nextB && ltp <= tbEntry(t1Fill, nextB.k, g) && capOk(slots, nextB.lots, sizeMult)) {
      return { kind: "add", id: nextB.id, lots: nextB.lots };
    }
  }

  if (awaitReload && armed && !anyOpen && gridLocked && validLtp(ltp)) {
    const sl = reloadSl ?? hardSlFromBase(t1Fill);
    if (ltp < sl && brokerShortLots != null && brokerShortLots <= 0) {
      const ids = reloadIds
        .filter((id) => {
          const slot = slotById(slots, id);
          return slot && !slot.open && slot.lots > 0;
        })
        .sort((a, b) => {
          const sa = slotById(slots, a)!;
          const sb = slotById(slots, b)!;
          return extraRank(sa) - extraRank(sb);
        });
      if (!ids.length) return { kind: "stop", reason: "Re-SELL list empty" };
      const lots = ids.reduce((n, id) => n + (slotById(slots, id)?.lots ?? 0), 0);
      return { kind: "resell", ids, lots };
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

export function nextSquareAllAction(state: BothEngineState): BothAction | null {
  const hi = highestOpen(state.slots);
  if (hi) return bookAction(hi, "SQUARE ALL");
  const hedge = highestOpenHedge(state.hedges);
  if (hedge) return { kind: "exit_hedge", hedgeId: hedge.id, lots: hedge.lots, reason: "SQUARE ALL · hedge" };
  return null;
}

export function hedgesNeeded(state: BothEngineState): BothHedge[] {
  if (!ENABLE_HEDGES || isEod()) return [];
  const out: BothHedge[] = [];
  for (const h of state.hedges) {
    if (h.open) continue;
    const trigger = slotById(state.slots, h.triggerId);
    if (trigger?.open) out.push(h);
  }
  return out;
}

function closeAllKeepLots(slots: BothSlot[]): BothSlot[] {
  return slots.map((s) => ({ ...s, open: false, fill: null }));
}

function afterShortFlat(state: BothEngineState, slots: BothSlot[], reason: string): BothEngineState {
  if (!shortsFlat(slots)) return { ...state, slots };
  if (isHardSlReason(reason) && state.t1Fill != null && state.t1Fill > 0 && state.strike != null) {
    const remembered = Array.from(new Set(state.reloadIds));
    const sl =
      state.hardSlPx != null && state.hardSlPx > 0
        ? state.hardSlPx
        : hardSlPrice(state.slots, state.t1Fill);
    return {
      ...state,
      slots: closeAllKeepLots(slots),
      awaitReload: remembered.length > 0,
      awaitRestart: false,
      slFlattening: false,
      reloadIds: remembered,
      hardSlPx: sl,
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
      reloadIds: [],
      hardSlPx: null,
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
    reloadIds: [],
    hardSlPx: null,
  };
}

export function applyFilledAction(
  state: BothEngineState,
  action: BothAction,
  fillPx: number,
): BothEngineState {
  let slots = ensurePlanningSlots(cloneSlots(state.slots), state.sizeMult);
  const hedges = cloneHedges(state.hedges);

  if (action.kind === "enter_t1") {
    const t1 = slots.find((s) => s.id === "T1");
    const print = fillPx > 0 ? fillPx : action.pick.ltp;
    if (t1) {
      t1.open = true;
      t1.fill = print;
    }
    slots = ensurePlanningSlots(slots, state.sizeMult);
    return {
      ...state,
      t1Fill: print,
      strike: action.pick.strike,
      optionType: action.pick.optionType,
      slots,
      hedges: buildHedges(slots).map((h) => {
        const prev = hedges.find((x) => x.id === h.id);
        return prev?.open ? prev : h;
      }),
      awaitReload: false,
      awaitRestart: false,
      slFlattening: false,
      reloadIds: [],
      hardSlPx: null,
    };
  }

  if (action.kind === "add") {
    const slot = slots.find((s) => s.id === action.id);
    if (slot && !slot.open) {
      slot.open = true;
      slot.fill = fillPx;
    }
    slots = ensurePlanningSlots(slots, state.sizeMult);
    const nextHedges = buildHedges(slots).map((h) => {
      const prev = hedges.find((x) => x.id === h.id);
      return prev?.open ? { ...h, ...prev, covers: prev.covers.slice() } : h;
    });
    return { ...state, slots, hedges: nextHedges };
  }

  if (action.kind === "resell") {
    for (const id of action.ids) {
      const slot = slots.find((s) => s.id === id);
      if (slot) {
        slot.open = true;
        slot.fill = fillPx;
      }
    }
    const t1 = slots.find((s) => s.id === "T1");
    const newT1 = t1?.open && t1.fill != null && t1.fill > 0 ? t1.fill : state.t1Fill;
    const still = state.reloadIds.some((id) => {
      const slot = slots.find((s) => s.id === id);
      return slot && !slot.open;
    });
    slots = ensurePlanningSlots(slots, state.sizeMult);
    return {
      ...state,
      t1Fill: newT1,
      slots,
      hedges: buildHedges(slots).map((h) => {
        const prev = hedges.find((x) => x.id === h.id);
        return prev?.open ? { ...h, ...prev, covers: prev.covers.slice() } : h;
      }),
      awaitReload: still,
      slFlattening: false,
      hardSlPx: still ? state.hardSlPx : null,
    };
  }

  if (action.kind === "exit_hedge") {
    const hedge = hedges.find((h) => h.id === action.hedgeId);
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
      reloadIds: [],
      hardSlPx: null,
    };
  }

  const slot = slots.find((s) => s.id === action.id);
  let reloadIds = state.reloadIds.slice();
  let slFlattening = state.slFlattening;
  let hardSlPx = state.hardSlPx;
  if (isHardSlReason(action.reason)) {
    if (!slFlattening) {
      reloadIds = [];
      slFlattening = true;
      hardSlPx = hardSlPrice(state.slots, state.t1Fill);
    }
    if (slot?.open && !reloadIds.includes(action.id)) reloadIds.push(action.id);
  }
  if (slot) {
    slot.open = false;
    slot.fill = null;
  }
  return afterShortFlat({ ...state, reloadIds, slFlattening, hardSlPx, hedges }, slots, action.reason);
}

export function markHedgeOpen(
  state: BothEngineState,
  hedgeId: string,
  strike: number,
  iid: number,
  fill: number,
): BothEngineState {
  const hedges = cloneHedges(state.hedges);
  const hedge = hedges.find((h) => h.id === hedgeId);
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
  state: BothEngineState;
  phantomClosed: string[];
  brokerFlat: boolean;
};

export function reconcileBrokerShortLots(state: BothEngineState, brokerShortLots: number): ReconcileResult {
  const trading = isInTrade(state.slots, state.t1Fill) || openLots(state.slots) > 0;
  const brokerLots = Math.max(0, Math.floor(brokerShortLots));
  if (state.awaitReload && brokerLots <= 0) {
    return { state, phantomClosed: [], brokerFlat: true };
  }
  if (trading && brokerLots <= 0) {
    return {
      state: {
        ...idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset, state.gap),
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
  const phantomClosed: string[] = [];
  const extras = slots
    .filter((s) => s.open && s.side !== "T1")
    .sort((a, b) => extraRank(b) - extraRank(a));
  for (const s of extras) {
    if (extra <= 0) break;
    s.open = false;
    s.fill = null;
    extra -= s.lots;
    phantomClosed.push(s.id);
  }
  return { state: { ...state, slots }, phantomClosed, brokerFlat: false };
}

export function localNewDayReset(state: BothEngineState): BothEngineState {
  return idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset, state.gap);
}

export function uiReset(state: BothEngineState): BothEngineState {
  return idleEngineState(state.optionType, state.sizeMult, state.entryMode, state.manualStrikeOffset, state.gap);
}

/** UI always shows T1 + A1–A4 + B1–B4; later extras appear once present/open. */
export function visibleSlots(slots: BothSlot[]): BothSlot[] {
  return sortSlots(slots).filter((s) => {
    if (s.side === "T1") return true;
    if (s.k <= UI_EXTRA_ALWAYS) return true;
    return s.open || s.fill != null;
  });
}

export type BothLogKind = "info" | "entry" | "exit" | "warn";

export type BothPersistedLog = {
  id: number;
  ts: number;
  text: string;
  kind: BothLogKind;
};

export type BothPersisted = {
  v: 1;
  day: string;
  iid: number | null;
  engine: BothEngineState;
  logs: BothPersistedLog[];
  nextLogId: number;
  gross: number;
  expense: number;
  trips: number;
  seenShort?: boolean;
};

const LOG_KINDS = new Set<BothLogKind>(["info", "entry", "exit", "warn"]);

function sanitizeIid(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function sanitizeSlots(raw: unknown, mult: SizeMult): BothSlot[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const slots: BothSlot[] = [];
  let hasT1 = false;
  for (const row of raw) {
    if (!row || typeof row !== "object") return null;
    const rec = row as Record<string, unknown>;
    const sideRaw = rec.side;
    const side: LegSide | null =
      sideRaw === "T1" || sideRaw === "A" || sideRaw === "B" ? sideRaw : null;
    if (!side) return null;
    const k = side === "T1" ? 0 : Math.floor(Number(rec.k));
    if (side !== "T1" && (!Number.isFinite(k) || k < 1 || k > MAX_EXTRA_K)) return null;
    const id = typeof rec.id === "string" && rec.id ? rec.id : slotId(side, k);
    const lots = Number(rec.lots);
    if (!Number.isFinite(lots) || lots <= 0) return null;
    const open = Boolean(rec.open);
    const fillRaw = rec.fill;
    const fill = typeof fillRaw === "number" && Number.isFinite(fillRaw) && fillRaw > 0 ? fillRaw : null;
    if (open && fill == null) return null;
    if (side === "T1") hasT1 = true;
    slots.push({ id, side, k, lots: Math.floor(lots), open, fill: open ? fill : null });
  }
  if (!hasT1) return null;
  return ensurePlanningSlots(slots, mult);
}

function sanitizeHedges(raw: unknown, slots: BothSlot[]): BothHedge[] {
  const base = buildHedges(slots);
  if (!Array.isArray(raw)) return base;
  return base.map((h) => {
    const row = raw.find((r) => r && typeof r === "object" && String((r as { id?: unknown }).id) === h.id);
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

function sanitizeLogs(raw: unknown): BothPersistedLog[] {
  if (!Array.isArray(raw)) return [];
  const out: BothPersistedLog[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = Number(rec.id);
    const ts = Number(rec.ts);
    const text = typeof rec.text === "string" ? rec.text : "";
    const kind = LOG_KINDS.has(rec.kind as BothLogKind) ? (rec.kind as BothLogKind) : "info";
    if (!Number.isFinite(id) || !Number.isFinite(ts) || !text) continue;
    out.push({ id, ts, text, kind });
    if (out.length >= 80) break;
  }
  return out;
}

export function sanitizeBothEngine(raw: unknown): BothEngineState | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const optionType: OptionType | null = rec.optionType === "CE" || rec.optionType === "PE" ? rec.optionType : null;
  if (!optionType) return null;
  const sizeMult: SizeMult = SIZE_MULTS.includes(rec.sizeMult as SizeMult) ? (rec.sizeMult as SizeMult) : 1;
  const slots = sanitizeSlots(rec.slots, sizeMult);
  if (!slots) return null;
  const hedges = sanitizeHedges(rec.hedges, slots);
  const t1 = slots.find((s) => s.id === "T1");
  const t1FillRaw = rec.t1Fill;
  const t1Fill =
    typeof t1FillRaw === "number" && Number.isFinite(t1FillRaw) && t1FillRaw > 0
      ? t1FillRaw
      : t1?.open && t1.fill != null
        ? t1.fill
        : null;
  const strikeRaw = rec.strike;
  const strike = typeof strikeRaw === "number" && Number.isFinite(strikeRaw) && strikeRaw > 0 ? strikeRaw : null;
  const reloadIds = Array.isArray(rec.reloadIds)
    ? rec.reloadIds.map((n) => String(n)).filter((id) => slots.some((s) => s.id === id))
    : [];
  const hardSlRaw = rec.hardSlPx;
  const hardSlPx =
    typeof hardSlRaw === "number" && Number.isFinite(hardSlRaw) && hardSlRaw > 0 ? hardSlRaw : null;
  const awaitReload = Boolean(rec.awaitReload) && t1Fill != null && strike != null && reloadIds.length > 0;
  const engine: BothEngineState = {
    optionType,
    sizeMult,
    entryMode: sanitizeEntryMode(rec.entryMode),
    manualStrikeOffset: sanitizeManualStrikeOffset(rec.manualStrikeOffset),
    gap: sanitizeGap(rec.gap),
    armed: Boolean(rec.armed),
    awaitRestart: Boolean(rec.awaitRestart),
    awaitReload,
    slFlattening: false,
    reloadIds: awaitReload ? Array.from(new Set(reloadIds)) : [],
    hardSlPx: awaitReload ? hardSlPx : null,
    slots,
    hedges,
    t1Fill,
    strike,
  };
  if (isInTrade(engine.slots, engine.t1Fill) && (engine.strike == null || engine.t1Fill == null)) return null;
  return engine;
}

export function parseBothSession(raw: unknown, today: string): BothPersisted | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== 1) return null;
  if (typeof rec.day !== "string" || rec.day !== today) return null;
  const engine = sanitizeBothEngine(rec.engine);
  if (!engine || !bothSessionActive(engine)) return null;
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
  // sessionStorage first (same-tab reload). localStorage is fallback.
  try {
    const session = sessionStorage.getItem(BOTHSIDE_STORE_KEY);
    if (session) return session;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(BOTHSIDE_STORE_KEY);
  } catch {
    return null;
  }
}

function writeStore(raw: string): void {
  try {
    sessionStorage.setItem(BOTHSIDE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(BOTHSIDE_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

function removeStore(): void {
  try {
    sessionStorage.removeItem(BOTHSIDE_STORE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(BOTHSIDE_STORE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadBothSession(nowMs: number = Date.now()): BothPersisted | null {
  try {
    const raw = readStore();
    if (!raw) return null;
    const parsed = parseBothSession(JSON.parse(raw), istCalendarDay(nowMs));
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

export function saveBothSession(snap: BothPersisted): void {
  if (!bothSessionActive(snap.engine)) {
    clearBothSession();
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
      } satisfies BothPersisted),
    );
  } catch {
    /* ignore */
  }
}

export function clearBothSession(): void {
  removeStore();
}

export function hedgeWindowLabel(hedge: Pick<BothHedge, "id" | "triggerId">): string {
  return hedge.triggerId === "T1" ? "Hedge T1" : `Hedge ${hedge.triggerId}`;
}

export function windowLabel(nowMs: number): string {
  const m = istMinuteOfDay(nowMs);
  if (m < ENTRY_MINUTE) return "Wait 09:16 IST";
  if (m >= EOD_MINUTE) return "EOD 15:15 — no new snake both-side";
  return "Hunt window open";
}
