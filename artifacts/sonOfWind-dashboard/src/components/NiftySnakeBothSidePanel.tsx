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
import {
  bumpPositionsRefresh,
  clearLocalPosition,
  fetchIxPositions,
  POSITIONS_REFRESH_EVENT,
  setLocalShortPosition,
} from "@/lib/ixPortfolio";
import { expectedLadderFill, ixOrderRejectedMessage, ladderOrderPricing, XTS_IX_ORDER_BASE } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import { liveAtmStrikeForChain } from "@/lib/liveAtmStrike";
import {
  BAND_HIGH,
  BAND_LOW,
  BAND_TARGET,
  BOTHSIDE_CLOCK_MS,
  BOTHSIDE_HUNT_WINGS,
  EV_MTM_FLAT,
  EV_NIFTY_BOTHSIDE_FLAT,
  ENABLE_HEDGES,
  HEDGE_PREMIUM_HIGH,
  HEDGE_PREMIUM_LOW,
  LOT_SIZE,
  MANUAL_STRIKE_OFFSETS,
  MAX_PLAN_TICKS,
  ROUND_TRIP_COST_PER_LOT,
  STEP_PTS,
  UNDERLYING,
  applyFilledAction,
  applySize,
  atmOffsetTag,
  avgFill,
  bookExpense,
  bookLevelForSlot,
  buildHedges,
  clearBothSession,
  closestTo100,
  formatAtmOffsetLabel,
  hardCapLots,
  hardSlPrice,
  hedgeLotsOpen,
  hedgeWindowLabel,
  hedgesNeeded,
  idleEngineState,
  isEod,
  isEntryWindow,
  isGridLocked,
  isLiveBoth,
  inPremiumBand,
  istCalendarDay,
  legLabel,
  loadBothSession,
  localNewDayReset,
  longBookedPnl,
  markHedgeOpen,
  nextSquareAllAction,
  openLots,
  openMtm,
  pickHedgePremium,
  pickManualStrike,
  pickNear100,
  planTick,
  qtyForLots,
  reconcileBrokerShortLots,
  resolveManualStrike,
  saveBothSession,
  sellLevel,
  shortBookedPnl,
  SIZE_MULTS,
  bothSessionActive,
  t1CoverPrice,
  t1Lots,
  uiReset,
  visibleSlots,
  windowLabel,
  type BothAction,
  type BothEngineState,
  type BothHedge,
  type ChainPremiumRow,
  type EntryMode,
  type HuntPick,
  type ManualStrikeOffset,
  type OpenDriveBias,
  type OptionType,
  type SizeMult,
} from "@/lib/niftySnakeBothSideRules";

const OPTION_QUOTE_POLL_MS = 8000;
const BROKER_CONFIRM_HITS = 2;
const SELL_GRACE_MS = 6000;
const HEDGE_RETRY_MS = 20000;
/** ~30s open-drive poll (ladder defines DRIVE_POLL_MS; use that cadence family). */
const DRIVE_POLL_MS = 30000;

type NsLog = { id: number; ts: number; text: string; kind: "info" | "entry" | "exit" | "warn" };
type PnlSnap = { gross: number; expense: number; trips: number };

type HedgeCandidate = { strike: number; exchangeInstrumentID: number };

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

