/**
 * NIFTY Ladder — same-strike short-premium grid.
 * Pure decision engine: planTick + level math + pickNear100.
 * UI / broker is a thin wrapper. Do not invent extra constants.
 */

export const UNDERLYING = "NIFTY";
export const BAND_LOW = 98;
export const BAND_HIGH = 105;
export const BAND_TARGET = 100;
export const STEP_PTS = 3;
export const T1_COVER_PCT = 0.3;
export const T1_HARD_SL_PCT = 0.7;
export const ENTRY_MINUTE = 9 * 60 + 16; // 09:16 IST
export const EOD_MINUTE = 15 * 60 + 15; // 15:15 IST
export const LOT_SIZE = 65;
export const SIZE_MULTS = [1, 2, 3] as const;
export const TRANCHE_LOTS = [5, 1, 1, 1, 2, 2, 2, 4, 4, 4, 8] as const;
export const TRANCHE_COUNT = 11;
export const MAX_PLAN_TICKS = 16;
export const LADDER_CLOCK_MS = 25;
/** Strikes each side of live ATM to subscribe for the ~100 hunt (not the full chain). */
export const LADDER_HUNT_WINGS = 10;
export const ROUND_TRIP_COST_PER_LOT = 25;

export type OptionType = "CE" | "PE";
export type SizeMult = (typeof SIZE_MULTS)[number];
export type OpenDriveBias = "UP" | "DOWN" | "FLAT";

