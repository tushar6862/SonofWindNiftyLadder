import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainResolved } from "@/types/market";
import { useLiveLtp, peekLiveTick } from "@/context/LiveLtpContext";
import { FastLtp } from "@/components/FastLtp";
import { useSubscribeTouchline } from "@/lib/mdRegistry";
import { refreshQuotesFromRest } from "@/lib/atpSeed";
import { peekTouchPx } from "@/lib/liveQuote";
import { fmtPnl, fmtPrice } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import {
  bumpPositionsRefresh,
  clearLocalPosition,
  fetchIxPositions,
  POSITIONS_REFRESH_EVENT,
  setLocalShortPosition,
} from "@/lib/ixPortfolio";
import { expectedLadderFill, ixOrderRejectedMessage, ladderOrderPricing, XTS_IX_ORDER_BASE } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import {
  BAND_HIGH,
  BAND_LOW,
  BAND_TARGET,
  EV_MTM_FLAT,
  EV_NIFTY_SNAKE_FLAT,
  HEDGE_PREMIUM_HIGH,
  HEDGE_PREMIUM_LOW,
  LOT_SIZE,
  MAX_PLAN_TICKS,
  ROUND_TRIP_COST_PER_LOT,
  SNAKE_CLOCK_MS,
  SNAKE_HUNT_WINGS,
  TRANCHE_LOTS,
  UNDERLYING,
  applyFilledAction,
  applySize,
  avgFill,
  bookExpense,
  bookLevel,
  buildHedges,
  clearSnakeSession,
  closestTo72,
  hedgeLotsOpen,
  hedgeWindowLabel,
  hedgesNeeded,
  idleEngineState,
  isEod,
  isEntryWindow,
  isGridLocked,
  isInTrade,
  isLiveSnake,
  istCalendarDay,
  loadSnakeSession,
  localNewDayReset,
  longBookedPnl,
  markHedgeOpen,
  nextSquareAllAction,
  openLots,
  openMtm,
  pickHedgePremium,
  pickNear72,
  planTick,
  qtyForLots,
  reconcileBrokerShortLots,
  saveSnakeSession,
  sellLevel,
  shortBookedPnl,
  SIZE_MULTS,
  snakeSessionActive,
  t1CoverPrice,
  t1HardSlPrice,
  uiReset,
  windowLabel,
  type ChainPremiumRow,
  type HedgeWindow,
  type HuntPick,
  type OptionType,
  type SizeMult,
  type SnakeAction,
  type SnakeEngineState,
  type SnakeHedge,
} from "@/lib/niftySnakeRules";

const OPTION_QUOTE_POLL_MS = 8000;
const BROKER_CONFIRM_HITS = 2;
const SELL_GRACE_MS = 6000;
const HEDGE_RETRY_MS = 20000;

type NsLog = { id: number; ts: number; text: string; kind: "info" | "entry" | "exit" | "warn" };
type PnlSnap = { gross: number; expense: number; trips: number };

type HedgeCandidate = { strike: number; exchangeInstrumentID: number };

function isNiftyChain(chain: ChainResolved): boolean {
  return String(chain.index || "").trim().toUpperCase() === UNDERLYING;
}

function resolveIid(chain: ChainResolved, strike: number, optionType: OptionType): number | null {
  const row = chain.instrumentMap[String(strike)];
  const iid = optionType === "CE" ? row?.ce : row?.pe;
  return typeof iid === "number" && iid > 0 ? iid : null;
}

function chainPremiumRows(chain: ChainResolved, ltps: Record<number, number>): ChainPremiumRow[] {
  const out: ChainPremiumRow[] = [];
  for (const [k, inst] of Object.entries(chain.instrumentMap || {})) {
    const strike = Number(k);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const call = typeof inst?.ce === "number" && inst.ce > 0 ? peekTouchPx(inst.ce, ltps) : null;
    const put = typeof inst?.pe === "number" && inst.pe > 0 ? peekTouchPx(inst.pe, ltps) : null;
    out.push({ strike, call_ltp: call, put_ltp: put });
  }
  return out;
}

