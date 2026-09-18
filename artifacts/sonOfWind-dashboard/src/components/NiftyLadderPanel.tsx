import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChainResolved } from "@/types/market";
import { useLiveLtp, peekLiveTick } from "@/context/LiveLtpContext";
import { FastLtp } from "@/components/FastLtp";
import { useSubscribeTouchline } from "@/lib/mdRegistry";
import { refreshQuotesFromRest } from "@/lib/atpSeed";
import { setHotFocus } from "@/lib/hotFocus";
import { peekTouchPx } from "@/lib/liveQuote";
import { fmtPnl, fmtPrice } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, fetchIxPositions, POSITIONS_REFRESH_EVENT, setLocalShortPosition, clearLocalPosition } from "@/lib/ixPortfolio";
import { XTS_IX_ORDER_BASE, expectedLadderFill, ixOrderRejectedMessage, ladderOrderPricing } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import { liveAtmStrikeForChain } from "@/lib/liveAtmStrike";
import {
  BAND_HIGH,
  BAND_LOW,
  BAND_TARGET,
  EOD_MINUTE,
  ENTRY_MINUTE,
  LADDER_CLOCK_MS,
  LADDER_HUNT_WINGS,
  LOT_SIZE,
  MANUAL_STRIKE_OFFSETS,
  MAX_PLAN_TICKS,
  SIZE_MULTS,
  UNDERLYING,
  addLevel,
  applyFilledAction,
  applySizeToEmptySlots,
  atmOffsetTag,
  avgFill,
  bookLevel,
  clearLadderSession,
  closestTo100,
  EV_NIFTY_LADDER_FLAT,
  emptySlots,
  formatAtmOffsetLabel,
  idleEngineState,
  isEod,
  isEntryWindow,
  isGridLocked,
  isInTrade,
  isLiveLadder,
  istCalendarDay,
  istMinuteOfDay,
  ladderSessionActive,
  loadLadderSession,
  localNewDayReset,
  nextSquareAllAction,
  openLots,
  openMtm,
  pickManualStrike,
  pickNear100,
  planTick,
  qtyForLots,
  reconcileBrokerShortLots,
  resolveManualStrike,
  ROUND_TRIP_COST_PER_LOT,
  saveLadderSession,
  t1CoverPrice,
  t1HardSlPrice,
  TRANCHE_LOTS,
  uiReset,
  type ChainPremiumRow,
  type EntryMode,
  type HuntPick,
  type LadderAction,
  type LadderEngineState,
  type ManualStrikeOffset,
  type OpenDriveBias,
  type OptionType,
  type SizeMult,
} from "@/lib/niftyLadderRules";

const DRIVE_POLL_MS = 10000;
const OPTION_QUOTE_POLL_MS = 8000;
const RECONCILE_MS = 12000;
const BROKER_CONFIRM_HITS = 2;

type NlLog = { id: number; ts: number; text: string; kind: "info" | "entry" | "exit" | "warn" };

type DriveState = {
  ready: boolean;
  closed: boolean;
  open: number | null;
  close: number | null;
  bias: OpenDriveBias | null;
  suggest: OptionType | null;
  error: string | null;
};

type DriveApi = {
  ok?: boolean;
  ready?: boolean;
  closed?: boolean;
  open?: number | null;
  close?: number | null;
  bias?: OpenDriveBias | null;
  suggest?: OptionType | null;
  error?: string;
};

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
    out.push({
      strike,
      call_ltp: call,
      put_ltp: put,
    });
  }
  return out;
}

function extractPosList(raw: unknown): Record<string, unknown>[] {
  const obj = (raw as { raw?: unknown })?.raw ?? raw;
  const res = (obj as { result?: unknown; Result?: unknown })?.result
    ?? (obj as { Result?: unknown })?.Result
    ?? obj;
  const lst = (res as { positionList?: unknown; PositionList?: unknown; positions?: unknown })?.positionList
    ?? (res as { PositionList?: unknown })?.PositionList
    ?? (res as { positions?: unknown })?.positions
    ?? res;
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
    ((num(row.LongPosition) ?? 0) - (num(row.ShortPosition) ?? 0));
  const obq = num(row.OpenBuyQuantity ?? row.openBuyQuantity) ?? 0;
  const osq = num(row.OpenSellQuantity ?? row.openSellQuantity) ?? 0;
  const q = qtyRaw != null && qtyRaw !== 0 ? qtyRaw : obq - osq;
  return Number.isFinite(q) ? q : 0;
}

function positionIid(row: Record<string, unknown>): number | null {
  return num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
}

function windowLabel(nowMs: number): string {
  const m = istMinuteOfDay(nowMs);
  if (m < ENTRY_MINUTE) return "Wait 09:16 IST";
  if (m >= EOD_MINUTE) return "EOD 15:15 — no new ladder";
  return "Hunt window open";
}

