import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainResolved } from "@/types/market";
import { peekLiveTick, useLiveLtp } from "@/context/LiveLtpContext";
import { peekTouchPx } from "@/lib/liveQuote";
import { setHotFocus } from "@/lib/hotFocus";
import { fmtPnl, fmtPrice, fmtQty } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, clearLocalPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import { expectedLadderFill, ixOrderRejectedMessage, ladderOrderPricing, XTS_IX_ORDER_BASE } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import {
  DEFAULT_QTY,
  LOT_SIZE,
  RSI_CE_ARM_THRESHOLD,
  RSI_CE_AUTO_EXIT,
  RSI_CE_CROSS_THRESHOLD,
  RSI_PE_ARM_THRESHOLD,
  RSI_PE_AUTO_EXIT,
  RSI_PE_CROSS_THRESHOLD,
  RSI_RATIOS,
  SIZE_MULTS,
  TIMEFRAMES,
  UNDERLYING,
  canSellCe,
  canSellPe,
  isRatioId,
  isSizeMult,
  isTimeframe,
  orderQuantity,
  parseQty,
  pickClosestLtp,
  pickHighestLtp,
  ratioById,
  shouldAutoExitCe,
  shouldAutoExitPe,
  shortMtm,
  type RatioId,
  type RsiSide,
  type RsiTimeframe,
  type SizeMult,
} from "@/lib/rsiBandRules";
import {
  Activity,
  AlertOctagon,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Layers,
  Play,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Square,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";

const SESSION_KEY = "sow_nifty_rsi_v1";
const POLL_INTERVAL_MS = 5000;
const WATCH_INTERVAL_MS = 200;

export type RsiLog = {
  id: number;
  ts: number;
  text: string;
  kind: "entry" | "exit" | "auto_exit" | "error" | "info";
};

export type RsiPosition = {
  side: RsiSide;
  strike: number;
  qty: number;
  fill: number;
  iid: number;
  segment: number;
  openedAt: number;
};

type SideQuote = { strike: number; ltp: number; iid: number };

type RsiCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  rsi: number | null;
};

type RsiSignal = {
  time: number;
  type: "CE_SELL" | "PE_SELL";
  rsi: number;
  spot: number;
  label: string;
};

type SessionBlob = {
  qtyText: string;
  ratio: RatioId;
  size: SizeMult;
  timeframe: RsiTimeframe;
  scaleZoom?: "zoomed" | "full";
  barZoom?: "30" | "50" | "all";
  chartHeight?: "normal" | "tall" | "max";
  cePosition: RsiPosition | null;
  pePosition: RsiPosition | null;
  logs: RsiLog[];
  logId: number;
};

function isNiftyChain(chain: ChainResolved): boolean {
  return String(chain.index || "").trim().toUpperCase() === UNDERLYING;
}

function positivePx(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sideQuotes(chain: ChainResolved, side: RsiSide, ltpMap?: Record<number, number>): SideQuote[] {
  const out: SideQuote[] = [];
  for (const [key, inst] of Object.entries(chain.instrumentMap || {})) {
    const strike = Number(key);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const iid = side === "CE" ? inst?.ce : inst?.pe;
    if (typeof iid !== "number" || !Number.isFinite(iid) || iid <= 0) continue;
    const ltp = peekTouchPx(iid, ltpMap);
    if (ltp == null || !(ltp > 0)) continue;
    out.push({ strike, ltp, iid });
  }
  return out;
}

function readPosition(raw: unknown): RsiPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<RsiPosition>;
  const side = row.side === "CE" || row.side === "PE" ? row.side : null;
  const strike = Number(row.strike);
  const qty = Number(row.qty);
  const fill = Number(row.fill);
  const iid = Number(row.iid);
  const segment = Number(row.segment);
  const openedAt = Number(row.openedAt) || Date.now();
  if (!side || !Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isSafeInteger(qty) || qty <= 0 || qty % LOT_SIZE !== 0) return null;
  if (!Number.isFinite(fill) || fill <= 0) return null;
  if (!Number.isFinite(iid) || iid <= 0) return null;
  if (!Number.isFinite(segment) || segment <= 0) return null;
  return { side, strike, qty, fill, iid, segment, openedAt };
}

function loadSession(): SessionBlob | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionBlob>;
    const qtyText = typeof parsed.qtyText === "string" ? parsed.qtyText : String(DEFAULT_QTY);
    const ratio = typeof parsed.ratio === "string" && isRatioId(parsed.ratio) ? parsed.ratio : "80-100";
    const size = typeof parsed.size === "number" && isSizeMult(parsed.size) ? parsed.size : 1;
    const timeframe = typeof parsed.timeframe === "number" && isTimeframe(parsed.timeframe) ? parsed.timeframe : 5;
    const scaleZoom = parsed.scaleZoom === "zoomed" || parsed.scaleZoom === "full" ? parsed.scaleZoom : "full";
    const barZoom = parsed.barZoom === "30" || parsed.barZoom === "50" || parsed.barZoom === "all" ? parsed.barZoom : "all";
    const chartHeight = parsed.chartHeight === "normal" || parsed.chartHeight === "tall" || parsed.chartHeight === "max" ? parsed.chartHeight : "normal";
    const cePosition = readPosition(parsed.cePosition);
    const pePosition = readPosition(parsed.pePosition);
    const logs = Array.isArray(parsed.logs) ? (parsed.logs as RsiLog[]).slice(0, 100) : [];
    const logId = logs.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    return { qtyText, ratio, size, timeframe, scaleZoom, barZoom, chartHeight, cePosition, pePosition, logs, logId };
  } catch {
    return null;
  }
}

function rememberShort(chain: ChainResolved, pos: RsiPosition) {
  const expiry = chain.expiryApi ? ` ${chain.expiryApi}` : "";
  setLocalShortPosition({
    exchangeInstrumentID: pos.iid,
    exchangeSegment: pos.segment,
    qty: pos.qty,
    fillPx: pos.fill,
    tradingSymbol: `NIFTY${expiry} ${pos.strike} ${pos.side}`,
  });
}

