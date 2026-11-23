import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChainExpiriesResponse, ChainResolved, ChainResolveResponse } from "@/types/market";
import { peekFyersWsLtp, peekLiveLtp, socketPrintAgeMs, subscribeLiveLtp } from "@/context/LiveLtpContext";
import { setHotFocus } from "@/lib/hotFocus";
import { fmtPnl, fmtPrice, fmtQty } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, clearLocalPosition, setLocalLongPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import { subscribeMdTouchline } from "@/lib/mdRegistry";
import { plausibleSpotPx } from "@/lib/liveAtmStrike";
import { ixOrderRejectedMessage, xtsOwnOrderFill } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import type { IndexName } from "@/pages/Dashboard";
import {
  atmBracket,
  bookedLong,
  bookedShort,
  bothQuoted,
  clockPhase,
  dayHaltTick,
  defaultFlipLock,
  draftFromLock,
  entryStrike,
  FLIP,
  flipBuyQuantity,
  flipFillCounts,
  flipIndex,
  flipStateName,
  istNow,
  liveLockLevels,
  longExitPx,
  longMark,
  nextLongTrail,
  nextTrail,
  openLots,
  parseFlipLock,
  parseFlipLots,
  parseFlipTrigger,
  pickFlipExpiry,
  pickOtmStrike,
  profitLockTick,
  readFlipLock,
  reversalTrigger,
  sellQuantity,
  shortMark,
  shouldBookLong,
  shouldFlip,
  shouldReverse,
  splitFlipBuy,
  splitFlipSell,
  stageAtm,
  syntheticFuture,
  tradableQuote,
  triggerPx,
  type DayHalt,
  type FlipLockDraft,
  type FlipLockParams,
  type ExpiryPick,
  type FlipClock,
  type FlipIndex,
  type FlipMode,
  type FlipPhase,
  type FlipSide,
} from "@/lib/flipRules";

const SESSION_KEY = "sow_flip_v1";
const GUARD_MS = 200;
const CHAIN_MS = 5000;
const CHAIN_REFRESH_MS = 20_000;
const ORDER_BACKOFF_MS = 2_000;
const WINGS = 12;

type LogKind = "entry" | "exit" | "error" | "info";
type FlipLog = { id: number; ts: number; text: string; kind: LogKind };

type OpenLeg = {
  index: FlipIndex;
  side: FlipSide;
  strike: number;
  iid: number;
  segment: number;
  expiry: string;
  mode: FlipMode;
  qty: number;
  sellFill: number;
  trailLow: number;
  trigger: number;
  buyAvg: number | null;
  /** Long only. Empty until the premium is 15% above the buy. */
  trailHigh: number | null;
  /** Long stop, 10% under the buy. Zero while the leg is short. */
  reversal: number;
};

/** After a long books profit, sell this far OTM until it fills. */
type Rebalance = {
  index: FlipIndex;
  side: FlipSide;
  qty: number;
  segment: number;
  expiry: string;
  anchor: number;
};

type PairLock = {
  index: FlipIndex;
  strike: number;
  segment: number;
  ceIid: number;
  peIid: number;
  expiry: string;
  lots: number;
};

type Loaded = {
  at: number;
  date: string;
  index: FlipIndex;
  expiry: ExpiryPick;
  chain: ChainResolved;
};

type OrderSent = {
  filledQty: number;
  fillPx: number | null;
  rate: number | null;
  counted: boolean;
  error: string | null;
};

type SessionStore = {
  sessionDate: string;
  triggerPct: number;
  lots: number;
  lock: FlipLockParams;
  lockFloor: number;
  lockPeak: number | null;
  cycleBase: number;
  legs: OpenLeg[];
  pairLock: PairLock | null;
  stagedAtm: number | null;
  stagedSpot: number | null;
  realized: number;
  started: boolean;
  dayClosed: boolean;
  halt: DayHalt | null;
  rebalance: Rebalance | null;
  logs: FlipLog[];
  logId: number;
};

function emptyStore(
  today: string,
  triggerPct: number = FLIP.triggerDefault,
  lock: FlipLockParams = defaultFlipLock(),
  lots: number = FLIP.lots,
): SessionStore {
  return {
    sessionDate: today,
    triggerPct,
    lots,
    lock,
    lockFloor: 0,
    lockPeak: null,
    cycleBase: 0,
    legs: [],
    pairLock: null,
    stagedAtm: null,
    stagedSpot: null,
    realized: 0,
    started: false,
    dayClosed: false,
    halt: null,
    rebalance: null,
    logs: [],
    logId: 1,
  };
}

function fmtStrike(strike: number): string {
  return Math.round(strike).toLocaleString("en-IN");
}

function symbolOf(leg: Pick<OpenLeg, "index" | "strike" | "side" | "expiry">): string {
  return `${leg.index} ${Math.round(leg.strike)} ${leg.side} ${leg.expiry}`.trim();
}

/** One short may flip. If both crossed, the larger rebound goes first. */
function hotterFlip(legs: readonly OpenLeg[]): OpenLeg | null {
  let best: OpenLeg | null = null;
  let over = 0;
  for (const leg of legs) {
    if (leg.mode !== "short" || !(leg.trigger > 0)) continue;
    const ltp = livePrint(leg.iid);
    if (!shouldFlip("short", ltp, leg.trigger) || ltp == null) continue;
    const ratio = ltp / leg.trigger;
    if (!best || ratio > over) {
      best = leg;
      over = ratio;
    }
  }
  return best;
}

function legTape(leg: OpenLeg): string {
  if (leg.mode === "short") {
    return `${fmtStrike(leg.strike)} · short · low ${fmtPrice(leg.trailLow)} · trigger ${fmtPrice(leg.trigger)}`;
  }
  const stop = leg.buyAvg != null ? reversalTrigger(leg.buyAvg) : 0;
  const exit = longExitPx(leg.trailHigh);
  const trail =
    exit != null && leg.trailHigh != null ? `high ${fmtPrice(leg.trailHigh)} · exit ${fmtPrice(exit)}` : "trail arms +15%";
  return `${fmtStrike(leg.strike)} · long · stop ${fmtPrice(stop)} · ${trail}`;
}

function livePrint(iid: number): number | null {
  if (!(iid > 0)) return null;
  const ws = peekFyersWsLtp(iid);
  if (ws != null && ws > 0) return tradableQuote(ws, true);
  if (socketPrintAgeMs(iid) == null) return null;
  return tradableQuote(peekLiveLtp(iid), true);
}

/** Black tape can show the latest print. Orders still require livePrint. */
function displayPx(iid: number): number | null {
  const live = livePrint(iid);
  if (live != null) return live;
  const px = peekLiveLtp(iid);
  return typeof px === "number" && Number.isFinite(px) && px > 0 ? px : null;
}

function spotNow(chain: ChainResolved): number | null {
  const px = livePrint(chain.spotToken);
  const ok = plausibleSpotPx(chain.index, px ?? undefined);
  return typeof ok === "number" ? ok : null;
}

function shownSpot(chain: ChainResolved): number | null {
  const live = spotNow(chain);
  if (live != null) return live;
  const snap = plausibleSpotPx(chain.index, chain.spotLtp);
  return typeof snap === "number" ? snap : null;
}

function rowAt(chain: ChainResolved, strike: number): { ce: number; pe: number } | null {
  const row = chain.instrumentMap?.[String(strike)];
  if (!row || !(row.ce > 0) || !(row.pe > 0)) return null;
  return row;
}

function around(atm: number): number[] {
  const step = FLIP.strikeStep;
  return [atm - 3 * step, atm - 2 * step, atm - step, atm, atm + step, atm + 2 * step, atm + 3 * step];
}

function readLeg(raw: unknown): OpenLeg | null {
  if (!raw || typeof raw !== "object") return null;
  const leg = raw as Partial<OpenLeg>;
  const index = flipIndex(leg.index);
  if (!index || (leg.side !== "CE" && leg.side !== "PE")) return null;
  if (leg.mode !== "short" && leg.mode !== "long") return null;
  const strike = Number(leg.strike);
  const iid = Number(leg.iid);
  const segment = Number(leg.segment);
  const qty = Number(leg.qty);
  const sellFill = Number(leg.sellFill);
  const trailLow = Number(leg.trailLow);
  const buyAvg = Number(leg.buyAvg);
  if (!(strike > 0) || !(iid > 0) || !(segment > 0) || !(qty > 0)) return null;
  if (leg.mode === "short" && !(sellFill > 0)) return null;
  if (leg.mode === "long" && !(buyAvg > 0)) return null;
  const low = trailLow > 0 ? trailLow : sellFill > 0 ? sellFill : buyAvg;
  const high = Number(leg.trailHigh);
  const avg = buyAvg > 0 ? buyAvg : null;
  return {
    index,
    side: leg.side,
    strike,
    iid,
    segment,
    expiry: typeof leg.expiry === "string" ? leg.expiry : "",
    mode: leg.mode,
    qty: Math.floor(qty),
    sellFill: sellFill > 0 ? sellFill : 0,
    trailLow: low,
    trigger: leg.mode === "short" ? triggerPx(low, FLIP.triggerDefault) : 0,
    buyAvg: avg,
    trailHigh: leg.mode === "long" && high > 0 ? high : null,
    reversal: leg.mode === "long" && avg != null ? reversalTrigger(avg) : 0,
  };
}