function setBothHotFocus(instruments: { exchangeSegment: number; exchangeInstrumentID: number }[]) {
  setHotFocus("snakebothside", instruments);
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

function legLevelView(
  slot: BothEngineState["slots"][number],
  gridLocked: boolean,
  t1Fill: number | null,
  gap: number,
  coverPx: number | null,
  huntIid: number | null,
  nearestIid: number | null,
) {
  const showLevels = gridLocked && t1Fill != null && t1Fill > 0;
  const addPx = showLevels ? sellLevel(t1Fill, slot, gap) : null;
  const bookPx = slot.side === "T1" ? coverPx : showLevels ? bookLevelForSlot(slot, t1Fill!, gap) : null;
  const addLiveIid = slot.side === "T1" && !showLevels ? (huntIid ?? nearestIid) : null;
  const addVal =
    slot.side === "T1" ? (showLevels ? fmtPrice(t1Fill) : null) : fmtPrice(addPx);
  return { addLiveIid, addVal, bookPx };
}

function StatusPill({ open }: { open: boolean }) {
  return (
    <span className={`nbs-pill${open ? " nbs-pill--open" : " nbs-pill--empty"}`}>
      {open ? "Open" : "Empty"}
    </span>
  );
}

function SideLegsTable({
  tone,
  title,
  hint,
  slots,
  gridLocked,
  t1Fill,
  gap,
  coverPx,
  huntIid,
  nearestIid,
}: {
  tone: "up" | "down";
  title: string;
  hint: string;
  slots: BothEngineState["slots"];
  gridLocked: boolean;
  t1Fill: number | null;
  gap: number;
  coverPx: number | null;
  huntIid: number | null;
  nearestIid: number | null;
}) {
  return (
    <div className={`nbs-side nbs-side--${tone}`}>
      <div className="nbs-side__head">
        <span>{title}</span>
        <span className="nbs-side__hint">{hint}</span>
      </div>
      <table className="nbs-table">
        <thead>
          <tr>
            <th>Leg</th>
            <th>Lots</th>
            <th>Add</th>
            <th>Book</th>
            <th>Fill</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {slots.map((slot) => {
            const { addLiveIid, addVal, bookPx } = legLevelView(
              slot,
              gridLocked,
              t1Fill,
              gap,
              coverPx,
              huntIid,
              nearestIid,
            );
            return (
              <tr key={slot.id} className={slot.open ? "nbs-row--open" : undefined}>
                <td>
                  <span className="nbs-leg">{legLabel(slot)}</span>
                  <span className="nbs-leg__sub">Qty {qtyForLots(slot.lots)}</span>
                </td>
                <td>{slot.lots}</td>
                <td>
                  {addLiveIid != null ? <FastLtp iid={addLiveIid} className="tabular-nums" /> : addVal ?? "—"}
                </td>
                <td>{fmtPrice(bookPx)}</td>
                <td>{slot.open ? fmtPrice(slot.fill) : "—"}</td>
                <td>
                  <StatusPill open={slot.open} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function T1Hero({
  slot,
  gridLocked,
  t1Fill,
  gap,
  coverPx,
  huntIid,
  nearestIid,
}: {
  slot: BothEngineState["slots"][number];
  gridLocked: boolean;
  t1Fill: number | null;
  gap: number;
  coverPx: number | null;
  huntIid: number | null;
  nearestIid: number | null;
}) {
  const { addLiveIid, addVal, bookPx } = legLevelView(
    slot,
    gridLocked,
    t1Fill,
    gap,
    coverPx,
    huntIid,
    nearestIid,
  );
  return (
    <div className={`nbs-t1${slot.open ? " nbs-t1--open" : ""}`}>
      <div className="nbs-t1__head">
        <span className="nbs-t1__name">T1</span>
        <StatusPill open={slot.open} />
        <span className="nbs-t1__meta">Qty {qtyForLots(slot.lots)} · primary short</span>
      </div>
      <div className="nbs-t1__metrics">
        <div className="nbs-metric">
          <span className="nbs-metric__label">Lots</span>
          <span className="nbs-metric__value">{slot.lots}</span>
        </div>
        <div className="nbs-metric">
          <span className="nbs-metric__label">Add / Entry</span>
          <span className="nbs-metric__value">
            {addLiveIid != null ? <FastLtp iid={addLiveIid} className="tabular-nums" /> : addVal ?? "—"}
          </span>
        </div>
        <div className="nbs-metric">
          <span className="nbs-metric__label">Book −30%</span>
          <span className="nbs-metric__value">{fmtPrice(bookPx)}</span>
        </div>
        <div className="nbs-metric">
          <span className="nbs-metric__label">Fill</span>
          <span className="nbs-metric__value">{slot.open ? fmtPrice(slot.fill) : "—"}</span>
        </div>
      </div>
    </div>
  );
}

export default function NiftySnakeBothSidePanel({ chain }: { chain: ChainResolved; qty?: number }) {
  const ltps = useLiveLtp();
  const nifty = isNiftyChain(chain);
  const seg = chain.optionSegment;
  const spotSeg = chain.spotSegment;
  const spotToken = chain.spotToken;

  const restoredRef = useRef(loadBothSession());
  const restored = restoredRef.current;

  const [engine, setEngine] = useState<BothEngineState>(() =>
    restored?.engine
      ? {
          ...restored.engine,
          slots: restored.engine.slots.map((s) => ({ ...s })),
          hedges: restored.engine.hedges.map((h) => ({ ...h, covers: h.covers.slice() })),
          reloadIds: restored.engine.reloadIds.slice(),
        }
      : idleEngineState("CE"),
  );
  const [iid, setIid] = useState<number | null>(() => restored?.iid ?? null);
  const [logs, setLogs] = useState<NsLog[]>(() => restored?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [targetText, setTargetText] = useState("");
  const [targetLocked, setTargetLocked] = useState(false);
  const [trailText, setTrailText] = useState("");
  const [trailLocked, setTrailLocked] = useState(false);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [pnl, setPnl] = useState<PnlSnap>(() => ({
    gross: restored?.gross ?? 0,
    expense: restored?.expense ?? 0,
    trips: restored?.trips ?? 0,
  }));
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
  const targetLockedRef = useRef(false);
  const targetPxRef = useRef<number | null>(null);
  const targetSideRef = useRef<"below" | "above">("below");
  const targetLoggedRef = useRef(false);
  const trailLockedRef = useRef(false);
  const trailPxRef = useRef<number | null>(null);
  const trailSideRef = useRef<"below" | "above">("above");
  const trailLoggedRef = useRef(false);
  const restoreNoteRef = useRef(Boolean(restored));
  const hedgeRetryRef = useRef<Record<string, number>>({});
  const hedgeBusyRef = useRef(false);
  const overlayIidRef = useRef<number | null>(null);
  const bandWaitLogAtRef = useRef(0);

  engineRef.current = engine;
  iidRef.current = iid;
  ltpsRef.current = ltps;
  chainRef.current = chain;
  niftyRef.current = nifty;
  logsRef.current = logs;
  pnlRef.current = pnl;

  const inTrade = isLiveBoth(engine);
  const gridLocked = isGridLocked(engine);
  const gap = engine.gap > 0 ? engine.gap : STEP_PTS;

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
      for (let i = -BOTHSIDE_HUNT_WINGS; i <= BOTHSIDE_HUNT_WINGS; i++) {
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

  const persistNow = useCallback((st: BothEngineState) => {
    if (!bothSessionActive(st)) {
      clearBothSession();
      return;
    }
    saveBothSession({
      v: 1,
      day: istCalendarDay(),
      iid: iidRef.current,
      engine: {
        ...st,
        slots: st.slots.map((s) => ({ ...s })),
        hedges: st.hedges.map((h) => ({ ...h, covers: h.covers.slice() })),
        reloadIds: st.reloadIds.slice(),
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
    (next?: BothEngineState) => {
      const st = next ?? engineRef.current;
      engineRef.current = st;
      setEngine({
        ...st,
        slots: st.slots.map((s) => ({ ...s })),
        hedges: st.hedges.map((h) => ({ ...h, covers: h.covers.slice() })),
        reloadIds: st.reloadIds.slice(),
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
    if (isLiveBoth(st) || st.awaitReload || st.t1Fill != null) return null;
    const ch = chainRef.current;
    const spot =
      typeof ltpsRef.current[ch.spotToken] === "number" && ltpsRef.current[ch.spotToken]! > 0
        ? ltpsRef.current[ch.spotToken]!
        : ch.spotLtp;
    const rows = chainPremiumRows(ch, ltpsRef.current);
    const step = typeof ch.step === "number" && ch.step > 0 ? ch.step : 50;
    const manual = st.entryMode === "manual";
    const pick = manual
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
    const livePick = touch && touch > 0 ? { ...pick, ltp: touch } : pick;
    if (!manual && !inPremiumBand(livePick.ltp)) return null;
    return livePick;
  }, []);

  const fetchFreshPositions = useCallback(async (): Promise<Record<string, unknown>[] | null> => {
    const r = (await fetchIxPositions("NetWise", { bypassCache: true })) as { stale?: boolean };
    if (r?.stale) return null;
    return extractPosList(r);
  }, []);

  const quoteHedgePick = useCallback(async (hedge: BothHedge) => {
    const ch = chainRef.current;
    const spot = ltpsRef.current[ch.spotToken];
    const spotPx = typeof spot === "number" && spot > 0 ? spot : ch.spotLtp;
    const r = (await apiFetch("/api/md/nifty_snake_bothside/hedge_candidates", {
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
    async (action: BothAction): Promise<boolean> => {
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
        const lots = st.slots.find((s) => s.id === "T1")?.lots ?? t1Lots(st.sizeMult);
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
        const sl = hardSlPrice(next.slots, next.t1Fill);
        pushLog(
          `ENTRY T1 SELL ${action.pick.strike} ${action.pick.optionType} × ${lots} lots (${qtyForLots(lots)} qty) @ ${fmtPrice(fill)} · cover ${fmtPrice(t1CoverPrice(fill))} · SL ${fmtPrice(sl)}`,
          "entry",
        );
        toast({
          title: `Nifty Snake Both Side T1 ${action.pick.optionType}`,
          description: `${action.pick.strike} @ ${fmtPrice(fill)} · ${lots} lots`,
        });
        return true;
      }

      if (action.kind === "exit_hedge") {
        const hedge = engineRef.current.hedges.find((h) => h.id === action.hedgeId);
        if (!hedge?.open || hedge.iid == null || hedge.fill == null) return true;
        const hint = await placeOrder("SELL", hedge.iid, hedge.lots);
        const fill = expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) || hedge.fill;
        const gross = longBookedPnl(hedge.fill, fill, hedge.lots);
        addPnl(gross, hedge.lots);
        const next = applyFilledAction(engineRef.current, action, fill);
        engineRef.current = next;
        sync(next);
        pushLog(
          `BOOK ${hedgeWindowLabel(hedge)} SELL × ${hedge.lots} lots @ ${fmtPrice(fill)} · ${action.reason}`,
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
        const ids = action.kind === "add" ? [action.id] : action.ids;
        const pending = ids.filter((id) => {
          const slot = engineRef.current.slots.find((s) => s.id === id);
          return slot && !slot.open;
        });
        if (!pending.length) return true;
        const lots = pending.reduce(
          (n, id) => n + (engineRef.current.slots.find((s) => s.id === id)?.lots ?? 0),
          0,
        );
        const liveAction: BothAction =
          action.kind === "add"
            ? { kind: "add", id: pending[0]!, lots }
            : { kind: "resell", ids: pending, lots };
        lastReconcileRef.current = Date.now();
        sellGraceUntilRef.current = Date.now() + SELL_GRACE_MS;
        seenBrokerShortRef.current = true;
        brokerCaughtUpRef.current = false;
        phantomHitsRef.current = 0;
        const hint = await placeOrder("SELL", instrumentId, lots);
        const fill =
          expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask) ||
          peekTouchPx(instrumentId, ltpsRef.current) ||
          0;
        if (!(fill > 0)) {
          pushLog(`${action.kind === "resell" ? "RESELL" : "ADD"} skipped — no live price`, "warn");
          return false;
        }
        const next = applyFilledAction(engineRef.current, liveAction, fill);
        engineRef.current = next;
        sync(next);
        const tabs = pending
          .map((id) => {
            const slot = next.slots.find((s) => s.id === id);
            return slot ? legLabel(slot) : id;
          })
          .join("+");
        if (action.kind === "resell") {
          pushLog(
            `RESELL ${tabs} SELL × ${lots} lots @ ${fmtPrice(fill)} · system resumes from new fills`,
            "entry",
          );
        } else {
          pushLog(`ADD ${tabs} SELL × ${lots} lots @ ${fmtPrice(fill)} · both-side grid live`, "entry");
        }
        return true;
      }

      const slot = engineRef.current.slots.find((s) => s.id === action.id);
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
        `BOOK ${legLabel(slot)} BUY × ${action.lots} lots @ ${fmtPrice(fill)} · ${action.reason} · realized ${fmtPnl(net)}`,
        "exit",
      );
      toast({
        title: slot.id === "T1" ? "Nifty Snake Both Side flat" : `${legLabel(slot)} booked`,
        description: action.reason,
      });
      return true;
    },
    [addPnl, placeOrder, pushLog, sync],
  );

  const buyNeededHedges = useCallback(async () => {
    if (!ENABLE_HEDGES || hedgeBusyRef.current || squareAllReqRef.current) return;
    if (isEod()) return;
    const st = engineRef.current;
    const ltp = peekTouchPx(iidRef.current, ltpsRef.current);
    const liveSl = hardSlPrice(st.slots, st.t1Fill);
    if (st.t1Fill != null && ltp != null && liveSl != null && ltp >= liveSl && openLots(st.slots) > 0) return;
    const needed = hedgesNeeded(st).filter((h) => Date.now() >= (hedgeRetryRef.current[h.id] ?? 0));
    if (!needed.length) return;
    hedgeBusyRef.current = true;
    try {
      for (const hedge of needed) {
        if (!engineRef.current.slots.find((s) => s.id === hedge.triggerId)?.open) continue;
        if (engineRef.current.hedges.find((h) => h.id === hedge.id)?.open) continue;
        try {
          const found = await quoteHedgePick(hedge);
          if (!found) {
            hedgeRetryRef.current[hedge.id] = Date.now() + HEDGE_RETRY_MS;
            pushLog(
              `${hedgeWindowLabel(hedge)} wait — no ${HEDGE_PREMIUM_LOW}–${HEDGE_PREMIUM_HIGH} premium yet`,
              "warn",
            );
            continue;
          }
          const hint = await placeOrder("BUY", found.pick.exchangeInstrumentID, hedge.lots);
          const fill = expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask) || found.pick.ltp;
          const next = markHedgeOpen(
            engineRef.current,
            hedge.id,
            found.pick.strike,
            found.pick.exchangeInstrumentID,
            fill,
          );
          engineRef.current = next;
          sync(next);
          pushLog(
            `HEDGE BUY ${hedgeWindowLabel(hedge)} ${found.pick.strike} ${engineRef.current.optionType} × ${hedge.lots} lots (${hedge.qty} qty) @ ${fmtPrice(fill)}`,
            "entry",
          );
        } catch (e: unknown) {
          hedgeRetryRef.current[hedge.id] = Date.now() + HEDGE_RETRY_MS;
          const msg = e instanceof Error ? e.message : String(e);
          pushLog(`${hedgeWindowLabel(hedge)} failed: ${msg}`, "warn");
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
        clearBothSession();
        pushLog(
          "Position booked — Nifty Snake Both Side short nikal gaya. START AGAIN to hunt 70–75.",
          "warn",
        );
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
      pushLog(`Phantom extras closed: ${result.phantomClosed.join(", ")}`, "warn");
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
        if (isLiveBoth(st) || st.armed) {
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

      const trailPx = trailPxRef.current;
      if (
        trailLockedRef.current &&
        trailPx != null &&
        liveLtpNow != null &&
        (trailSideRef.current === "above" ? liveLtpNow >= trailPx : liveLtpNow <= trailPx)
      ) {
        if (engineRef.current.armed || openLots(engineRef.current.slots) > 0 || hedgeLotsOpen(engineRef.current.hedges) > 0) {
          const next = { ...engineRef.current, armed: false };
          engineRef.current = next;
          sync(next);
          if (!trailLoggedRef.current) {
            trailLoggedRef.current = true;
            pushLog(`TRAIL SL ${fmtPrice(trailPx)} — SQUARE ALL + PAUSE`, "warn");
            toast({ title: "Trail SL hit", description: `Squaring all at ${fmtPrice(trailPx)} and pausing.` });
          }
          if (openLots(engineRef.current.slots) > 0 || hedgeLotsOpen(engineRef.current.hedges) > 0) {
            targetStrikeOnlyRef.current = false;
            squareAllReqRef.current = true;
          }
        }
      } else {
        trailLoggedRef.current = false;
      }

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
          pushLog(
            strikeOnly ? "TARGET — booking this strike" : "SQUARE ALL — shorts highest first, then hedges",
            "warn",
          );
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
        const huntPick = huntFromLive();
        const action = planTick({
          nowMs: Date.now(),
          armed: st.armed,
          awaitRestart: st.awaitRestart,
          awaitReload: st.awaitReload,
          reloadIds: st.reloadIds,
          hardSlPx: st.hardSlPx,
          t1Fill: st.t1Fill,
          slots: st.slots,
          hedges: st.hedges,
          ltp,
          huntPick,
          brokerShortLots: brokerShortLotsRef.current,
          entryMode: st.entryMode ?? "auto",
          gap: st.gap,
          sizeMult: st.sizeMult,
        });
        if (!action) {
          if (
            st.armed &&
            !st.awaitRestart &&
            !isLiveBoth(st) &&
            !st.awaitReload &&
            isEntryWindow(Date.now()) &&
            (st.entryMode ?? "auto") === "auto"
          ) {
            const nearest = closestTo100(chainPremiumRows(chainRef.current, ltpsRef.current), st.optionType);
            if (nearest && !inPremiumBand(nearest.ltp)) {
              const now = Date.now();
              if (now - (bandWaitLogAtRef.current || 0) > 8000) {
                bandWaitLogAtRef.current = now;
                pushLog(
                  `AUTO wait — nearest ${nearest.strike} @ ${fmtPrice(nearest.ltp)} outside band ${BAND_LOW}–${BAND_HIGH}`,
                  "warn",
                );
              }
            }
          }
          break;
        }
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
      toast({ title: "Nifty Snake Both Side order failed", description: msg, variant: "destructive" });
    } finally {
      busyRef.current = false;
      if (uiBusy) setBusy(false);
    }
  }, [buyNeededHedges, executeAction, huntFromLive, pushLog, reconcileNow, sync]);

  const runCycleRef = useRef(runCycle);
  runCycleRef.current = runCycle;

  useEffect(() => {
    const onFlat = () => {
      const next: BothEngineState = { ...engineRef.current, armed: false };
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
    window.addEventListener(EV_NIFTY_BOTHSIDE_FLAT, onFlat);
    window.addEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    return () => {
      window.removeEventListener(EV_MTM_FLAT, onFlat);
      window.removeEventListener(EV_NIFTY_BOTHSIDE_FLAT, onFlat);
      window.removeEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh);
    };
  }, [pushLog, reconcileNow, sync]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void runCycleRef.current();
    }, BOTHSIDE_CLOCK_MS);
    const clock = window.setInterval(() => setClockMs(Date.now()), 250);
    return () => {
      window.clearInterval(id);
      window.clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    for (const key of [
      "sow_nifty_ladder_target",
      "sow_nifty_snake_target",
      "sow_nifty_bothside_target",
      "sow_nifty_snake_bothside_target",
    ]) {
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
    const built = buildHedges(st.slots);
    if (st.hedges.length === built.length || st.hedges.some((h) => h.open)) return;
    const next = { ...st, hedges: built };
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
        : "Reload restore — Nifty Snake Both Side session",
      "info",
    );
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
      const bias = r.bias ?? null;
      const suggest = bias === "FLAT" ? null : (r.suggest ?? null);
      setDrive({
        ready: Boolean(r.ready),
        closed: Boolean(r.closed),
        open: typeof r.open === "number" ? r.open : null,
        close: typeof r.close === "number" ? r.close : null,
        bias,
        suggest,
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
      toast({ title: "Nifty Snake Both Side", description: "Switch the index to NIFTY.", variant: "destructive" });
      return;
    }
    const now = Date.now();
    const st = engineRef.current;
    const trading = openLots(st.slots) > 0 || st.awaitReload;
    if (isEod(now) && !trading) {
      toast({ title: "No new both-side today", description: "Past 15:15 IST — wait for next session." });
      pushLog("START rejected — past 15:15 IST", "warn");
      return;
    }
    const next: BothEngineState = { ...st, armed: true, awaitRestart: false };
    engineRef.current = next;
    sync(next);
    if (st.awaitReload) {
      pushLog(
        "RESUME — re-SELL remembered legs when LTP is below hard SL. System resumes from new fills.",
        "info",
      );
      toast({ title: "Nifty Snake Both Side resumed", description: "Re-SELL when LTP < hard SL." });
    } else if (openLots(st.slots) > 0) {
      pushLog("RESUME — T-A / T-B extras live (books, cover, hard SL stay on)", "info");
      toast({ title: "Nifty Snake Both Side resumed", description: "Both-side adds are live again." });
    } else if (!isEntryWindow(now)) {
      if (st.entryMode === "manual") {
        pushLog(
          `Armed — waiting for 09:16 IST, then MANUAL ${atmOffsetTag(st.manualStrikeOffset)} (no band)`,
          "info",
        );
      } else {
        pushLog(`Armed — waiting for 09:16 IST, then hunt ${BAND_LOW}–${BAND_HIGH}`, "info");
      }
      toast({ title: "Nifty Snake Both Side armed", description: "Entry after 09:16 IST." });
    } else if (st.entryMode === "manual") {
      pushLog(`START — MANUAL ${atmOffsetTag(st.manualStrikeOffset)} · no band · direct T1`, "info");
      toast({
        title: "Nifty Snake Both Side started",
        description: `Manual ${atmOffsetTag(st.manualStrikeOffset)} — enter on live print.`,
      });
    } else {
      pushLog(`START — hunting ~${BAND_TARGET} premium in ${BAND_LOW}–${BAND_HIGH}`, "info");
      toast({
        title: "Nifty Snake Both Side started",
        description: `Sell T1 only inside ${BAND_LOW}–${BAND_HIGH}.`,
      });
    }
    void runCycleRef.current();
  };

  const pause = () => {
    const next: BothEngineState = { ...engineRef.current, armed: false };
    engineRef.current = next;
    sync(next);
    pushLog("PAUSE — no hunt, no new extras, no re-SELL. Books, T1 −30%, hard SL, EOD still fire.", "info");
    toast({ title: "Nifty Snake Both Side paused", description: "Protective exits stay on." });
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

  const lockTrail = () => {
    const px = Number(trailText.replace(/,/g, "").trim());
    if (!Number.isFinite(px) || px <= 0) {
      toast({ title: "Trail SL", description: "Pehle price likho.", variant: "destructive" });
      return;
    }
    const live = peekTouchPx(iidRef.current, ltpsRef.current);
    trailPxRef.current = px;
    trailSideRef.current = live != null && px > live ? "above" : "below";
    trailLockedRef.current = true;
    trailLoggedRef.current = false;
    setTrailLocked(true);
    toast({
      title: "Trail SL locked",
      description: `${fmtPrice(px)} · hit pe SQUARE ALL + pause.`,
    });
  };

  const unlockTrail = () => {
    trailLockedRef.current = false;
    trailPxRef.current = null;
    trailLoggedRef.current = false;
    setTrailLocked(false);
  };

  const squareAll = () => {
    const st = engineRef.current;
    if (openLots(st.slots) <= 0 && hedgeLotsOpen(st.hedges) <= 0) return;
    const next: BothEngineState = { ...st, armed: false };
    engineRef.current = next;
    sync(next);
    targetStrikeOnlyRef.current = false;
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

  const applyDriveSuggest = () => {
    if (!drive.suggest || inTrade) return;
    setSide(drive.suggest);
    pushLog(`Open drive applied — side set to ${drive.suggest}`, "info");
  };

  const setMult = (sizeMult: SizeMult) => {
    const st = engineRef.current;
    if (st.sizeMult === sizeMult) return;
    if (openLots(st.slots) > 0 || st.awaitReload || st.t1Fill != null || hedgeLotsOpen(st.hedges) > 0) return;
    const next = applySize(st, sizeMult);
    engineRef.current = next;
    sync(next);
  };

  const controlsLocked = gridLocked || engine.awaitReload;

  const setEntryMode = (entryMode: EntryMode) => {
    const st = engineRef.current;
    if (openLots(st.slots) > 0 || st.awaitReload || st.t1Fill != null || st.entryMode === entryMode) return;
    const next: BothEngineState = { ...st, entryMode, manualStrikeOffset: 0 };
    engineRef.current = next;
    sync(next);
  };

  const setManualOffset = (manualStrikeOffset: ManualStrikeOffset) => {
    const st = engineRef.current;
    if (openLots(st.slots) > 0 || st.awaitReload || st.t1Fill != null || st.manualStrikeOffset === manualStrikeOffset) {
      return;
    }
    const next: BothEngineState = { ...st, manualStrikeOffset };
    engineRef.current = next;
    sync(next);
  };

  const rows = useMemo(() => chainPremiumRows(chain, ltps), [chain, ltps, clockMs]);
  const step = typeof chain.step === "number" && chain.step > 0 ? chain.step : 50;
  const liveAtm = liveAtmStrikeForChain(chain, typeof spotLive === "number" ? spotLive : undefined);
  const huntPick =
    !gridLocked && !engine.awaitReload
      ? engine.entryMode === "manual"
        ? pickManualStrike(rows, engine.optionType, liveAtm, engine.manualStrikeOffset, step)
        : pickNear100(rows, engine.optionType)
      : null;
  const manualDisplayStrike =
    engine.entryMode === "manual" ? resolveManualStrike(liveAtm, engine.manualStrikeOffset, step) : null;
  const nearest = closestTo100(rows, engine.optionType);
  const avg = avgFill(engine.slots);
  const lotsOpen = openLots(engine.slots);
  const capLots = hardCapLots(engine.sizeMult ?? 1);
  const mtm = openMtm(avg, liveLtp, lotsOpen);
  const coverPx = gridLocked && engine.t1Fill != null ? t1CoverPrice(engine.t1Fill) : null;
  const displayHardSl = engine.awaitReload
    ? engine.hardSlPx
    : gridLocked
      ? hardSlPrice(engine.slots, engine.t1Fill)
      : null;
  const primaryLabel = engine.awaitRestart ? "START AGAIN" : "START";
  const net = pnl.gross - pnl.expense;

  const huntIid = huntPick
    ? resolveIid(chain, huntPick.strike, huntPick.optionType)
    : manualDisplayStrike != null
      ? resolveIid(chain, manualDisplayStrike, engine.optionType)
      : null;
  const nearestIid = nearest ? resolveIid(chain, nearest.strike, nearest.optionType) : null;
  const paintIid = lotsOpen > 0 || engine.awaitReload ? iid : huntIid ?? nearestIid;

  const vis = useMemo(() => visibleSlots(engine.slots), [engine.slots]);
  const taSlots = vis.filter((s) => s.side === "A");
  const tbSlots = vis.filter((s) => s.side === "B");
  const t1Slot = vis.find((s) => s.side === "T1");

  useEffect(() => {
    if (!seg || paintIid == null || !Number.isFinite(paintIid) || paintIid <= 0) {
      setBothHotFocus([]);
      return;
    }
    setBothHotFocus([{ exchangeSegment: seg, exchangeInstrumentID: paintIid }]);
    return () => {
      setBothHotFocus([]);
    };
  }, [seg, paintIid]);

  const statusNote = !nifty
    ? "NIFTY only — switch index"
    : engine.awaitReload
      ? engine.armed
        ? `Hard SL flat — re-SELL ${engine.reloadIds.map((id) => {
            const s = engine.slots.find((x) => x.id === id);
            return s ? legLabel(s) : id;
          }).join("+") || "?"} when LTP < SL`
        : "Hard SL flat — PAUSE (START to re-SELL same legs)"
      : engine.awaitRestart
        ? "Await Restart — START AGAIN hunts a new 70–75"
        : gridLocked && engine.armed
          ? "In Trade · T-A up / T-B down"
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

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Entry</span>
            <div className="nl-toggle">
              {(["auto", "manual"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  disabled={controlsLocked}
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
                disabled={controlsLocked}
                onChange={setManualOffset}
              />
            </div>
          )}

          <div className="flex flex-col gap-1 min-w-[80px]">
            <span className="ramsetu-glass-toolbar__label">Gap</span>
            <span className="font-semibold tabular-nums text-foreground">+{gap} / −{gap}</span>
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
              title="Clear this both-side UI only — does not square XTS"
            >
              RESET
            </button>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex flex-col gap-3">
        {!nifty && (
          <div className="ramsetu-glass-empty">
            Nifty Snake Both Side trades NIFTY options only. Switch the top index to NIFTY.
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <button
            type="button"
            disabled={inTrade || !drive.suggest}
            onClick={applyDriveSuggest}
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
              {drive.suggest
                ? `Suggest ${drive.suggest} · click to apply`
                : drive.bias === "FLAT"
                  ? "FLAT · no suggest"
                  : drive.error || "Hint only · not auto-entry"}
            </div>
            {(drive.open != null || drive.close != null) && (
              <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
                O {fmtPrice(drive.open)} → C {fmtPrice(drive.close)}
              </div>
            )}
          </button>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">
              {engine.strike != null
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
              {engine.strike != null
                ? `${engine.strike.toLocaleString("en-IN")} ${engine.optionType}`
                : huntPick
                  ? `${huntPick.strike.toLocaleString("en-IN")} ${engine.optionType}`
                  : engine.entryMode === "manual" && manualDisplayStrike != null
                    ? `${manualDisplayStrike.toLocaleString("en-IN")} ${engine.optionType}`
                    : "—"}
            </div>
            <div className="ramsetu-glass-card__rule">
              {engine.strike != null
                ? "Strike locked"
                : engine.entryMode === "manual"
                  ? huntPick
                    ? (
                        <>
                          LTP <FastLtp iid={huntIid} className="tabular-nums" /> ·{" "}
                          {atmOffsetTag(engine.manualStrikeOffset)} · no band
                        </>
                      )
                    : `${atmOffsetTag(engine.manualStrikeOffset)} · no band`
                  : huntPick
                    ? (
                        <>
                          LTP <FastLtp iid={huntIid} className="tabular-nums" /> · band {BAND_LOW}–{BAND_HIGH}
                        </>
                      )
                    : nearest
                      ? (
                          <>
                            Nearest {nearest.strike} @ <FastLtp iid={nearestIid} className="tabular-nums" />{" "}
                            (outside band)
                          </>
                        )
                      : `No print in ${BAND_LOW}–${BAND_HIGH}`}
            </div>
          </div>

          <div className="ramsetu-glass-card ramsetu-glass-card--center">
            <div className="ramsetu-glass-card__badge">T1 FILL</div>
            <div className="ramsetu-glass-card__strike tabular-nums">{fmtPrice(engine.t1Fill)}</div>
            <div className="ramsetu-glass-card__rule">
              Cover {fmtPrice(coverPx)} · hard SL {fmtPrice(displayHardSl)} · gap {gap}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 tabular-nums">
              Cap {lotsOpen}/{capLots} lots · band {BAND_LOW}–{BAND_HIGH} ~{BAND_TARGET}
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
            <div className="mt-1.5 flex flex-col items-center gap-1.5">
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
                <button
                  type="button"
                  disabled={targetLocked}
                  onClick={lockTarget}
                  className="ramsetu-glass-exec min-w-0 px-2 py-1"
                >
                  Lock
                </button>
                <button
                  type="button"
                  disabled={!targetLocked}
                  onClick={unlockTarget}
                  className="ramsetu-glass-stop min-w-0 px-2 py-1"
                >
                  Unlock
                </button>
              </div>
              <div className="flex items-center justify-center gap-1">
                <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Trail SL</span>
                <input
                  aria-label="Trail SL"
                  placeholder="price"
                  value={trailText}
                  disabled={trailLocked}
                  onChange={(e) => setTrailText(e.target.value)}
                  className="h-6 w-[72px] rounded-md border border-border/60 bg-background/70 px-1.5 text-center text-[11px] font-semibold tabular-nums"
                />
                <button
                  type="button"
                  disabled={trailLocked}
                  onClick={lockTrail}
                  className="ramsetu-glass-exec min-w-0 px-2 py-1"
                >
                  Lock
                </button>
                <button
                  type="button"
                  disabled={!trailLocked}
                  onClick={unlockTrail}
                  className="ramsetu-glass-stop min-w-0 px-2 py-1"
                >
                  Unlock
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="nbs-board">
          {t1Slot && (
            <T1Hero
              slot={t1Slot}
              gridLocked={gridLocked}
              t1Fill={engine.t1Fill}
              gap={gap}
              coverPx={coverPx}
              huntIid={huntIid}
              nearestIid={nearestIid}
            />
          )}
          <div className="nbs-sides">
            {taSlots.length > 0 && (
              <SideLegsTable
                tone="up"
                title="T-A · Up"
                hint={`sell F+${gap}k · book −${gap}`}
                slots={taSlots}
                gridLocked={gridLocked}
                t1Fill={engine.t1Fill}
                gap={gap}
                coverPx={coverPx}
                huntIid={huntIid}
                nearestIid={nearestIid}
              />
            )}
            {tbSlots.length > 0 && (
              <SideLegsTable
                tone="down"
                title="T-B · Down"
                hint={`sell F−${gap}k · book −${gap + 1}`}
                slots={tbSlots}
                gridLocked={gridLocked}
                t1Fill={engine.t1Fill}
                gap={gap}
                coverPx={coverPx}
                huntIid={huntIid}
                nearestIid={nearestIid}
              />
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="ramsetu-glass-toolbar__label mb-2">
            Log · gross {fmtPnl(pnl.gross)} · expense {fmtPnl(pnl.expense)} · net {fmtPnl(net)} · {pnl.trips} lot RT
          </div>
          {!logs.length ? (
            <p className="ramsetu-glass-empty text-[12px]">
              START dabao — 09:16 ke baad selected CE/PE pe band {BAND_LOW}–{BAND_HIGH} (prefer ~{BAND_TARGET}).
              Same strike short-only both-side grid: T1 + T-A (up +{STEP_PTS}) + T-B (down −{STEP_PTS}). Extras
              lots 3,3,4,4,3,3 (Ladder-70) · Lot {LOT_SIZE} · size 1x/2x/3x · hard SL cheapest open × 1.30. Hard
              SL ke baad same legs re-SELL jab LTP SL ke neeche aaye — system naye fills se resume karta hai.
              TARGET = book strike + PAUSE; TRAIL SL = square ALL + PAUSE. Open-drive hint alag hai — FLAT pe
              suggest nahi. Nifty Ladder / Snake / Ladder Both Side se alag engine hai.
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