function formatCandleTime(epochSec: number): string {
  if (!epochSec) return "--:--";
  const d = new Date(epochSec * 1000);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function RsiBandPanel({ chain, active }: { chain: ChainResolved; active: boolean }) {
  const boot = useMemo(() => loadSession(), []);
  const [qtyText, setQtyText] = useState(boot?.qtyText ?? String(DEFAULT_QTY));
  const [ratio, setRatio] = useState<RatioId>(boot?.ratio ?? "80-100");
  const [size, setSize] = useState<SizeMult>(boot?.size ?? 1);
  const [timeframe, setTimeframe] = useState<RsiTimeframe>(boot?.timeframe ?? 5);
  const [cePosition, setCePosition] = useState<RsiPosition | null>(boot?.cePosition ?? null);
  const [pePosition, setPePosition] = useState<RsiPosition | null>(boot?.pePosition ?? null);
  const [logs, setLogs] = useState<RsiLog[]>(boot?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(0);

  // Backend RSI states
  const [confirmedRsi, setConfirmedRsi] = useState<number | null>(null);
  const [projectedRsi, setProjectedRsi] = useState<number | null>(null);
  const [candles, setCandles] = useState<RsiCandle[]>([]);
  const [signals, setSignals] = useState<RsiSignal[]>([]);
  const [backendSource, setBackendSource] = useState<string>("fyers");
  const [lastFetchTs, setLastFetchTs] = useState<number>(0);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Hover crosshair inspection state
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Chart Zoom & Display Scaling States (Defaults per user preference)
  const [scaleZoom, setScaleZoom] = useState<"zoomed" | "full">(boot?.scaleZoom ?? "full");
  const [barZoom, setBarZoom] = useState<"30" | "50" | "all">(boot?.barZoom ?? "all");
  const [chartHeight, setChartHeight] = useState<"normal" | "tall" | "max">(boot?.chartHeight ?? "normal");

  const ltps = useLiveLtp();
  const logIdRef = useRef(boot?.logId ?? 1);
  const chainRef = useRef(chain);
  const cePosRef = useRef(cePosition);
  const pePosRef = useRef(pePosition);
  const busyRef = useRef(false);
  const autoExitInFlightRef = useRef<{ CE: boolean; PE: boolean }>({ CE: false, PE: false });

  chainRef.current = chain;
  cePosRef.current = cePosition;
  pePosRef.current = pePosition;
  busyRef.current = busy;

  const nifty = isNiftyChain(chain);
  const parsedQty = parseQty(qtyText);
  const band = ratioById(ratio);
  const effectiveOrderQty = parsedQty.ok ? orderQuantity(parsedQty.qty, size) : null;

  // Live Spot price from chain spot token
  const liveSpotLtp = useMemo(() => {
    const spotToken = chain.spotToken;
    if (typeof spotToken === "number" && spotToken > 0) {
      const p = peekTouchPx(spotToken, ltps);
      if (p != null && p > 0) return p;
      if (ltps[spotToken] != null && ltps[spotToken] > 0) return ltps[spotToken];
    }
    return null;
  }, [chain.spotToken, ltps, pulse]);

  // Projected Live RSI
  const liveRsi = useMemo(() => {
    if (projectedRsi != null && Number.isFinite(projectedRsi)) return projectedRsi;
    if (confirmedRsi != null && Number.isFinite(confirmedRsi)) return confirmedRsi;
    return null;
  }, [projectedRsi, confirmedRsi]);

  // All available quotes for CE and PE
  const ceAllQuotes = useMemo(() => {
    if (!nifty) return [];
    return sideQuotes(chain, "CE", ltps);
  }, [nifty, chain, ltps, pulse]);

  const peAllQuotes = useMemo(() => {
    if (!nifty) return [];
    return sideQuotes(chain, "PE", ltps);
  }, [nifty, chain, ltps, pulse]);

  // Candidate option picks: first inside band, otherwise fallback to closest
  const cePick = useMemo(() => {
    if (!ceAllQuotes.length) return null;
    const inside = pickHighestLtp(ceAllQuotes, band.low, band.high);
    if (inside) return { pick: inside, inBand: true };
    const closest = pickClosestLtp(ceAllQuotes, band.low, band.high);
    return closest ? { pick: closest, inBand: false } : null;
  }, [ceAllQuotes, band.low, band.high]);

  const pePick = useMemo(() => {
    if (!peAllQuotes.length) return null;
    const inside = pickHighestLtp(peAllQuotes, band.low, band.high);
    if (inside) return { pick: inside, inBand: true };
    const closest = pickClosestLtp(peAllQuotes, band.low, band.high);
    return closest ? { pick: closest, inBand: false } : null;
  }, [peAllQuotes, band.low, band.high]);

  const ceCandidate = cePick?.pick ?? null;
  const peCandidate = pePick?.pick ?? null;

  // Live LTP and MTM of open short positions
  const ceLiveLtp = cePosition ? peekTouchPx(cePosition.iid, ltps) ?? ltps[cePosition.iid] ?? null : null;
  const peLiveLtp = pePosition ? peekTouchPx(pePosition.iid, ltps) ?? ltps[pePosition.iid] ?? null : null;

  const ceMtm = cePosition && ceLiveLtp != null ? shortMtm(cePosition.fill, ceLiveLtp, cePosition.qty) : null;
  const peMtm = pePosition && peLiveLtp != null ? shortMtm(pePosition.fill, peLiveLtp, pePosition.qty) : null;
  const totalMtm = (ceMtm ?? 0) + (peMtm ?? 0);

  const pushLog = useCallback((text: string, kind: RsiLog["kind"]) => {
    const id = logIdRef.current++;
    setLogs((prev) => [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 100));
  }, []);

  // Save session across page reloads
  useEffect(() => {
    const blob: SessionBlob = {
      qtyText,
      ratio,
      size,
      timeframe,
      scaleZoom,
      barZoom,
      chartHeight,
      cePosition,
      pePosition,
      logs,
      logId: logIdRef.current,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(blob));
    } catch {
      /* ignore */
    }
  }, [qtyText, ratio, size, timeframe, scaleZoom, barZoom, chartHeight, cePosition, pePosition, logs]);

  // Sync open short positions to local store for LeftPanel MTM & PositionsTable
  useEffect(() => {
    if (cePosition) rememberShort(chainRef.current, cePosition);
    if (pePosition) rememberShort(chainRef.current, pePosition);
  }, [cePosition, pePosition]);

  // Fast pulse for preview and LTP refresh
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setPulse((n) => n + 1), 250);
    return () => window.clearInterval(id);
  }, [active]);

  // Hot focus: register candidate and open position tokens with backend for live Fyers stream
  useEffect(() => {
    if (!active || !nifty) {
      setHotFocus("rsi", []);
      return;
    }
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (seg: number, iid: number) => {
      if (seg > 0 && iid > 0 && !seen.has(iid)) {
        seen.add(iid);
        instruments.push({ exchangeSegment: seg, exchangeInstrumentID: iid });
      }
    };

    if (chain.spotToken > 0 && chain.spotSegment > 0) add(chain.spotSegment, chain.spotToken);
    if (cePosition) add(cePosition.segment, cePosition.iid);
    if (pePosition) add(pePosition.segment, pePosition.iid);
    if (ceCandidate) add(chain.optionSegment, ceCandidate.iid);
    if (peCandidate) add(chain.optionSegment, peCandidate.iid);

    setHotFocus("rsi", instruments);
    return () => setHotFocus("rsi", []);
  }, [active, nifty, chain.spotToken, chain.spotSegment, chain.optionSegment, cePosition, pePosition, ceCandidate, peCandidate]);

  // Fetch RSI data from backend every 5 seconds while active
  const fetchRsiData = useCallback(async () => {
    if (!active) return;
    try {
      const spot = liveSpotLtp ?? undefined;
      const res = (await apiFetch("/api/rsi/data", {
        method: "POST",
        body: JSON.stringify({ timeframe, liveSpot: spot }),
      })) as {
        ok?: boolean;
        timeframe?: number;
        source?: string;
        candles?: RsiCandle[];
        signals?: RsiSignal[];
        confirmedRsi?: number | null;
        projectedRsi?: number | null;
        liveRsi?: number | null;
        error?: string;
      };

      if (res?.ok) {
        setConfirmedRsi(res.confirmedRsi ?? null);
        setProjectedRsi(res.projectedRsi ?? null);
        setCandles(res.candles || []);
        setSignals(res.signals || []);
        setBackendSource(res.source || "fyers");
        setLastFetchTs(Date.now());
        setFetchError(null);
      } else {
        setFetchError(res?.error || "Failed to load RSI data");
      }
    } catch (e: unknown) {
      setFetchError(e instanceof Error ? e.message : String(e));
    }
  }, [active, timeframe, liveSpotLtp]);

  useEffect(() => {
    if (!active) return;
    void fetchRsiData();
    const id = window.setInterval(fetchRsiData, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active, fetchRsiData]);

  // Execute order via XTS API
  const placeOrder = useCallback(
    async (side: "BUY" | "SELL", instrumentId: number, qty: number, segment: number) => {
      const tick = peekLiveTick(instrumentId);
      const ltp = peekTouchPx(instrumentId, ltps);
      const response = (await apiFetch("/api/ix/place_order", {
        method: "POST",
        body: JSON.stringify({
          ...XTS_IX_ORDER_BASE,
          ...ladderOrderPricing(side, ltp, tick?.bid, tick?.ask),
          exchangeSegment: segment,
          exchangeInstrumentID: instrumentId,
          orderSide: side,
          orderQuantity: qty,
        }),
      })) as { ok?: boolean; error?: string; raw?: unknown; fillHint?: { ltp?: number; bid?: number; ask?: number } };
      const rejected = ixOrderRejectedMessage(response?.raw) || ixOrderRejectedMessage(response);
      if (rejected) throw new Error(rejected);
      bumpPositionsRefresh();
      const hintLtp = positivePx(response?.fillHint?.ltp) ?? ltp;
      const hintBid = positivePx(response?.fillHint?.bid) ?? positivePx(tick?.bid);
      const hintAsk = positivePx(response?.fillHint?.ask) ?? positivePx(tick?.ask);
      return { ltp: hintLtp, bid: hintBid, ask: hintAsk };
    },
    [ltps],
  );

  // START CE / START PE Manual Entry
  const handleStartEntry = useCallback(
    async (side: RsiSide) => {
      if (busyRef.current) return;
      const isCe = side === "CE";
      const existing = isCe ? cePosRef.current : pePosRef.current;
      if (existing) {
        toast({ title: `Nifty RSI`, description: `${side} position is already open. Use EXIT ${side}.`, variant: "destructive" });
        return;
      }
      if (!parsedQty.ok) {
        toast({ title: "Invalid Quantity", description: parsedQty.error, variant: "destructive" });
        return;
      }
      const candidate = isCe ? ceCandidate : peCandidate;
      if (!candidate) {
        toast({ title: `No ${side} Strike Available`, description: `Could not resolve any active ${side} option quote.`, variant: "destructive" });
        return;
      }

      // Check entry threshold (60.5 for CE, 39.5 for PE)
      const armOk = isCe ? canSellCe(liveRsi, false) : canSellPe(liveRsi, false);
      if (!armOk) {
        const cond = isCe ? `≤ ${RSI_CE_ARM_THRESHOLD}` : `≥ ${RSI_PE_ARM_THRESHOLD}`;
        toast({
          title: `RSI Entry Condition Not Met`,
          description: `START ${side} requires live RSI ${cond}. Current live RSI is ${liveRsi?.toFixed(1) ?? "──"}.`,
          variant: "destructive",
        });
        return;
      }

      const totalQty = orderQuantity(parsedQty.qty, size);
      const segment = chainRef.current.optionSegment;
      setBusy(true);
      busyRef.current = true;
      try {
        const hint = await placeOrder("SELL", candidate.iid, totalQty, segment);
        const fill = positivePx(expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask)) ?? candidate.ltp;
        const newPos: RsiPosition = {
          side,
          strike: candidate.strike,
          qty: totalQty,
          fill,
          iid: candidate.iid,
          segment,
          openedAt: Date.now(),
        };

        if (isCe) setCePosition(newPos);
        else setPePosition(newPos);

        rememberShort(chainRef.current, newPos);
        const strikeStr = Math.round(candidate.strike).toLocaleString("en-IN");
        pushLog(
          `START ${side}: SOLD ${strikeStr} ${side} × ${fmtQty(totalQty)} @ ${fmtPrice(fill)} · RSI: ${liveRsi?.toFixed(1) ?? "──"}`,
          "entry",
        );
        toast({
          title: `START ${side} Filled`,
          description: `${strikeStr} ${side} × ${fmtQty(totalQty)} @ ${fmtPrice(fill)}`,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        pushLog(`START ${side} FAILED: ${msg}`, "error");
        toast({ title: `START ${side} Failed`, description: msg, variant: "destructive" });
      } finally {
        setBusy(false);
        busyRef.current = false;
      }
    },
    [parsedQty, ceCandidate, peCandidate, liveRsi, size, placeOrder, pushLog],
  );

  // EXIT CE / EXIT PE (Manual or Auto-exit)
  const exitPosition = useCallback(
    async (side: RsiSide, reason: string, isAuto: boolean = false) => {
      const pos = side === "CE" ? cePosRef.current : pePosRef.current;
      if (!pos) {
        toast({ title: `EXIT ${side}`, description: `No open ${side} position found.` });
        return;
      }
      if (isAuto && autoExitInFlightRef.current[side]) return;

      if (isAuto) autoExitInFlightRef.current[side] = true;
      setBusy(true);
      busyRef.current = true;

      try {
        const hint = await placeOrder("BUY", pos.iid, pos.qty, pos.segment);
        const exitPx =
          positivePx(expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask)) ??
          positivePx(peekTouchPx(pos.iid, ltps)) ??
          pos.fill;
        const pnl = shortMtm(pos.fill, exitPx, pos.qty);
        clearLocalPosition(pos.iid);

        if (side === "CE") setCePosition(null);
        else setPePosition(null);

        const strikeStr = Math.round(pos.strike).toLocaleString("en-IN");
        const logKind = isAuto ? "auto_exit" : "exit";
        pushLog(
          `EXIT ${pos.side}: BOUGHT ${strikeStr} ${pos.side} × ${fmtQty(pos.qty)} @ ${fmtPrice(exitPx)} · P&L: ${fmtPnl(pnl)} · ${reason}`,
          logKind,
        );
        toast({
          title: isAuto ? `AUTO EXIT (${pos.side}) Triggered` : `EXIT ${pos.side} Completed`,
          description: `${strikeStr} ${pos.side} closed @ ${fmtPrice(exitPx)} · P&L ${fmtPnl(pnl)}`,
          variant: isAuto ? "destructive" : "default",
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        pushLog(`EXIT ${side} FAILED: ${msg}`, "error");
        toast({ title: `EXIT ${side} Failed`, description: msg, variant: "destructive" });
      } finally {
        if (isAuto) autoExitInFlightRef.current[side] = false;
        setBusy(false);
        busyRef.current = false;
      }
    },
    [placeOrder, pushLog, ltps],
  );

  // Square All: closes both open CE and PE positions
  const handleSquareAll = useCallback(async () => {
    if (busyRef.current) return;
    const hasCe = cePosRef.current != null;
    const hasPe = pePosRef.current != null;
    if (!hasCe && !hasPe) {
      toast({ title: "Nifty RSI", description: "No open positions to square off." });
      return;
    }
    setBusy(true);
    busyRef.current = true;
    try {
      if (hasCe) await exitPosition("CE", "SQUARE ALL manual");
      if (hasPe) await exitPosition("PE", "SQUARE ALL manual");
      pushLog("SQUARE ALL finished. Portfolio flat.", "info");
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }, [exitPosition, pushLog]);

  // Continuous Auto-Exit Watcher: monitors live RSI against 63.0 (CE) and 37.0 (PE)
  useEffect(() => {
    if (!active) return;
    const checkAutoExits = () => {
      if (busyRef.current) return;
      const currentRsi = liveRsi;
      if (currentRsi == null) return;

      // CE Auto-exit: live RSI > 63
      if (cePosRef.current && shouldAutoExitCe(currentRsi, true)) {
        if (!autoExitInFlightRef.current.CE) {
          void exitPosition("CE", `AUTO EXIT: RSI ${currentRsi.toFixed(1)} > ${RSI_CE_AUTO_EXIT}`, true);
        }
      }

      // PE Auto-exit: live RSI < 37
      if (pePosRef.current && shouldAutoExitPe(currentRsi, true)) {
        if (!autoExitInFlightRef.current.PE) {
          void exitPosition("PE", `AUTO EXIT: RSI ${currentRsi.toFixed(1)} < ${RSI_PE_AUTO_EXIT}`, true);
        }
      }
    };

    const id = window.setInterval(checkAutoExits, WATCH_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active, liveRsi, exitPosition]);

  // Button enabled flags
  const ceStartEnabled = useMemo(() => {
    if (busy || cePosition != null || !parsedQty.ok || !ceCandidate) return false;
    return canSellCe(liveRsi, false);
  }, [busy, cePosition, parsedQty.ok, ceCandidate, liveRsi]);

  const peStartEnabled = useMemo(() => {
    if (busy || pePosition != null || !parsedQty.ok || !peCandidate) return false;
    return canSellPe(liveRsi, false);
  }, [busy, pePosition, parsedQty.ok, peCandidate, liveRsi]);

  const rsiToneClass = useMemo(() => {
    if (liveRsi == null) return "text-muted-foreground";
    if (liveRsi > 60) return "text-red-500 dark:text-red-400";
    if (liveRsi < 40) return "text-emerald-500 dark:text-emerald-400";
    return "text-cyan-500 dark:text-cyan-400";
  }, [liveRsi]);

  const rsiZoneLabel = useMemo(() => {
    if (liveRsi == null) return "CONNECTING";
    if (liveRsi > 60) return "OVERBOUGHT (SELL CE ZONE)";
    if (liveRsi < 40) return "OVERSOLD (SELL PE ZONE)";
    return "NEUTRAL ZONE (ARMED)";
  }, [liveRsi]);

  // RSI Trend delta (rising vs falling points from previous confirmed candle)
  const rsiDelta = useMemo(() => {
    if (candles.length < 2) return null;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const curr = liveRsi ?? last?.rsi;
    if (curr == null || prev?.rsi == null) return null;
    return curr - prev.rsi;
  }, [candles, liveRsi]);

  // Session RSI Min / Max extremes
  const rsiExtremes = useMemo(() => {
    const valid = candles.map((c) => c.rsi).filter((r): r is number => r != null && Number.isFinite(r));
    if (!valid.length) return { min: null, max: null };
    return {
      min: Math.min(...valid),
      max: Math.max(...valid),
    };
  }, [candles]);

  // Visible candles based on horizontal bar zoom
  const displayCandles = useMemo(() => {
    if (barZoom === "30") return candles.slice(-30);
    if (barZoom === "50") return candles.slice(-50);
    return candles;
  }, [candles, barZoom]);

  // Vertical scale range
  const { scaleMin, scaleMax } = useMemo(() => {
    if (scaleZoom === "full") return { scaleMin: 0, scaleMax: 100 };
    // Zoomed: Active strategy band 20 to 80 (or dynamically expanded if day range exceeds)
    const dayMin = rsiExtremes.min != null ? Math.min(20, Math.floor(rsiExtremes.min - 3)) : 20;
    const dayMax = rsiExtremes.max != null ? Math.max(80, Math.ceil(rsiExtremes.max + 3)) : 80;
    return { scaleMin: Math.max(0, dayMin), scaleMax: Math.min(100, dayMax) };
  }, [scaleZoom, rsiExtremes]);

  // Convert RSI to CSS percentage top (0% at top, 100% at bottom)
  const rsiToPct = useCallback(
    (rsi: number | null | undefined) => {
      if (rsi == null || !Number.isFinite(rsi)) return 50;
      const range = scaleMax - scaleMin;
      if (range <= 0) return 50;
      const topPct = ((scaleMax - rsi) / range) * 100;
      return Math.max(1, Math.min(99, topPct));
    },
    [scaleMin, scaleMax],
  );

  // Convert RSI to SVG Y coordinate (0 at top, 200 at bottom)
  const rsiToSvgY = useCallback(
    (rsi: number | null | undefined) => {
      if (rsi == null || !Number.isFinite(rsi)) return 100;
      const range = scaleMax - scaleMin;
      if (range <= 0) return 100;
      return 200 - ((rsi - scaleMin) / range) * 200;
    },
    [scaleMin, scaleMax],
  );

  // Visible signals matching displayed candles
  const displayStartSec = displayCandles.length ? displayCandles[0].time : 0;
  const visibleSignals = useMemo(() => {
    return signals.filter((s) => s.time >= displayStartSec - timeframe * 60);
  }, [signals, displayStartSec, timeframe]);

  // Active inspected candle for crosshair hover
  const activeInspectCandle = useMemo(() => {
    if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < displayCandles.length) {
      return displayCandles[hoverIdx];
    }
    return displayCandles.length ? displayCandles[displayCandles.length - 1] : null;
  }, [hoverIdx, displayCandles]);

  const heightClass =
    chartHeight === "max"
      ? "min-h-[420px] h-[450px]"
      : chartHeight === "tall"
        ? "min-h-[330px] h-[350px]"
        : "min-h-[250px] h-[270px]";

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[11px] sow-glass-shell">
      {/* Top Header Bar */}
      <div className="shrink-0 p-2.5 bg-card/90 border-b border-border/80 backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Timeframe pills + Wilder RSI Display */}
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1 bg-secondary/50 p-0.5 rounded-lg border border-border/70">
              <span className="text-[10px] uppercase font-bold text-muted-foreground px-1.5 flex items-center gap-1">
                <Clock className="w-3 h-3 text-cyan-500" /> TF
              </span>
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setTimeframe(tf)}
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold transition-all cursor-pointer ${
                    timeframe === tf
                      ? "bg-cyan-600 text-white shadow-sm font-bold scale-105"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  {tf}m
                </button>
              ))}
            </div>

            {/* Live Wilder RSI(14) Gauge Pill */}
            <div className="flex items-center gap-2.5 px-3 py-1 rounded-lg bg-card border border-border/80 shadow-xs">
              <Activity className="w-4 h-4 text-cyan-500 animate-pulse" />
              <div>
                <div className="flex items-center gap-1.5 leading-none">
                  <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Wilder RSI(14)</span>
                  <span className="text-[9px] px-1 py-0.2 rounded bg-cyan-500/20 text-cyan-600 dark:text-cyan-300 font-mono font-bold">
                    LIVE
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span className={`text-[17px] font-black font-mono tracking-tight ${rsiToneClass}`}>
                    {liveRsi != null ? liveRsi.toFixed(1) : "──"}
                  </span>
                  <span className="text-[9px] font-extrabold uppercase tracking-wider text-muted-foreground">
                    {rsiZoneLabel}
                  </span>
                </div>
              </div>
            </div>

            {/* Live NIFTY Spot Badge */}
            <div className="flex flex-col justify-center px-2.5 py-1 rounded-lg bg-secondary/50 border border-border/60 font-mono">
              <span className="text-[9px] font-bold text-muted-foreground uppercase">NIFTY Spot</span>
              <span className="text-[13px] font-black text-foreground">
                {liveSpotLtp != null ? fmtPrice(liveSpotLtp) : "──"}
              </span>
            </div>
          </div>

          {/* Right: Ratio Band selector, Qty, Sizing, Refresh */}
          <div className="flex items-center gap-2.5">
            {/* Ratio Band Selector */}
            <div className="flex items-center gap-1 bg-secondary/50 p-0.5 rounded-lg border border-border/70">
              <span className="text-[10px] text-muted-foreground px-1 font-bold">Band:</span>
              {RSI_RATIOS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRatio(r.id)}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                    ratio === r.id
                      ? "bg-blue-600 text-white shadow-sm font-black"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {/* Qty Input */}
            <div className="flex items-center gap-1 bg-secondary/50 px-2 py-1 rounded-lg border border-border/70">
              <span className="text-muted-foreground text-[10px] font-bold">Qty:</span>
              <input
                type="text"
                value={qtyText}
                onChange={(e) => setQtyText(e.target.value)}
                className="w-14 px-1 rounded bg-background border border-border text-right font-mono text-[11px] font-bold focus:outline-none focus:border-cyan-500"
              />
            </div>

            {/* Size Multipliers */}
            <div className="flex items-center gap-0.5 bg-secondary/50 p-0.5 rounded-lg border border-border/70">
              {SIZE_MULTS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSize(m)}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                    size === m
                      ? "bg-purple-600 text-white shadow-sm font-black"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m}x
                </button>
              ))}
            </div>

            {/* Order Lots pill */}
            {effectiveOrderQty != null && (
              <span className="text-[10px] font-mono px-2 py-1 rounded-lg bg-card text-foreground font-bold border border-border/70 shadow-2xs">
                {effectiveOrderQty} qty ({effectiveOrderQty / LOT_SIZE}L)
              </span>
            )}

            {/* Refresh Button */}
            <button
              type="button"
              onClick={fetchRsiData}
              title="Refresh Market & RSI"
              className="p-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground border border-border/60 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Command Center: CALL (CE) and PUT (PE) Decks */}
      <div className="shrink-0 p-3 bg-secondary/20 border-b border-border/60">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {/* CALL DESK (CE) */}
          <div className="bg-card border-2 border-red-500/30 rounded-xl p-3.5 shadow-sm flex flex-col justify-between">
            <div>
              {/* Header */}
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30">
                    <ArrowDownRight className="w-4 h-4 stroke-[2.5]" />
                  </span>
                  <div>
                    <h3 className="text-[13px] font-black text-red-700 dark:text-red-400 tracking-wide uppercase">
                      CALL DESK (CE)
                    </h3>
                    <span className="text-[10px] text-muted-foreground block font-medium">Bearish short entry when RSI ≤ 60.5</span>
                  </div>
                </div>

                {/* Arming Status Pill */}
                <div>
                  {cePosition ? (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-red-500/20 text-red-600 dark:text-red-300 border border-red-500/50 animate-pulse">
                      ● IN POSITION
                    </span>
                  ) : ceStartEnabled ? (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/50">
                      ✓ ARMED (RSI ≤ 60.5)
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-secondary text-muted-foreground border border-border/60">
                      ⏳ WAITING (RSI &gt; 60.5)
                    </span>
                  )}
                </div>
              </div>

              {/* Target Strike & Status Box */}
              <div className="p-2.5 rounded-lg bg-secondary/50 border border-border/80 mb-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-muted-foreground">Candidate Strike:</span>
                  <div className="text-right">
                    {ceCandidate ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[16px] font-black text-foreground tracking-tight">
                          {Math.round(ceCandidate.strike).toLocaleString("en-IN")} CE
                        </span>
                        <span className="text-[16px] font-mono font-black text-red-600 dark:text-red-400">
                          ₹{fmtPrice(ceCandidate.ltp)}
                        </span>
                        {!cePick?.inBand && (
                          <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/15 px-1.5 py-0.2 rounded border border-amber-500/30">
                            Closest
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground font-semibold">Scanning strikes…</span>
                    )}
                  </div>
                </div>

                {cePosition && (
                  <div className="pt-2 border-t border-border/70 grid grid-cols-3 gap-2 text-[11px]">
                    <div className="bg-card p-1.5 rounded border border-border/60">
                      <span className="text-muted-foreground text-[10px] block font-semibold">Short Fill</span>
                      <span className="font-mono font-extrabold text-[12px] text-foreground">₹{fmtPrice(cePosition.fill)}</span>
                    </div>
                    <div className="bg-card p-1.5 rounded border border-border/60">
                      <span className="text-muted-foreground text-[10px] block font-semibold">Current LTP</span>
                      <span className="font-mono font-extrabold text-[12px] text-foreground">
                        {ceLiveLtp ? `₹${fmtPrice(ceLiveLtp)}` : "──"}
                      </span>
                    </div>
                    <div className="bg-card p-1.5 rounded border border-border/60">
                      <span className="text-muted-foreground text-[10px] block font-semibold">CE P&amp;L (MTM)</span>
                      <span className={`font-mono font-black text-[13px] ${(ceMtm ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                        {ceMtm != null ? fmtPnl(ceMtm) : "──"}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between text-[10px] font-bold text-muted-foreground pt-0.5">
                  <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 font-mono">
                    <ShieldAlert className="w-3.5 h-3.5" /> Auto-Exit: RSI &gt; {RSI_CE_AUTO_EXIT}
                  </span>
                  <span>Arm Rule: RSI ≤ {RSI_CE_ARM_THRESHOLD}</span>
                </div>
              </div>
            </div>

            {/* Dedicated Action Buttons: START CE and EXIT CE */}
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                disabled={!ceStartEnabled}
                onClick={() => handleStartEntry("CE")}
                className={`py-2.5 px-3 rounded-lg font-black text-[13px] flex items-center justify-center gap-2 transition-all shadow-sm ${
                  ceStartEnabled
                    ? "bg-red-600 hover:bg-red-500 text-white shadow-red-600/30 cursor-pointer active:scale-95"
                    : "bg-secondary text-muted-foreground border border-border/60 !cursor-not-allowed opacity-45"
                }`}
              >
                <Play className="w-4 h-4 fill-current" />
                START CE
              </button>

              <button
                type="button"
                disabled={busy || !cePosition}
                onClick={() => exitPosition("CE", "Manual EXIT CE")}
                className={`py-2.5 px-3 rounded-lg font-black text-[13px] flex items-center justify-center gap-2 transition-all shadow-sm ${
                  cePosition
                    ? "bg-rose-700 hover:bg-rose-600 text-white shadow-rose-900/30 cursor-pointer active:scale-95 border border-rose-500"
                    : "bg-secondary/40 text-muted-foreground/60 border border-border/40 !cursor-not-allowed opacity-40"
                }`}
              >
                <Square className="w-4 h-4 fill-current" />
                EXIT CE
              </button>
            </div>
          </div>

          {/* PUT DESK (PE) */}
          <div className="bg-card border-2 border-emerald-500/30 rounded-xl p-3.5 shadow-sm flex flex-col justify-between">
            <div>
              {/* Header */}
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                    <ArrowUpRight className="w-4 h-4 stroke-[2.5]" />
                  </span>
                  <div>
                    <h3 className="text-[13px] font-black text-emerald-700 dark:text-emerald-400 tracking-wide uppercase">
                      PUT DESK (PE)
                    </h3>
                    <span className="text-[10px] text-muted-foreground block font-medium">Bullish short entry when RSI ≥ 39.5</span>
                  </div>
                </div>

                {/* Arming Status Pill */}
                <div>
                  {pePosition ? (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border border-emerald-500/50 animate-pulse">
                      ● IN POSITION
                    </span>
                  ) : peStartEnabled ? (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/50">
                      ✓ ARMED (RSI ≥ 39.5)
                    </span>
                  ) : (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-secondary text-muted-foreground border border-border/60">
                      ⏳ WAITING (RSI &lt; 39.5)
                    </span>
                  )}
                </div>
              </div>

              {/* Target Strike & Status Box */}
              <div className="p-2.5 rounded-lg bg-secondary/50 border border-border/80 mb-3 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold text-muted-foreground">Candidate Strike:</span>
                  <div className="text-right">
                    {peCandidate ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[16px] font-black text-foreground tracking-tight">
                          {Math.round(peCandidate.strike).toLocaleString("en-IN")} PE
                        </span>
                        <span className="text-[16px] font-mono font-black text-emerald-600 dark:text-emerald-400">
                          ₹{fmtPrice(peCandidate.ltp)}
                        </span>
                        {!pePick?.inBand && (
                          <span className="text-[9px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/15 px-1.5 py-0.2 rounded border border-amber-500/30">
                            Closest
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground font-semibold">Scanning strikes…</span>
                    )}
                  </div>
                </div>

                {pePosition && (
                  <div className="pt-2 border-t border-border/70 grid grid-cols-3 gap-2 text-[11px]">
                    <div className="bg-card p-1.5 rounded border border-border/60">
                      <span className="text-muted-foreground text-[10px] block font-semibold">Short Fill</span>
                      <span className="font-mono font-extrabold text-[12px] text-foreground">₹{fmtPrice(pePosition.fill)}</span>
                    </div>
                    <div className="bg-card p-1.5 rounded border border-border/60">
                      <span className="text-muted-foreground text-[10px] block font-semibold">Current LTP</span>
                      <span className="font-mono font-extrabold text-[12px] text-foreground">
                        {peLiveLtp ? `₹${fmtPrice(peLiveLtp)}` : "──"}
                      </span>
                    </div>
                    <div className="bg-card p-1.5 rounded border border-border/60">
                      <span className="text-muted-foreground text-[10px] block font-semibold">PE P&amp;L (MTM)</span>
                      <span className={`font-mono font-black text-[13px] ${(peMtm ?? 0) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                        {peMtm != null ? fmtPnl(peMtm) : "──"}
                      </span>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between text-[10px] font-bold text-muted-foreground pt-0.5">
                  <span className="text-amber-600 dark:text-amber-400 flex items-center gap-1 font-mono">
                    <ShieldAlert className="w-3.5 h-3.5" /> Auto-Exit: RSI &lt; {RSI_PE_AUTO_EXIT}
                  </span>
                  <span>Arm Rule: RSI ≥ {RSI_PE_ARM_THRESHOLD}</span>
                </div>
              </div>
            </div>

            {/* Dedicated Action Buttons: START PE and EXIT PE */}
            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                disabled={!peStartEnabled}
                onClick={() => handleStartEntry("PE")}
                className={`py-2.5 px-3 rounded-lg font-black text-[13px] flex items-center justify-center gap-2 transition-all shadow-sm ${
                  peStartEnabled
                    ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-600/30 cursor-pointer active:scale-95"
                    : "bg-secondary text-muted-foreground border border-border/60 !cursor-not-allowed opacity-45"
                }`}
              >
                <Play className="w-4 h-4 fill-current" />
                START PE
              </button>

              <button
                type="button"
                disabled={busy || !pePosition}
                onClick={() => exitPosition("PE", "Manual EXIT PE")}
                className={`py-2.5 px-3 rounded-lg font-black text-[13px] flex items-center justify-center gap-2 transition-all shadow-sm ${
                  pePosition
                    ? "bg-rose-700 hover:bg-rose-600 text-white shadow-rose-900/30 cursor-pointer active:scale-95 border border-rose-500"
                    : "bg-secondary/40 text-muted-foreground/60 border border-border/40 !cursor-not-allowed opacity-40"
                }`}
              >
                <Square className="w-4 h-4 fill-current" />
                EXIT PE
              </button>
            </div>
          </div>
        </div>

        {/* Global Strategy Status & Square All Bar */}
        <div className="mt-3 flex items-center justify-between px-3.5 py-2 rounded-xl bg-card border border-border/80 shadow-xs">
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-extrabold uppercase text-muted-foreground flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-cyan-600 dark:text-cyan-400" /> Combined Strategy MTM:
            </span>
            <span className={`text-[17px] font-black font-mono tracking-tight ${totalMtm >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
              {fmtPnl(totalMtm)}
            </span>
            <span className="text-[11px] text-muted-foreground font-semibold">
              (CE: <span className="font-mono text-foreground">{ceMtm != null ? fmtPnl(ceMtm) : "₹0"}</span> | PE:{" "}
              <span className="font-mono text-foreground">{peMtm != null ? fmtPnl(peMtm) : "₹0"}</span>)
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || (!cePosition && !pePosition)}
              onClick={handleSquareAll}
              className="px-5 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-black text-[12px] transition-all shadow-sm hover:shadow-amber-600/30 disabled:opacity-40 !disabled:cursor-not-allowed cursor-pointer flex items-center gap-1.5 active:scale-95"
            >
              <AlertOctagon className="w-4 h-4" />
              SQUARE ALL
            </button>
          </div>
        </div>
      </div>

      {/* Lower Deck: RSI Trend Chart (Left) + Activity Log (Right) */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden bg-background/40">
        {/* Left: Professional Interactive RSI Chart */}
        <div className="flex-1 min-h-0 flex flex-col p-3 border-r border-border/60 overflow-hidden">
          {/* Chart Header & Interactive Inspector Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2 px-1">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-500" />
              <span className="text-[12px] uppercase font-black text-foreground tracking-wide">
                WILDER RSI(14) OSCILLATOR ({timeframe}m SPOT CANDLES)
              </span>
            </div>

            {/* Chart Zoom & View Scaling Controls */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Vertical Scale Zoom (20-80 Zoom vs 0-100 Full) */}
              <div className="flex items-center gap-0.5 bg-secondary/60 p-0.5 rounded-lg border border-border/70 text-[10px]">
                <span className="text-muted-foreground px-1 font-bold">Scale:</span>
                <button
                  type="button"
                  onClick={() => setScaleZoom("zoomed")}
                  title="Zoom into 20-80 active trading range"
                  className={`px-1.5 py-0.5 rounded font-black cursor-pointer transition-all ${
                    scaleZoom === "zoomed"
                      ? "bg-cyan-600 text-white shadow-xs font-black"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  20-80 Zoom
                </button>
                <button
                  type="button"
                  onClick={() => setScaleZoom("full")}
                  title="Full 0-100 range"
                  className={`px-1.5 py-0.5 rounded font-bold cursor-pointer transition-all ${
                    scaleZoom === "full"
                      ? "bg-cyan-600 text-white shadow-xs font-black"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                  }`}
                >
                  0-100 Full
                </button>
              </div>

              {/* Horizontal Bar Zoom (30 / 50 / All) */}
              <div className="flex items-center gap-0.5 bg-secondary/60 p-0.5 rounded-lg border border-border/70 text-[10px]">
                <span className="text-muted-foreground px-1 font-bold">Bars:</span>
                {(["30", "50", "all"] as const).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBarZoom(b)}
                    className={`px-1.5 py-0.5 rounded font-bold cursor-pointer transition-all ${
                      barZoom === b
                        ? "bg-blue-600 text-white shadow-xs font-black"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                    }`}
                  >
                    {b === "all" ? "All" : `${b}`}
                  </button>
                ))}
              </div>

              {/* Height Selector (Normal / Tall / Max) */}
              <div className="flex items-center gap-0.5 bg-secondary/60 p-0.5 rounded-lg border border-border/70 text-[10px]">
                <span className="text-muted-foreground px-1 font-bold">Height:</span>
                <button
                  type="button"
                  onClick={() => setChartHeight("normal")}
                  className={`px-1.5 py-0.5 rounded font-bold cursor-pointer ${
                    chartHeight === "normal"
                      ? "bg-purple-600 text-white shadow-xs font-black"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Std
                </button>
                <button
                  type="button"
                  onClick={() => setChartHeight("tall")}
                  className={`px-1.5 py-0.5 rounded font-bold cursor-pointer ${
                    chartHeight === "tall"
                      ? "bg-purple-600 text-white shadow-xs font-black"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Tall
                </button>
                <button
                  type="button"
                  onClick={() => setChartHeight("max")}
                  className={`px-1.5 py-0.5 rounded font-bold cursor-pointer ${
                    chartHeight === "max"
                      ? "bg-purple-600 text-white shadow-xs font-black"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Max
                </button>
              </div>

              {/* Hover Inspector Tooltip / Live Status Readout */}
              {activeInspectCandle ? (
                <div className="flex items-center gap-2 bg-secondary/90 px-2 py-0.5 rounded-md border border-border/80 font-bold shadow-2xs text-[10px] font-mono">
                  <span className="text-muted-foreground">[{formatCandleTime(activeInspectCandle.time)}]</span>
                  <span>
                    Spot: <span className="text-foreground font-black">₹{fmtPrice(activeInspectCandle.close)}</span>
                  </span>
                  <span>
                    RSI:{" "}
                    <span
                      className={`font-black ${
                        activeInspectCandle.rsi != null && activeInspectCandle.rsi > 60
                          ? "text-red-500"
                          : activeInspectCandle.rsi != null && activeInspectCandle.rsi < 40
                            ? "text-emerald-500"
                            : "text-cyan-500"
                      }`}
                    >
                      {activeInspectCandle.rsi != null ? activeInspectCandle.rsi.toFixed(1) : "──"}
                    </span>
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {/* RSI Live Intelligence & Strategy Context Bar */}
          <div className="mb-2 p-2 rounded-lg bg-card border border-border/80 flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono shadow-2xs">
            {/* Left: Trend & Zone Status */}
            <div className="flex items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded font-black flex items-center gap-1 ${
                  liveRsi != null && liveRsi > 60
                    ? "bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/40"
                    : liveRsi != null && liveRsi < 40
                      ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/40"
                      : "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border border-cyan-500/30"
                }`}
              >
                ● {rsiZoneLabel}
              </span>

              {rsiDelta != null && (
                <span
                  className={`font-black flex items-center gap-0.5 ${
                    rsiDelta > 0 ? "text-emerald-600 dark:text-emerald-400" : rsiDelta < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
                  }`}
                >
                  {rsiDelta > 0 ? `▲ +${rsiDelta.toFixed(1)} pts` : rsiDelta < 0 ? `▼ ${rsiDelta.toFixed(1)} pts` : "─ Flat"}
                </span>
              )}
            </div>

            {/* Center: Distance to Action Triggers */}
            <div className="flex items-center gap-3 text-muted-foreground font-semibold">
              <span>
                To 60 CE Sell:{" "}
                <span className="font-bold text-foreground font-mono">
                  {liveRsi != null ? (liveRsi >= 60 ? "TRIGGER ACTIVE" : `${(60 - liveRsi).toFixed(1)} pts away`) : "──"}
                </span>
              </span>
              <span>•</span>
              <span>
                To 40 PE Sell:{" "}
                <span className="font-bold text-foreground font-mono">
                  {liveRsi != null ? (liveRsi <= 40 ? "TRIGGER ACTIVE" : `${(liveRsi - 40).toFixed(1)} pts away`) : "──"}
                </span>
              </span>
            </div>

            {/* Right: Session High / Low Extremes */}
            <div className="flex items-center gap-2 text-muted-foreground">
              <span>
                Day Low: <span className="font-bold text-emerald-600 dark:text-emerald-400">{rsiExtremes.min != null ? rsiExtremes.min.toFixed(1) : "──"}</span>
              </span>
              <span>|</span>
              <span>
                Day High: <span className="font-bold text-red-600 dark:text-red-400">{rsiExtremes.max != null ? rsiExtremes.max.toFixed(1) : "──"}</span>
              </span>
            </div>
          </div>

          {/* Main Chart Card: Zoomed Plot Area + Staggered Y-Axis Strip */}
          <div className={`flex-1 ${heightClass} w-full rounded-xl bg-card border border-border/80 shadow-xs flex flex-col justify-between overflow-hidden relative transition-all duration-200`}>
            <div className="flex-1 flex min-h-0 relative">
              {/* SVG Vector Plot Area */}
              <div
                className="flex-1 min-w-0 h-full relative cursor-crosshair overflow-hidden"
                onMouseMove={(e) => {
                  if (!displayCandles.length) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                  const idx = Math.round((relX / rect.width) * (displayCandles.length - 1));
                  setHoverIdx(idx);
                }}
                onMouseLeave={() => setHoverIdx(null)}
              >
                {/* Horizontal Background Zones with Subtle Watermarks */}
                {/* Overbought Zone (60 - 100) */}
                <div
                  className="absolute inset-x-0 top-0 bg-red-500/[0.04] border-b border-red-500/25 pointer-events-none"
                  style={{ height: `${rsiToPct(60)}%` }}
                >
                  <span className="absolute top-2 left-3 text-[9px] font-black text-red-500/35 uppercase tracking-widest select-none">
                    Bearish Reversal Zone (Sell CE Area)
                  </span>
                </div>

                {/* Neutral Channel (40 - 60) */}
                <div
                  className="absolute inset-x-0 bg-cyan-500/[0.02] border-b border-emerald-500/25 pointer-events-none"
                  style={{ top: `${rsiToPct(60)}%`, height: `${rsiToPct(40) - rsiToPct(60)}%` }}
                >
                  <span className="absolute top-1/2 -translate-y-1/2 left-3 text-[9px] font-black text-muted-foreground/25 uppercase tracking-widest select-none">
                    Neutral Consolidation Channel (40 - 60)
                  </span>
                </div>

                {/* Oversold Zone (0 - 40) */}
                <div
                  className="absolute inset-x-0 bottom-0 bg-emerald-500/[0.04] pointer-events-none"
                  style={{ top: `${rsiToPct(40)}%`, height: `${100 - rsiToPct(40)}%` }}
                >
                  <span className="absolute bottom-2 left-3 text-[9px] font-black text-emerald-500/35 uppercase tracking-widest select-none">
                    Bullish Reversal Zone (Sell PE Area)
                  </span>
                </div>

                {/* Reference Guideline Lines (Clean, Crisp, Non-Overlapping) */}
                {/* 63 CE Auto-Exit Line */}
                <div
                  className="absolute inset-x-0 border-t border-dotted border-amber-500/70 pointer-events-none"
                  style={{ top: `${rsiToPct(63)}%` }}
                />

                {/* 60 CE Sell Line */}
                <div
                  className="absolute inset-x-0 border-t border-dashed border-red-500/80 pointer-events-none"
                  style={{ top: `${rsiToPct(60)}%` }}
                />

                {/* 50 Center Guideline */}
                <div
                  className="absolute inset-x-0 border-t border-dotted border-border/80 pointer-events-none"
                  style={{ top: `${rsiToPct(50)}%` }}
                />

                {/* 40 PE Sell Line */}
                <div
                  className="absolute inset-x-0 border-t border-dashed border-emerald-500/80 pointer-events-none"
                  style={{ top: `${rsiToPct(40)}%` }}
                />

                {/* 37 PE Auto-Exit Line */}
                <div
                  className="absolute inset-x-0 border-t border-dotted border-amber-500/70 pointer-events-none"
                  style={{ top: `${rsiToPct(37)}%` }}
                />

                {/* Real-time Live RSI Tracking Line */}
                {liveRsi != null && (
                  <div
                    className="absolute inset-x-0 border-t border-dashed border-cyan-400/80 pointer-events-none transition-all duration-300 z-10"
                    style={{ top: `${rsiToPct(liveRsi)}%` }}
                  />
                )}

                {/* SVG Curves & Vectors with 6% Right Padding to prevent touching axis border */}
                {displayCandles.length > 0 && (
                  <svg className="w-full h-full overflow-visible pointer-events-none" viewBox="0 0 1000 200" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="rsiWaveGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="#0284c7" stopOpacity="0.35" />
                        <stop offset="50%" stopColor="#0284c7" stopOpacity="0.12" />
                        <stop offset="100%" stopColor="#0284c7" stopOpacity="0.01" />
                      </linearGradient>
                    </defs>

                    {(() => {
                      const valid = displayCandles
                        .map((c, i) => ({
                          x: (i / Math.max(1, displayCandles.length - 1)) * 940,
                          y: c.rsi != null ? rsiToSvgY(c.rsi) : null,
                        }))
                        .filter((pt) => pt.y != null) as { x: number; y: number }[];
                      if (valid.length < 2) return null;
                      const ptsStr = valid.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
                      const areaStr = `${valid[0].x.toFixed(1)},200 ${ptsStr} ${valid[valid.length - 1].x.toFixed(1)},200`;
                      const tip = valid[valid.length - 1];
                      return (
                        <>
                          <polygon fill="url(#rsiWaveGrad)" points={areaStr} />
                          <polyline fill="none" stroke="#0284c7" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" points={ptsStr} />
                          {/* Pulsing Live Point with ample breathing space */}
                          <circle cx={tip.x} cy={tip.y} r="10" fill="#0284c7" opacity="0.3" className="animate-ping" />
                          <circle cx={tip.x} cy={tip.y} r="6.5" fill="#38bdf8" stroke="#ffffff" strokeWidth="2" />
                        </>
                      );
                    })()}

                    {/* Signal Crossover Markers on Curve */}
                    {visibleSignals.map((sig, idx) => {
                      const candleIdx = displayCandles.findIndex((c) => Math.abs(c.time - sig.time) < timeframe * 60);
                      if (candleIdx < 0) return null;
                      const x = (candleIdx / Math.max(1, displayCandles.length - 1)) * 940;
                      const y = rsiToSvgY(sig.rsi);
                      const isCe = sig.type === "CE_SELL";
                      return (
                        <g key={idx} transform={`translate(${x}, ${y})`}>
                          <circle r="8" fill={isCe ? "#dc2626" : "#059669"} stroke="#ffffff" strokeWidth="2" />
                          <path
                            d={isCe ? "M -3 -1 L 3 -1 L 0 3 Z" : "M -3 1 L 3 1 L 0 -3 Z"}
                            fill="#ffffff"
                          />
                        </g>
                      );
                    })}
                  </svg>
                )}

                {/* HTML Signal Chips Over Markers */}
                {visibleSignals.map((sig, idx) => {
                  const candleIdx = displayCandles.findIndex((c) => Math.abs(c.time - sig.time) < timeframe * 60);
                  if (candleIdx < 0) return null;
                  const leftPct = (candleIdx / Math.max(1, displayCandles.length - 1)) * 94;
                  const topPct = rsiToPct(sig.rsi);
                  const isCe = sig.type === "CE_SELL";
                  return (
                    <div
                      key={idx}
                      className="absolute -translate-x-1/2 pointer-events-none z-10"
                      style={{
                        left: `${leftPct}%`,
                        top: isCe ? `calc(${topPct}% - 24px)` : `calc(${topPct}% + 10px)`,
                      }}
                    >
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-black shadow-md border flex items-center gap-0.5 whitespace-nowrap ${
                          isCe ? "bg-red-600 text-white border-red-400" : "bg-emerald-600 text-white border-emerald-400"
                        }`}
                      >
                        {isCe ? "▼ SELL CE" : "▲ SELL PE"}
                      </span>
                    </div>
                  );
                })}

                {/* Vertical Crosshair Line on Mouse Move */}
                {hoverIdx != null && hoverIdx >= 0 && hoverIdx < displayCandles.length && (
                  <div
                    className="absolute top-0 bottom-0 border-l border-cyan-500/80 pointer-events-none z-20"
                    style={{ left: `${(hoverIdx / Math.max(1, displayCandles.length - 1)) * 94}%` }}
                  />
                )}
              </div>

              {/* Dedicated HTML Y-Axis Strip with Staggered 2-Column Layout & Generous 16px Left Spacing */}
              <div className="w-[140px] shrink-0 border-l border-border/80 bg-secondary/30 relative select-none font-mono">
                {/* Scale Max Extreme */}
                <div className="absolute right-3 -translate-y-1/2 text-[9px] font-bold text-muted-foreground/60" style={{ top: "4%" }}>
                  {scaleMax} {scaleMax >= 80 ? "OB" : ""}
                </div>

                {/* 63 Exit CE Tag (Anchored to the RIGHT) */}
                <div
                  className="absolute right-3 -translate-y-1/2 flex items-center z-10"
                  style={{ top: `${rsiToPct(63)}%` }}
                >
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/50 shadow-2xs whitespace-nowrap">
                    63.0 EXIT
                  </span>
                </div>

                {/* 60 Sell CE Tag (Anchored with 16px Left Spacing from Divider) */}
                <div
                  className="absolute left-4 -translate-y-1/2 flex items-center z-10"
                  style={{ top: `${rsiToPct(60)}%` }}
                >
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-red-500/20 text-red-600 dark:text-red-400 border border-red-500/50 shadow-2xs whitespace-nowrap">
                    60.0 SELL
                  </span>
                </div>

                {/* 50 Center Reference */}
                <div
                  className="absolute left-4 -translate-y-1/2 flex items-center"
                  style={{ top: `${rsiToPct(50)}%` }}
                >
                  <span className="text-[9px] font-bold text-muted-foreground">
                    50.0 MID
                  </span>
                </div>

                {/* 40 Sell PE Tag (Anchored with 16px Left Spacing from Divider) */}
                <div
                  className="absolute left-4 -translate-y-1/2 flex items-center z-10"
                  style={{ top: `${rsiToPct(40)}%` }}
                >
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border border-emerald-500/50 shadow-2xs whitespace-nowrap">
                    40.0 SELL
                  </span>
                </div>

                {/* 37 Exit PE Tag (Anchored to the RIGHT) */}
                <div
                  className="absolute right-3 -translate-y-1/2 flex items-center z-10"
                  style={{ top: `${rsiToPct(37)}%` }}
                >
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/50 shadow-2xs whitespace-nowrap">
                    37.0 EXIT
                  </span>
                </div>

                {/* Scale Min Extreme */}
                <div className="absolute right-3 -translate-y-1/2 text-[9px] font-bold text-muted-foreground/60" style={{ top: "96%" }}>
                  {scaleMin} {scaleMin <= 20 ? "OS" : ""}
                </div>

                {/* Dynamic Real-time Live RSI Badge with comfortable 12px Left Clearance */}
                {liveRsi != null && (
                  <div
                    className="absolute left-3 right-3 -translate-y-1/2 z-30 flex items-center justify-center transition-all duration-300"
                    style={{ top: `${rsiToPct(liveRsi)}%` }}
                  >
                    <span className="w-full text-center px-1.5 py-0.5 rounded text-[11px] font-black bg-cyan-600 text-white shadow-xl border border-cyan-300 ring-2 ring-cyan-500/40">
                      ◀ {liveRsi.toFixed(1)} LIVE
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Bottom X-Axis Time Row */}
            <div className="h-6 border-t border-border/80 bg-secondary/20 flex items-center justify-between px-3 text-[9px] font-mono text-muted-foreground select-none">
              <div className="flex-1 flex items-center justify-between pr-8">
                {displayCandles.length > 0 ? (
                  [0, 0.2, 0.4, 0.6, 0.8, 1.0].map((pct, idx) => {
                    const cIdx = Math.round(pct * (displayCandles.length - 1));
                    const c = displayCandles[cIdx];
                    return (
                      <span key={idx}>
                        {c ? formatCandleTime(c.time) : "--:--"}
                      </span>
                    );
                  })
                ) : (
                  <span>Session Timeline</span>
                )}
              </div>
              <span className="w-[140px] text-right font-bold text-foreground">
                {scaleZoom === "zoomed" ? "ZOOM 20-80" : "FULL 0-100"}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Strategy Activity & Audit Log */}
        <div className="w-full md:w-[320px] flex flex-col p-3 min-h-0 bg-card/40">
          <div className="flex items-center justify-between mb-2 px-1">
            <span className="text-[11px] uppercase font-extrabold text-foreground flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-cyan-500" /> Activity &amp; Audit Log
            </span>
            <button
              type="button"
              onClick={() => setLogs([])}
              className="text-[10px] text-muted-foreground hover:text-foreground font-semibold cursor-pointer underline"
            >
              Clear
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 font-mono text-[10px] p-2.5 bg-card border border-border/80 rounded-xl shadow-2xs">
            {logs.length === 0 ? (
              <div className="text-muted-foreground p-4 text-center text-[11px] font-medium">
                No orders yet. Click <span className="font-bold text-red-600 dark:text-red-400">START CE</span> or{" "}
                <span className="font-bold text-emerald-600 dark:text-emerald-400">START PE</span> to enter short.
              </div>
            ) : (
              logs.map((log) => {
                const color =
                  log.kind === "entry"
                    ? "text-emerald-700 dark:text-emerald-300 font-bold"
                    : log.kind === "auto_exit"
                      ? "text-amber-700 dark:text-amber-300 font-black"
                      : log.kind === "exit"
                        ? "text-cyan-700 dark:text-cyan-300 font-bold"
                        : log.kind === "error"
                          ? "text-red-600 dark:text-red-400 font-black"
                          : "text-muted-foreground";
                const timeStr = new Date(log.ts).toLocaleTimeString("en-IN", { hour12: false });
                return (
                  <div key={log.id} className="p-1 rounded hover:bg-secondary/40 border-b border-border/30 leading-snug">
                    <span className="text-muted-foreground font-semibold mr-1.5">[{timeStr}]</span>
                    <span className={color}>{log.text}</span>
                  </div>
                );
              })
            )}
          </div>

          {signals.length > 0 && (
            <div className="mt-2.5 pt-1.5 border-t border-border/60 text-[10px] text-muted-foreground flex items-center justify-between font-mono">
              <span className="font-semibold">Last Closed Signal:</span>
              <span className="font-black text-foreground">
                {signals[signals.length - 1].type} @ RSI {signals[signals.length - 1].rsi.toFixed(1)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