function readRebalance(raw: unknown): Rebalance | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<Rebalance>;
  const index = flipIndex(row.index);
  if (!index || (row.side !== "CE" && row.side !== "PE")) return null;
  const qty = Number(row.qty);
  const segment = Number(row.segment);
  const anchor = Number(row.anchor);
  if (!(qty > 0) || !(segment > 0) || !(anchor > 0)) return null;
  return {
    index,
    side: row.side,
    qty: Math.floor(qty),
    segment,
    expiry: typeof row.expiry === "string" ? row.expiry : "",
    anchor,
  };
}

function shortFromFill(base: Omit<OpenLeg, "mode" | "qty" | "sellFill" | "trailLow" | "trigger" | "buyAvg" | "trailHigh" | "reversal">, fill: number, qty: number, triggerPct: number): OpenLeg {
  return {
    ...base,
    mode: "short",
    qty,
    sellFill: fill,
    trailLow: fill,
    trigger: triggerPx(fill, triggerPct),
    buyAvg: null,
    trailHigh: null,
    reversal: 0,
  };
}

function readLock(raw: unknown): PairLock | null {
  if (!raw || typeof raw !== "object") return null;
  const lock = raw as Partial<PairLock>;
  const index = flipIndex(lock.index);
  const strike = Number(lock.strike);
  const segment = Number(lock.segment);
  const ceIid = Number(lock.ceIid);
  const peIid = Number(lock.peIid);
  if (!index || !(strike > 0) || !(segment > 0) || !(ceIid > 0) || !(peIid > 0)) return null;
  const lots = parseFlipLots(String(lock.lots ?? FLIP.lots));
  return {
    index,
    strike,
    segment,
    ceIid,
    peIid,
    expiry: typeof lock.expiry === "string" ? lock.expiry : "",
    lots: lots.ok ? lots.lots : FLIP.lots,
  };
}

function loadStore(): SessionStore {
  const clock = istNow();
  const phase = clockPhase(clock);
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return emptyStore(clock.date);
    const parsed = JSON.parse(raw) as Partial<SessionStore>;
    const saved = parseFlipTrigger(String(parsed.triggerPct ?? FLIP.triggerDefault));
    const triggerPct = saved.ok ? saved.trigger : FLIP.triggerDefault;
    const lock = readFlipLock(parsed.lock);
    const lotsParsed = parseFlipLots(String(parsed.lots ?? FLIP.lots));
    const lots = lotsParsed.ok ? lotsParsed.lots : FLIP.lots;
    if (parsed.sessionDate !== clock.date) return emptyStore(clock.date, triggerPct, lock, lots);
    const legs = (Array.isArray(parsed.legs) ? parsed.legs : [])
      .map((row) => {
        const leg = readLeg(row);
        if (!leg || leg.mode !== "short") return leg;
        return { ...leg, trigger: triggerPx(leg.trailLow, triggerPct) };
      })
      .filter((leg): leg is OpenLeg => leg != null)
      .slice(0, 2);
    const logs = Array.isArray(parsed.logs)
      ? parsed.logs.filter(
          (row): row is FlipLog =>
            !!row && typeof row === "object" && typeof row.id === "number" && typeof row.text === "string",
        )
      : [];
    const shut = phase === "shut";
    const realized = Number(parsed.realized) || 0;
    const peak = typeof parsed.lockPeak === "number" && Number.isFinite(parsed.lockPeak) ? parsed.lockPeak : null;
    const halt = parsed.halt === "loss" || parsed.halt === "target" ? parsed.halt : null;
    return {
      sessionDate: clock.date,
      triggerPct,
      lots,
      lock,
      lockFloor: Number(parsed.lockFloor) > 0 ? Number(parsed.lockFloor) : 0,
      lockPeak: peak,
      cycleBase: typeof parsed.cycleBase === "number" && Number.isFinite(parsed.cycleBase) ? parsed.cycleBase : realized,
      legs,
      pairLock: shut ? null : readLock(parsed.pairLock),
      stagedAtm: Number(parsed.stagedAtm) > 0 && !shut ? Number(parsed.stagedAtm) : null,
      stagedSpot: Number(parsed.stagedSpot) > 0 && !shut ? Number(parsed.stagedSpot) : null,
      realized,
      started: shut || halt != null ? false : parsed.started === true,
      dayClosed: shut || parsed.dayClosed === true,
      halt,
      rebalance: shut || halt != null ? null : readRebalance(parsed.rebalance),
      logs: logs.slice(0, 80),
      logId: logs.reduce((max, row) => Math.max(max, row.id), 0) + 1,
    };
  } catch {
    return emptyStore(clock.date);
  }
}