function ManualStrikeDropdown({
  atm,
  step,
  optionType,
  offset,
  disabled,
  onChange,
}: {
  atm: number;
  step: number;
  optionType: OptionType;
  offset: ManualStrikeOffset;
  disabled?: boolean;
  onChange: (offset: ManualStrikeOffset) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 200 });

  const placeMenu = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 220) });
  };

  useLayoutEffect(() => {
    if (!open) return;
    placeMenu();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onWin = () => placeMenu();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selectedStrike = resolveManualStrike(atm, offset, step);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`nl-strike-dd__btn${open ? " nl-strike-dd__btn--open" : ""}`}
      >
        <span className="nl-strike-dd__label">{formatAtmOffsetLabel(offset)}</span>
        <span className="nl-strike-dd__strike tabular-nums">{selectedStrike.toLocaleString("en-IN")}</span>
        <span className={`nl-strike-dd__badge${optionType === "PE" ? " nl-strike-dd__badge--pe" : ""}`}>
          {optionType}
        </span>
        <span className="nl-strike-dd__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={menuRef}
            className="nl-strike-dd__menu"
            style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.width }}
          >
            {MANUAL_STRIKE_OFFSETS.map((off) => {
              const strike = resolveManualStrike(atm, off, step);
              const on = off === offset;
              return (
                <button
                  key={off}
                  type="button"
                  className={`nl-strike-dd__opt${on ? " nl-strike-dd__opt--on" : ""}`}
                  onClick={() => {
                    onChange(off);
                    setOpen(false);
                  }}
                >
                  <span className="nl-strike-dd__label">{formatAtmOffsetLabel(off)}</span>
                  <span className="nl-strike-dd__strike tabular-nums">{strike.toLocaleString("en-IN")}</span>
                  <span className={`nl-strike-dd__badge${optionType === "PE" ? " nl-strike-dd__badge--pe" : ""}`}>
                    {optionType}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

export default function NiftyLadderPanel({ chain }: { chain: ChainResolved; qty?: number }) {
  const ltps = useLiveLtp();
  const nifty = isNiftyChain(chain);
  const seg = chain.optionSegment;
  const spotSeg = chain.spotSegment;
  const spotToken = chain.spotToken;

  const restoredRef = useRef(loadLadderSession());
  const restored = restoredRef.current;

  const [engine, setEngine] = useState<LadderEngineState>(() =>
    restored?.engine
      ? { ...restored.engine, slots: restored.engine.slots.map((s) => ({ ...s })) }
      : idleEngineState("CE", 1),
  );
  const [iid, setIid] = useState<number | null>(() => restored?.iid ?? null);
  const [logs, setLogs] = useState<NlLog[]>(() => restored?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [targetText, setTargetText] = useState("");
  const [targetLocked, setTargetLocked] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [drive, setDrive] = useState<DriveState>({
    ready: false,
    closed: false,
    open: null,
    close: null,
    bias: null,
    suggest: null,
    error: null,
  });

  const engineRef = useRef(engine);
  const iidRef = useRef<number | null>(iid);
  const ltpsRef = useRef(ltps);
  const chainRef = useRef(chain);
  const niftyRef = useRef(nifty);
  const busyRef = useRef(false);
  const logIdRef = useRef(restored?.nextLogId ?? 1);
  const logsRef = useRef<NlLog[]>(logs);
  const sessionDayRef = useRef(istCalendarDay());
  const lastReconcileRef = useRef(0);
  const seenBrokerShortRef = useRef(Boolean(restored?.engine && isLiveLadder(restored.engine)));
  const brokerShortLotsRef = useRef<number | null>(null);
  const brokerCaughtUpRef = useRef(false);
  const brokerFlatHitsRef = useRef(0);
  const phantomHitsRef = useRef(0);
  const squareAllReqRef = useRef(false);
  const targetTextRef = useRef("");
  const targetLockedRef = useRef(false);
  const targetPxRef = useRef<number | null>(null);
  const targetSideRef = useRef<"below" | "above">("below");
  const targetLoggedRef = useRef(false);
  const restoreNoteRef = useRef(Boolean(restored));

  engineRef.current = engine;
  iidRef.current = iid;
  ltpsRef.current = ltps;
  chainRef.current = chain;
  niftyRef.current = nifty;
  logsRef.current = logs;

  const inTrade = isLiveLadder(engine);
  const gridLocked = isGridLocked(engine);
  const overlayIidRef = useRef<number | null>(null);

  useEffect(() => {
    const lots = openLots(engine.slots);
    const avg = avgFill(engine.slots) ?? engine.t1Fill;
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
    if (overlayIidRef.current != null && !inTrade) {
      clearLocalPosition(overlayIidRef.current);
      overlayIidRef.current = null;
    }
  }, [
    inTrade,
    iid,
    engine.slots,
    engine.t1Fill,
    engine.strike,
    engine.optionType,
    chain.optionSegment,
    chain.expiryApi,
  ]);
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
      typeof spotLive === "number" && spotLive > 0
        ? Math.round(spotLive / step) * step
        : chain.atmStrike;
    const atmRow = chain.instrumentMap?.[String(atm)] ?? chain.instrumentMap?.[String(chain.atmStrike)];
    add(atmRow?.ce);
    add(atmRow?.pe);
    if (typeof atm === "number" && Number.isFinite(atm) && atm > 0) {
      for (let i = -LADDER_HUNT_WINGS; i <= LADDER_HUNT_WINGS; i++) {
        const row = chain.instrumentMap?.[String(atm + i * step)];
        if (!row) continue;
        add(engine.optionType === "CE" ? row.ce : row.pe);
      }
    }
    add(iid);
    return Array.from(new Set(ids));
  }, [chain.atmStrike, chain.instrumentMap, chain.step, engine.optionType, iid, spotLive]);

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

  const persistNow = useCallback((st: LadderEngineState) => {
    if (!ladderSessionActive(st)) {
      clearLadderSession();
      return;
    }
    const cur = engineRef.current;
    if (!ladderSessionActive(cur)) {
      clearLadderSession();
      return;
    }
    saveLadderSession({
      v: 1,
      day: istCalendarDay(),
      iid: iidRef.current,
      engine: cur,
      logs: logsRef.current,
      nextLogId: logIdRef.current,
    });
  }, []);

  const sync = useCallback((next?: LadderEngineState) => {
    const st = next ?? engineRef.current;
    engineRef.current = st;
    setEngine({ ...st, slots: st.slots.map((s) => ({ ...s })) });
    setIid(iidRef.current);
    persistNow(st);
  }, [persistNow]);

  const pushLog = useCallback((text: string, kind: NlLog["kind"] = "info") => {
    const id = logIdRef.current++;
    setLogs((prev) => {
      const next = [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 60);
      logsRef.current = next;
      persistNow(engineRef.current);
      return next;
    });
  }, [persistNow]);

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
    const hintLtp =
      typeof r?.fillHint?.ltp === "number" && r.fillHint.ltp > 0 ? r.fillHint.ltp : ltp;
    const hintBid =
      typeof r?.fillHint?.bid === "number" && r.fillHint.bid > 0 ? r.fillHint.bid : tick?.bid ?? null;
    const hintAsk =
      typeof r?.fillHint?.ask === "number" && r.fillHint.ask > 0 ? r.fillHint.ask : tick?.ask ?? null;
    return { ltp: hintLtp, bid: hintBid, ask: hintAsk };
  }, []);

  const huntFromLive = useCallback((): HuntPick | null => {
    const st = engineRef.current;
    if (isLiveLadder(st)) return null;
    const ch = chainRef.current;
    const spot =
      typeof ltpsRef.current[ch.spotToken] === "number" && ltpsRef.current[ch.spotToken]! > 0
        ? ltpsRef.current[ch.spotToken]!
        : ch.spotLtp;
    const rows = chainPremiumRows(ch, ltpsRef.current);
    const step = typeof ch.step === "number" && ch.step > 0 ? ch.step : 50;
    const pick =
      st.entryMode === "manual"
        ? pickManualStrike(
            rows,
            st.optionType,
            liveAtmStrikeForChain(ch, typeof spot === "number" ? spot : undefined),
            st.manualStrikeOffset,
            step,
          )
        : pickNear100(rows, st.optionType);
    if (!pick) return null;
    const instrumentId = resolveIid(ch, pick.strike, pick.optionType);
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

  const executeAction = useCallback(
    async (action: LadderAction): Promise<boolean> => {
      const st = engineRef.current;
      if (action.kind === "enter_t1") {
        if (isLiveLadder(engineRef.current)) return true;
        const instrumentId = resolveIid(chainRef.current, action.pick.strike, action.pick.optionType);
        if (!instrumentId) {
          pushLog(`No instrument for ${action.pick.strike} ${action.pick.optionType}`, "warn");
          return false;
        }
        const t1 = st.slots.find((s) => s.index === 1);
        const lots = t1?.lots ?? TRANCHE_LOTS[0] * st.sizeMult;
        lastReconcileRef.current = Date.now();
        const hint = await placeOrder("SELL", instrumentId, lots);
        const fill =
          expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) ||
          action.pick.ltp;
        iidRef.current = instrumentId;
        lastReconcileRef.current = Date.now();
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        brokerShortLotsRef.current = null;
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        pushLog(
          `T1 SELL ${action.pick.strike} ${action.pick.optionType} × ${lots} lots @ ${fmtPrice(fill)} — grid locked`,
          "entry",
        );
        toast({
          title: `Nifty Ladder T1 ${action.pick.optionType}`,
          description: `${action.pick.strike} @ ${fmtPrice(fill)} · ${lots} lots`,
        });
        return true;
      }

      const instrumentId = iidRef.current;
      if (!instrumentId) {
        pushLog("Locked contract missing — cannot add/book", "warn");
        return false;
      }
      if (action.kind === "add" || action.kind === "reload") {
        if (action.kind === "add" && !isGridLocked(engineRef.current)) return true;
        const pending = action.indices.filter((idx) => {
          const slot = engineRef.current.slots.find((s) => s.index === idx);
          return slot && !slot.open;
        });
        if (!pending.length) return true;
        const lots = pending.reduce((n, idx) => {
          const slot = engineRef.current.slots.find((s) => s.index === idx);
          return n + (slot?.lots ?? 0);
        }, 0);
        const liveAction = { ...action, indices: pending, lots };
        const tick = peekLiveTick(instrumentId);
        const live = peekTouchPx(instrumentId, ltpsRef.current);
        const fillGuess =
          expectedLadderFill("SELL", live, tick?.bid ?? null, tick?.ask ?? null) ||
          (st.t1Fill != null && st.t1Fill > 0 ? addLevel(st.t1Fill, pending[0] ?? 2) : 0);
        if (!(fillGuess > 0)) {
          pushLog(`${action.kind === "reload" ? "RELOAD" : "ADD"} T${pending.join("+T")} skipped — no live price`, "warn");
          return false;
        }
        lastReconcileRef.current = Date.now();
        brokerCaughtUpRef.current = false;
        phantomHitsRef.current = 0;
        const reserved = applyFilledAction(engineRef.current, liveAction, fillGuess);
        engineRef.current = reserved;
        sync(reserved);
        const hint = await placeOrder("SELL", instrumentId, lots);
        const fill =
          expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) || fillGuess;
        const next = applyFilledAction(engineRef.current, liveAction, fill);
        engineRef.current = next;
        sync(next);
        const tabs = pending.map((i) => `T${i}`).join("+");
        pushLog(
          `${action.kind === "reload" ? "RELOAD" : "ADD"} ${tabs} SELL × ${lots} lots @ ${fmtPrice(fill)}`,
          "entry",
        );
        return true;
      }

      const slot = engineRef.current.slots.find((s) => s.index === action.index);
      if (!slot?.open) return true;
      lastReconcileRef.current = Date.now();
      phantomHitsRef.current = 0;
      if (action.index > 1) {
        const reserved = applyFilledAction(engineRef.current, action, 1);
        engineRef.current = reserved;
        sync(reserved);
      }
      const hint = await placeOrder("BUY", instrumentId, action.lots);
      const fill =
        expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask) ||
        (st.t1Fill != null && st.t1Fill > 0 ? st.t1Fill : 0);
      const next = applyFilledAction(engineRef.current, action, fill);
      engineRef.current = next;
      if (!isLiveLadder(next) || (!next.awaitReload && !isInTrade(next.slots, next.t1Fill))) {
        iidRef.current = null;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        brokerShortLotsRef.current = null;
      } else if (next.awaitReload) {
        lastReconcileRef.current = 0;
        brokerCaughtUpRef.current = false;
        seenBrokerShortRef.current = true;
        brokerShortLotsRef.current = null;
      }
      sync(next);
      pushLog(`BOOK T${action.index} BUY × ${action.lots} lots @ ${fmtPrice(fill)} · ${action.reason}`, "exit");
      toast({
        title: action.index === 1 ? "Nifty Ladder flat" : `T${action.index} booked`,
        description: action.reason,
      });
      return true;
    },
    [placeOrder, pushLog, sync],
  );

  const reconcileNow = useCallback(async () => {
    const st = engineRef.current;
    if (!isLiveLadder(st) && !st.awaitReload) return;
    try {
      const list = await fetchFreshPositions();
      if (!list) return;
      const locked = iidRef.current;
      const openShorts = list.filter((p) => positionNetQty(p) < 0);
      if (!locked && openShorts.length > 0) return;
      const row = locked ? list.find((p) => positionIid(p) === locked) : undefined;
      const net = row ? positionNetQty(row) : 0;
      const brokerShortLots = net < 0 ? Math.round(Math.abs(net) / LOT_SIZE) : 0;
      brokerShortLotsRef.current = brokerShortLots;
      const uiLots = openLots(engineRef.current.slots);

      if (engineRef.current.awaitReload) {
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        if (brokerShortLots <= 0) {
          brokerCaughtUpRef.current = true;
        }
        return;
      }

      if (brokerShortLots >= uiLots && uiLots > 0) {
        seenBrokerShortRef.current = true;
        brokerCaughtUpRef.current = true;
        brokerFlatHitsRef.current = 0;
        phantomHitsRef.current = 0;
        return;
      }

      if (brokerShortLots <= 0) {
        phantomHitsRef.current = 0;
        // Fresh T1: empty/stale book is not a square-off (seenBrokerShort is false).
        // Reload restore: seenBrokerShort is already true — XTS may already be net 0.
        // Do not also require brokerCaughtUp, or a booked-in-XTS session stays stuck IN TRADE.
        if (!seenBrokerShortRef.current) return;
        brokerFlatHitsRef.current += 1;
        if (brokerFlatHitsRef.current < BROKER_CONFIRM_HITS) return;
        iidRef.current = null;
        seenBrokerShortRef.current = false;
        brokerCaughtUpRef.current = false;
        brokerFlatHitsRef.current = 0;
        const flat: LadderEngineState = {
          ...idleEngineState(engineRef.current.optionType, engineRef.current.sizeMult),
          awaitRestart: true,
        };
        engineRef.current = flat;
        sync(flat);
        pushLog("Broker square-off — Nifty Ladder session cleared. START AGAIN to hunt.", "warn");
        return;
      }

      // broker has some short but fewer lots than UI — only phantom after a live catch-up
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
        if (isLiveLadder(st)) {
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
          if (openLots(engineRef.current.slots) > 0) squareAllReqRef.current = true;
        }
      } else {
        targetLoggedRef.current = false;
      }

      const live = isLiveLadder(engineRef.current);
      const recMs = engineRef.current.awaitReload ? 1500 : RECONCILE_MS;
      if (live && Date.now() - lastReconcileRef.current >= recMs) {
        lastReconcileRef.current = Date.now();
        await reconcileNow();
      }

      if (squareAllReqRef.current) {
        squareAllReqRef.current = false;
        if (openLots(engineRef.current.slots) > 0) {
          uiBusy = true;
          setBusy(true);
          pushLog("SQUARE ALL — covering highest-open first", "warn");
          for (let i = 0; i < MAX_PLAN_TICKS; i++) {
            const action = nextSquareAllAction(engineRef.current.slots);
            if (!action) break;
            const ok = await executeAction(action);
            if (!ok) break;
          }
        }
        return;
      }

      for (let i = 0; i < MAX_PLAN_TICKS; i++) {
        if (squareAllReqRef.current) break;
        const st = engineRef.current;
        const locked = iidRef.current;
        const ltp = peekTouchPx(locked, ltpsRef.current);
        const action = planTick({
          nowMs: Date.now(),
          armed: st.armed,
          awaitRestart: st.awaitRestart,
          awaitReload: st.awaitReload,
          t1Fill: st.t1Fill,
          slots: st.slots,
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
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog(`Order failed: ${msg}`, "warn");
      toast({ title: "Nifty Ladder order failed", description: msg, variant: "destructive" });
    } finally {
      busyRef.current = false;
      if (uiBusy) setBusy(false);
    }
  }, [executeAction, huntFromLive, pushLog, reconcileNow, sync]);

  const runCycleRef = useRef(runCycle);
  runCycleRef.current = runCycle;

  useEffect(() => {
    const onFlat = () => {
      const next: LadderEngineState = { ...engineRef.current, armed: false };
      engineRef.current = next;
      sync(next);
      if (isLiveLadder(next)) {
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
    window.addEventListener(EV_NIFTY_LADDER_FLAT, onFlat);
    window.addEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    return () => {
      window.removeEventListener(EV_NIFTY_LADDER_FLAT, onFlat);
      window.removeEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    };
  }, [pushLog, reconcileNow, sync]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void runCycleRef.current();
    }, LADDER_CLOCK_MS);
    const clock = window.setInterval(() => {
      setClockMs(Date.now());
    }, 250);
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
    if (!restoreNoteRef.current) return;
    restoreNoteRef.current = false;
    const snap = restoredRef.current;
    if (!snap) return;
    const trading = isLiveLadder(snap.engine);
    const label =
      trading && snap.engine.strike != null
        ? `Reload restore — ${snap.engine.strike.toLocaleString("en-IN")} ${snap.engine.optionType} still live`
        : "Reload restore — still armed, hunting";
    pushLog(label, "info");
    if (trading) {
      lastReconcileRef.current = 0;
      void reconcileNow();
    }
  }, [pushLog, reconcileNow]);

  const refreshDrive = useCallback(async () => {
    if (!niftyRef.current) return;
    try {
      const liveSpot = ltpsRef.current[spotToken];
      const r = (await apiFetch("/api/md/nifty_ladder/open_drive", {
        method: "POST",
        body: JSON.stringify({
          exchangeSegment: spotSeg,
          exchangeInstrumentID: spotToken,
          liveLtp: typeof liveSpot === "number" ? liveSpot : 0,
        }),
      })) as DriveApi;
      if (!r?.ok) {
        setDrive((d) => ({ ...d, error: r?.error || "Open drive fetch failed" }));
        return;
      }
      setDrive({
        ready: Boolean(r.ready),
        closed: Boolean(r.closed),
        open: typeof r.open === "number" ? r.open : null,
        close: typeof r.close === "number" ? r.close : null,
        bias: r.bias ?? null,
        suggest: r.suggest ?? null,
        error: null,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setDrive((d) => ({
        ...d,
        error: msg.includes("404") ? "Open-drive API 404 — restart backend" : msg,
      }));
    }
  }, [spotSeg, spotToken]);

  useEffect(() => {
    void refreshDrive();
    const id = window.setInterval(() => void refreshDrive(), DRIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshDrive]);

  const start = () => {
    if (!nifty) {
      toast({ title: "Nifty Ladder", description: "Switch the index to NIFTY.", variant: "destructive" });
      return;
    }
    const now = Date.now();
    const st = engineRef.current;
    const trading = isLiveLadder(st);
    if (isEod(now) && !trading) {
      toast({ title: "No new ladder today", description: "Past 15:15 IST — wait for next session." });
      pushLog("START rejected — past 15:15 IST", "warn");
      return;
    }
    const next: LadderEngineState = { ...st, armed: true, awaitRestart: false };
    engineRef.current = next;
    sync(next);
    if (trading) {
      if (st.awaitReload) {
        pushLog("RESUME — hard-SL reload T1–T9 same locked t1Fill when LTP < SL", "info");
        toast({ title: "Nifty Ladder resumed", description: "Reload when LTP is below hard SL." });
      } else {
        pushLog("RESUME extras on +3 (protective exits stay live)", "info");
        toast({ title: "Nifty Ladder resumed", description: "Adds on +3 are live again." });
      }
    } else if (!isEntryWindow(now)) {
      if (st.entryMode === "manual") {
        pushLog(
          `Armed — waiting for 09:16 IST, then MANUAL ${atmOffsetTag(st.manualStrikeOffset)} (no band)`,
          "info",
        );
      } else {
        pushLog(`Armed — waiting for 09:16 IST, then hunt ${BAND_LOW}–${BAND_HIGH}`, "info");
      }
      toast({ title: "Nifty Ladder armed", description: "Entry after 09:16 IST." });
    } else if (st.entryMode === "manual") {
      pushLog(`START — MANUAL ${atmOffsetTag(st.manualStrikeOffset)} · no band · direct T1`, "info");
      toast({
        title: "Nifty Ladder started",
        description: `Manual ${atmOffsetTag(st.manualStrikeOffset)} — enter on live print.`,
      });
    } else {
      pushLog(`START — hunting ~${BAND_TARGET} premium in ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({
        title: "Nifty Ladder started",
        description: `Hunting ${BAND_LOW}–${BAND_HIGH} on selected side.`,
      });
    }
    void runCycleRef.current();
  };

  const pause = () => {
    const next: LadderEngineState = { ...engineRef.current, armed: false };
    engineRef.current = next;
    sync(next);
    pushLog("PAUSE — no hunt / no new adds. Extras −3, T1 −30%, hard SL, EOD still fire", "info");
    toast({ title: "Nifty Ladder paused", description: "Protective exits stay on." });
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
    if (openLots(engineRef.current.slots) <= 0) return;
    squareAllReqRef.current = true;
    void runCycleRef.current();
  };

  const reset = () => {
    const st = engineRef.current;
    if (iid != null) clearLocalPosition(iid);
    iidRef.current = null;
    seenBrokerShortRef.current = false;
    brokerCaughtUpRef.current = false;
    brokerFlatHitsRef.current = 0;
    phantomHitsRef.current = 0;
    brokerShortLotsRef.current = null;
    const next = uiReset(st);
    engineRef.current = next;
    logsRef.current = [];
    logIdRef.current = 1;
    setLogs([]);
    sync(next);
    pushLog("RESET — UI cleared (broker positions untouched)", "info");
  };

  const setSide = (optionType: OptionType) => {
    const st = engineRef.current;
    if (isLiveLadder(st) || st.optionType === optionType) return;
    const next = { ...st, optionType };
    engineRef.current = next;
    sync(next);
  };

  const setMult = (sizeMult: SizeMult) => {
    const st = engineRef.current;
    if (isLiveLadder(st) || st.sizeMult === sizeMult) return;
    const next: LadderEngineState = {
      ...st,
      sizeMult,
      slots: applySizeToEmptySlots(emptySlots(sizeMult), sizeMult),
    };
    engineRef.current = next;
    sync(next);
  };

  const setEntryMode = (entryMode: EntryMode) => {
    const st = engineRef.current;
    if (isLiveLadder(st) || st.entryMode === entryMode) return;
    const next: LadderEngineState = { ...st, entryMode, manualStrikeOffset: 0 };
    engineRef.current = next;
    sync(next);
  };

  const setManualOffset = (manualStrikeOffset: ManualStrikeOffset) => {
    const st = engineRef.current;
    if (isLiveLadder(st) || st.manualStrikeOffset === manualStrikeOffset) return;
    const next: LadderEngineState = { ...st, manualStrikeOffset };
    engineRef.current = next;
    sync(next);
  };

  const rows = useMemo(
    () => chainPremiumRows(chain, ltps),
    // clockMs: peekLiveTick updates faster than React LTP state — hunt must follow XTS prints.
    [chain, ltps, clockMs],
  );
  const step = typeof chain.step === "number" && chain.step > 0 ? chain.step : 50;
  const liveAtm = liveAtmStrikeForChain(chain, typeof spotLive === "number" ? spotLive : undefined);
  const huntPick = !inTrade
    ? engine.entryMode === "manual"
      ? pickManualStrike(rows, engine.optionType, liveAtm, engine.manualStrikeOffset, step)
      : pickNear100(rows, engine.optionType)
    : null;
  const manualDisplayStrike =
    engine.entryMode === "manual" ? resolveManualStrike(liveAtm, engine.manualStrikeOffset, step) : null;
  const nearest = closestTo100(rows, engine.optionType);
  const avg = avgFill(engine.slots);
  const lotsOpen = openLots(engine.slots);
  const mtm = openMtm(avg, liveLtp, lotsOpen);
  const coverPx = gridLocked && engine.t1Fill != null ? t1CoverPrice(engine.t1Fill) : null;
  const hardSlPx = gridLocked && engine.t1Fill != null ? t1HardSlPrice(engine.t1Fill) : null;
  const primaryLabel = engine.awaitRestart ? "START AGAIN" : "START";

  const huntIid = huntPick
    ? resolveIid(chain, huntPick.strike, huntPick.optionType)
    : manualDisplayStrike != null
      ? resolveIid(chain, manualDisplayStrike, engine.optionType)
      : null;
  const nearestIid = nearest ? resolveIid(chain, nearest.strike, nearest.optionType) : null;
  const huntLive = peekTouchPx(huntIid, ltps) ?? huntPick?.ltp ?? null;
  const paintIid = inTrade ? iid : huntIid ?? nearestIid;

  useEffect(() => {
    if (!seg || paintIid == null || !Number.isFinite(paintIid) || paintIid <= 0) {
      setHotFocus("ladder", []);
      return;
    }
    // Server hot-focus (~120ms touchline) owns LIVE. Client REST poll was fighting the socket and freezing ticks.
    setHotFocus("ladder", [{ exchangeSegment: seg, exchangeInstrumentID: paintIid }]);
    return () => {
      setHotFocus("ladder", []);
    };
  }, [seg, paintIid]);

  const t2AddPx = gridLocked && engine.t1Fill != null ? addLevel(engine.t1Fill, 2) : null;
  const t2BookPx = gridLocked && engine.t1Fill != null ? bookLevel(engine.t1Fill, 2) : null;
  const statusNote = !nifty
    ? "NIFTY only — switch index"
    : engine.awaitReload
      ? engine.armed
        ? "Hard SL flat — reload T1–T9 when LTP < SL"
        : "Hard SL flat — PAUSE (START to reload same locked grid)"
      : engine.awaitRestart
        ? "Await Restart — press START AGAIN to hunt a new ~100"
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
                  disabled={inTrade}
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
                  disabled={inTrade}
                  onClick={() => setMult(m)}
                  className={`nl-toggle__btn${engine.sizeMult === m ? " nl-toggle__btn--on" : ""}`}
                >
                  {m}x
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Entry</span>
            <div className="nl-toggle">
              {(["auto", "manual"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={inTrade}
                  onClick={() => setEntryMode(mode)}
                  className={`nl-toggle__btn${engine.entryMode === mode ? " nl-toggle__btn--on" : ""}`}
                >
                  {mode === "auto" ? "Auto" : "Manual"}
                </button>
              ))}
            </div>
          </div>

          {engine.entryMode === "manual" && (
            <div className="flex flex-col gap-1 min-w-[160px]">
              <span className="ramsetu-glass-toolbar__label">Strike</span>
              <ManualStrikeDropdown
                atm={liveAtm}
                step={step}
                optionType={engine.optionType}
                offset={engine.manualStrikeOffset}
                disabled={inTrade}
                onChange={setManualOffset}
              />
            </div>
          )}

          <div className="flex flex-col gap-1 min-w-[88px]">
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
            <button
              type="button"
              disabled={busy || !engine.armed}
              onClick={pause}
              className="ramsetu-glass-stop"
            >
              PAUSE
            </button>
            <button
              type="button"
              disabled={busy || lotsOpen <= 0}
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
              title="Clear this ladder UI only — does not square XTS"
            >
              RESET
            </button>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex flex-col gap-3">
        {!nifty && (
          <div className="ramsetu-glass-empty">
            Nifty Ladder trades NIFTY options only. Switch the top index to NIFTY.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <button
            type="button"
            disabled={inTrade || !drive.suggest}
            onClick={() => drive.suggest && setSide(drive.suggest)}
            className={`ramsetu-glass-card ramsetu-glass-card--center nl-drive${
              drive.bias === "UP" ? " nl-drive--up" : drive.bias === "DOWN" ? " nl-drive--down" : ""
            }`}
            title="Hint only — click to set CE/PE if not in trade"
          >
            <div className="ramsetu-glass-card__badge">09:15 OPEN DRIVE</div>
            <div className="ramsetu-glass-card__strike tabular-nums">
              {drive.bias ?? (drive.closed ? "—" : "Wait 09:16")}
            </div>
            <div className="ramsetu-glass-card__rule">
              {drive.suggest ? `Suggest ${drive.suggest}` : drive.error || "Hint only · not auto-entry"}
            </div>
            {(drive.open != null || drive.close != null) && (
              <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                O {fmtPrice(drive.open)} → C {fmtPrice(drive.close)}
              </div>
            )}
          </button>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">
              {inTrade
                ? `HUNT PICK · ${engine.optionType}`
                : engine.entryMode === "manual"
                  ? `MANUAL PICK · ${engine.optionType}`
                  : `HUNT PICK · ${engine.optionType}`}
            </div>
            <div
              className={`ramsetu-glass-card__strike tabular-nums ${
                engine.optionType === "PE" ? "ramsetu-glass-card__strike--pe" : "text-cd-green"
              }`}
            >
              {inTrade && engine.strike != null
                ? `${engine.strike.toLocaleString("en-IN")} ${engine.optionType}`
                : huntPick
                  ? `${huntPick.strike.toLocaleString("en-IN")} ${engine.optionType}`
                  : engine.entryMode === "manual" && manualDisplayStrike != null
                    ? `${manualDisplayStrike.toLocaleString("en-IN")} ${engine.optionType}`
                    : "—"}
            </div>
            <div className="ramsetu-glass-card__rule">
              {inTrade
                ? "Strike locked"
                : engine.entryMode === "manual"
                  ? huntPick
                    ? (
                        <>
                          LTP <FastLtp iid={huntIid} className="tabular-nums" /> · {atmOffsetTag(engine.manualStrikeOffset)} · no band
                        </>
                      )
                    : `${atmOffsetTag(engine.manualStrikeOffset)} · no band`
                  : huntPick
                    ? <>LTP <FastLtp iid={huntIid} className="tabular-nums" /> · band {BAND_LOW}–{BAND_HIGH}</>
                    : nearest
                      ? <>Nearest {nearest.strike} @ <FastLtp iid={nearestIid} className="tabular-nums" /> (outside band)</>
                      : `No print in ${BAND_LOW}–${BAND_HIGH}`}
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">T1 FILL</div>
            <div className="ramsetu-glass-card__strike tabular-nums">{fmtPrice(engine.t1Fill)}</div>
            <div className="ramsetu-glass-card__rule">
              T2 add {fmtPrice(t2AddPx)} · T2 book {fmtPrice(t2BookPx)} · SL {fmtPrice(hardSlPx)}
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
              MTM {fmtPnl(mtm ?? 0)} · {lotsOpen} lots · Lot {LOT_SIZE} · RT ₹{ROUND_TRIP_COST_PER_LOT}/lot
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
            const f = engine.t1Fill;
            const showLevels = gridLocked && f != null && f > 0;
            const addPx = showLevels ? addLevel(f, s.index) : null;
            const bookPx = s.index === 1 ? coverPx : showLevels ? bookLevel(f, s.index) : null;
            const addVal =
              s.index === 1
                ? showLevels
                  ? fmtPrice(engine.t1Fill)
                  : fmtPrice(huntLive)
                : fmtPrice(addPx);
            const status = s.open ? "Open" : "Empty";
            return (
              <div key={s.index} className={`nl-block${s.open ? " nl-block--open" : ""}`}>
                <div className="nl-block__top">
                  <span className="nl-block__tranche">T{s.index}</span>
                  <span className={s.open ? "nl-block__status nl-block__status--open" : "nl-block__status"}>
                    {status}
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
              </div>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="ramsetu-glass-toolbar__label mb-2">Log</div>
          {!logs.length ? (
            <p className="ramsetu-glass-empty text-[12px]">
              START dabao — 09:16 ke baad selected CE/PE pe ~{BAND_TARGET} premium hunt. Same strike
              short-only ladder (SELL entry) — no long hedge. Extras har +3 (gap-fill, no skip), book −3,
              T1 −30% / hard SL +30% (cover BUY = short exit), flatten 15:15. T1–T9 default
              8,2,2,2,2,3,3,4,4 lots. Grid locks on T1 print, never XTS avg.
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