function extractPosList(raw: unknown): Record<string, unknown>[] {
  const obj = (raw as { raw?: unknown })?.raw ?? raw;
  const res =
    (obj as { result?: unknown; Result?: unknown })?.result ??
    (obj as { Result?: unknown })?.Result ??
    obj;
  const lst =
    (res as { positionList?: unknown; PositionList?: unknown; positions?: unknown })?.positionList ??
    (res as { PositionList?: unknown })?.PositionList ??
    (res as { positions?: unknown })?.positions ??
    res;
  return Array.isArray(lst) ? (lst as Record<string, unknown>[]) : [];
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function positionNetQty(row: Record<string, unknown>): number {
  const qtyRaw =
    num(row.NetPosition ?? row.netPosition ?? row.Quantity ?? row.quantity) ??
    (num(row.LongPosition) ?? 0) - (num(row.ShortPosition) ?? 0);
  const obq = num(row.OpenBuyQuantity ?? row.openBuyQuantity) ?? 0;
  const osq = num(row.OpenSellQuantity ?? row.openSellQuantity) ?? 0;
  const q = qtyRaw != null && qtyRaw !== 0 ? qtyRaw : obq - osq;
  return Number.isFinite(q) ? q : 0;
}

function positionIid(row: Record<string, unknown>): number | null {
  return num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
}

function ltpFromMap(map: Record<string, number> | undefined, iid: number): number | null {
  if (!map) return null;
  const raw = map[String(iid)] ?? map[iid as unknown as string];
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

export default function NiftySnakePanel({ chain }: { chain: ChainResolved; qty?: number }) {
  const ltps = useLiveLtp();
  const nifty = isNiftyChain(chain);
  const seg = chain.optionSegment;
  const spotSeg = chain.spotSegment;
  const spotToken = chain.spotToken;

  const restoredRef = useRef(loadSnakeSession());
  const restored = restoredRef.current;

  const [engine, setEngine] = useState<SnakeEngineState>(() =>
    restored?.engine
      ? {
          ...restored.engine,
          slots: restored.engine.slots.map((s) => ({ ...s })),
          hedges: restored.engine.hedges.map((h) => ({ ...h, covers: h.covers.slice() })),
        }
      : idleEngineState("CE"),
  );
  const [iid, setIid] = useState<number | null>(() => restored?.iid ?? null);
  const [logs, setLogs] = useState<NsLog[]>(() => restored?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [targetText, setTargetText] = useState("");
  const [targetLocked, setTargetLocked] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [pnl, setPnl] = useState<PnlSnap>(() => ({
    gross: restored?.gross ?? 0,
    expense: restored?.expense ?? 0,
    trips: restored?.trips ?? 0,
  }));

  const engineRef = useRef(engine);
  const iidRef = useRef<number | null>(iid);
  const ltpsRef = useRef(ltps);
  const chainRef = useRef(chain);
  const niftyRef = useRef(nifty);
  const busyRef = useRef(false);
  const logIdRef = useRef(restored?.nextLogId ?? 1);
  const logsRef = useRef<NsLog[]>(logs);
  const pnlRef = useRef(pnl);
  const sessionDayRef = useRef(istCalendarDay());
  const lastReconcileRef = useRef(0);
  const seenBrokerShortRef = useRef(
    Boolean(restored?.seenShort || (restored?.engine && openLots(restored.engine.slots) > 0)),
  );
  const brokerShortLotsRef = useRef<number | null>(null);
  const brokerCaughtUpRef = useRef(false);
  const brokerFlatHitsRef = useRef(0);
  const phantomHitsRef = useRef(0);
  const sellGraceUntilRef = useRef(0);
  const squareAllReqRef = useRef(false);
  const targetStrikeOnlyRef = useRef(false);
  const targetTextRef = useRef("");
  const targetLockedRef = useRef(false);
  const targetPxRef = useRef<number | null>(null);
  const targetSideRef = useRef<"below" | "above">("below");
  const targetLoggedRef = useRef(false);
  const restoreNoteRef = useRef(Boolean(restored));
  const hedgeRetryRef = useRef<Partial<Record<HedgeWindow, number>>>({});
  const hedgeBusyRef = useRef(false);
  const overlayIidRef = useRef<number | null>(null);

  engineRef.current = engine;
  iidRef.current = iid;
  ltpsRef.current = ltps;
  chainRef.current = chain;
  niftyRef.current = nifty;
  logsRef.current = logs;
  pnlRef.current = pnl;

  const inTrade = isLiveSnake(engine);
  const gridLocked = isGridLocked(engine);

  useEffect(() => {
    const lots = openLots(engine.slots);
    const avg = avgFill(engine.slots) ?? (engine.slots.find((s) => s.open)?.fill ?? null);
    if (inTrade && iid != null && lots > 0 && avg != null && avg > 0) {
      overlayIidRef.current = iid;
      const exp = String(chain.expiryApi || "").trim();
      const sym =
        engine.strike != null
          ? `${UNDERLYING}${exp ? ` ${exp}` : ""} ${engine.strike} ${engine.optionType}`
          : undefined;
      setLocalShortPosition({
        exchangeInstrumentID: iid,
        exchangeSegment: chain.optionSegment,
        qty: qtyForLots(lots),
        fillPx: avg,
        tradingSymbol: sym,
      });
      return;
    }
    if (overlayIidRef.current != null && openLots(engine.slots) <= 0) {
      clearLocalPosition(overlayIidRef.current);
      overlayIidRef.current = null;
    }
  }, [inTrade, iid, engine.slots, engine.awaitReload, engine.strike, engine.optionType, chain.optionSegment, chain.expiryApi]);

  const liveLtp = peekTouchPx(iid, ltps);
  const spotLive =
    typeof ltps[spotToken] === "number" && ltps[spotToken]! > 0 ? ltps[spotToken]! : chain.spotLtp;

  const watchIids = useMemo(() => {
    const ids: number[] = [];
    const add = (n: number | null | undefined) => {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) ids.push(n);
    };
    const step = typeof chain.step === "number" && chain.step > 0 ? chain.step : 50;
    const atm =
      typeof spotLive === "number" && spotLive > 0 ? Math.round(spotLive / step) * step : chain.atmStrike;
    if (typeof atm === "number" && Number.isFinite(atm) && atm > 0) {
      for (let i = -SNAKE_HUNT_WINGS; i <= SNAKE_HUNT_WINGS; i++) {
        const row = chain.instrumentMap?.[String(atm + i * step)];
        if (!row) continue;
        add(engine.optionType === "CE" ? row.ce : row.pe);
      }
    }
    add(iid);
    for (const h of engine.hedges) add(h.iid);
    return Array.from(new Set(ids));
  }, [chain.atmStrike, chain.instrumentMap, chain.step, engine.hedges, engine.optionType, iid, spotLive]);

  useSubscribeTouchline(seg, watchIids);
  useSubscribeTouchline(spotSeg, [spotToken]);

  useEffect(() => {
    if (!seg || !watchIids.length) return;
    let cancelled = false;
    const instruments = watchIids.map((exchangeInstrumentID) => ({
      exchangeSegment: seg,
      exchangeInstrumentID,
    }));
    const poll = () => {
      void refreshQuotesFromRest(instruments, () => cancelled);
    };
    poll();
    const iv = window.setInterval(poll, OPTION_QUOTE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [seg, watchIids]);

  const persistNow = useCallback((st: SnakeEngineState) => {
    if (!snakeSessionActive(st)) {
      clearSnakeSession();
      return;
    }
    saveSnakeSession({
      v: 1,
      day: istCalendarDay(),
      iid: iidRef.current,
      engine: {
        ...st,
        slots: st.slots.map((s) => ({ ...s })),
        hedges: st.hedges.map((h) => ({ ...h, covers: h.covers.slice() })),
        reloadIndices: st.reloadIndices.slice(),
      },
      logs: logsRef.current,
      nextLogId: logIdRef.current,
      gross: pnlRef.current.gross,
      expense: pnlRef.current.expense,
      trips: pnlRef.current.trips,
      seenShort: seenBrokerShortRef.current,
    });
  }, []);

  const sync = useCallback(
    (next?: SnakeEngineState) => {
      const st = next ?? engineRef.current;
      engineRef.current = st;
      setEngine({
        ...st,
        slots: st.slots.map((s) => ({ ...s })),
        hedges: st.hedges.map((h) => ({ ...h, covers: h.covers.slice() })),
        reloadIndices: st.reloadIndices.slice(),
      });
      setIid(iidRef.current);
      persistNow(st);
    },
    [persistNow],
  );

  useEffect(() => {
    const flush = () => persistNow(engineRef.current);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [persistNow]);

  const addPnl = useCallback(
    (grossAdd: number, lots: number) => {
      const expenseAdd = bookExpense(lots);
      const next = {
        gross: pnlRef.current.gross + grossAdd,
        expense: pnlRef.current.expense + expenseAdd,
        trips: pnlRef.current.trips + lots,
      };
      pnlRef.current = next;
      setPnl(next);
      persistNow(engineRef.current);
    },
    [persistNow],
  );

  const pushLog = useCallback(
    (text: string, kind: NsLog["kind"] = "info") => {
      const id = logIdRef.current++;
      setLogs((prev) => {
        const next = [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 80);
        logsRef.current = next;
        persistNow(engineRef.current);
        return next;
      });
    },
    [persistNow],
  );

  const placeOrder = useCallback(async (side: "BUY" | "SELL", instrumentId: number, lots: number) => {
    const oq = qtyForLots(lots);
    const tick = peekLiveTick(instrumentId);
    const ltp = peekTouchPx(instrumentId, ltpsRef.current);
    const r = (await apiFetch("/api/ix/place_order", {
      method: "POST",
      body: JSON.stringify({
        ...XTS_IX_ORDER_BASE,
        ...ladderOrderPricing(side, ltp, tick?.bid, tick?.ask),
        exchangeSegment: chainRef.current.optionSegment,
        exchangeInstrumentID: instrumentId,
        orderSide: side,
        orderQuantity: oq,
      }),
    })) as { ok?: boolean; error?: string; raw?: unknown; fillHint?: { ltp?: number; bid?: number; ask?: number } };
    const rejected = ixOrderRejectedMessage(r?.raw) || ixOrderRejectedMessage(r);
    if (rejected) throw new Error(rejected);
    bumpPositionsRefresh();
    const hintLtp = typeof r?.fillHint?.ltp === "number" && r.fillHint.ltp > 0 ? r.fillHint.ltp : ltp;
    const hintBid = typeof r?.fillHint?.bid === "number" && r.fillHint.bid > 0 ? r.fillHint.bid : tick?.bid ?? null;
    const hintAsk = typeof r?.fillHint?.ask === "number" && r.fillHint.ask > 0 ? r.fillHint.ask : tick?.ask ?? null;
    return { ltp: hintLtp, bid: hintBid, ask: hintAsk };
  }, []);

  const huntFromLive = useCallback((): HuntPick | null => {
    const st = engineRef.current;
    if (isLiveSnake(st) || st.awaitReload || st.t1Fill != null) return null;
    const rows = chainPremiumRows(chainRef.current, ltpsRef.current);
    const pick = pickNear72(rows, st.optionType);
    if (!pick) return null;
    const instrumentId = resolveIid(chainRef.current, pick.strike, pick.optionType);
    if (!instrumentId) return null;
    const touch = peekTouchPx(instrumentId, ltpsRef.current);
    if (touch && touch > 0) return { ...pick, ltp: touch };
    return pick;
  }, []);

  const fetchFreshPositions = useCallback(async (): Promise<Record<string, unknown>[] | null> => {
    const r = (await fetchIxPositions("NetWise", { bypassCache: true })) as { stale?: boolean };
    if (r?.stale) return null;
    return extractPosList(r);
  }, []);

  const quoteHedgePick = useCallback(async (hedge: SnakeHedge) => {
    const ch = chainRef.current;
    const spot = ltpsRef.current[ch.spotToken];
    const spotPx = typeof spot === "number" && spot > 0 ? spot : ch.spotLtp;
    const r = (await apiFetch("/api/md/nifty_snake/hedge_candidates", {
      method: "POST",
      body: JSON.stringify({
        expiry: ch.expiryApi || "",
        optionType: engineRef.current.optionType,
        spot: spotPx,
        step: ch.step,
      }),
    })) as { ok?: boolean; error?: string; candidates?: HedgeCandidate[] };
    if (!r?.ok || !r.candidates?.length) {
      throw new Error(r?.error || "No cheap-hedge strikes in master");
    }
    const instruments = r.candidates.slice(0, 60).map((c) => ({
      exchangeSegment: ch.optionSegment,
      exchangeInstrumentID: c.exchangeInstrumentID,
    }));
    const ltpMap: Record<string, number> = {};
    for (let i = 0; i < instruments.length; i += 20) {
      const quote = (await apiFetch("/api/md/quote_snapshot", {
        method: "POST",
        body: JSON.stringify({ xtsMessageCode: 1501, instruments: instruments.slice(i, i + 20) }),
      })) as { ltpMap?: Record<string, number> };
      Object.assign(ltpMap, quote.ltpMap || {});
    }
    const priced = r.candidates
      .map((c) => ({ ...c, ltp: ltpFromMap(ltpMap, c.exchangeInstrumentID) }))
      .filter((c): c is HedgeCandidate & { ltp: number } => c.ltp != null);
    const pick = pickHedgePremium(priced, engineRef.current.optionType);
    if (!pick) return null;
    return { hedge, pick };
  }, []);

  const executeAction = useCallback(
    async (action: SnakeAction): Promise<boolean> => {
      const st = engineRef.current;
      if (action.kind === "stop") {
        const next = applyFilledAction(st, action, 0);
        engineRef.current = next;
        sync(next);
        pushLog(action.reason, "warn");
        return true;
      }

      if (action.kind === "enter_t1") {
        if (openLots(engineRef.current.slots) > 0 || engineRef.current.t1Fill != null) return true;
        const instrumentId = resolveIid(chainRef.current, action.pick.strike, action.pick.optionType);
        if (!instrumentId) {
          pushLog(`No instrument for ${action.pick.strike} ${action.pick.optionType}`, "warn");
          return false;
        }
        const lots = st.slots.find((s) => s.index === 1)?.lots ?? TRANCHE_LOTS[0];
        lastReconcileRef.current = Date.now();
        const hint = await placeOrder("SELL", instrumentId, lots);
        const fill = expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) || action.pick.ltp;
        iidRef.current = instrumentId;
        seenBrokerShortRef.current = true;
        sellGraceUntilRef.current = Date.now() + SELL_GRACE_MS;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        brokerShortLotsRef.current = null;
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        pushLog(
          `ENTRY T1 SELL ${action.pick.strike} ${action.pick.optionType} × ${lots} lots (${qtyForLots(lots)} qty) @ ${fmtPrice(fill)} · cover ${fmtPrice(t1CoverPrice(fill))} · SL ${fmtPrice(t1HardSlPrice(fill))}`,
          "entry",
        );
        toast({
          title: `Nifty Snake T1 ${action.pick.optionType}`,
          description: `${action.pick.strike} @ ${fmtPrice(fill)} · ${lots} lots`,
        });
        return true;
      }

      if (action.kind === "exit_hedge") {
        const hedge = engineRef.current.hedges.find((h) => h.window === action.window);
        if (!hedge?.open || hedge.iid == null || hedge.fill == null) return true;
        const hint = await placeOrder("SELL", hedge.iid, hedge.lots);
        const fill = expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) || hedge.fill;
        const gross = longBookedPnl(hedge.fill, fill, hedge.lots);
        addPnl(gross, hedge.lots);
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        pushLog(
          `BOOK hedge ${hedgeWindowLabel(action.window)} SELL × ${hedge.lots} lots @ ${fmtPrice(fill)} · ${action.reason}`,
          "exit",
        );
        return true;
      }

      const instrumentId = iidRef.current;
      if (!instrumentId) {
        pushLog("Locked contract missing — cannot add/book", "warn");
        return false;
      }

      if (action.kind === "add" || action.kind === "resell") {
        const indices = action.kind === "add" ? [action.index] : action.indices;
        const pending = indices.filter((idx) => {
          const slot = engineRef.current.slots.find((s) => s.index === idx);
          return slot && !slot.open;
        });
        if (!pending.length) return true;
        const lots = pending.reduce((n, idx) => n + (engineRef.current.slots.find((s) => s.index === idx)?.lots ?? 0), 0);
        const liveAction: SnakeAction =
          action.kind === "add"
            ? { kind: "add", index: pending[0]!, lots }
            : { kind: "resell", indices: pending, lots };
        lastReconcileRef.current = Date.now();
        sellGraceUntilRef.current = Date.now() + SELL_GRACE_MS;
        seenBrokerShortRef.current = true;
        brokerCaughtUpRef.current = false;
        phantomHitsRef.current = 0;
        const hint = await placeOrder("SELL", instrumentId, lots);
        const fill = expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) || peekTouchPx(instrumentId, ltpsRef.current) || 0;
        if (!(fill > 0)) {
          pushLog(`${action.kind === "resell" ? "RESELL" : "ADD"} skipped — no live price`, "warn");
          return false;
        }
        const next = applyFilledAction(engineRef.current, liveAction, fill);
        engineRef.current = next;
        sync(next);
        const tabs = pending.map((i) => `T${i}`).join("+");
        pushLog(
          `${action.kind === "resell" ? "RESELL" : "ADD"} ${tabs} SELL × ${lots} lots @ ${fmtPrice(fill)} · grid still original T1`,
          "entry",
        );
        return true;
      }

      const slot = engineRef.current.slots.find((s) => s.index === action.index);
      if (!slot?.open || slot.fill == null) return true;
      const entry = slot.fill;
      lastReconcileRef.current = Date.now();
      phantomHitsRef.current = 0;
      const hint = await placeOrder("BUY", instrumentId, action.lots);
      const fill = expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask) || entry;
      const gross = shortBookedPnl(entry, fill, action.lots);
      addPnl(gross, action.lots);
      const next = applyFilledAction(engineRef.current, action, fill);
      engineRef.current = next;
      if (openLots(next.slots) <= 0) {
        if (iidRef.current != null) clearLocalPosition(iidRef.current);
        if (next.awaitReload) {
          lastReconcileRef.current = 0;
          brokerCaughtUpRef.current = false;
          seenBrokerShortRef.current = true;
          brokerShortLotsRef.current = null;
        } else {
          iidRef.current = next.t1Fill != null ? iidRef.current : null;
          if (next.t1Fill == null) {
            seenBrokerShortRef.current = false;
            brokerCaughtUpRef.current = false;
            brokerShortLotsRef.current = null;
          }
        }
      }
      sync(next);
      const net = pnlRef.current.gross - pnlRef.current.expense;
      pushLog(
        `BOOK T${action.index} BUY × ${action.lots} lots @ ${fmtPrice(fill)} · ${action.reason} · realized ${fmtPnl(net)}`,
        "exit",
      );
      toast({
        title: action.index === 1 ? "Nifty Snake flat" : `T${action.index} booked`,
        description: action.reason,
      });
      return true;
    },
    [addPnl, placeOrder, pushLog, sync],
  );

  const buyNeededHedges = useCallback(async () => {
    if (hedgeBusyRef.current || squareAllReqRef.current) return;
    if (isEod()) return;
    const st = engineRef.current;
    const ltp = peekTouchPx(iidRef.current, ltpsRef.current);
    if (st.t1Fill != null && ltp != null && ltp >= t1HardSlPrice(st.t1Fill) && openLots(st.slots) > 0) return;
    const needed = hedgesNeeded(st).filter((h) => Date.now() >= (hedgeRetryRef.current[h.window] ?? 0));
    if (!needed.length) return;
    hedgeBusyRef.current = true;
    try {
      for (const hedge of needed) {
        if (!engineRef.current.slots.find((s) => s.index === hedge.window)?.open) continue;
        if (engineRef.current.hedges.find((h) => h.window === hedge.window)?.open) continue;
        try {
          const found = await quoteHedgePick(hedge);
          if (!found) {
            hedgeRetryRef.current[hedge.window] = Date.now() + HEDGE_RETRY_MS;
            pushLog(
              `Hedge ${hedgeWindowLabel(hedge.window)} wait — no ${HEDGE_PREMIUM_LOW}–${HEDGE_PREMIUM_HIGH} premium yet`,
              "warn",
            );
            continue;
          }
          const hint = await placeOrder("BUY", found.pick.exchangeInstrumentID, hedge.lots);
          const fill =
            expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask) || found.pick.ltp;
          const next = markHedgeOpen(
            engineRef.current,
            hedge.window,
            found.pick.strike,
            found.pick.exchangeInstrumentID,
            fill,
          );
          engineRef.current = next;
          sync(next);
          pushLog(
            `HEDGE BUY ${hedgeWindowLabel(hedge.window)} ${found.pick.strike} ${engineRef.current.optionType} × ${hedge.lots} lots (${hedge.qty} qty) @ ${fmtPrice(fill)}`,
            "entry",
          );
        } catch (e: unknown) {
          hedgeRetryRef.current[hedge.window] = Date.now() + HEDGE_RETRY_MS;
          const msg = e instanceof Error ? e.message : String(e);
          pushLog(`Hedge ${hedgeWindowLabel(hedge.window)} failed: ${msg}`, "warn");
        }
      }
    } finally {
      hedgeBusyRef.current = false;
    }
  }, [placeOrder, pushLog, quoteHedgePick, sync]);

  const reconcileNow = useCallback(async () => {
    const st = engineRef.current;
    if (openLots(st.slots) <= 0 && !st.awaitReload) return;
    try {
      const list = await fetchFreshPositions();
      if (!list) return;
      const locked = iidRef.current;
      const row = locked ? list.find((p) => positionIid(p) === locked) : undefined;
      const net = row ? positionNetQty(row) : 0;
      const brokerShortLots = net < 0 ? Math.round(Math.abs(net) / LOT_SIZE) : 0;
      brokerShortLotsRef.current = brokerShortLots;
      const uiLots = openLots(engineRef.current.slots);

      const hedges = engineRef.current.hedges;
      if (list.length > 0 && hedges.some((h) => h.open && h.iid != null)) {
        let hedgeChanged = false;
        const nextHedges = hedges.map((h) => {
          if (!h.open || h.iid == null) return h;
          const hedgeRow = list.find((p) => positionIid(p) === h.iid);
          const hedgeNet = hedgeRow ? positionNetQty(hedgeRow) : 0;
          if (hedgeNet > 0) return h;
          hedgeChanged = true;
          return { ...h, open: false, fill: null };
        });
        if (hedgeChanged) {
          const dropped = { ...engineRef.current, hedges: nextHedges };
          engineRef.current = dropped;
          sync(dropped);
          pushLog("Booked hedge removed — broker long is gone.", "warn");
        }
      }

      if (engineRef.current.awaitReload) {
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        if (brokerShortLots <= 0) brokerCaughtUpRef.current = true;
        return;
      }

      if (brokerShortLots >= uiLots && uiLots > 0) {
        seenBrokerShortRef.current = true;
        brokerCaughtUpRef.current = true;
        sellGraceUntilRef.current = 0;
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        return;
      }

      if (brokerShortLots <= 0) {
        phantomHitsRef.current = 0;
        const waitingForFill = Date.now() < sellGraceUntilRef.current && !brokerCaughtUpRef.current;
        if (waitingForFill || !seenBrokerShortRef.current) return;
        const need = list.length === 0 ? BROKER_CONFIRM_HITS : 1;
        brokerFlatHitsRef.current += 1;
        if (brokerFlatHitsRef.current < need) return;
        if (iidRef.current != null) clearLocalPosition(iidRef.current);
        iidRef.current = null;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        const flat = reconcileBrokerShortLots(engineRef.current, 0).state;
        engineRef.current = flat;
        sync(flat);
        pushLog("Position booked — Nifty Snake short nikal gaya. START AGAIN to hunt 70–75.", "warn");
        return;
      }

      if (!brokerCaughtUpRef.current) return;
      const result = reconcileBrokerShortLots(engineRef.current, brokerShortLots);
      if (!result.phantomClosed.length) {
        phantomHitsRef.current = 0;
        return;
      }
      phantomHitsRef.current += 1;
      if (phantomHitsRef.current < BROKER_CONFIRM_HITS) return;
      phantomHitsRef.current = 0;
      brokerCaughtUpRef.current = false;
      engineRef.current = result.state;
      sync(result.state);
      pushLog(`Phantom extras closed: T${result.phantomClosed.join(", T")}`, "warn");
    } catch {
      /* ignore */
    }
  }, [fetchFreshPositions, pushLog, sync]);

  const runCycle = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    let uiBusy = false;
    try {
      const nowMs = Date.now();
      const day = istCalendarDay(nowMs);
      if (day !== sessionDayRef.current) {
        sessionDayRef.current = day;
        const st = engineRef.current;
        if (isLiveSnake(st) || st.armed) {
          iidRef.current = null;
          seenBrokerShortRef.current = false;
          brokerCaughtUpRef.current = false;
          brokerFlatHitsRef.current = 0;
          phantomHitsRef.current = 0;
          brokerShortLotsRef.current = null;
          const next = localNewDayReset(st);
          engineRef.current = next;
          sync(next);
          pushLog("New IST day — local reset. Square leftover broker qty manually if still open.", "warn");
        }
      }

      if (!niftyRef.current) return;

      const liveLtpNow = peekTouchPx(iidRef.current, ltpsRef.current);
      const targetPx = targetPxRef.current;
      if (
        targetLockedRef.current &&
        targetPx != null &&
        liveLtpNow != null &&
        (targetSideRef.current === "above" ? liveLtpNow >= targetPx : liveLtpNow <= targetPx)
      ) {
        if (engineRef.current.armed || openLots(engineRef.current.slots) > 0) {
          const next = { ...engineRef.current, armed: false };
          engineRef.current = next;
          sync(next);
          if (!targetLoggedRef.current) {
            targetLoggedRef.current = true;
            pushLog(`TARGET ${fmtPrice(targetPx)} — book this strike + PAUSE`, "warn");
            toast({ title: "Target hit", description: `Booking ${fmtPrice(targetPx)} and pausing.` });
          }
          if (openLots(engineRef.current.slots) > 0) {
            targetStrikeOnlyRef.current = true;
            squareAllReqRef.current = true;
          }
        }
      } else {
        targetLoggedRef.current = false;
      }

      const live = openLots(engineRef.current.slots) > 0 || engineRef.current.awaitReload;
      const recMs = engineRef.current.awaitReload ? 1500 : 4000;
      if (live && Date.now() - lastReconcileRef.current >= recMs) {
        lastReconcileRef.current = Date.now();
        await reconcileNow();
      }

      if (squareAllReqRef.current) {
        squareAllReqRef.current = false;
        const strikeOnly = targetStrikeOnlyRef.current;
        targetStrikeOnlyRef.current = false;
        if (openLots(engineRef.current.slots) > 0 || (!strikeOnly && hedgeLotsOpen(engineRef.current.hedges) > 0)) {
          uiBusy = true;
          setBusy(true);
          pushLog(strikeOnly ? "TARGET — booking this strike" : "SQUARE ALL — shorts highest-T first, then hedges", "warn");
          for (let i = 0; i < MAX_PLAN_TICKS; i++) {
            const action = nextSquareAllAction(engineRef.current);
            if (!action || (strikeOnly && action.kind === "exit_hedge")) break;
            const ok = await executeAction(action);
            if (!ok) break;
          }
        }
        return;
      }

      for (let i = 0; i < MAX_PLAN_TICKS; i++) {
        if (squareAllReqRef.current) break;
        const st = engineRef.current;
        const ltp = peekTouchPx(iidRef.current, ltpsRef.current);
        const action = planTick({
          nowMs: Date.now(),
          armed: st.armed,
          awaitRestart: st.awaitRestart,
          awaitReload: st.awaitReload,
          reloadIndices: st.reloadIndices,
          t1Fill: st.t1Fill,
          slots: st.slots,
          hedges: st.hedges,
          ltp,
          huntPick: huntFromLive(),
          brokerShortLots: brokerShortLotsRef.current,
        });
        if (!action) break;
        if (!uiBusy) {
          uiBusy = true;
          setBusy(true);
        }
        const ok = await executeAction(action);
        if (!ok) break;
        if (engineRef.current.awaitReload && action.kind === "book") break;
      }

      if (!squareAllReqRef.current && engineRef.current.armed !== false) {
        await buyNeededHedges();
      } else if (engineRef.current.slots.some((s) => s.open)) {
        await buyNeededHedges();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog(`Order failed: ${msg}`, "warn");
      toast({ title: "Nifty Snake order failed", description: msg, variant: "destructive" });
    } finally {
      busyRef.current = false;
      if (uiBusy) setBusy(false);
    }
  }, [buyNeededHedges, executeAction, huntFromLive, pushLog, reconcileNow, sync]);

  const runCycleRef = useRef(runCycle);
  runCycleRef.current = runCycle;

  useEffect(() => {
    const onFlat = () => {
      const next: SnakeEngineState = { ...engineRef.current, armed: false };
      engineRef.current = next;
      sync(next);
      if (openLots(next.slots) > 0 || hedgeLotsOpen(next.hedges) > 0) {
        squareAllReqRef.current = true;
        pushLog("MTM TARGET/SL — SQUARE ALL + hunt paused", "warn");
      } else {
        pushLog("MTM TARGET/SL — hunt paused", "warn");
      }
      void runCycleRef.current();
    };
    const onPosRefresh = () => {
      if (busyRef.current) return;
      void reconcileNow();
    };
    window.addEventListener(EV_MTM_FLAT, onFlat);
    window.addEventListener(EV_NIFTY_SNAKE_FLAT, onFlat);
    window.addEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    return () => {
      window.removeEventListener(EV_MTM_FLAT, onFlat);
      window.removeEventListener(EV_NIFTY_SNAKE_FLAT, onFlat);
      window.removeEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    };
  }, [pushLog, reconcileNow, sync]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void runCycleRef.current();
    }, SNAKE_CLOCK_MS);
    const clock = window.setInterval(() => setClockMs(Date.now()), 250);
    return () => {
      window.clearInterval(id);
      window.clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    for (const key of ["sow_nifty_ladder_target", "sow_nifty_snake_target"]) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
  }, []);

  useEffect(() => {
    const st = engineRef.current;
    if (iidRef.current || st.strike == null) return;
    const resolvedIid = resolveIid(chain, st.strike, st.optionType);
    if (!resolvedIid) return;
    iidRef.current = resolvedIid;
    setIid(resolvedIid);
    persistNow(st);
  }, [chain, persistNow]);

  useEffect(() => {
    const st = engineRef.current;
    if (st.hedges.length === TRANCHE_LOTS.length || st.hedges.some((h) => h.open)) return;
    const next = { ...st, hedges: buildHedges(st.slots) };
    engineRef.current = next;
    sync(next);
  }, [sync]);

  useEffect(() => {
    if (!restoreNoteRef.current) return;
    restoreNoteRef.current = false;
    const snap = restoredRef.current;
    if (!snap) return;
    const trading = openLots(snap.engine.slots) > 0 || snap.engine.awaitReload;
    pushLog(
      trading && snap.engine.strike != null
        ? `Reload restore — ${snap.engine.strike.toLocaleString("en-IN")} ${snap.engine.optionType} still live`
        : "Reload restore — Nifty Snake session",
      "info",
    );
    if (trading) {
      lastReconcileRef.current = 0;
      void reconcileNow();
    }
  }, [pushLog, reconcileNow]);

  const start = () => {
    if (!nifty) {
      toast({ title: "Nifty Snake", description: "Switch the index to NIFTY.", variant: "destructive" });
      return;
    }
    const now = Date.now();
    const st = engineRef.current;
    const trading = openLots(st.slots) > 0 || st.awaitReload;
    if (isEod(now) && !trading) {
      toast({ title: "No new snake today", description: "Past 15:15 IST — wait for next session." });
      pushLog("START rejected — past 15:15 IST", "warn");
      return;
    }
    const next: SnakeEngineState = { ...st, armed: true, awaitRestart: false };
    engineRef.current = next;
    sync(next);
    if (st.awaitReload) {
      pushLog("RESUME — re-SELL remembered legs when LTP is below hard SL. Cover/SL stay on original T1.", "info");
      toast({ title: "Nifty Snake resumed", description: "Re-SELL when LTP < hard SL." });
    } else if (openLots(st.slots) > 0) {
      pushLog("RESUME extras on +3 (books, cover, hard SL stay live)", "info");
      toast({ title: "Nifty Snake resumed", description: "Adds on +3 are live again." });
    } else if (!isEntryWindow(now)) {
      pushLog(`Armed — waiting for 09:16 IST, then hunt ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({ title: "Nifty Snake armed", description: "Entry after 09:16 IST." });
    } else {
      pushLog(`START — hunting ~${BAND_TARGET} premium in ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({
        title: "Nifty Snake started",
        description: `Sell T1 only inside ${BAND_LOW}–${BAND_HIGH}.`,
      });
    }
    void runCycleRef.current();
  };

  const pause = () => {
    const next: SnakeEngineState = { ...engineRef.current, armed: false };
    engineRef.current = next;
    sync(next);
    pushLog("PAUSE — no hunt, no new extras, no re-SELL. Books, T1 −30%, hard SL, EOD still fire.", "info");
    toast({ title: "Nifty Snake paused", description: "Protective exits stay on." });
  };

  const lockTarget = () => {
    const px = Number(targetText.replace(/,/g, "").trim());
    if (!Number.isFinite(px) || px <= 0) {
      toast({ title: "Target", description: "Pehle price likho.", variant: "destructive" });
      return;
    }
    const live = peekTouchPx(iidRef.current, ltpsRef.current);
    targetPxRef.current = px;
    targetSideRef.current = live != null && px > live ? "above" : "below";
    targetLockedRef.current = true;
    targetLoggedRef.current = false;
    setTargetLocked(true);
    toast({
      title: "Target locked",
      description: `${fmtPrice(px)} · is strike ki positions book + pause. Session mein save nahi.`,
    });
  };

  const unlockTarget = () => {
    targetLockedRef.current = false;
    targetPxRef.current = null;
    targetLoggedRef.current = false;
    setTargetLocked(false);
  };

  const squareAll = () => {
    const st = engineRef.current;
    if (openLots(st.slots) <= 0 && hedgeLotsOpen(st.hedges) <= 0) return;
    const next: SnakeEngineState = { ...st, armed: false };
    engineRef.current = next;
    sync(next);
    squareAllReqRef.current = true;
    void runCycleRef.current();
  };

  const reset = () => {
    if (iid != null) clearLocalPosition(iid);
    iidRef.current = null;
    seenBrokerShortRef.current = false;
    brokerCaughtUpRef.current = false;
    brokerFlatHitsRef.current = 0;
    phantomHitsRef.current = 0;
    brokerShortLotsRef.current = null;
    const next = uiReset(engineRef.current);
    engineRef.current = next;
    logsRef.current = [];
    logIdRef.current = 1;
    const zero = { gross: 0, expense: 0, trips: 0 };
    pnlRef.current = zero;
    setPnl(zero);
    setLogs([]);
    sync(next);
    pushLog("RESET — UI cleared (broker positions untouched)", "info");
  };

  const setSide = (optionType: OptionType) => {
    const st = engineRef.current;
    if (openLots(st.slots) > 0 || st.awaitReload || st.t1Fill != null || st.optionType === optionType) return;
    const next = { ...st, optionType };
    engineRef.current = next;
    sync(next);
  };

  const setMult = (sizeMult: SizeMult) => {
    const st = engineRef.current;
    if (st.sizeMult === sizeMult) return;
    if (openLots(st.slots) > 0 || st.awaitReload || st.t1Fill != null || hedgeLotsOpen(st.hedges) > 0) return;
    const next = applySize(st, sizeMult);
    engineRef.current = next;
    sync(next);
  };

  const rows = useMemo(() => chainPremiumRows(chain, ltps), [chain, ltps, clockMs]);
  const huntPick = !gridLocked && !engine.awaitReload ? pickNear72(rows, engine.optionType) : null;
  const nearest = closestTo72(rows, engine.optionType);
  const avg = avgFill(engine.slots);
  const lotsOpen = openLots(engine.slots);
  const mtm = openMtm(avg, liveLtp, lotsOpen);
  const coverPx = gridLocked && engine.t1Fill != null ? t1CoverPrice(engine.t1Fill) : null;
  const hardSlPx = gridLocked && engine.t1Fill != null ? t1HardSlPrice(engine.t1Fill) : null;
  const primaryLabel = engine.awaitRestart ? "START AGAIN" : "START";
  const net = pnl.gross - pnl.expense;

  const huntIid = huntPick ? resolveIid(chain, huntPick.strike, huntPick.optionType) : null;
  const nearestIid = nearest ? resolveIid(chain, nearest.strike, nearest.optionType) : null;
  const huntLive = peekTouchPx(huntIid, ltps) ?? huntPick?.ltp ?? null;
  const paintIid = lotsOpen > 0 || engine.awaitReload ? iid : huntIid ?? nearestIid;

  const statusNote = !nifty
    ? "NIFTY only — switch index"
    : engine.awaitReload
      ? engine.armed
        ? `Hard SL flat — re-SELL T${engine.reloadIndices.join("+T") || "?"} when LTP < SL`
        : "Hard SL flat — PAUSE (START to re-SELL same legs)"
      : engine.awaitRestart
        ? "Await Restart — START AGAIN hunts a new 70–75"
        : gridLocked && engine.armed
          ? "In Trade · adds on +3"
          : gridLocked
            ? "In Trade · paused (exits still live)"
            : engine.armed
              ? `Armed · ${windowLabel(clockMs)}`
              : "Idle";

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[11px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar nl-toolbar">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`nl-chip${engine.armed ? " nl-chip--on" : ""}`}>Armed</span>
          <span className={`nl-chip${engine.awaitRestart ? " nl-chip--wait" : ""}`}>Await Restart</span>
          <span className={`nl-chip${engine.awaitReload ? " nl-chip--wait" : ""}`}>Await Reload</span>
          <span className={`nl-chip${gridLocked ? " nl-chip--trade" : ""}`}>In Trade</span>
          <span className="text-muted-foreground font-semibold">{statusNote}</span>
        </div>

        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Side</span>
            <div className="nl-toggle">
              {(["CE", "PE"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  disabled={gridLocked || engine.awaitReload}
                  onClick={() => setSide(side)}
                  className={`nl-toggle__btn${engine.optionType === side ? " nl-toggle__btn--on" : ""}${
                    side === "PE" ? " nl-toggle__btn--pe" : ""
                  }`}
                >
                  {side}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Size</span>
            <div className="nl-toggle">
              {SIZE_MULTS.map((m) => (
                <button
                  key={m}
                  type="button"
                  disabled={gridLocked || engine.awaitReload || hedgeLotsOpen(engine.hedges) > 0}
                  onClick={() => setMult(m)}
                  className={`nl-toggle__btn${(engine.sizeMult ?? 1) === m ? " nl-toggle__btn--on" : ""}`}
                >
                  {m}x
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1 min-w-[120px]">
            <span className="ramsetu-glass-toolbar__label">Window</span>
            <span className="font-semibold tabular-nums text-foreground">{windowLabel(clockMs)}</span>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2 pb-0.5">
            <button
              type="button"
              disabled={busy || engine.armed || !nifty}
              onClick={start}
              className={engine.awaitRestart ? "nl-btn-again" : "ramsetu-glass-exec min-w-[88px]"}
            >
              {primaryLabel}
            </button>
            <button type="button" disabled={busy || !engine.armed} onClick={pause} className="ramsetu-glass-stop">
              PAUSE
            </button>
            <button
              type="button"
              disabled={busy || (lotsOpen <= 0 && hedgeLotsOpen(engine.hedges) <= 0)}
              onClick={squareAll}
              className="ramsetu-glass-stop"
            >
              SQUARE ALL
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={reset}
              className="nl-btn-reset"
              title="Clear this snake UI only — does not square XTS"
            >
              RESET
            </button>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex flex-col gap-3">
        {!nifty && (
          <div className="ramsetu-glass-empty">
            Nifty Snake trades NIFTY options only. Switch the top index to NIFTY.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">T1 BAND</div>
            <div className="ramsetu-glass-card__strike tabular-nums">
              {BAND_LOW}–{BAND_HIGH}
            </div>
            <div className="ramsetu-glass-card__rule">Prefer ~{BAND_TARGET} · hunt from 09:16 · lot {LOT_SIZE}</div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">HUNT PICK · {engine.optionType}</div>
            <div
              className={`ramsetu-glass-card__strike tabular-nums ${
                engine.optionType === "PE" ? "ramsetu-glass-card__strike--pe" : "text-cd-green"
              }`}
            >
              {engine.strike != null
                ? `${engine.strike.toLocaleString("en-IN")} ${engine.optionType}`
                : huntPick
                  ? `${huntPick.strike.toLocaleString("en-IN")} ${engine.optionType}`
                  : "—"}
            </div>
            <div className="ramsetu-glass-card__rule">
              {engine.strike != null
                ? "Strike locked"
                : huntPick
                  ? (
                      <>
                        LTP <FastLtp iid={huntIid} className="tabular-nums" /> · band {BAND_LOW}–{BAND_HIGH}
                      </>
                    )
                  : nearest
                    ? (
                        <>
                          Nearest {nearest.strike} @ <FastLtp iid={nearestIid} className="tabular-nums" /> (outside band)
                        </>
                      )
                    : `No print in ${BAND_LOW}–${BAND_HIGH}`}
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">T1 FILL</div>
            <div className="ramsetu-glass-card__strike tabular-nums">{fmtPrice(engine.t1Fill)}</div>
            <div className="ramsetu-glass-card__rule">
              Cover {fmtPrice(coverPx)} · hard SL {fmtPrice(hardSlPx)}
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">LIVE</div>
            <FastLtp iid={paintIid} as="div" className="ramsetu-glass-card__strike tabular-nums" />
            <div
              className={`ramsetu-glass-card__rule ${
                mtm != null && mtm >= 0 ? "text-cd-green" : mtm != null ? "ramsetu-glass-table__strike--pe" : ""
              }`}
            >
              MTM {fmtPnl(mtm ?? 0)} · {lotsOpen} lots · net {fmtPnl(net)} · RT ₹{ROUND_TRIP_COST_PER_LOT}/lot
            </div>
            <div className="mt-1.5 flex flex-col items-center gap-1">
              <div className="flex items-center justify-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Target</span>
                <input
                  aria-label="Target"
                  placeholder="price"
                  value={targetText}
                  disabled={targetLocked}
                  onChange={(e) => setTargetText(e.target.value)}
                  className="h-6 w-[72px] rounded-md border border-border/60 bg-background/70 px-1.5 text-center text-[11px] font-semibold tabular-nums"
                />
              </div>
              <div className="flex flex-nowrap items-center justify-center gap-1">
                <button type="button" disabled={targetLocked} onClick={lockTarget} className="ramsetu-glass-exec min-w-0 px-2 py-1">
                  Lock
                </button>
                <button type="button" disabled={!targetLocked} onClick={unlockTarget} className="ramsetu-glass-stop min-w-0 px-2 py-1">
                  Unlock
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="nl-blocks overflow-auto">
          {engine.slots.map((s) => {
            const hedge = engine.hedges.find((h) => h.window === s.index);
            const f = engine.t1Fill;
            const showLevels = gridLocked && f != null && f > 0;
            const addPx = showLevels ? sellLevel(f, s.index) : null;
            const bookPx = s.index === 1 ? coverPx : showLevels ? bookLevel(f, s.index) : null;
            const addVal =
              s.index === 1
                ? showLevels
                  ? fmtPrice(engine.t1Fill)
                  : fmtPrice(huntLive)
                : fmtPrice(addPx);
            return (
              <div key={s.index} className={`nl-block${s.open ? " nl-block--open" : ""}`}>
                <div className="nl-block__top">
                  <span className="nl-block__tranche">T{s.index}</span>
                  <span className={s.open ? "nl-block__status nl-block__status--open" : "nl-block__status"}>
                    {s.open ? "Open" : "Empty"}
                  </span>
                </div>
                <div className="nl-block__grid">
                  <div className="nl-block__cell">
                    <span className="nl-block__label">Lots</span>
                    <span className="nl-block__num">{s.lots}</span>
                  </div>
                  <div className="nl-block__cell">
                    <span className="nl-block__label">Add</span>
                    <span className="nl-block__num">{addVal}</span>
                  </div>
                  <div className="nl-block__cell">
                    <span className="nl-block__label">Book</span>
                    <span className="nl-block__num">{fmtPrice(bookPx)}</span>
                  </div>
                  <div className="nl-block__cell">
                    <span className="nl-block__label">Fill</span>
                    <span className="nl-block__num">{s.open ? fmtPrice(s.fill) : "—"}</span>
                  </div>
                </div>
                <div className="text-[10px] font-semibold text-muted-foreground tabular-nums">
                  Qty {qtyForLots(s.lots)}
                  {" · "}
                  Hedge T{s.index}{" "}
                  {hedge?.open && hedge.strike != null
                    ? `${hedge.strike.toLocaleString("en-IN")} @ ${fmtPrice(hedge.fill)}`
                    : `~${HEDGE_PREMIUM_LOW}–${HEDGE_PREMIUM_HIGH}`}
                </div>
              </div>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="ramsetu-glass-toolbar__label mb-2">
            Log · gross {fmtPnl(pnl.gross)} · expense {fmtPnl(pnl.expense)} · net {fmtPnl(net)} · {pnl.trips} lot RT
          </div>
          {!logs.length ? (
            <p className="ramsetu-glass-empty text-[12px]">
              START dabao — 09:16 ke baad selected CE/PE pe {BAND_LOW}–{BAND_HIGH} (prefer ~{BAND_TARGET}). Same
              strike short grid T1–T7 lots {TRANCHE_LOTS.join(", ")}. Extras +3, book −3. T1 cover −30% / hard SL
              +30% original fill se. Hard SL ke baad same legs re-SELL jab LTP SL ke neeche aaye. PAUSE pe naya
              sell nahi, exits chalu. Nifty Ladder se alag engine hai.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {logs.map((l) => (
                <li
                  key={l.id}
                  className={`font-mono text-[12px] leading-snug ${
                    l.kind === "entry"
                      ? "text-cd-green"
                      : l.kind === "exit"
                        ? "ramsetu-glass-table__strike--pe"
                        : l.kind === "warn"
                          ? "text-amber-500"
                          : "text-muted-foreground"
                  }`}
                >
                  {new Date(l.ts).toLocaleTimeString("en-IN", { hour12: false })} · {l.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