function moneyDraft(text: string): string {
  const cleaned = text.replace(/[^\d.]/g, "");
  const parts = cleaned.split(".");
  const whole = (parts[0] ?? "").slice(0, 7);
  if (parts.length === 1) return whole;
  return `${whole}.${parts.slice(1).join("").slice(0, 2)}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="cd-field">
      <span className="cd-field__label">{label}</span>
      {children}
    </label>
  );
}

function FlipPx({ iid }: { iid: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const paint = () => {
      const node = ref.current;
      if (!node) return;
      const px = displayPx(iid);
      node.textContent = px == null ? "—" : px.toFixed(2);
    };
    paint();
    const stop = subscribeLiveLtp(iid, paint);
    const id = window.setInterval(paint, 400);
    return () => {
      stop();
      window.clearInterval(id);
    };
  }, [iid]);
  return <span ref={ref} className="tabular-nums" />;
}

function remember(leg: OpenLeg): void {
  const tradingSymbol = symbolOf(leg);
  if (leg.mode === "long" && leg.buyAvg != null) {
    setLocalLongPosition({
      exchangeInstrumentID: leg.iid,
      exchangeSegment: leg.segment,
      qty: leg.qty,
      fillPx: leg.buyAvg,
      tradingSymbol,
    });
    return;
  }
  setLocalShortPosition({
    exchangeInstrumentID: leg.iid,
    exchangeSegment: leg.segment,
    qty: leg.qty,
    fillPx: leg.sellFill,
    tradingSymbol,
  });
}

function legQuoteMark(leg: OpenLeg): number | null {
  const ltp = livePrint(leg.iid);
  if (ltp == null) return null;
  if (leg.mode === "short") return shortMark(leg.sellFill, ltp, leg.qty);
  if (leg.buyAvg == null) return null;
  return longMark(leg.buyAvg, ltp, leg.qty);
}

export default function FlipPanel({ index, active }: { index: IndexName; active: boolean }) {
  const boot = useRef<SessionStore | null>(null);
  if (!boot.current) boot.current = loadStore();
  const initial = boot.current;

  const [triggerPct, setTriggerPct] = useState(initial.triggerPct);
  const [draftTrigger, setDraftTrigger] = useState(String(initial.triggerPct));
  const [lots, setLots] = useState(initial.lots);
  const [draftLots, setDraftLots] = useState(String(initial.lots));
  const [lockParams, setLockParams] = useState<FlipLockParams>(initial.lock);
  const [lockDraft, setLockDraft] = useState<FlipLockDraft>(() => draftFromLock(initial.lock));
  const [lockFloor, setLockFloor] = useState(initial.lockFloor);
  const [lockPeak, setLockPeak] = useState<number | null>(initial.lockPeak);
  const [cycleBase, setCycleBase] = useState(initial.cycleBase);
  const [legs, setLegs] = useState<OpenLeg[]>(initial.legs);
  const [pairLock, setPairLock] = useState<PairLock | null>(initial.pairLock);
  const [stagedAtm, setStagedAtm] = useState<number | null>(initial.stagedAtm);
  const [stagedSpot, setStagedSpot] = useState<number | null>(initial.stagedSpot);
  const [realized, setRealized] = useState(initial.realized);
  const [started, setStarted] = useState(initial.started);
  const [dayClosed, setDayClosed] = useState(initial.dayClosed);
  const [halt, setHalt] = useState<DayHalt | null>(initial.halt);
  const [rebalance, setRebalance] = useState<Rebalance | null>(initial.rebalance);
  const [logs, setLogs] = useState<FlipLog[]>(initial.logs);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [chainNote, setChainNote] = useState("");
  const [markTick, setMarkTick] = useState(0);

  const triggerRef = useRef(triggerPct);
  const lotsRef = useRef(lots);
  const lockParamsRef = useRef(lockParams);
  const floorRef = useRef(lockFloor);
  const peakRef = useRef(lockPeak);
  const cycleBaseRef = useRef(cycleBase);
  const legsRef = useRef(legs);
  const lockRef = useRef(pairLock);
  const stagedAtmRef = useRef(stagedAtm);
  const stagedSpotRef = useRef(stagedSpot);
  const realizedRef = useRef(realized);
  const startedRef = useRef(started);
  const dayClosedRef = useRef(dayClosed);
  const haltRef = useRef(halt);
  const rebalanceRef = useRef(rebalance);
  const haltPendingRef = useRef<DayHalt | null>(null);
  /** A short that crossed together with the leg we just flipped. It must cool off before it can flip. */
  const flipHoldRef = useRef<FlipSide | null>(null);
  const loadedRef = useRef(loaded);
  const indexRef = useRef(index);
  const activeRef = useRef(active);
  const busyRef = useRef(false);
  const tickingRef = useRef(false);
  const backoffRef = useRef(0);
  const notedRef = useRef(new Map<string, string>());
  const logIdRef = useRef(initial.logId);
  const sessionDateRef = useRef(initial.sessionDate);
  const shownRef = useRef(0);
  triggerRef.current = triggerPct;
  lotsRef.current = lots;
  lockParamsRef.current = lockParams;
  floorRef.current = lockFloor;
  peakRef.current = lockPeak;
  cycleBaseRef.current = cycleBase;
  legsRef.current = legs;
  lockRef.current = pairLock;
  stagedAtmRef.current = stagedAtm;
  stagedSpotRef.current = stagedSpot;
  realizedRef.current = realized;
  startedRef.current = started;
  dayClosedRef.current = dayClosed;
  haltRef.current = halt;
  rebalanceRef.current = rebalance;
  loadedRef.current = loaded;
  indexRef.current = index;
  activeRef.current = active;

  const pushLog = useCallback((text: string, kind: LogKind) => {
    const row: FlipLog = { id: logIdRef.current++, ts: Date.now(), text, kind };
    setLogs((prev) => [row, ...prev].slice(0, 80));
  }, []);

  const note = useCallback(
    (key: string, text: string, kind: LogKind) => {
      if (notedRef.current.get(key) === text) return;
      notedRef.current.set(key, text);
      pushLog(text, kind);
    },
    [pushLog],
  );

  const commitLegs = useCallback((next: OpenLeg[]) => {
    legsRef.current = next;
    setLegs(next);
  }, []);

  const commitLock = useCallback((next: PairLock | null) => {
    lockRef.current = next;
    setPairLock(next);
  }, []);

  const commitStage = useCallback((atm: number | null, spot: number | null) => {
    stagedAtmRef.current = atm;
    stagedSpotRef.current = spot;
    setStagedAtm(atm);
    setStagedSpot(spot);
  }, []);

  const commitHalt = useCallback((next: DayHalt | null) => {
    haltRef.current = next;
    setHalt(next);
  }, []);

  const commitRebalance = useCallback((next: Rebalance | null) => {
    rebalanceRef.current = next;
    setRebalance(next);
  }, []);

  const addRealized = useCallback((pnl: number) => {
    const next = realizedRef.current + pnl;
    realizedRef.current = next;
    setRealized(next);
  }, []);

  const commitProfit = useCallback((floor: number, peak: number | null) => {
    floorRef.current = floor;
    peakRef.current = peak;
    setLockFloor(floor);
    setLockPeak(peak);
  }, []);

  useEffect(() => {
    const store: SessionStore = {
      sessionDate: sessionDateRef.current,
      triggerPct,
      lots,
      lock: lockParams,
      lockFloor,
      lockPeak,
      cycleBase,
      legs,
      pairLock,
      stagedAtm,
      stagedSpot,
      realized,
      started,
      dayClosed,
      halt,
      rebalance,
      logs,
      logId: logIdRef.current,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(store));
    } catch {
      /* ignore quota */
    }
  }, [triggerPct, lots, lockParams, lockFloor, lockPeak, cycleBase, legs, pairLock, stagedAtm, stagedSpot, realized, started, dayClosed, halt, rebalance, logs]);

  useEffect(() => {
    const name = flipIndex(index);
    if (!name) return;
    let cancelled = false;
    const load = async () => {
      const clock = istNow();
      const open = legsRef.current.length > 0 || lockRef.current != null;
      const watching = activeRef.current || startedRef.current || open;
      if (!watching) return;
      const have = loadedRef.current;
      const stale = !have || have.date !== clock.date || have.index !== name;
      const refresh = startedRef.current && legsRef.current.length === 0 && lockRef.current == null && !!have && Date.now() - have.at > CHAIN_REFRESH_MS;
      if (have && !stale && !refresh) return;
      try {
        const exp = (await apiFetch("/api/chain/expiries", {
          method: "POST",
          body: JSON.stringify({ index: name }),
        })) as ChainExpiriesResponse;
        if (cancelled || flipIndex(indexRef.current) !== name) return;
        if (!exp.ok || !exp.expiries?.length) {
          setChainNote(exp.ok === false ? exp.error || "Expiry list failed." : "Expiry list failed.");
          return;
        }
        const pick = pickFlipExpiry(exp.expiries, clock);
        if (!pick) {
          setChainNote("No weekday expiry on or after today.");
          return;
        }
        const tradeRaw = (await apiFetch("/api/chain/resolve", {
          method: "POST",
          body: JSON.stringify({ index: name, expiry: pick.api, wings: WINGS, skipNotify: true }),
        })) as ChainResolveResponse;
        if (cancelled || flipIndex(indexRef.current) !== name) return;
        if (!tradeRaw.ok) {
          setChainNote(tradeRaw.error || "Expiry chain failed.");
          return;
        }
        const next: Loaded = { at: Date.now(), date: clock.date, index: name, expiry: pick, chain: tradeRaw };
        loadedRef.current = next;
        setLoaded(next);
        setChainNote("");
        notedRef.current.delete("chain");
      } catch (err: unknown) {
        if (!cancelled) setChainNote(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = window.setInterval(() => void load(), CHAIN_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [index, active]);

  useEffect(() => {
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (segment: number, iid: number) => {
      if (!(segment > 0) || !(iid > 0) || seen.has(iid)) return;
      seen.add(iid);
      instruments.push({ exchangeSegment: segment, exchangeInstrumentID: iid });
    };
    const chain = loaded?.chain;
    const keep = active || started || legs.length > 0 || pairLock != null || rebalance != null;
    const warmAll = started || legs.length > 0 || rebalance != null;
    if (chain && keep && flipIndex(index)) {
      add(chain.spotSegment, chain.spotToken);
      if (warmAll) {
        for (const row of Object.values(chain.instrumentMap ?? {})) {
          if (!row) continue;
          add(chain.optionSegment, row.ce);
          add(chain.optionSegment, row.pe);
        }
      } else {
        const centers = [chain.atmStrike, stagedAtm, pairLock?.strike].filter((n): n is number => typeof n === "number" && n > 0);
        for (const center of centers) {
          for (const strike of around(center)) {
            const row = rowAt(chain, strike);
            if (!row) continue;
            add(chain.optionSegment, row.ce);
            add(chain.optionSegment, row.pe);
          }
        }
      }
    }
    for (const leg of legs) add(leg.segment, leg.iid);
    if (pairLock) {
      add(pairLock.segment, pairLock.ceIid);
      add(pairLock.segment, pairLock.peIid);
    }
    let cancelled = false;
    if (instruments.length) void subscribeMdTouchline(instruments, () => cancelled);
    setHotFocus("flip", instruments);
    return () => {
      cancelled = true;
      setHotFocus("flip", []);
    };
  }, [index, active, started, loaded, legs, pairLock, stagedAtm, rebalance]);

  const sendOrder = useCallback(
    async (
      orderSide: "BUY" | "SELL",
      instrumentId: number,
      orderQuantity: number,
      segment: number,
      exit: boolean,
    ): Promise<OrderSent> => {
      const rate = livePrint(instrumentId);
      const blank = (error: string): OrderSent => ({
        filledQty: 0,
        fillPx: null,
        rate,
        counted: false,
        error,
      });
      if (rate == null && !exit) return blank("No live quote. Order not sent.");
      let response: { ok?: boolean; error?: string; raw?: unknown } | null = null;
      try {
        response = (await apiFetch("/api/ix/place_order", {
          method: "POST",
          body: JSON.stringify({
            orderType: "MARKET",
            productType: "NRML",
            timeInForce: "IOC",
            apiOrderSource: "WEBAPI",
            disclosedQuantity: 0,
            limitPrice: 0,
            stopPrice: 0,
            keepMarket: true,
            exchangeSegment: segment,
            exchangeInstrumentID: instrumentId,
            orderSide,
            orderQuantity,
            bookOnlyIfFilled: true,
          }),
        })) as { ok?: boolean; error?: string; raw?: unknown };
      } catch (err: unknown) {
        bumpPositionsRefresh();
        return blank(err instanceof Error ? err.message : String(err));
      }
      bumpPositionsRefresh();
      const raw = response?.raw ?? response;
      const own = xtsOwnOrderFill(raw, instrumentId);
      const rejectedText = ixOrderRejectedMessage(raw) || ixOrderRejectedMessage(response) || response?.error || null;
      if (own && (rate == null || flipFillCounts(own.px, rate))) {
        return { filledQty: own.qty, fillPx: own.px, rate, counted: true, error: null };
      }
      return {
        filledQty: 0,
        fillPx: own?.px ?? null,
        rate,
        counted: false,
        error: rejectedText || "Order not filled",
      };
    },
    [],
  );

  const clearBook = useCallback(() => {
    commitLegs([]);
    commitLock(null);
    commitStage(null, null);
    commitRebalance(null);
    flipHoldRef.current = null;
  }, [commitLegs, commitLock, commitRebalance, commitStage]);

  const flatten = useCallback(
    async (reason: string) => {
      commitLock(null);
      commitRebalance(null);
      let guard = 0;
      while (legsRef.current.length && guard < 4) {
        guard += 1;
        const leg = legsRef.current[0]!;
        const orderSide = leg.mode === "short" ? "BUY" : "SELL";
        const sent = await sendOrder(orderSide, leg.iid, leg.qty, leg.segment, true);
        if (!sent.counted || sent.fillPx == null || sent.filledQty <= 0) {
          pushLog(
            `Not booked. ${reason} ${orderSide} ${leg.side} ${fmtStrike(leg.strike)} rate ${sent.rate == null ? "—" : fmtPrice(sent.rate)}. ${sent.error || ""}`.trim(),
            "error",
          );
          backoffRef.current = Date.now() + ORDER_BACKOFF_MS;
          return false;
        }
        const used = Math.min(sent.filledQty, leg.qty);
        const booked =
          leg.mode === "short" ? bookedShort(leg.sellFill, sent.fillPx, used) : bookedLong(sent.fillPx, leg.buyAvg ?? sent.fillPx, used);
        addRealized(booked);
        const left = leg.qty - used;
        if (left <= 0) {
          clearLocalPosition(leg.iid, booked);
          commitLegs(legsRef.current.filter((row) => row.iid !== leg.iid));
        } else {
          const nextLeg = { ...leg, qty: left };
          commitLegs(legsRef.current.map((row) => (row.iid === leg.iid ? nextLeg : row)));
          remember(nextLeg);
        }
        pushLog(
          `${reason} ${orderSide} ${leg.side} ${fmtStrike(leg.strike)} fill ${fmtPrice(sent.fillPx)} booked ${fmtPnl(booked)}`,
          "exit",
        );
      }
      if (!legsRef.current.length) {
        commitStage(null, null);
        commitProfit(0, null);
        pushLog(`${reason}. Card is flat.`, "info");
        return true;
      }
      backoffRef.current = Date.now() + ORDER_BACKOFF_MS;
      return false;
    },
    [addRealized, commitLegs, commitLock, commitProfit, commitRebalance, commitStage, pushLog, sendOrder],
  );

  const sellLocked = useCallback(async () => {
    const lock = lockRef.current;
    if (!lock || clockPhase(istNow()) !== "open") return;
    const missing = (["CE", "PE"] as const).filter((side) => !legsRef.current.some((row) => row.side === side));
    if (!missing.length) {
      commitLock(null);
      return;
    }
    const sentRows = await Promise.all(
      missing.map(async (side) => {
        const iid = side === "CE" ? lock.ceIid : lock.peIid;
        const rate = livePrint(iid);
        if (clockPhase(istNow()) !== "open") return { side, iid, rate, sent: null as OrderSent | null };
        if (!(rate != null && rate > 0)) {
          note(`quote-${side}`, `${side} has no live quote. Sell waits.`, "info");
          return { side, iid, rate, sent: null as OrderSent | null };
        }
        const sent = await sendOrder("SELL", iid, sellQuantity(lock.index, lock.lots), lock.segment, false);
        return { side, iid, rate, sent };
      }),
    );
    let next = legsRef.current.slice();
    let changed = false;
    for (const row of sentRows) {
      if (!row.sent) continue;
      if (!row.sent.counted || row.sent.fillPx == null || row.sent.filledQty <= 0) {
        pushLog(
          `Not booked. SELL ${row.side} ${fmtStrike(lock.strike)} rate ${row.rate == null ? "—" : fmtPrice(row.rate)}. ${row.sent.error || ""}`.trim(),
          "error",
        );
        backoffRef.current = Date.now() + ORDER_BACKOFF_MS;
        continue;
      }
      const qty = Math.min(row.sent.filledQty, sellQuantity(lock.index, lock.lots));
      const leg = shortFromFill(
        {
          index: lock.index,
          side: row.side,
          strike: lock.strike,
          iid: row.iid,
          segment: lock.segment,
          expiry: lock.expiry,
        },
        row.sent.fillPx,
        qty,
        triggerRef.current,
      );
      next = [...next.filter((item) => item.side !== row.side), leg];
      changed = true;
      remember(leg);
      pushLog(`SELL ${row.side} ${fmtStrike(lock.strike)} fill ${fmtPrice(row.sent.fillPx)} qty ${fmtQty(qty)}`, "entry");
    }
    if (changed) commitLegs(next);
    const ce = next.find((row) => row.side === "CE");
    const pe = next.find((row) => row.side === "PE");
    if (ce && pe) {
      commitLock(null);
      const state = flipStateName(ce.mode, pe.mode);
      if (state) pushLog(`${state}.`, "info");
      if (ce.mode === "short" && pe.mode === "short") {
        toast({ title: "Flip sold", description: `${lock.index} ${fmtStrike(lock.strike)} CE and PE` });
      }
    }
  }, [commitLegs, commitLock, note, pushLog, sendOrder]);

  const logState = useCallback(() => {
    const ce = legsRef.current.find((row) => row.side === "CE") ?? null;
    const pe = legsRef.current.find((row) => row.side === "PE") ?? null;
    const text = flipStateName(ce?.mode ?? null, pe?.mode ?? null);
    if (text) note("state", `${text}.`, "info");
  }, [note]);

  /** Sell the long quantity only. A partial fill stays long and the caller does not continue. */
  const closeLong = useCallback(
    async (leg: OpenLeg, reason: string): Promise<boolean> => {
      const live = legsRef.current.find((row) => row.iid === leg.iid && row.mode === "long");
      if (!live || live.buyAvg == null) return false;
      const sent = await sendOrder("SELL", live.iid, live.qty, live.segment, false);
      if (!sent.counted || sent.fillPx == null || sent.filledQty <= 0) {
        pushLog(
          `Not booked. ${reason} SELL ${live.side} ${fmtStrike(live.strike)} rate ${sent.rate == null ? "—" : fmtPrice(sent.rate)}. ${sent.error || ""}`.trim(),
          "error",
        );
        backoffRef.current = Date.now() + ORDER_BACKOFF_MS;
        return false;
      }
      const used = Math.min(sent.filledQty, live.qty);
      const booked = bookedLong(sent.fillPx, live.buyAvg, used);
      addRealized(booked);
      const left = live.qty - used;
      if (left > 0) {
        const nextLeg = { ...live, qty: left };
        commitLegs(legsRef.current.map((row) => (row.iid === live.iid ? nextLeg : row)));
        remember(nextLeg);
        pushLog(
          `${reason} SELL ${live.side} ${fmtStrike(live.strike)} fill ${fmtPrice(sent.fillPx)} booked ${fmtPnl(booked)}. Long left ${fmtQty(left)}.`,
          "exit",
        );
        return false;
      }
      clearLocalPosition(live.iid, booked);
      commitLegs(legsRef.current.filter((row) => row.iid !== live.iid));
      pushLog(`${reason} SELL ${live.side} ${fmtStrike(live.strike)} fill ${fmtPrice(sent.fillPx)} booked ${fmtPnl(booked)}.`, "exit");
      logState();
      return true;
    },
    [addRealized, commitLegs, logState, pushLog, sendOrder],
  );

  /** Sell twice the long. The first half closes it. The rest is a new short, trailed from this fill. */
  const reverseLong = useCallback(
    async (leg: OpenLeg) => {
      const live = legsRef.current.find((row) => row.iid === leg.iid && row.mode === "long");
      if (!live || live.buyAvg == null) return;
      const sent = await sendOrder("SELL", live.iid, flipBuyQuantity(live.qty), live.segment, false);
      if (!sent.counted || sent.fillPx == null || sent.filledQty <= 0) {
        pushLog(
          `Not booked. REVERSAL SELL ${live.side} ${fmtStrike(live.strike)} rate ${sent.rate == null ? "—" : fmtPrice(sent.rate)}. ${sent.error || ""}`.trim(),
          "error",
        );
        backoffRef.current = Date.now() + ORDER_BACKOFF_MS;
        return;
      }
      const split = splitFlipSell(live.qty, sent.filledQty);
      if (split.cover > 0) addRealized(bookedLong(sent.fillPx, live.buyAvg, split.cover));
      if (split.longLeft > 0) {
        const nextLeg = { ...live, qty: split.longLeft };
        commitLegs(legsRef.current.map((row) => (row.iid === live.iid ? nextLeg : row)));
        remember(nextLeg);
        pushLog(
          `REVERSAL SELL ${live.side} ${fmtStrike(live.strike)} fill ${fmtPrice(sent.fillPx)} covered ${fmtQty(split.cover)}. Long left ${fmtQty(split.longLeft)}.`,
          "exit",
        );
        return;
      }
      clearLocalPosition(live.iid, bookedLong(sent.fillPx, live.buyAvg, split.cover));
      let shortQty = split.shortQty;
      let fill = sent.fillPx;
      if (shortQty <= 0) {
        const again = await sendOrder("SELL", live.iid, live.qty, live.segment, false);
        if (!again.counted || again.fillPx == null || again.filledQty <= 0) {
          commitLegs(legsRef.current.filter((row) => row.iid !== live.iid));
          pushLog(`REVERSAL closed ${live.side} ${fmtStrike(live.strike)}. The new short was not filled.`, "exit");
          logState();
          return;
        }
        shortQty = Math.min(again.filledQty, live.qty);
        fill = again.fillPx;
      }
      const nextLeg = shortFromFill(live, fill, shortQty, triggerRef.current);
      commitLegs(legsRef.current.map((row) => (row.iid === live.iid ? nextLeg : row)));
      remember(nextLeg);
      pushLog(
        `REVERSAL ${live.side} ${fmtStrike(live.strike)} sell ${fmtPrice(fill)} qty ${fmtQty(flipBuyQuantity(live.qty))}. New short ${fmtQty(shortQty)}. Trail ${fmtPrice(fill)}.`,
        "entry",
      );
      logState();
    },
    [addRealized, commitLegs, logState, pushLog, sendOrder],
  );

  const flipShort = useCallback(
    async (leg: OpenLeg) => {
      const live = legsRef.current.find((row) => row.iid === leg.iid && row.mode === "short");
      if (!live) return;
      const ltp = livePrint(live.iid);
      if (!shouldFlip(live.mode, ltp, live.trigger)) return;
      const sent = await sendOrder("BUY", live.iid, flipBuyQuantity(live.qty), live.segment, false);
      if (!sent.counted || sent.fillPx == null || sent.filledQty <= 0) {
        pushLog(
          `Not booked. FLIP BUY ${live.side} ${fmtStrike(live.strike)} rate ${sent.rate == null ? "—" : fmtPrice(sent.rate)}. ${sent.error || ""}`.trim(),
          "error",
        );
        backoffRef.current = Date.now() + ORDER_BACKOFF_MS;
        return;
      }
      const split = splitFlipBuy(live.qty, sent.filledQty);
      if (split.cover > 0) addRealized(bookedShort(live.sellFill, sent.fillPx, split.cover));
      if (split.shortLeft > 0) {
        const nextLeg = { ...live, qty: split.shortLeft };
        commitLegs(legsRef.current.map((row) => (row.iid === live.iid ? nextLeg : row)));
        remember(nextLeg);
        pushLog(
          `FLIP BUY ${live.side} ${fmtStrike(live.strike)} fill ${fmtPrice(sent.fillPx)} covered ${fmtQty(split.cover)}. Short left ${fmtQty(split.shortLeft)}.`,
          "exit",
        );
        return;
      }
      if (split.longQty > 0) {
        const nextLeg: OpenLeg = {
          ...live,
          mode: "long",
          qty: split.longQty,
          buyAvg: sent.fillPx,
          trigger: 0,
          trailHigh: null,
          reversal: reversalTrigger(sent.fillPx),
        };
        commitLegs(legsRef.current.map((row) => (row.iid === live.iid ? nextLeg : row)));
        remember(nextLeg);
        const booked = bookedShort(live.sellFill, sent.fillPx, split.cover);
        pushLog(
          `FLIP ${live.side} ${fmtStrike(live.strike)} buy ${fmtPrice(sent.fillPx)} qty ${fmtQty(sent.filledQty)}. Short booked ${fmtPnl(booked)}. Long avg ${fmtPrice(sent.fillPx)}. Stop ${fmtPrice(nextLeg.reversal)}.`,
          "entry",
        );
        toast({ title: `${live.side} flipped`, description: `${live.index} ${fmtStrike(live.strike)} long ${fmtQty(split.longQty)}` });
        logState();
        return;
      }
      clearLocalPosition(live.iid, bookedShort(live.sellFill, sent.fillPx, split.cover));
      commitLegs(legsRef.current.filter((row) => row.iid !== live.iid));
      pushLog(`FLIP BUY ${live.side} ${fmtStrike(live.strike)} closed the short. No long opened.`, "exit");
      logState();
    },
    [addRealized, commitLegs, logState, pushLog, sendOrder],
  );

  /** Sell the far OTM whose premium is nearest ₹70 and trail that new short. */
  const sellOtm = useCallback(async () => {
    const job = rebalanceRef.current;
    if (!job) return;
    if (legsRef.current.some((row) => row.side === job.side)) {
      commitRebalance(null);
      return;
    }
    const book = loadedRef.current;
    if (!book || book.index !== job.index) {
      note("otm", "Chain is not ready. The ₹70 OTM sell waits.", "info");
      return;
    }
    const quotes: { strike: number; px: number | null }[] = [];
    for (const [key, row] of Object.entries(book.chain.instrumentMap ?? {})) {
      const strike = Number(key);
      if (!(strike > 0) || !row) continue;
      const iid = job.side === "CE" ? row.ce : row.pe;
      quotes.push({ strike, px: livePrint(iid) });
    }
    const strike = pickOtmStrike(quotes, job.side, job.anchor);
    if (strike == null) {
      note("otm", `${job.side} OTM near ${FLIP.otmPremium} has no live quote. Sell waits.`, "info");
      return;
    }
    const row = rowAt(book.chain, strike);
    if (!row) return;
    const iid = job.side === "CE" ? row.ce : row.pe;
    const sent = await sendOrder("SELL", iid, job.qty, job.segment, false);
    if (!sent.counted || sent.fillPx == null || sent.filledQty <= 0) {
      pushLog(
        `Not booked. OTM SELL ${job.side} ${fmtStrike(strike)} rate ${sent.rate == null ? "—" : fmtPrice(sent.rate)}. ${sent.error || ""}`.trim(),
        "error",
      );
      backoffRef.current = Date.now() + ORDER_BACKOFF_MS;
      return;
    }
    const qty = Math.min(sent.filledQty, job.qty);
    const leg = shortFromFill(
      { index: job.index, side: job.side, strike, iid, segment: job.segment, expiry: job.expiry || book.chain.expiryUi || book.expiry.label },
      sent.fillPx,
      qty,
      triggerRef.current,
    );
    commitRebalance(null);
    commitLegs([...legsRef.current.filter((item) => item.side !== job.side), leg]);
    remember(leg);
    notedRef.current.delete("otm");
    pushLog(`OTM SELL ${job.side} ${fmtStrike(strike)} fill ${fmtPrice(sent.fillPx)} qty ${fmtQty(qty)}. Near ${FLIP.otmPremium}.`, "entry");
    logState();
  }, [commitLegs, commitRebalance, logState, note, pushLog, sendOrder]);

  const engineRef = useRef<() => Promise<void>>(async () => {});
  engineRef.current = async () => {
    if (tickingRef.current || busyRef.current) return;
    const clock: FlipClock = istNow();
    if (sessionDateRef.current !== clock.date) {
      sessionDateRef.current = clock.date;
      startedRef.current = false;
      dayClosedRef.current = false;
      realizedRef.current = 0;
      cycleBaseRef.current = 0;
      setStarted(false);
      setDayClosed(false);
      setRealized(0);
      setCycleBase(0);
      commitHalt(null);
      commitRebalance(null);
      haltPendingRef.current = null;
      commitProfit(0, null);
      clearBook();
      loadedRef.current = null;
      setLoaded(null);
      notedRef.current.clear();
      pushLog("New session. Card cleared.", "info");
      return;
    }

    const phase = clockPhase(clock);
    tickingRef.current = true;
    try {
      if (phase === "shut") {
        if (!dayClosedRef.current) {
          dayClosedRef.current = true;
          setDayClosed(true);
          const open = legsRef.current.length > 0 || lockRef.current != null || rebalanceRef.current != null;
          if (startedRef.current) {
            startedRef.current = false;
            setStarted(false);
          }
          pushLog(open ? "15:15. Flattening the card." : "15:15. No new sell.", "info");
        }
        if (legsRef.current.length || lockRef.current || rebalanceRef.current) await flatten("15:15");
        return;
      }

      if (!startedRef.current) {
        if (legsRef.current.length || lockRef.current || rebalanceRef.current) await flatten("STOP");
        return;
      }

      const ordersOk = Date.now() >= backoffRef.current;
      const pct = triggerRef.current;
      let trailed = legsRef.current.slice();
      let trailChanged = false;
      for (const leg of trailed) {
        const ltp = livePrint(leg.iid) ?? 0;
        if (leg.mode === "short") {
          const moved = nextTrail(leg.trailLow, ltp, pct);
          if (moved.trailLow !== leg.trailLow || moved.trigger !== leg.trigger) {
            trailChanged = true;
            trailed = trailed.map((row) => (row.iid === leg.iid ? { ...row, trailLow: moved.trailLow, trigger: moved.trigger } : row));
          }
          continue;
        }
        if (leg.mode !== "long" || leg.buyAvg == null) continue;
        const high = nextLongTrail(leg.buyAvg, leg.trailHigh, ltp);
        const reversal = reversalTrigger(leg.buyAvg);
        if (high !== leg.trailHigh || reversal !== leg.reversal) {
          trailChanged = true;
          trailed = trailed.map((row) => (row.iid === leg.iid ? { ...row, trailHigh: high, reversal } : row));
        }
      }
      if (trailChanged) commitLegs(trailed);

      let day: number | null = realizedRef.current;
      let cycle: number | null = realizedRef.current - cycleBaseRef.current;
      if (legsRef.current.length) {
        for (const leg of legsRef.current) {
          const mark = legQuoteMark(leg);
          if (mark == null) {
            day = null;
            cycle = null;
            break;
          }
          day += mark;
          cycle += mark;
        }
      }
      const dayExit = dayHaltTick(day);
      if (dayExit) haltPendingRef.current = dayExit;
      if (haltPendingRef.current) {
        const why = haltPendingRef.current;
        const label = why === "loss" ? "Daily loss" : "Daily target";
        pushLog(`${label}${day == null ? "" : ` ${fmtPnl(day)}`}. Flattening.`, "info");
        busyRef.current = true;
        setBusy(true);
        const closed = await flatten(label);
        if (closed) {
          haltPendingRef.current = null;
          commitHalt(why);
          startedRef.current = false;
          setStarted(false);
          pushLog(`${label} closed the card. START sends no new sell today.`, "info");
        }
        return;
      }

      if (legsRef.current.length && cycle != null) {
        const bookIndex = legsRef.current[0]!.index;
        const lots = openLots(
          legsRef.current.map((leg) => leg.qty),
          bookIndex,
        );
        const step = profitLockTick({
          mtm: cycle,
          lots,
          floor: floorRef.current,
          peak: peakRef.current,
          params: lockParamsRef.current,
        });
        if (step.floor !== floorRef.current || step.peak !== peakRef.current) {
          const raised = step.floor > floorRef.current;
          commitProfit(step.floor, step.peak);
          if (raised) {
            pushLog(
              `Profit lock floor ${fmtPrice(step.floor)}${step.peak != null ? ` · peak ${fmtPrice(step.peak)}` : ""}.`,
              "info",
            );
          }
        }
        if (step.square) {
          pushLog(`Profit lock. Cycle ${fmtPnl(cycle)} at floor ${fmtPrice(step.floor)}. Flattening.`, "info");
          busyRef.current = true;
          setBusy(true);
          const closed = await flatten("Lock");
          if (closed) {
            startedRef.current = false;
            setStarted(false);
          }
          return;
        }
      }

      if (ordersOk && clockPhase(istNow()) === "open") {
        const rows = legsRef.current;
        const longs = rows.filter((row) => row.mode === "long" && row.buyAvg != null);
        const run = async (work: () => Promise<unknown>) => {
          busyRef.current = true;
          setBusy(true);
          await work();
        };
        if (longs.length > 1) {
          const first = longs[0];
          if (first) await run(() => closeLong(first, "One long"));
          return;
        }
        const reversing = longs.find((leg) => shouldReverse("long", livePrint(leg.iid), reversalTrigger(leg.buyAvg ?? 0)));
        if (reversing) {
          await run(() => reverseLong(reversing));
          return;
        }
        if (rebalanceRef.current) {
          await run(() => sellOtm());
          return;
        }
        const booking = longs.find((leg) => {
          const ltp = livePrint(leg.iid);
          const stop = reversalTrigger(leg.buyAvg ?? 0);
          return ltp != null && ltp > stop && shouldBookLong(ltp, longExitPx(leg.trailHigh));
        });
        if (booking) {
          await run(async () => {
            const job: Rebalance = {
              index: booking.index,
              side: booking.side,
              qty: booking.qty,
              segment: booking.segment,
              expiry: booking.expiry,
              anchor: booking.strike,
            };
            const closed = await closeLong(booking, "Long exit");
            if (!closed) return;
            commitRebalance(job);
            await sellOtm();
          });
          return;
        }
        if (flipHoldRef.current) {
          const held = rows.find((row) => row.side === flipHoldRef.current);
          const heldLtp = held ? livePrint(held.iid) : null;
          if (!held || held.mode !== "short" || !shouldFlip("short", heldLtp, held.trigger)) flipHoldRef.current = null;
        }
        const hit = hotterFlip(rows.filter((row) => row.side !== flipHoldRef.current));
        if (hit) {
          await run(async () => {
            const otherShort = legsRef.current.find((row) => row.side !== hit.side && row.mode === "short");
            const otherLtp = otherShort ? livePrint(otherShort.iid) : null;
            const otherHot = !!otherShort && shouldFlip("short", otherLtp, otherShort.trigger);
            const other = legsRef.current.find((row) => row.side !== hit.side && row.mode === "long");
            if (other) {
              const closed = await closeLong(other, "One long");
              if (!closed) return;
            }
            const still = legsRef.current.find((row) => row.iid === hit.iid && row.mode === "short");
            if (!still) return;
            await flipShort(still);
            if (otherHot) {
              flipHoldRef.current = otherShort!.side;
              note(
                "hold",
                `${otherShort!.side} also crossed. It stays short until it trades back under its trigger. Only one leg is long.`,
                "info",
              );
            }
          });
          return;
        }
      }

      if (!startedRef.current) {
        if (legsRef.current.length || lockRef.current || rebalanceRef.current) await flatten("STOP");
        return;
      }
      if (clockPhase(istNow()) !== "open" && clockPhase(istNow()) !== "stage" && clockPhase(istNow()) !== "pre") return;

      const name = flipIndex(indexRef.current);
      const flat = legsRef.current.length === 0 && lockRef.current == null && rebalanceRef.current == null;
      if (!name && flat) note("index", "Flip trades NIFTY or SENSEX only. No order.", "info");

      if (lockRef.current && ordersOk && clockPhase(istNow()) === "open") {
        busyRef.current = true;
        setBusy(true);
        await sellLocked();
        return;
      }

      if (!flat) return;
      if (!name) return;
      if (phase === "pre") {
        note("plan", "Before 09:15. START waits. ATM stages at 09:10.", "info");
        return;
      }
      if (!ordersOk) return;
      const book = loadedRef.current;
      if (!book || book.index !== name || book.date !== clock.date) {
        note("chain", chainNote || "Expiry chain is not ready.", "info");
        return;
      }
      if (stagedAtmRef.current == null) {
        const spot = spotNow(book.chain);
        const atm = spot == null ? null : stageAtm(spot);
        if (spot == null || atm == null) {
          note("spot", "No live spot. ATM not staged.", "info");
          return;
        }
        commitStage(atm, spot);
        notedRef.current.delete("spot");
        const stagedBracket = atmBracket(atm);
        pushLog(
          `Staged ATM ${fmtStrike(atm)} from spot ${fmtPrice(spot)}. Quotes ${stagedBracket.map((n) => fmtStrike(n)).join(", ")}.`,
          "info",
        );
        if (phase !== "open") note("plan", `ATM ${fmtStrike(atm)} staged. Sell at 09:15.`, "info");
        return;
      }
      if (phase !== "open") {
        note("plan", `ATM ${fmtStrike(stagedAtmRef.current ?? 0)} staged. Sell at 09:15.`, "info");
        return;
      }
      const spot = spotNow(book.chain);
      const staged = stagedAtmRef.current;
      if (spot == null || staged == null) {
        note("spot", "No live spot. Sell waits.", "info");
        return;
      }
      const strike = entryStrike(staged, spot);
      const row = rowAt(book.chain, strike);
      if (!row) {
        note("strike", `${fmtStrike(strike)} is not on the ${book.expiry.label} chain.`, "info");
        return;
      }
      const ceLtp = livePrint(row.ce);
      const peLtp = livePrint(row.pe);
      if (!bothQuoted(ceLtp, peLtp)) {
        note("quote", "Sell waits until CE and PE both have a live quote.", "info");
        return;
      }
      const lock: PairLock = {
        index: name,
        strike,
        segment: book.chain.optionSegment,
        ceIid: row.ce,
        peIid: row.pe,
        expiry: book.chain.expiryUi || book.expiry.label,
        lots: lotsRef.current,
      };
      commitLock(lock);
      notedRef.current.delete("quote");
      notedRef.current.delete("strike");
      pushLog(
        `Entry ${fmtStrike(strike)}. Spot ${fmtPrice(spot)}. Staged ATM ${fmtStrike(staged)}. Strike stays for this sell. ${lotsRef.current} lots.`,
        "info",
      );
      busyRef.current = true;
      setBusy(true);
      await sellLocked();
    } finally {
      tickingRef.current = false;
      busyRef.current = false;
      setBusy(false);
      const now = Date.now();
      const showing = activeRef.current || startedRef.current || legsRef.current.length > 0;
      if (showing && now - shownRef.current > 400) {
        shownRef.current = now;
        setMarkTick((n) => (n + 1) % 1_000_000);
      }
    }
  };

  useEffect(() => {
    const id = window.setInterval(() => void engineRef.current(), GUARD_MS);
    return () => window.clearInterval(id);
  }, []);

  const saveParameters = () => {
    const parsedLots = parseFlipLots(draftLots);
    if (!parsedLots.ok) {
      toast({ title: "Flip settings", description: parsedLots.error, variant: "destructive" });
      return;
    }
    const parsed = parseFlipTrigger(draftTrigger);
    if (!parsed.ok) {
      toast({ title: "Flip settings", description: parsed.error, variant: "destructive" });
      return;
    }
    const locked = parseFlipLock(lockDraft);
    if (!locked.ok) {
      toast({ title: "Flip settings", description: locked.error, variant: "destructive" });
      return;
    }
    triggerRef.current = parsed.trigger;
    lotsRef.current = parsedLots.lots;
    lockParamsRef.current = locked.params;
    setTriggerPct(parsed.trigger);
    setLots(parsedLots.lots);
    setLockParams(locked.params);
    const next = legsRef.current.map((leg) =>
      leg.mode === "short" ? { ...leg, trigger: triggerPx(leg.trailLow, parsed.trigger) } : leg,
    );
    commitLegs(next);
    const levels = liveLockLevels(locked.params, parsedLots.lots);
    pushLog(
      `Settings saved. ${parsedLots.lots} lots. Flip ${parsed.trigger}%. Step ${fmtPrice(levels.step1)}, lock ${fmtPrice(levels.lock)}, trail ${fmtPrice(levels.trail)} at ${locked.params.trailPercent}%.`,
      "info",
    );
    toast({ title: "Flip settings", description: "Saved. Rupee boxes are per lot." });
  };

  const startDesk = () => {
    if (busyRef.current || tickingRef.current) return;
    const phase = clockPhase(istNow());
    if (!flipIndex(indexRef.current)) {
      pushLog("Flip trades NIFTY or SENSEX only. No order.", "info");
      toast({ title: "Flip", description: "Select NIFTY or SENSEX.", variant: "destructive" });
      return;
    }
    if (phase === "shut") {
      pushLog("After 15:15. START sends no new sell.", "info");
      return;
    }
    const dayBlock = haltRef.current ?? dayHaltTick(realizedRef.current);
    if (dayBlock) {
      if (!haltRef.current) commitHalt(dayBlock);
      const text = dayBlock === "loss" ? "Daily loss ₹5,000. START sends no new sell." : "Daily target ₹15,000. START sends no new sell.";
      pushLog(text, "info");
      toast({ title: "Flip", description: text, variant: "destructive" });
      return;
    }
    if (legsRef.current.length || lockRef.current || rebalanceRef.current) {
      pushLog("An open short or an open long blocks the next sell.", "info");
      return;
    }
    if (startedRef.current) return;
    notedRef.current.clear();
    flipHoldRef.current = null;
    cycleBaseRef.current = realizedRef.current;
    setCycleBase(realizedRef.current);
    commitProfit(0, null);
    commitStage(null, null);
    startedRef.current = true;
    setStarted(true);
    pushLog(
      phase === "open" ? "START. Staging ATM and selling on the next tick." : "START. Waiting. ATM stages at 09:10. Sell at 09:15.",
      "info",
    );
  };

  const stop = () => {
    if (tickingRef.current || busyRef.current) {
      startedRef.current = false;
      setStarted(false);
      pushLog("STOP. Flattening when the current order finishes.", "info");
      return;
    }
    startedRef.current = false;
    setStarted(false);
    if (!legsRef.current.length && !lockRef.current && !rebalanceRef.current) {
      commitStage(null, null);
      commitLock(null);
      pushLog("STOP. No new sell.", "info");
      return;
    }
    tickingRef.current = true;
    busyRef.current = true;
    setBusy(true);
    void flatten("STOP").finally(() => {
      tickingRef.current = false;
      busyRef.current = false;
      setBusy(false);
    });
  };

  const name = flipIndex(index);
  const clock = istNow();
  const phase: FlipPhase = clockPhase(clock);
  void markTick;
  const ceLeg = legs.find((leg) => leg.side === "CE") ?? null;
  const peLeg = legs.find((leg) => leg.side === "PE") ?? null;
  const chainNow = loaded?.chain ?? null;
  const spotShown = chainNow ? shownSpot(chainNow) : null;
  const liveSpot = chainNow ? spotNow(chainNow) : null;
  const roundedAtm = spotShown != null ? stageAtm(spotShown) : null;
  const entryPreview = stagedAtm != null && liveSpot != null ? entryStrike(stagedAtm, liveSpot) : stagedAtm;
  const legsDiffer = ceLeg != null && peLeg != null && ceLeg.strike !== peLeg.strike;
  const previewStrike = legsDiffer
    ? (entryPreview ?? pairLock?.strike ?? roundedAtm ?? (chainNow && chainNow.atmStrike > 0 ? chainNow.atmStrike : null))
    : (ceLeg?.strike ??
      peLeg?.strike ??
      pairLock?.strike ??
      entryPreview ??
      roundedAtm ??
      (chainNow && chainNow.atmStrike > 0 ? chainNow.atmStrike : null));
  const previewRow = chainNow && previewStrike != null ? rowAt(chainNow, previewStrike) : null;
  const ceWatch = ceLeg ? displayPx(ceLeg.iid) : previewRow ? displayPx(previewRow.ce) : null;
  const peWatch = peLeg ? displayPx(peLeg.iid) : previewRow ? displayPx(previewRow.pe) : null;
  const synth = previewStrike != null && ceWatch != null && peWatch != null ? syntheticFuture(previewStrike, ceWatch, peWatch) : null;
  const bracket = previewStrike != null ? atmBracket(previewStrike) : null;
  const marks = legs.map((leg) => legQuoteMark(leg));
  const markReady = marks.every((n) => n != null);
  const live = markReady ? marks.reduce<number>((sum, n) => sum + (n ?? 0), 0) : null;
  const gross = live == null ? null : realized + live;
  const stateName = flipStateName(ceLeg?.mode ?? null, peLeg?.mode ?? null);
  const bothShort = stateName === "STATE_A_SIDEWAYS";
  const deskWord = halt === "loss"
    ? "LOSS"
    : halt === "target"
      ? "TARGET"
      : stateName === "STATE_A_SIDEWAYS"
        ? "SIDEWAYS"
        : stateName === "STATE_B_BULLISH"
          ? "BULLISH"
          : stateName === "STATE_C_BEARISH"
            ? "BEARISH"
            : ceLeg?.mode === "long" || peLeg?.mode === "long"
              ? "LONG"
              : ceLeg || peLeg
                ? "SHORT"
                : !started
                  ? "FLAT"
                  : phase === "shut"
                    ? "CLOSED"
                    : phase === "open"
                      ? "SELL"
                      : "WAIT";
  const deskMeta = stateName
    ? stateName
    : !started
      ? halt === "loss"
        ? "Daily loss closed"
        : halt === "target"
          ? "Daily target closed"
          : "No new sell"
      : phase === "pre"
        ? "Stages at 09:10"
        : phase === "stage"
          ? "Sells at 09:15"
          : phase === "shut"
            ? "Session closed"
            : "Next tick";
  const qtyLabel = name ? `${lots} × ${FLIP.lotSize[name]} = ${fmtQty(sellQuantity(name, lots))}` : `${lots} lots`;
  const savedLock = draftFromLock(lockParams);
  const draftDirty =
    draftLots !== String(lots) ||
    draftTrigger !== String(triggerPct) ||
    lockDraft.step1PerLot !== savedLock.step1PerLot ||
    lockDraft.lockPerLot !== savedLock.lockPerLot ||
    lockDraft.trailPerLot !== savedLock.trailPerLot ||
    lockDraft.trailPercent !== savedLock.trailPercent;
  const levelLots = legs.length && legs[0] ? openLots(legs.map((leg) => leg.qty), legs[0].index) : lots;
  const levels = liveLockLevels(lockParams, levelLots);
  const cycleMtm = live == null ? null : realized - cycleBase + live;
  const status = !name
    ? "Select NIFTY or SENSEX. This desk sends no order for another index."
    : halt === "loss"
      ? "Daily loss ₹5,000. The card is closed for today."
      : halt === "target"
        ? "Daily target ₹15,000. The card is closed for today."
        : phase === "shut" || dayClosed
          ? "After 15:15. No new sell. An open leg is bought if short and sold if long."
          : !started
            ? "Stopped. The next START sells a new straddle only when the card is flat."
            : bothShort
              ? "STATE_A_SIDEWAYS. Each short trails down. A 15% rebound buys twice that short and leaves it long."
              : stateName === "STATE_B_BULLISH"
                ? "STATE_B_BULLISH. CE long stops 10% under its buy. PE stays short. Both cannot be long."
                : stateName === "STATE_C_BEARISH"
                  ? "STATE_C_BEARISH. PE long stops 10% under its buy. CE stays short. Both cannot be long."
                  : ceLeg?.mode === "long" || peLeg?.mode === "long"
                    ? "One leg is long. Its stop is 10% under the buy. The other side is flat until the ₹70 OTM sell fills."
                    : legs.length || pairLock || rebalance
                    ? rebalance
                      ? `Selling the far ${rebalance.side} near ₹${FLIP.otmPremium} to rebuild the short.`
                      : "One leg is open. The other sell is still working. A new straddle waits until the card is flat."
                    : phase === "pre"
                      ? "Before 09:15. START waits. ATM stages at 09:10."
                      : phase === "stage"
                        ? stagedAtm
                          ? `ATM ${fmtStrike(stagedAtm)} staged. Sell at 09:15.`
                          : "Waiting for a live spot to stage the ATM."
                        : "Flat card. Staging the ATM from this spot and selling on the next tick.";

  const clockLabel = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}:${String(clock.second).padStart(2, "0")}`;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[13px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar">
        <div className="n930-tape">
          <div className="n930-cell">
            <div className="n930-kicker">Desk</div>
            <div className="n930-px">{deskWord}</div>
            <div className="n930-meta">{`${clockLabel} IST · ${deskMeta}`}</div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">CE</div>
            <div className="n930-px n930-px--ce">
              {ceLeg ? <FlipPx iid={ceLeg.iid} /> : previewRow ? <FlipPx iid={previewRow.ce} /> : "—"}
            </div>
            <div className="n930-meta">
              {ceLeg
                ? legTape(ceLeg)
                : previewStrike
                  ? `${fmtStrike(previewStrike)} · watch`
                  : chainNote || "—"}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">PE</div>
            <div className="n930-px n930-px--pe">
              {peLeg ? <FlipPx iid={peLeg.iid} /> : previewRow ? <FlipPx iid={previewRow.pe} /> : "—"}
            </div>
            <div className="n930-meta">
              {peLeg
                ? legTape(peLeg)
                : previewStrike
                  ? `${fmtStrike(previewStrike)} · watch`
                  : chainNote || "—"}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">Mark</div>
            <div className={`n930-px ${gross != null && gross > 0 ? "n930-px--up" : gross != null && gross < 0 ? "n930-px--down" : ""}`}>
              {fmtPnl(gross)}
            </div>
            <div className="n930-meta">
              {`booked ${fmtPnl(realized)}`}
              {live == null && legs.length ? " · mark incomplete" : live != null ? ` · live ${fmtPnl(live)}` : ""}
              {cycleMtm == null ? " · cycle waits" : ` · cycle ${fmtPnl(cycleMtm)}`}
              {lockFloor > 0 ? ` · floor ${fmtPrice(lockFloor)}` : " · no floor"}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">ATM</div>
            <div className="n930-px">{previewStrike != null ? fmtStrike(previewStrike) : "—"}</div>
            <div className="n930-meta">
              {spotShown != null ? `spot ${fmtPrice(spotShown)}` : chainNow ? "spot —" : "—"}
              {ceWatch != null ? ` · CE ${fmtPrice(ceWatch)}` : ""}
              {peWatch != null ? ` · PE ${fmtPrice(peWatch)}` : ""}
              {synth != null ? ` · synth ${fmtPrice(synth)}` : ""}
              {bracket ? ` · ${bracket.map((n) => fmtStrike(n)).join(" · ")}` : ""}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">{name ?? "Index"}</div>
            <div className="n930-px">{loaded?.expiry.label ?? (name ? "…" : "—")}</div>
            <div className="n930-meta">
              {qtyLabel}
              {` · trigger ${triggerPct}%`}
              {chainNote ? ` · ${chainNote}` : ""}
            </div>
          </div>
        </div>

        <div className="cd-trade">
          <p className="cd-trade__status">{status}</p>
          <div className="cd-trade__actions">
            <label className="cd-field" style={{ width: 88 }}>
              <span className="cd-field__label">Lots</span>
              <input
                aria-label="Lots"
                inputMode="numeric"
                value={draftLots}
                onChange={(e) => setDraftLots(e.target.value.replace(/[^\d]/g, "").slice(0, 2))}
                className="ramsetu-glass-select cd-field__control"
              />
            </label>
            <button type="button" disabled={busy} onClick={startDesk} className="ramsetu-glass-exec" aria-pressed={started}>
              START
            </button>
            <button type="button" disabled={busy} onClick={stop} className="ramsetu-glass-stop nv-stop">
              STOP
            </button>
          </div>
        </div>

        <div className="cd-params">
          <div className="cd-params__grid">
            <Field label="Flip trigger %">
              <input
                aria-label="Flip trigger percent"
                inputMode="numeric"
                value={draftTrigger}
                onChange={(e) => setDraftTrigger(e.target.value.replace(/[^\d]/g, "").slice(0, 2))}
                className="ramsetu-glass-select cd-field__control"
              />
            </Field>
            <Field label="Step 1 ₹/lot">
              <input
                aria-label="Step 1 trigger per lot"
                inputMode="decimal"
                value={lockDraft.step1PerLot}
                onChange={(e) => setLockDraft((row) => ({ ...row, step1PerLot: moneyDraft(e.target.value) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </Field>
            <Field label="Lock ₹/lot">
              <input
                aria-label="Step 1 lock per lot"
                inputMode="decimal"
                value={lockDraft.lockPerLot}
                onChange={(e) => setLockDraft((row) => ({ ...row, lockPerLot: moneyDraft(e.target.value) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </Field>
            <Field label="Trail ₹/lot">
              <input
                aria-label="Trail trigger per lot"
                inputMode="decimal"
                value={lockDraft.trailPerLot}
                onChange={(e) => setLockDraft((row) => ({ ...row, trailPerLot: moneyDraft(e.target.value) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </Field>
            <Field label="Trail %">
              <input
                aria-label="Trail percent"
                inputMode="decimal"
                value={lockDraft.trailPercent}
                onChange={(e) => setLockDraft((row) => ({ ...row, trailPercent: moneyDraft(e.target.value) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </Field>
          </div>
          <div className="cd-params__bar">
            <span className="cd-params__qty">
              {levelLots} lots · step {fmtPrice(levels.step1)} · lock {fmtPrice(levels.lock)} · trail {fmtPrice(levels.trail)} · {levels.trailPercent}%
            </span>
            <span className="cd-params__note">
              {draftDirty
                ? "Not saved. The live card still uses the last save."
                : "Per lot. Trail % is not multiplied by lots."}
            </span>
            <button type="button" onClick={saveParameters} className="ramsetu-glass-exec">
              Save
            </button>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex min-h-0 flex-1 flex-col gap-3">
        <div className="ramsetu-glass-card">
          <div className="ramsetu-glass-card__badge">Live card</div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
            {(["CE", "PE"] as const).map((side) => {
              const leg = side === "CE" ? ceLeg : peLeg;
              const watch = side === "CE" ? ceWatch : peWatch;
              const mark = leg ? legQuoteMark(leg) : null;
              return (
                <div key={side}>
                  <div className="ramsetu-glass-toolbar__label">{side}</div>
                  <div className={`text-[14px] font-extrabold tabular-nums ${side === "PE" ? "ramsetu-glass-table__strike--pe" : "text-cd-green"}`}>
                    {leg ? fmtStrike(leg.strike) : previewStrike != null ? fmtStrike(previewStrike) : "—"}
                    {leg ? ` ${leg.mode}` : previewStrike != null ? " watch" : ""}
                  </div>
                  <div className="text-[12px] tabular-nums text-muted-foreground">
                    LTP {leg ? <FlipPx iid={leg.iid} /> : watch != null ? fmtPrice(watch) : "—"}
                    {leg?.mode === "short" ? ` · sold ${fmtPrice(leg.sellFill)} · low ${fmtPrice(leg.trailLow)} · trigger ${fmtPrice(leg.trigger)} · qty ${fmtQty(leg.qty)}` : ""}
                    {leg?.mode === "long" && leg.buyAvg != null
                      ? ` · avg ${fmtPrice(leg.buyAvg)} · stop ${fmtPrice(reversalTrigger(leg.buyAvg))} · ${leg.trailHigh != null && longExitPx(leg.trailHigh) != null ? `high ${fmtPrice(leg.trailHigh)} · exit ${fmtPrice(longExitPx(leg.trailHigh) ?? 0)}` : "trail arms +15%"} · qty ${fmtQty(leg.qty)}`
                      : ""}
                    {mark != null ? ` · mark ${fmtPnl(mark)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[12px] font-semibold text-muted-foreground">
            Slippage model {fmtPrice(FLIP.slipLow)} to {fmtPrice(FLIP.slipHigh)} points per leg. The price on this card is the broker fill.
            {lockFloor > 0 ? ` Profit floor ${fmtPrice(lockFloor)}.` : " Profit floor is not set."}
            {lockPeak != null ? ` Peak ${fmtPrice(lockPeak)}.` : ""}
            {cycleMtm == null ? " Cycle MTM waits for a live price." : ` Cycle MTM ${fmtPnl(cycleMtm)}.`}
          </p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="ramsetu-glass-toolbar__label">Log</span>
            <button type="button" onClick={() => setLogs([])} className="nl-btn-reset">
              Clear
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!logs.length ? (
              <p className="text-[14px] font-semibold leading-snug text-foreground/80">
                NIFTY or SENSEX only. Nearest weekday expiry, strike step 50, 2 lots. NIFTY sells 130 and flips with a buy of 260. SENSEX sells 40 and flips with a buy of 80.
                Session 09:15 to 15:15 IST. Before 09:15, START waits, stages the ATM at 09:10, and sells at 09:15. After 09:15 a flat card stages from the live spot and sells on the next tick.
                The entry keeps the staged ATM while the spot is within 60 points. Both legs need a live quote. A blank, zero, or previous close is not a quote.
                Each short trails down. The trigger is the trailing low times one plus the saved percent, default 15, save 7 to 15. When that leg prints at the trigger, the buy is twice the short.
                Half closes the short and half opens a long. That long stops 10% under the buy: a sell of twice the long closes it and opens a new short. After the long is 15% in profit, a 5% pullback from the high books it and sells the far OTM near ₹70.
                CE and PE are never long together. If the other short flips while one leg is long, that long is sold first and the short flips only after the fill. A loss of ₹5,000 or a profit of ₹15,000 on the day flattens the card and blocks the next START. STOP and 15:15 still flatten. The card price is the broker fill. Slippage of 0.20 to 0.40 is not added again.
                Profit lock boxes are per lot. At 2 lots the defaults are step ₹3,000, lock ₹2,000, trail ₹3,400, and 80%. The floor only rises. A missing price does not square. A loss before the first lock stays open. The next START begins a new cycle.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {logs.map((row) => (
                  <li
                    key={row.id}
                    className={`font-mono text-[12px] leading-snug ${
                      row.kind === "entry"
                        ? "text-cd-green"
                        : row.kind === "exit"
                          ? "text-cd-red"
                          : row.kind === "error"
                            ? "text-amber-500"
                            : "text-muted-foreground"
                    }`}
                  >
                    {new Date(row.ts).toLocaleTimeString("en-IN", { hour12: false })} · {row.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