export type LadderSlot = {
  index: number;
  lots: number;
  open: boolean;
  fill: number | null;
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

export type PlanTickInput = {
  nowMs: number;
  armed: boolean;
  awaitRestart: boolean;
  t1Fill: number | null;
  slots: LadderSlot[];
  ltp: number | null;
  huntPick: HuntPick | null;
};

export type LadderAction =
  | { kind: "enter_t1"; pick: HuntPick }
  | { kind: "add"; index: number; lots: number }
  | { kind: "book"; index: number; lots: number; reason: string };

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

export function isEntryWindow(nowMs: number = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= ENTRY_MINUTE;
}

export function isEod(nowMs: number = Date.now()): boolean {
  return istMinuteOfDay(nowMs) >= EOD_MINUTE;
}

export function lotsForMult(mult: SizeMult): number[] {
  const m = SIZE_MULTS.includes(mult) ? mult : 1;
  return TRANCHE_LOTS.map((lots) => lots * m);
}

export function emptySlots(mult: SizeMult = 1): LadderSlot[] {
  return lotsForMult(mult).map((lots, i) => ({
    index: i + 1,
    lots,
    open: false,
    fill: null,
  }));
}

export function applySizeToEmptySlots(slots: LadderSlot[], mult: SizeMult): LadderSlot[] {
  const lots = lotsForMult(mult);
  return slots.map((s, i) => (s.open ? s : { ...s, lots: lots[i] ?? s.lots }));
}

export function cloneSlots(slots: LadderSlot[]): LadderSlot[] {
  return slots.map((s) => ({ ...s }));
}

export function isInTrade(slots: LadderSlot[], t1Fill: number | null): boolean {
  const t1 = slots.find((s) => s.index === 1);
  return Boolean(t1?.open && t1Fill != null && t1Fill > 0);
}

export function openLots(slots: LadderSlot[]): number {
  return slots.reduce((sum, s) => (s.open ? sum + s.lots : sum), 0);
}

export function avgFill(slots: LadderSlot[]): number | null {
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

export function qtyForLots(lots: number): number {
  return Math.max(1, Math.floor(lots) * LOT_SIZE);
}

export function addLevel(t1Fill: number, index: number): number {
  return t1Fill + STEP_PTS * (index - 1);
}

export function bookLevel(t1Fill: number, index: number): number {
  return addLevel(t1Fill, index) - STEP_PTS;
}

export function t1CoverPrice(t1Fill: number): number {
  return t1Fill * (1 - T1_COVER_PCT);
}

export function t1HardSlPrice(t1Fill: number): number {
  return t1Fill * (1 + T1_HARD_SL_PCT);
}

export function inPremiumBand(ltp: number | null | undefined): boolean {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp >= BAND_LOW && ltp <= BAND_HIGH;
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

/** UI “nearest” display only. Never used for T1 entry. */
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

function slotByIndex(slots: LadderSlot[], index: number): LadderSlot | undefined {
  return slots.find((s) => s.index === index);
}

function highestOpen(slots: LadderSlot[]): LadderSlot | null {
  let best: LadderSlot | null = null;
  for (const s of slots) {
    if (!s.open) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best;
}

function highestOpenExtra(slots: LadderSlot[]): LadderSlot | null {
  let best: LadderSlot | null = null;
  for (const s of slots) {
    if (!s.open || s.index <= 1) continue;
    if (!best || s.index > best.index) best = s;
  }
  return best;
}

function firstEmptyExtra(slots: LadderSlot[]): LadderSlot | null {
  const t1 = slotByIndex(slots, 1);
  if (!t1?.open) return null;
  const extras = slots.filter((s) => s.index >= 2).sort((a, b) => a.index - b.index);
  for (const s of extras) {
    if (!s.open) return s;
  }
  return null;
}

function validLtp(ltp: number | null | undefined): ltp is number {
  return typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0;
}

function bookAction(slot: LadderSlot, reason: string): LadderAction {
  return { kind: "book", index: slot.index, lots: slot.lots, reason };
}

/**
 * ONE next action. Caller MUST loop until null (max ~16) so a spike can
 * open T2–T4 in one burst, and a gap-down can book extras then T1 in order.
 * Priority is strict: first match wins.
 */
export function planTick(input: PlanTickInput): LadderAction | null {
  const { nowMs, armed, awaitRestart, t1Fill, slots, ltp, huntPick } = input;
  const trading = isInTrade(slots, t1Fill);

  // 1) EOD (istMinuteOfDay >= 15:15)
  if (isEod(nowMs)) {
    if (!trading) return null;
    const hi = highestOpen(slots);
    if (!hi) return null;
    return bookAction(hi, `EOD 15:15 · T${hi.index}`);
  }

  // 2) Not inTrade
  if (!trading) {
    if (!armed || awaitRestart) return null;
    if (!isEntryWindow(nowMs)) return null;
    if (!huntPick) return null;
    return { kind: "enter_t1", pick: huntPick };
  }

  // 3) inTrade but ltp invalid
  if (!validLtp(ltp) || t1Fill == null || !(t1Fill > 0)) return null;

  // 4) HARD SL: ltp >= t1Fill * 1.70
  if (ltp >= t1HardSlPrice(t1Fill)) {
    const hi = highestOpen(slots);
    if (!hi) return null;
    return bookAction(hi, `HARD SL +70% · flatten T${hi.index}`);
  }

  // 5) T1 COVER path: ltp <= t1Fill * 0.70
  if (ltp <= t1CoverPrice(t1Fill)) {
    const extra = highestOpenExtra(slots);
    if (extra) {
      return bookAction(extra, `T1 30% path · book T${extra.index} first`);
    }
    const t1 = slotByIndex(slots, 1);
    if (t1?.open) return bookAction(t1, "T1 −30% cover");
    return null;
  }

  // 6) Extra −3 book (T1 is NEVER booked by this rule)
  const highestExtra = highestOpenExtra(slots);
  if (highestExtra && ltp <= bookLevel(t1Fill, highestExtra.index)) {
    return bookAction(highestExtra, `T${highestExtra.index} −3`);
  }

  // 7) Adds only if armed === true (PAUSE blocks this)
  if (armed === true) {
    const next = firstEmptyExtra(slots);
    if (next && ltp >= addLevel(t1Fill, next.index)) {
      return { kind: "add", index: next.index, lots: next.lots };
    }
  }

  // 8) else null
  return null;
}

export function nextSquareAllAction(slots: LadderSlot[]): LadderAction | null {
  const hi = highestOpen(slots);
  if (!hi) return null;
  return bookAction(hi, "SQUARE ALL");
}

export function reasonAwaitsRestart(reason: string): boolean {
  const u = reason.toUpperCase();
  return !u.includes("EOD") && !u.includes("SQUARE");
}

export type LadderEngineState = {
  optionType: OptionType;
  sizeMult: SizeMult;
  armed: boolean;
  awaitRestart: boolean;
  slots: LadderSlot[];
  t1Fill: number | null;
  strike: number | null;
};

export function idleEngineState(
  optionType: OptionType = "CE",
  sizeMult: SizeMult = 1,
): LadderEngineState {
  return {
    optionType,
    sizeMult,
    armed: false,
    awaitRestart: false,
    slots: emptySlots(sizeMult),
    t1Fill: null,
    strike: null,
  };
}

/** Apply a planTick / square-all action after the order filled at `fillPx`. */
export function applyFilledAction(
  state: LadderEngineState,
  action: LadderAction,
  fillPx: number,
): LadderEngineState {
  const slots = cloneSlots(state.slots);
  if (action.kind === "enter_t1") {
    const t1 = slots.find((s) => s.index === 1);
    if (t1) {
      t1.open = true;
      t1.fill = fillPx;
    }
    return {
      ...state,
      t1Fill: fillPx,
      strike: action.pick.strike,
      optionType: action.pick.optionType,
      slots,
      awaitRestart: false,
    };
  }
  if (action.kind === "add") {
    const slot = slots.find((s) => s.index === action.index);
    if (slot) {
      slot.open = true;
      slot.fill = fillPx;
    }
    return { ...state, slots };
  }
  const slot = slots.find((s) => s.index === action.index);
  if (slot) {
    slot.open = false;
    slot.fill = null;
  }
  if (action.index === 1) {
    return {
      ...state,
      slots: emptySlots(state.sizeMult),
      t1Fill: null,
      strike: null,
      armed: false,
      awaitRestart: reasonAwaitsRestart(action.reason),
    };
  }
  return { ...state, slots };
}

/** If broker reports T1 fill and no extras are open yet, replace t1Fill (shifts the grid). */
export function maybeConfirmT1Fill(state: LadderEngineState, confirmedFill: number): LadderEngineState {
  if (!isInTrade(state.slots, state.t1Fill)) return state;
  if (!(confirmedFill > 0) || !Number.isFinite(confirmedFill)) return state;
  const extrasOpen = state.slots.some((s) => s.open && s.index > 1);
  if (extrasOpen) return state;
  const slots = cloneSlots(state.slots);
  const t1 = slots.find((s) => s.index === 1);
  if (t1) t1.fill = confirmedFill;
  return { ...state, t1Fill: confirmedFill, slots };
}

export type ReconcileResult = {
  state: LadderEngineState;
  phantomClosed: number[];
  brokerFlat: boolean;
};

/**
 * Live broker reconcile. Source of truth = net SHORT lots of the locked contract.
 * If UI lots > broker: close highest extras first (phantom). Never auto-open
 * extras when broker shows more shorts — that re-booked T2 in a loop.
 * If broker is flat: wipe to Idle (caller must have seen a live short first).
 */
export function reconcileBrokerShortLots(
  state: LadderEngineState,
  brokerShortLots: number,
): ReconcileResult {
  const trading = isInTrade(state.slots, state.t1Fill);
  const brokerLots = Math.max(0, Math.floor(brokerShortLots));
  if (trading && brokerLots <= 0) {
    return {
      state: idleEngineState(state.optionType, state.sizeMult),
      phantomClosed: [],
      brokerFlat: true,
    };
  }
  const uiLots = openLots(state.slots);
  if (uiLots <= brokerLots) {
    return { state, phantomClosed: [], brokerFlat: false };
  }
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

export function shortBookedPnl(entryFill: number, exitFill: number, lots: number): number {
  return (entryFill - exitFill) * lots * LOT_SIZE;
}

export function openMtm(avg: number | null, liveLtp: number | null, lots: number): number | null {
  if (avg == null || liveLtp == null || !(avg > 0) || !(liveLtp > 0) || lots <= 0) return null;
  return (avg - liveLtp) * lots * LOT_SIZE;
}

export function backtestAddFill(ltp: number, level: number): number {
  return Math.min(ltp, level);
}

export function backtestBookFill(opts: {
  reason: string;
  ltp: number;
  prevLtp: number | null;
  level: number;
  hardSl: number;
}): number {
  const { reason, ltp, prevLtp, level, hardSl } = opts;
  const u = reason.toUpperCase();
  if (u.includes("EOD")) return ltp;
  if (u.includes("HARD SL")) {
    if (prevLtp != null && prevLtp < hardSl) return hardSl;
    return ltp;
  }
  if (prevLtp != null && prevLtp > level) return level;
  return ltp;
}

export function localNewDayReset(state: LadderEngineState): LadderEngineState {
  return {
    ...state,
    armed: false,
    awaitRestart: false,
    slots: emptySlots(state.sizeMult),
    t1Fill: null,
    strike: null,
  };
}

export function uiReset(state: LadderEngineState): LadderEngineState {
  return idleEngineState(state.optionType, state.sizeMult);
}

/** Persist while armed or still in trade. Clear after square-all / all books / idle. */
export function ladderSessionActive(state: LadderEngineState): boolean {
  return Boolean(state.armed || isInTrade(state.slots, state.t1Fill));
}

export const LADDER_STORE_KEY = "sow_nifty_ladder_v1";
/** MTM TARGET/SL Exit All — pause hunt and square the ladder so it does not re-enter. */
export const EV_NIFTY_LADDER_FLAT = "sow:nifty_ladder_flat";

export type LadderLogKind = "info" | "entry" | "exit" | "warn";

export type LadderPersistedLog = {
  id: number;
  ts: number;
  text: string;
  kind: LadderLogKind;
};

export type LadderPersisted = {
  v: 1;
  day: string;
  iid: number | null;
  engine: LadderEngineState;
  logs: LadderPersistedLog[];
  nextLogId: number;
};

const LOG_KINDS = new Set<LadderLogKind>(["info", "entry", "exit", "warn"]);

function sanitizeIid(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.floor(raw);
}

function sanitizeSlots(raw: unknown, sizeMult: SizeMult): LadderSlot[] | null {
  if (!Array.isArray(raw) || raw.length !== TRANCHE_COUNT) return null;
  const slots: LadderSlot[] = [];
  for (let i = 0; i < TRANCHE_COUNT; i++) {
    const row = raw[i];
    if (!row || typeof row !== "object") return null;
    const rec = row as Record<string, unknown>;
    const index = Number(rec.index);
    if (index !== i + 1) return null;
    const lots = Number(rec.lots);
    if (!Number.isFinite(lots) || lots <= 0) return null;
    const open = Boolean(rec.open);
    const fillRaw = rec.fill;
    const fill =
      typeof fillRaw === "number" && Number.isFinite(fillRaw) && fillRaw > 0 ? fillRaw : null;
    if (open && fill == null) return null;
    slots.push({
      index,
      lots: Math.max(1, Math.floor(lots)),
      open,
      fill: open ? fill : null,
    });
  }
  const expected = lotsForMult(sizeMult);
  const anyOpen = slots.some((s) => s.open);
  if (!anyOpen) {
    return slots.map((s, i) => ({ ...s, lots: expected[i] ?? s.lots }));
  }
  return slots;
}

function sanitizeLogs(raw: unknown): LadderPersistedLog[] {
  if (!Array.isArray(raw)) return [];
  const out: LadderPersistedLog[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    const id = Number(rec.id);
    const ts = Number(rec.ts);
    const text = typeof rec.text === "string" ? rec.text : "";
    const kind = LOG_KINDS.has(rec.kind as LadderLogKind) ? (rec.kind as LadderLogKind) : "info";
    if (!Number.isFinite(id) || !Number.isFinite(ts) || !text) continue;
    out.push({ id, ts, text, kind });
    if (out.length >= 60) break;
  }
  return out;
}

export function sanitizeLadderEngine(raw: unknown): LadderEngineState | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const optionType: OptionType | null =
    rec.optionType === "CE" || rec.optionType === "PE" ? rec.optionType : null;
  if (!optionType) return null;
  const sizeMult = SIZE_MULTS.includes(rec.sizeMult as SizeMult) ? (rec.sizeMult as SizeMult) : null;
  if (!sizeMult) return null;
  const slots = sanitizeSlots(rec.slots, sizeMult);
  if (!slots) return null;
  const t1 = slots.find((s) => s.index === 1);
  const t1FillRaw = rec.t1Fill;
  let t1Fill =
    typeof t1FillRaw === "number" && Number.isFinite(t1FillRaw) && t1FillRaw > 0 ? t1FillRaw : null;
  if (t1?.open && t1.fill != null && t1.fill > 0) {
    t1Fill = t1Fill ?? t1.fill;
  }
  const strikeRaw = rec.strike;
  const strike =
    typeof strikeRaw === "number" && Number.isFinite(strikeRaw) && strikeRaw > 0
      ? strikeRaw
      : null;
  const engine: LadderEngineState = {
    optionType,
    sizeMult,
    armed: Boolean(rec.armed),
    awaitRestart: Boolean(rec.awaitRestart),
    slots,
    t1Fill,
    strike,
  };
  if (isInTrade(engine.slots, engine.t1Fill) && (engine.strike == null || engine.t1Fill == null)) {
    return null;
  }
  return engine;
}

export function parseLadderSession(raw: unknown, today: string): LadderPersisted | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== 1) return null;
  if (typeof rec.day !== "string" || rec.day !== today) return null;
  const engine = sanitizeLadderEngine(rec.engine);
  if (!engine || !ladderSessionActive(engine)) return null;
  const logs = sanitizeLogs(rec.logs);
  const nextLogIdRaw = Number(rec.nextLogId);
  const maxLogId = logs.reduce((m, l) => Math.max(m, l.id), 0);
  const nextLogId =
    Number.isFinite(nextLogIdRaw) && nextLogIdRaw > maxLogId ? Math.floor(nextLogIdRaw) : maxLogId + 1;
  return {
    v: 1,
    day: rec.day,
    iid: sanitizeIid(rec.iid),
    engine,
    logs,
    nextLogId,
  };
}

function readLadderStoreRaw(): string | null {
  try {
    const s = sessionStorage.getItem(LADDER_STORE_KEY);
    if (s) return s;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(LADDER_STORE_KEY);
  } catch {
    return null;
  }
}

function writeLadderStoreRaw(raw: string): void {
  try {
    sessionStorage.setItem(LADDER_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(LADDER_STORE_KEY, raw);
  } catch {
    /* ignore */
  }
}

function removeLadderStoreRaw(): void {
  try {
    sessionStorage.removeItem(LADDER_STORE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(LADDER_STORE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadLadderSession(nowMs: number = Date.now()): LadderPersisted | null {
  try {
    const raw = readLadderStoreRaw();
    if (!raw) return null;
    const parsed = parseLadderSession(JSON.parse(raw), istCalendarDay(nowMs));
    if (!parsed) {
      removeLadderStoreRaw();
      return null;
    }
    return parsed;
  } catch {
    removeLadderStoreRaw();
    return null;
  }
}

export function saveLadderSession(snap: LadderPersisted): void {
  if (!ladderSessionActive(snap.engine)) {
    clearLadderSession();
    return;
  }
  try {
    writeLadderStoreRaw(
      JSON.stringify({
        v: 1,
        day: snap.day,
        iid: snap.iid,
        engine: {
          ...snap.engine,
          slots: snap.engine.slots.map((s) => ({ ...s })),
        },
        logs: snap.logs.slice(0, 60),
        nextLogId: snap.nextLogId,
      } satisfies LadderPersisted),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearLadderSession(): void {
  removeLadderStoreRaw();
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
