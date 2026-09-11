import { useMemo, useState, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { RefreshCw, Filter, Plus, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { apiFetch } from "@/lib/backend";
import {
  bumpPositionsRefresh,
  fetchIxOrderBook,
  fetchIxPositions,
  fetchIxTradeBook,
  POSITIONS_REFRESH_EVENT,
} from "@/lib/ixPortfolio";
import { useLiveAtp, useLiveLtp } from "@/context/LiveLtpContext";
import { XTS_IX_ORDER_BASE, ixOrderPricing } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import { fmtPnl, fmtPrice, fmtQty } from "@/lib/formatNumber";
import { openTradeBookPdf, summarizeDayPnl } from "@/lib/tradeBookPdf";

type PositionExitKind = "sl" | "tgt" | "manual";

const TABS = ["Positions", "Order Book", "Trade Book"];

/** XTS portfolio snapshot often trails fills; coalesced reload after orders. */

type AnyObj = Record<string, any>;

/** `draftPx` = box while editing; `px` = committed trigger level (used only when `armed`). */
type PxWatch = {
  px: string;
  draftPx: string;
  armed: boolean;
  busy: boolean;
  lastMsg?: string;
};
type WatchState = Record<number, { sl: PxWatch; tgt: PxWatch }>;
type AddLotsState = Record<number, { lots: number }>;

/** Signed net qty; align with LeftPanel MTM (use open buy/sell when net fields are still zero). */
function computePositionNetQty(row: AnyObj): number {
  const qtyRaw =
    num(row.NetPosition ?? row.netPosition ?? row.Quantity ?? row.quantity) ??
    ((num(row.LongPosition) ?? 0) - (num(row.ShortPosition) ?? 0));
  const obq = num(row.OpenBuyQuantity ?? row.openBuyQuantity) ?? 0;
  const osq = num(row.OpenSellQuantity ?? row.openSellQuantity) ?? 0;
  const q =
    qtyRaw != null && Number.isFinite(qtyRaw) && qtyRaw !== 0 ? qtyRaw : obq - osq;
  return typeof q === "number" && Number.isFinite(q) ? q : 0;
}

/** Broker average fill — same basis as the Avg. Price column. */
function averageEntryPx(row: AnyObj): number | null {
  const netQty = computePositionNetQty(row);
  if (!netQty) return null;
  const buyAvg = num(row.BuyAveragePrice ?? row.buyAvgPrice ?? row.BuyAvgPrice);
  const sellAvg = num(row.SellAveragePrice ?? row.sellAvgPrice ?? row.SellAvgPrice);
  const fallback = num(row.AveragePrice ?? row.avgPrice);
  const avg =
    netQty < 0
      ? (sellAvg ?? buyAvg ?? fallback)
      : netQty > 0
        ? (buyAvg ?? sellAvg ?? fallback)
        : (buyAvg ?? sellAvg ?? fallback);
  return avg != null && Number.isFinite(avg) && avg > 0 ? avg : null;
}

function resolveAutoSlEntryPx(
  pending: { streamEntryPx: number | null },
  row: AnyObj,
): number | null {
  const streamPx = pending.streamEntryPx;
  if (streamPx != null && streamPx > 0) return streamPx;
  return averageEntryPx(row);
}

function computeAutoSlPxFromEntry(entryPx: number, netQty: number, slPct: number): string | null {
  const pct = Number(slPct);
  if (!(Number.isFinite(entryPx) && entryPx > 0 && Number.isFinite(netQty) && netQty !== 0 && Number.isFinite(pct) && pct >= 0)) return null;
  const mult = pct / 100;
  const sl = netQty < 0 ? entryPx * (1 + mult) : entryPx * (1 - mult);
  if (!(Number.isFinite(sl) && sl > 0)) return null;
  return sl.toFixed(2);
}

/** SL watcher uses stream LTP; fall back to broker row so hits are not missed when MD lags. */
function resolvePositionRowLtp(row: AnyObj, iid: number, ltps: Record<number, number>): number | null {
  const live = ltps[iid];
  if (typeof live === "number" && Number.isFinite(live) && live > 0) return live;
  const broker = num(
    row.LastTradePrice ??
      row.lastTradePrice ??
      row.LastTradedPrice ??
      row.lastTradedPrice ??
      row.ltp,
  );
  return broker != null && broker > 0 ? broker : null;
}

/** Previous LTP per instrument for Mace SL cross detection (shared across sell/buy sections). */
const slWatchPrevLtpRef: { current: Record<number, number> } = { current: {} };

function computeWatchSlHit(
  w: { sl: PxWatch },
  netQty: number,
  ltp: number,
  iid: number,
): boolean {
  const slPx = num(w.sl.px);
  if (!w.sl.armed || slPx == null) return false;
  slWatchPrevLtpRef.current[iid] = ltp;
  return netQty < 0 ? ltp >= slPx : ltp <= slPx;
}

/** Place exit order for an open position leg. */
async function placeExitAndWaitFlat(row: AnyObj, ltpHint?: number | null): Promise<boolean> {
  const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
  const seg = segToId(row.ExchangeSegment ?? row.exchangeSegment);
  const netQty = computePositionNetQty(row);
  if (iid == null || seg == null || !netQty) return false;
  const side = netQty < 0 ? "BUY" : "SELL";
  const qty = Math.abs(netQty);
  const productType = String(row.ProductType ?? row.productType ?? "NRML");
  const brokerLtp = num(
    row.LastTradePrice ??
      row.lastTradePrice ??
      row.LastTradedPrice ??
      row.lastTradedPrice ??
      row.ltp,
  );
  const ltp = typeof ltpHint === "number" && ltpHint > 0 ? ltpHint : brokerLtp;
  await apiFetch("/api/ix/place_order", {
    method: "POST",
    body: JSON.stringify({
      ...XTS_IX_ORDER_BASE,
      ...ixOrderPricing(side, ltp),
      exchangeSegment: seg,
      exchangeInstrumentID: iid,
      orderSide: side,
      orderQuantity: qty,
      productType,
    }),
  });
  bumpPositionsRefresh();
  return true;
}


/** Take-profit from same entry basis as SL: short profits when LTP falls; long when LTP rises. */
function computeAutoTgtPxFromEntry(entryPx: number, netQty: number, tgtPct: number): string | null {
  const pct = Number(tgtPct);
  if (!(Number.isFinite(entryPx) && entryPx > 0 && Number.isFinite(netQty) && netQty !== 0 && Number.isFinite(pct) && pct > 0)) return null;
  const mult = pct / 100;
  const tgt = netQty < 0 ? entryPx * (1 - mult) : entryPx * (1 + mult);
  if (!(Number.isFinite(tgt) && tgt > 0)) return null;
  return tgt.toFixed(2);
}

function useOrderPanelQty(defaultQty = 20) {
  const [qty, setQty] = useState<number>(defaultQty);
  useEffect(() => {
    const onQty = (ev: Event) => {
      const ce = ev as CustomEvent<{ qty?: number }>;
      const q = ce?.detail?.qty;
      if (typeof q === "number" && Number.isFinite(q) && q > 0) setQty(q);
    };
    window.addEventListener("sow:order_qty", onQty as EventListener);
    return () => window.removeEventListener("sow:order_qty", onQty as EventListener);
  }, []);
  return qty;
}

function segToId(seg: unknown): number | null {
  const s = String(seg ?? "").trim().toUpperCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const map: Record<string, number> = { NSECM: 1, NSEFO: 2, NSECD: 3, BSECM: 11, BSEFO: 12, MCXFO: 51 };
  return map[s] ?? null;
}

function extractOpenPosInstruments(rows: AnyObj[]): { exchangeSegment: number; exchangeInstrumentID: number }[] {
  const out: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
  const seen = new Set<string>();
  for (const r of rows || []) {
    const iid = num(r.ExchangeInstrumentID ?? r.ExchangeInstrumentId ?? r.exchangeInstrumentID);
    const seg = segToId(r.ExchangeSegment ?? r.exchangeSegment);
    if (iid == null || iid <= 0 || seg == null || seg <= 0) continue;
    const key = `${seg}:${iid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ exchangeSegment: seg, exchangeInstrumentID: iid });
  }
  return out;
}

function useSubscribeOpenPositions(rows: AnyObj[]) {
  const openInstruments = useMemo(() => extractOpenPosInstruments(rows), [rows]);
  useEffect(() => {
    if (!openInstruments.length) return;
    let cancelled = false;
    void (async () => {
      const { subscribeMdTouchline } = await import("@/lib/mdRegistry");
      const { seedAtpFromRest } = await import("@/lib/atpSeed");
      await subscribeMdTouchline(openInstruments, () => cancelled);
      if (!cancelled) void seedAtpFromRest(openInstruments, () => cancelled);
    })();
    return () => {
      cancelled = true;
    };
  }, [openInstruments]);
}

function asArray(x: any): any[] {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    const inner = x.result ?? x.Result ?? x.data ?? x.Data;
    if (Array.isArray(inner)) return inner;
    // XTS interactive positions commonly return { result: { positionList: [...] } }
    const posList = inner?.positionList ?? inner?.PositionList ?? x.positionList ?? x.PositionList;
    if (Array.isArray(posList)) return posList;
  }
  return [];
}

function num(x: any): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const n = Number(x.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/* ── Reusable quantity-fraction button group ─────────────────── */
function QtyButtons({ qty, small = false }: { qty: number; small?: boolean }) {
  const cls = small
    ? "px-1 py-0.5 text-[9px] border border-border rounded hover:bg-accent transition-colors text-foreground"
    : "px-1 py-0.5 text-[9px] border border-border rounded hover:bg-accent transition-colors text-foreground";
  return (
    <div className="flex items-center gap-0.5">
      <button className={cls}>{qty}</button>
    </div>
  );
}

/* ── PnL display cell ────────────────────────────────────────── */
function PnlCell({ pnl }: { pnl: number }) {
  const color = pnl > 0 ? "text-cd-green" : pnl < 0 ? "text-red-400" : "text-foreground";
  return (
    <td className={`text-center px-1 py-1 font-semibold font-mono tabular-nums ${color}`}>
      {fmtPnl(pnl)}
    </td>
  );
}

function PositionRow({
  r,
  watch,
  onWatchChange,
  onApplyWatch,
  onDisarm,
  onExitNow,
  addLots,
  lotSize,
  onAddLotsChange,
  onAddNow,
}: {
  r: AnyObj;
  watch?: { sl: PxWatch; tgt: PxWatch };
  onWatchChange: (kind: "sl" | "tgt", draftPx: string) => void;
  onApplyWatch: (kind: "sl" | "tgt") => void;
  onDisarm: (kind: "sl" | "tgt") => void;
  onExitNow: () => void;
  addLots: number;
  lotSize: number;
  onAddLotsChange: (lots: number) => void;
  onAddNow: () => void;
}) {
  const ltps = useLiveLtp();
  const iid = num(r.ExchangeInstrumentID ?? r.ExchangeInstrumentId ?? r.exchangeInstrumentID);
  const ltpLive = iid != null ? ltps[iid] : undefined;
  const netQty = computePositionNetQty(r);
  const buyAvg = num(r.BuyAveragePrice ?? r.buyAvgPrice ?? r.BuyAvgPrice);
  const sellAvg = num(r.SellAveragePrice ?? r.sellAvgPrice ?? r.SellAvgPrice);
  // For correct PnL: shorts should use SellAveragePrice, longs should use BuyAveragePrice.
  const avg =
    netQty < 0
      ? (sellAvg ?? buyAvg ?? num(r.AveragePrice ?? r.avgPrice) ?? 0)
      : netQty > 0
        ? (buyAvg ?? sellAvg ?? num(r.AveragePrice ?? r.avgPrice) ?? 0)
        : (buyAvg ?? sellAvg ?? num(r.AveragePrice ?? r.avgPrice) ?? 0);
  const ltpBroker = num(
    (r as any).LastTradePrice ??
      (r as any).lastTradePrice ??
      (r as any).LastTradedPrice ??
      (r as any).lastTradedPrice ??
      (r as any).LastTradedPrice ??
      (r as any).ltp,
  );
  const ltp =
    typeof ltpLive === "number" && Number.isFinite(ltpLive)
      ? ltpLive
      : (ltpBroker ?? num(r.LastTradedPrice) ?? num(r.ltp) ?? 0);
  // Prefer broker-computed MTM when it is meaningful; keys vary across builds (some include spaces).
  const mtmBroker = num(
    (r as any).MTM ??
      (r as any).MarkToMarket ??
      (r as any).markToMarket ??
      (r as any)["Mark To Market"] ??
      (r as any)["MarkToMarket "] ??
      (r as any).UnrealizedMTM ??
      (r as any).unrealizedMTM ??
      (r as any)["Actual Mark To Market"] ??
      (r as any).ActualMarkToMarket ??
      (r as any).actualMarkToMarket ??
      (r as any).ActualMTM ??
      (r as any).actualMTM,
  );
  // XTS terminal MTM matches: (ActualSellAmount - ActualBuyAmount) + (NetQty * LTP)
  // (falls back to NetAmount/NetValue when Actual* not present).
  const actualSellAmt = num(r.ActualSellAmount ?? r.actualSellAmount);
  const actualBuyAmt = num(r.ActualBuyAmount ?? r.actualBuyAmount);
  const mtmFromActual =
    actualSellAmt != null && actualBuyAmt != null && Number.isFinite(ltp) && netQty
      ? (actualSellAmt - actualBuyAmt) + netQty * ltp
      : null;
  const netAmount = num(r.NetAmount ?? r.NetValue ?? r.netAmount ?? r.netValue);
  const mtmFromNetAmount = netAmount != null && Number.isFinite(ltp) && netQty ? netAmount + netQty * ltp : null;
  const derived = netQty && avg ? (ltp - avg) * netQty : 0;
  const pnl =
    mtmBroker != null && Math.abs(mtmBroker) > 1e-9
      ? mtmBroker
      : mtmFromActual != null
        ? mtmFromActual
        : mtmFromNetAmount != null
          ? mtmFromNetAmount
          : derived;
  return (
    <tr className="border-b border-border/40 hover:bg-accent/30">
      <td className="px-1 py-1"><input type="checkbox" className="w-3 h-3" /></td>
      <td className="text-center px-1 py-1">{String(r.TradingSymbol ?? r.tradingSymbol ?? r.Symbol ?? r.symbol ?? "—")}</td>
      <td className={`text-center px-1 py-1 font-semibold ${netQty < 0 ? "text-red-500" : "text-green-500"}`}>{fmtQty(netQty)}</td>
      <td className="text-center px-1 py-1 font-mono tabular-nums">{fmtPrice(ltp)}</td>
      <td className="text-center px-1 py-1 font-mono tabular-nums">{fmtPrice(avg)}</td>
      <PnlCell pnl={pnl} />
      {/* SL */}
      <td className="text-center px-1 py-1">
        <div className="flex items-center gap-0.5 justify-center">
          <input
            value={watch?.sl?.armed ? (watch?.sl?.px ?? "") : (watch?.sl?.draftPx ?? "")}
            onChange={(e) => onWatchChange("sl", e.target.value)}
            readOnly={!!watch?.sl?.armed}
            title={watch?.sl?.armed ? "DISARM to edit SL" : "Type SL price, then APPLY"}
            placeholder="SL"
            className="w-[54px] bg-input border border-border rounded px-1 py-0.5 text-[10px] font-mono tabular-nums read-only:opacity-80"
          />
          {watch?.sl?.armed ? (
            <button
              type="button"
              className="px-1 py-0.5 text-[11px] bg-gray-600 text-white rounded cursor-pointer disabled:cursor-not-allowed"
              onClick={() => onDisarm("sl")}
              disabled={watch?.sl?.busy}
            >
              DISARM
            </button>
          ) : (
            <button
              type="button"
              className="px-1 py-0.5 text-[11px] bg-emerald-700 hover:bg-emerald-600 text-white rounded cursor-pointer disabled:cursor-not-allowed"
              onClick={() => onApplyWatch("sl")}
              disabled={watch?.sl?.busy}
            >
              APPLY
            </button>
          )}
        </div>
      </td>
      {/* Target */}
      <td className="text-center px-1 py-1">
        <div className="flex items-center gap-0.5 justify-center">
          <input
            value={watch?.tgt?.armed ? (watch?.tgt?.px ?? "") : (watch?.tgt?.draftPx ?? "")}
            onChange={(e) => onWatchChange("tgt", e.target.value)}
            readOnly={!!watch?.tgt?.armed}
            title={watch?.tgt?.armed ? "DISARM to edit target" : "Type target price, then APPLY"}
            placeholder="TGT"
            className="w-[54px] bg-input border border-border rounded px-1 py-0.5 text-[10px] font-mono tabular-nums read-only:opacity-80"
          />
          {watch?.tgt?.armed ? (
            <button
              type="button"
              className="px-1 py-0.5 text-[11px] bg-gray-600 text-white rounded cursor-pointer disabled:cursor-not-allowed"
              onClick={() => onDisarm("tgt")}
              disabled={watch?.tgt?.busy}
            >
              DISARM
            </button>
          ) : (
            <button
              type="button"
              className="px-1 py-0.5 text-[11px] bg-emerald-700 hover:bg-emerald-600 text-white rounded cursor-pointer disabled:cursor-not-allowed"
              onClick={() => onApplyWatch("tgt")}
              disabled={watch?.tgt?.busy}
            >
              APPLY
            </button>
          )}
        </div>
      </td>
      <td className="text-center px-1 py-1">
        <div className="flex items-center gap-1 justify-center">
          <input
            type="number"
            min={1}
            step={1}
            value={addLots}
            onChange={(e) => onAddLotsChange(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
            className="w-[40px] bg-input border border-border rounded px-1 py-0.5 text-[10px] text-center font-mono tabular-nums"
            title="Lots"
          />
          <span className="text-[11px] text-muted-foreground font-mono tabular-nums" title="Contracts">
            {Math.max(1, addLots) * Math.max(1, lotSize)}
          </span>
          <button
            type="button"
            className="px-1 py-0.5 text-[11px] bg-green-700 hover:bg-green-600 text-white rounded cursor-pointer disabled:cursor-not-allowed"
            onClick={onAddNow}
          >
            ADD
          </button>
        </div>
      </td>
      <td className="text-center px-1 py-1">
        <button
          type="button"
          className="px-1.5 py-0.5 text-[11px] bg-red-700 hover:bg-red-600 text-white rounded cursor-pointer disabled:cursor-not-allowed"
          onClick={onExitNow}
          disabled={watch?.sl?.busy || watch?.tgt?.busy}
        >
          EXIT
        </button>
      </td>
    </tr>
  );
}

const POS_TABLE_HEADERS = ["Symbol","Qty","LTP","Avg. Price","PnL","SL","Target","Add","Exit"];

/* ── Open positions section ──────────────────────────────────── */
function SellPositionsSection() {
  const [expanded, setExpanded] = useState(true);
  const [rows, setRows] = useState<AnyObj[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const ltps = useLiveLtp();
  const atps = useLiveAtp();
  const [watchMap, setWatchMap] = useState<WatchState>({});
  const watchMapRef = useRef(watchMap);
  watchMapRef.current = watchMap;
  const [addLotsMap, setAddLotsMap] = useState<AddLotsState>({});
  const orderPanelQty = useOrderPanelQty(20);
  const [pendingAutoSl, setPendingAutoSl] = useState<
    Record<
      number,
      {
        slPct: number;
        tgtPct: number | null;
        streamEntryPx: number | null;
      }
    >
  >({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        setErr(null);
        const resp = (await fetchIxPositions("NetWise")) as AnyObj;
        const arr = asArray(resp?.raw) || asArray(resp);
        if (!cancelled) {
          if (Boolean(resp?.stale) && arr.length === 0) return;
          setRows(arr);
          setErr(null);
        }
      } catch {
        /* keep last rows — rate-limit / broker errors must not wipe MTM */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    const onRefresh = () => setRefreshKey((k) => k + 1);
    window.addEventListener(POSITIONS_REFRESH_EVENT, onRefresh as EventListener);
    return () => window.removeEventListener(POSITIONS_REFRESH_EVENT, onRefresh as EventListener);
  }, []);

  useEffect(() => {
    const onAutoSl = (ev: Event) => {
      const ce = ev as CustomEvent<{
        exchangeInstrumentID?: number;
        slPct?: number;
        tgtPct?: number;
        entryPx?: number | null;
      }>;
      const iid = num(ce?.detail?.exchangeInstrumentID);
      if (iid == null) return;
      const pct = num(ce?.detail?.slPct);
      if (pct == null) return;
      const streamEntryPx = num(ce?.detail?.entryPx);
      const tgtPctRaw = num(ce?.detail?.tgtPct);
      const tgtPct = tgtPctRaw != null && tgtPctRaw > 0 ? tgtPctRaw : null;
      setPendingAutoSl((prev) => ({
        ...prev,
        [iid]: { slPct: pct, tgtPct, streamEntryPx },
      }));
    };
    window.addEventListener("sow:auto_sl", onAutoSl as EventListener);
    return () => window.removeEventListener("sow:auto_sl", onAutoSl as EventListener);
  }, []);

  const openRows = useMemo(() => rows.filter((r) => computePositionNetQty(r) < 0), [rows]);
  useSubscribeOpenPositions(openRows);

  useEffect(() => {
    const entries = Object.entries(pendingAutoSl);
    if (!entries.length) return;
    for (const row of openRows) {
      const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
      if (iid == null) continue;
      const pending = pendingAutoSl[iid];
      if (!pending) continue;

      const existing = watchMap[iid]?.sl?.px;
      const hasExistingSl = !!(existing && String(existing).trim() !== "");
      if (hasExistingSl) {
        setPendingAutoSl((p) => {
          const { [iid]: _, ...rest } = p;
          return rest;
        });
        continue;
      }

      const netQty = computePositionNetQty(row);
      const entryForSl = resolveAutoSlEntryPx(pending, row);
      if (entryForSl == null) continue;
      const px = computeAutoSlPxFromEntry(entryForSl, netQty, pending.slPct);
      if (!px) continue;

      const tgtPctNum = pending.tgtPct;
      const tgtPx =
        tgtPctNum != null && tgtPctNum > 0 && entryForSl != null
          ? computeAutoTgtPxFromEntry(entryForSl, netQty, tgtPctNum)
          : null;

      setWatchMap((prev) => {
        const cur = prev[iid] ?? {
          sl: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
          tgt: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
        };
        const existingTgt = cur.tgt?.px && String(cur.tgt.px).trim() !== "";
        const nextTgt =
          tgtPx && !existingTgt ? { ...cur.tgt, px: tgtPx, draftPx: tgtPx, armed: true } : cur.tgt;
        return {
          ...prev,
          [iid]: {
            ...cur,
            sl: {
              ...cur.sl,
              px,
              draftPx: px,
              armed: true,
            },
            tgt: nextTgt,
          },
        };
      });
      setPendingAutoSl((p) => {
        const { [iid]: _, ...rest } = p;
        return rest;
      });
    }
  }, [pendingAutoSl, openRows, watchMap, ltps]);

  const exitOrder = async (
    row: AnyObj,
    exitKind: PositionExitKind = "manual",
    quote?: { slPx?: number; ltp?: number },
  ): Promise<boolean> => {
    const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
    if (iid == null) return false;
    try {
      const ok = await placeExitAndWaitFlat(row, quote?.ltp ?? resolvePositionRowLtp(row, iid, ltps));
      if (ok && (exitKind === "sl" || exitKind === "tgt")) return ok;
      return ok;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const title = exitKind === "sl" ? "SL exit failed (will retry)" : "Exit failed";
      toast({ title, description: msg, variant: "destructive" });
      return false;
    }
  };

  const addOrder = async (row: AnyObj, lots: number) => {
    const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
    const seg = segToId(row.ExchangeSegment ?? row.exchangeSegment);
    const netQty = computePositionNetQty(row);
    const lotSz = num(row.Marketlot ?? row.MarketLot ?? row.marketlot) ?? 0;
    if (iid == null || seg == null || lotSz <= 0) return;
    const side = netQty < 0 ? "SELL" : "BUY"; // add same direction
    const qty = Math.max(1, Math.floor(lots)) * lotSz;
    const productType = String(row.ProductType ?? row.productType ?? "NRML");
    try {
      await apiFetch("/api/ix/place_order", {
        method: "POST",
        body: JSON.stringify({
          ...XTS_IX_ORDER_BASE,
          ...ixOrderPricing(side, resolvePositionRowLtp(row, iid, ltps)),
          exchangeSegment: seg,
          exchangeInstrumentID: iid,
          orderSide: side,
          orderQuantity: qty,
          productType,
        }),
      });
      toast({
        title: "Add order sent",
        description: `${side} ${qty} (Lots ${Math.max(1, Math.floor(lots))})`,
      });
      bumpPositionsRefresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Add failed", description: msg, variant: "destructive" });
      throw e;
    }
  };

  const setDraftPx = (iid: number, kind: "sl" | "tgt", draftPx: string) => {
    setWatchMap((prev) => {
      const cur = prev[iid] ?? {
        sl: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
        tgt: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
      };
      return { ...prev, [iid]: { ...cur, [kind]: { ...cur[kind], draftPx } } };
    });
  };

  const applyWatch = (iid: number, kind: "sl" | "tgt") => {
    const cur = watchMapRef.current[iid] ?? {
      sl: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
      tgt: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
    };
    const raw = String(cur[kind].draftPx ?? "").trim();
    const pxNum = num(raw);
    if (pxNum == null || !(pxNum > 0)) {
      toast({
        title: kind === "sl" ? "SL not applied" : "Target not applied",
        description: "Enter a valid price, then APPLY.",
        variant: "destructive",
      });
      return;
    }
    const px = pxNum.toFixed(2);
    setWatchMap((prev) => {
      const pr = prev[iid] ?? {
        sl: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
        tgt: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
      };
      return {
        ...prev,
        [iid]: {
          ...pr,
          [kind]: {
            ...pr[kind],
            px,
            draftPx: px,
            armed: true,

          },
        },
      };
    });
  };

  const disarm = (iid: number, kind: "sl" | "tgt") => {
    setWatchMap((prev) => {
      const cur = prev[iid];
      if (!cur) return prev;
      const w = cur[kind];
      return {
        ...prev,
        [iid]: {
          ...cur,
          [kind]: {
            ...w,
            armed: false,
            busy: false,
            draftPx: w.px || w.draftPx,

          },
        },
      };
    });
  };

  useEffect(() => {
    // Auto exit when armed SL/TGT hits.
    for (const row of openRows) {
      const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
      if (iid == null) continue;
      const w = watchMap[iid];
      if (!w) continue;
      const ltp = resolvePositionRowLtp(row, iid, ltps);
      if (ltp == null) continue;
      const netQty = computePositionNetQty(row);
      if (!netQty) continue;
      const slPx = num(w.sl.px);
      const tgtPx = num(w.tgt.px);
      const slHit = computeWatchSlHit(w, netQty, ltp, iid);
      const tgtHit = w.tgt.armed && tgtPx != null && (netQty < 0 ? ltp <= tgtPx : ltp >= tgtPx);
      if ((slHit && !w.sl.busy) || (tgtHit && !w.tgt.busy)) {
        const kind: "sl" | "tgt" = slHit ? "sl" : "tgt";
        setWatchMap((prev) => ({
          ...prev,
          [iid]: { ...prev[iid], [kind]: { ...prev[iid][kind], busy: true } },
        }));
        void (async () => {
          let ok = false;
          try {
            ok = await exitOrder(
              row,
              kind,
              kind === "sl" && slPx != null ? { slPx, ltp } : undefined,
            );
          } catch {
            ok = false;
          }
          setWatchMap((prev) => {
            const cur = prev[iid];
            if (!cur) return prev;
            if (!ok) {
              return {
                ...prev,
                [iid]: { ...cur, [kind]: { ...cur[kind], busy: false } },
              };
            }
            if (kind === "sl") {
              return {
                ...prev,
                [iid]: {
                  ...cur,
                  sl: { ...cur.sl, armed: false, busy: false },
                },
              };
            }
            return {
              ...prev,
              [iid]: {
                ...cur,
                sl: { ...cur.sl, armed: false, busy: false },
                tgt: { ...cur.tgt, armed: false, busy: false },
              },
            };
          });
        })();
      }
    }
  }, [openRows, watchMap, ltps, atps]);
  const pnlColor = "text-foreground";
  const totalValue = 0;
  const pnl = 0;
  return (
    <div className="sow-glass-positions-section">
      {/* Summary bar */}
      <div className="sow-glass-positions-section__head" onClick={() => setExpanded(v => !v)}>
        <span>Sell Positions</span>
        {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
      </div>
      {expanded && (
        <div className="sow-glass-positions-scroll overflow-x-auto">
          <table style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th className="w-5 px-1 py-1"></th>
                {POS_TABLE_HEADERS.map(c => (
                  <th key={c} className="text-center px-1 py-1 text-muted-foreground font-medium whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {err && rows.length === 0 && (
                <tr>
                  <td className="px-2 py-2 text-red-400 text-[10px]" colSpan={POS_TABLE_HEADERS.length + 1}>
                    {err}
                  </td>
                </tr>
              )}
              {openRows.map((r, i) => {
                  const iid = num(r.ExchangeInstrumentID ?? r.ExchangeInstrumentId ?? r.exchangeInstrumentID);
                  const w = iid != null ? watchMap[iid] : undefined;
                  const lotSz = num(r.Marketlot ?? r.MarketLot ?? r.marketlot) ?? 1;
                  const defaultLots = Math.max(1, Math.round(orderPanelQty / Math.max(1, lotSz)));
                  const lots = iid != null ? (addLotsMap[iid]?.lots ?? defaultLots) : defaultLots;
                  return (
                    <PositionRow
                      key={i}
                      r={r}
                      watch={w}
                      addLots={lots}
                      lotSize={Math.max(1, lotSz)}
                      onAddLotsChange={(nl) => {
                        if (iid == null) return;
                        setAddLotsMap((prev) => ({ ...prev, [iid]: { lots: Math.max(1, nl) } }));
                      }}
                      onAddNow={() => {
                        if (iid == null) return;
                        void addOrder(r, lots);
                      }}
                      onWatchChange={(kind, draftPx) => {
                        if (iid == null) return;
                        setDraftPx(iid, kind, draftPx);
                      }}
                      onApplyWatch={(kind) => {
                        if (iid == null) return;
                        applyWatch(iid, kind);
                      }}
                      onDisarm={(kind) => {
                        if (iid == null) return;
                        disarm(iid, kind);
                      }}
                      onExitNow={() => void exitOrder(r)}
                    />
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BoughtPositionsSection() {
  const [expanded, setExpanded] = useState(true);
  const [rows, setRows] = useState<AnyObj[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const ltps = useLiveLtp();
  const atps = useLiveAtp();
  const [watchMap, setWatchMap] = useState<WatchState>({});
  const watchMapRef = useRef(watchMap);
  watchMapRef.current = watchMap;
  const [addLotsMap, setAddLotsMap] = useState<AddLotsState>({});
  const orderPanelQty = useOrderPanelQty(20);
  const [pendingAutoSl, setPendingAutoSl] = useState<
    Record<
      number,
      {
        slPct: number;
        tgtPct: number | null;
        streamEntryPx: number | null;
      }
    >
  >({});
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = (await fetchIxPositions("NetWise")) as AnyObj;
        const arr = asArray(resp?.raw) || asArray(resp);
        if (!cancelled) {
          if (Boolean(resp?.stale) && arr.length === 0) return;
          setRows(arr);
        }
      } catch {
        /* keep last rows */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  useEffect(() => {
    const onRefresh = () => setRefreshKey((k) => k + 1);
    window.addEventListener(POSITIONS_REFRESH_EVENT, onRefresh as EventListener);
    return () => window.removeEventListener(POSITIONS_REFRESH_EVENT, onRefresh as EventListener);
  }, []);
  useEffect(() => {
    const onAutoSl = (ev: Event) => {
      const ce = ev as CustomEvent<{
        exchangeInstrumentID?: number;
        slPct?: number;
        tgtPct?: number;
        entryPx?: number | null;
      }>;
      const iid = num(ce?.detail?.exchangeInstrumentID);
      if (iid == null) return;
      const pct = num(ce?.detail?.slPct);
      if (pct == null) return;
      const streamEntryPx = num(ce?.detail?.entryPx);
      const tgtPctRaw = num(ce?.detail?.tgtPct);
      const tgtPct = tgtPctRaw != null && tgtPctRaw > 0 ? tgtPctRaw : null;
      setPendingAutoSl((prev) => ({
        ...prev,
        [iid]: { slPct: pct, tgtPct, streamEntryPx },
      }));
    };
    window.addEventListener("sow:auto_sl", onAutoSl as EventListener);
    return () => window.removeEventListener("sow:auto_sl", onAutoSl as EventListener);
  }, []);

  const openRows = useMemo(() => rows.filter((r) => computePositionNetQty(r) > 0), [rows]);
  useSubscribeOpenPositions(openRows);

  useEffect(() => {
    const entries = Object.entries(pendingAutoSl);
    if (!entries.length) return;
    for (const row of openRows) {
      const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
      if (iid == null) continue;
      const pending = pendingAutoSl[iid];
      if (!pending) continue;

      const existing = watchMap[iid]?.sl?.px;
      const hasExistingSl = !!(existing && String(existing).trim() !== "");
      if (hasExistingSl) {
        setPendingAutoSl((p) => {
          const { [iid]: _, ...rest } = p;
          return rest;
        });
        continue;
      }

      const netQty = computePositionNetQty(row);
      const entryForSl = resolveAutoSlEntryPx(pending, row);
      if (entryForSl == null) continue;
      const px = computeAutoSlPxFromEntry(entryForSl, netQty, pending.slPct);
      if (!px) continue;

      const tgtPctNum = pending.tgtPct;
      const tgtPx =
        tgtPctNum != null && tgtPctNum > 0 && entryForSl != null
          ? computeAutoTgtPxFromEntry(entryForSl, netQty, tgtPctNum)
          : null;

      setWatchMap((prev) => {
        const cur = prev[iid] ?? {
          sl: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
          tgt: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
        };
        const existingTgt = cur.tgt?.px && String(cur.tgt.px).trim() !== "";
        const nextTgt =
          tgtPx && !existingTgt ? { ...cur.tgt, px: tgtPx, draftPx: tgtPx, armed: true } : cur.tgt;
        return {
          ...prev,
          [iid]: {
            ...cur,
            sl: {
              ...cur.sl,
              px,
              draftPx: px,
              armed: true,
            },
            tgt: nextTgt,
          },
        };
      });
      setPendingAutoSl((p) => {
        const { [iid]: _, ...rest } = p;
        return rest;
      });
    }
  }, [pendingAutoSl, openRows, watchMap, ltps]);

  const exitOrder = async (
    row: AnyObj,
    exitKind: PositionExitKind = "manual",
    quote?: { slPx?: number; ltp?: number },
  ): Promise<boolean> => {
    const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
    if (iid == null) return false;
    try {
      const ok = await placeExitAndWaitFlat(row, quote?.ltp ?? resolvePositionRowLtp(row, iid, ltps));
      if (ok && (exitKind === "sl" || exitKind === "tgt")) return ok;
      return ok;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const title = exitKind === "sl" ? "SL exit failed (will retry)" : "Exit failed";
      toast({ title, description: msg, variant: "destructive" });
      return false;
    }
  };

  const addOrder = async (row: AnyObj, lots: number) => {
    const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
    const seg = segToId(row.ExchangeSegment ?? row.exchangeSegment);
    const netQty = computePositionNetQty(row);
    const lotSz = num(row.Marketlot ?? row.MarketLot ?? row.marketlot) ?? 0;
    if (iid == null || seg == null || lotSz <= 0) return;
    const side = netQty < 0 ? "SELL" : "BUY";
    const qty = Math.max(1, Math.floor(lots)) * lotSz;
    const productType = String(row.ProductType ?? row.productType ?? "NRML");
    try {
      await apiFetch("/api/ix/place_order", {
        method: "POST",
        body: JSON.stringify({
          ...XTS_IX_ORDER_BASE,
          ...ixOrderPricing(side, resolvePositionRowLtp(row, iid, ltps)),
          exchangeSegment: seg,
          exchangeInstrumentID: iid,
          orderSide: side,
          orderQuantity: qty,
          productType,
        }),
      });
      toast({
        title: "Add order sent",
        description: `${side} ${qty} (Lots ${Math.max(1, Math.floor(lots))})`,
      });
      bumpPositionsRefresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Add failed", description: msg, variant: "destructive" });
      throw e;
    }
  };

  const setDraftPx = (iid: number, kind: "sl" | "tgt", draftPx: string) => {
    setWatchMap((prev) => {
      const cur = prev[iid] ?? {
        sl: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
        tgt: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
      };
      return { ...prev, [iid]: { ...cur, [kind]: { ...cur[kind], draftPx } } };
    });
  };

  const applyWatch = (iid: number, kind: "sl" | "tgt") => {
    const cur = watchMapRef.current[iid] ?? {
      sl: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
      tgt: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
    };
    const raw = String(cur[kind].draftPx ?? "").trim();
    const pxNum = num(raw);
    if (pxNum == null || !(pxNum > 0)) {
      toast({
        title: kind === "sl" ? "SL not applied" : "Target not applied",
        description: "Enter a valid price, then APPLY.",
        variant: "destructive",
      });
      return;
    }
    const px = pxNum.toFixed(2);
    setWatchMap((prev) => {
      const pr = prev[iid] ?? {
        sl: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
        tgt: { px: "", draftPx: "", armed: false, busy: false } as PxWatch,
      };
      return {
        ...prev,
        [iid]: {
          ...pr,
          [kind]: {
            ...pr[kind],
            px,
            draftPx: px,
            armed: true,

          },
        },
      };
    });
  };

  const disarm = (iid: number, kind: "sl" | "tgt") => {
    setWatchMap((prev) => {
      const cur = prev[iid];
      if (!cur) return prev;
      const w = cur[kind];
      return {
        ...prev,
        [iid]: {
          ...cur,
          [kind]: {
            ...w,
            armed: false,
            busy: false,
            draftPx: w.px || w.draftPx,

          },
        },
      };
    });
  };

  useEffect(() => {
    for (const row of openRows) {
      const iid = num(row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID);
      if (iid == null) continue;
      const w = watchMap[iid];
      if (!w) continue;
      const ltp = resolvePositionRowLtp(row, iid, ltps);
      if (typeof ltp !== "number" || !Number.isFinite(ltp)) continue;
      const netQty = computePositionNetQty(row);
      if (!netQty) continue;
      const slPx = num(w.sl.px);
      const tgtPx = num(w.tgt.px);
      const slHit = computeWatchSlHit(w, netQty, ltp, iid);
      const tgtHit = w.tgt.armed && tgtPx != null && (netQty < 0 ? ltp <= tgtPx : ltp >= tgtPx);
      if ((slHit && !w.sl.busy) || (tgtHit && !w.tgt.busy)) {
        const kind: "sl" | "tgt" = slHit ? "sl" : "tgt";
        setWatchMap((prev) => ({
          ...prev,
          [iid]: { ...prev[iid], [kind]: { ...prev[iid][kind], busy: true } },
        }));
        void (async () => {
          let ok = false;
          try {
            ok = await exitOrder(
              row,
              kind,
              kind === "sl" && slPx != null ? { slPx, ltp } : undefined,
            );
          } catch {
            ok = false;
          }
          setWatchMap((prev) => {
            const cur = prev[iid];
            if (!cur) return prev;
            if (!ok) {
              return {
                ...prev,
                [iid]: { ...cur, [kind]: { ...cur[kind], busy: false } },
              };
            }
            if (kind === "sl") {
              return {
                ...prev,
                [iid]: {
                  ...cur,
                  sl: { ...cur.sl, armed: false, busy: false },
                },
              };
            }
            return {
              ...prev,
              [iid]: {
                ...cur,
                sl: { ...cur.sl, armed: false, busy: false },
                tgt: { ...cur.tgt, armed: false, busy: false },
              },
            };
          });
        })();
      }
    }
  }, [openRows, watchMap, ltps, atps]);
  const pnlColor = "text-foreground";
  const pnl = 0;
  return (
    <div className="sow-glass-positions-section">
      <div className="sow-glass-positions-section__head" onClick={() => setExpanded(v => !v)}>
        <span>Bought Positions</span>
        {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
      </div>
      {expanded && (
        <div className="sow-glass-positions-scroll overflow-x-auto">
          <table style={{ minWidth: 1000 }}>
            <thead>
              <tr>
                <th className="w-5 px-1 py-1"></th>
                {POS_TABLE_HEADERS.map(c => (
                  <th key={c} className="text-center px-1 py-1 text-muted-foreground font-medium whitespace-nowrap">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {openRows.map((r, i) => {
                const iid = num(r.ExchangeInstrumentID ?? r.ExchangeInstrumentId ?? r.exchangeInstrumentID);
                const w = iid != null ? watchMap[iid] : undefined;
                const lotSz = num(r.Marketlot ?? r.MarketLot ?? r.marketlot) ?? 1;
                const defaultLots = Math.max(1, Math.round(orderPanelQty / Math.max(1, lotSz)));
                const lots = iid != null ? (addLotsMap[iid]?.lots ?? defaultLots) : defaultLots;
                return (
                  <PositionRow
                    key={i}
                    r={r}
                    watch={w}
                    addLots={lots}
                    lotSize={Math.max(1, lotSz)}
                    onAddLotsChange={(nl) => {
                      if (iid == null) return;
                      setAddLotsMap((prev) => ({ ...prev, [iid]: { lots: Math.max(1, nl) } }));
                    }}
                    onAddNow={() => {
                      if (iid == null) return;
                      void addOrder(r, lots);
                    }}
                    onWatchChange={(kind, draftPx) => {
                      if (iid == null) return;
                      setDraftPx(iid, kind, draftPx);
                    }}
                    onApplyWatch={(kind) => {
                      if (iid == null) return;
                      applyWatch(iid, kind);
                    }}
                    onDisarm={(kind) => {
                      if (iid == null) return;
                      disarm(iid, kind);
                    }}
                    onExitNow={() => void exitOrder(r)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ClosedPositionsSection() {
  const [expanded, setExpanded] = useState(true);
  const [rows, setRows] = useState<AnyObj[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = (await fetchIxPositions("DayWise")) as AnyObj;
        const arr = asArray(resp?.raw) || asArray(resp);
        if (!cancelled) {
          if (Boolean(resp?.stale) && arr.length === 0) return;
          setRows(arr);
        }
      } catch {
        /* keep last rows */
      }
    };
    void load();
    const iv = window.setInterval(() => void load(), 90_000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);
  return (
    <div className="sow-glass-positions-section">
      <div className="sow-glass-positions-section__head" onClick={() => setExpanded(v => !v)}>
        <span>Closed Positions</span>
        {expanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
      </div>
      {expanded && (
        <div className="sow-glass-positions-scroll overflow-x-auto">
          <table style={{ minWidth: 700 }}>
            <thead>
              <tr>
                <th className="w-5 px-1 py-1"><input type="checkbox" className="w-3 h-3" /></th>
                <th className="text-left px-2 py-1 text-muted-foreground font-medium">Symbol</th>
                <th className="text-center px-2 py-1 text-muted-foreground font-medium">Qty</th>
                <th className="text-center px-2 py-1 text-muted-foreground font-medium">Sell Avg</th>
                <th className="text-center px-2 py-1 text-muted-foreground font-medium">Buy Avg</th>
                <th className="text-center px-2 py-1 text-muted-foreground font-medium">PnL</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-border/40 hover:bg-accent/30">
                  <td className="px-1 py-1.5"><input type="checkbox" className="w-3 h-3" /></td>
                  <td className="px-2 py-1.5 text-foreground">{String(r.TradingSymbol ?? r.Symbol ?? "—")}</td>
                  <td className="text-center px-2 py-1.5 text-foreground">{fmtQty(num(r.NetPosition ?? r.Quantity) ?? 0)}</td>
                  <td className="text-center px-2 py-1.5 text-foreground">{fmtPrice(num(r.SellAveragePrice))}</td>
                  <td className="text-center px-2 py-1.5 text-foreground">{fmtPrice(num(r.BuyAveragePrice))}</td>
                  <td className="text-center px-2 py-1.5 text-foreground">{fmtPnl(num(r.MTM ?? r.mtm ?? r.MarkToMarket))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const BOOK_PAGE_SIZES = [10, 15, 25, 50] as const;

function BookPaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const end = total === 0 ? 0 : Math.min(safePage * pageSize, total);

  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1.5 border-t border-border/40 text-[10px] text-muted-foreground flex-wrap">
      <span>
        {total === 0 ? "No records" : `${start}–${end} of ${total}`}
      </span>
      <div className="flex items-center gap-2 ml-auto">
        <label className="flex items-center gap-1">
          <span>Rows</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="bg-background/60 border border-border/50 rounded px-1 py-0.5 text-[10px] text-foreground"
          >
            {BOOK_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span>
          Page {safePage} / {totalPages}
        </span>
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
          className="p-0.5 rounded hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          title="Previous page"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)}
          className="p-0.5 rounded hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          title="Next page"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function useBookRows(endpoint: "/api/ix/orderbook" | "/api/ix/tradebook") {
  const [rows, setRows] = useState<AnyObj[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  const loadRows = async () => {
    try {
      const resp = (await (endpoint === "/api/ix/orderbook" ? fetchIxOrderBook() : fetchIxTradeBook())) as AnyObj;
      const arr = asArray(resp?.raw) || asArray(resp);
      setRows(arr);
      setPage(1);
    } catch {
      /* keep last rows */
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const resp = (await (endpoint === "/api/ix/orderbook" ? fetchIxOrderBook() : fetchIxTradeBook())) as AnyObj;
        const arr = asArray(resp?.raw) || asArray(resp);
        if (!cancelled) {
          setRows(arr);
          setPage(1);
        }
      } catch {
        /* keep last rows */
      }
    })();
    const onRefresh = () => {
      void loadRows();
    };
    window.addEventListener(POSITIONS_REFRESH_EVENT, onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener(POSITIONS_REFRESH_EVENT, onRefresh);
    };
  }, [endpoint]);

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

  return {
    rows: pageRows,
    allRows: rows,
    total: rows.length,
    page: safePage,
    pageSize,
    setPage,
    setPageSize: (size: number) => {
      setPageSize(size);
      setPage(1);
    },
  };
}

function OrderBookSection() {
  const { rows, total, page, pageSize, setPage, setPageSize } = useBookRows("/api/ix/orderbook");

  return (
    <div className="sow-glass-positions-section mx-2 mb-2">
      <div className="sow-glass-positions-section__head !cursor-default">
        <span>Order Book</span>
      </div>
      <div className="sow-glass-positions-scroll overflow-x-auto max-h-[420px] overflow-y-auto">
        <table style={{ minWidth: 900 }}>
          <thead>
            <tr>
              {["Symbol","Type","Order Side","Quantity","Rem Qty","Order Price","Status","Date"].map(c => (
                <th key={c} className="text-center px-2 py-1 text-muted-foreground font-medium whitespace-nowrap">
                  <span className="inline-flex items-center gap-0.5">{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">
                  No orders
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={String(r.AppOrderID ?? r.appOrderId ?? i)} className="border-b border-border/40 hover:bg-accent/30">
                  <td className="px-2 py-1.5 text-center whitespace-nowrap text-foreground">{String(r.TradingSymbol ?? r.tradingSymbol ?? "—")}</td>
                  <td className="px-2 py-1.5 text-center text-foreground">{String(r.OrderType ?? r.orderType ?? "—")}</td>
                  <td className={`px-2 py-1.5 text-center font-semibold ${String(r.OrderSide ?? r.orderSide ?? "").toUpperCase() === "BUY" ? "text-blue-500" : "text-red-500"}`}>{String(r.OrderSide ?? r.orderSide ?? "—")}</td>
                  <td className="px-2 py-1.5 text-center text-foreground">{String(r.OrderQuantity ?? r.orderQuantity ?? "—")}</td>
                  <td className="px-2 py-1.5 text-center text-foreground">{String(r.LeavesQuantity ?? r.leavesQuantity ?? "")}</td>
                  <td className="px-2 py-1.5 text-center text-foreground">{String(r.OrderPrice ?? r.orderPrice ?? "")}</td>
                  <td className="px-2 py-1.5 text-center text-green-500">{String(r.OrderStatus ?? r.orderStatus ?? "—")}</td>
                  <td className="px-2 py-1.5 text-center whitespace-nowrap text-foreground">{String(r.LastUpdateDateTime ?? r.LastUpdateTime ?? r.lastUpdateTime ?? "")}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <BookPaginationBar
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

function TradeBookSection() {
  const { rows, allRows, total, page, pageSize, setPage, setPageSize } = useBookRows("/api/ix/tradebook");
  const ltps = useLiveLtp();
  const [pdfBusy, setPdfBusy] = useState(false);
  const [posRows, setPosRows] = useState<AnyObj[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const net = (await fetchIxPositions("NetWise")) as AnyObj;
        const positions = asArray(net?.raw) || asArray(net);
        if (!cancelled) setPosRows(positions);
      } catch {
        /* keep last rows */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const daySplit = useMemo(() => summarizeDayPnl(posRows, ltps), [posRows, ltps]);

  const onPdf = async () => {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      let positions: AnyObj[] = [];
      try {
        const day = (await fetchIxPositions("DayWise")) as AnyObj;
        positions = asArray(day?.raw) || asArray(day);
        if (!positions.length) {
          const net = (await fetchIxPositions("NetWise")) as AnyObj;
          positions = asArray(net?.raw) || asArray(net);
        }
      } catch {
        positions = [];
      }
      if (!allRows.length && !positions.length) {
        toast({ title: "No trades", description: "Trade Book is empty — nothing to put in PDF." });
        return;
      }
        const { fileName } = openTradeBookPdf(allRows, { positions: positions.length ? positions : posRows, ltps });
      toast({ title: "Trade Book PDF", description: `${fileName} opened with today's P&L.` });
    } catch (e) {
      toast({
        title: "PDF failed",
        description: e instanceof Error ? e.message : "Could not open Trade Book PDF.",
        variant: "destructive",
      });
    } finally {
      setPdfBusy(false);
    }
  };

  return (
    <div className="sow-glass-positions-section mx-2 mb-2">
      <div className="sow-glass-positions-section__head !cursor-default">
        <span>Trade Book</span>
        <div className="ml-auto flex items-center gap-2 font-mono tabular-nums text-[10px] font-semibold">
          <span className="text-cd-green" title="Today plus (winning symbols)">
            {fmtPnl(daySplit.plus)}
          </span>
          <span className="text-red-400" title="Today minus (losing symbols)">
            {daySplit.minus === 0 ? "0.00" : fmtPnl(daySplit.minus)}
          </span>
          <span
            className={daySplit.total > 0 ? "text-cd-green" : daySplit.total < 0 ? "text-red-400" : "text-muted-foreground"}
            title="Net day P&L"
          >
            NET {fmtPnl(daySplit.total)}
          </span>
          <button
            type="button"
            onClick={() => void onPdf()}
            disabled={pdfBusy}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border border-border/50 text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors disabled:opacity-50"
            title="Open Trade Book PDF with day P&L"
          >
            <Download className="w-3 h-3" />
            {pdfBusy ? "PDF…" : "PDF"}
          </button>
        </div>
      </div>
      <div className="sow-glass-positions-scroll overflow-x-auto max-h-[420px] overflow-y-auto">
        <table style={{ minWidth: 900 }}>
          <thead>
            <tr>
              {["Symbol","Product Type","Order Side","Trade Price","Traded Quantity","Quantity","Order Status","Date"].map(c => (
                <th key={c} className="text-center px-2 py-1 text-muted-foreground font-medium whitespace-nowrap">
                  <span className="inline-flex items-center gap-0.5">{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-2 py-6 text-center text-muted-foreground">
                  No trades
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={String(r.ExecutionID ?? r.executionId ?? `${r.AppOrderID ?? i}-${i}`)} className="border-b border-border/40 hover:bg-accent/30">
                  <td className="px-2 py-1.5 text-center whitespace-nowrap text-foreground">{String(r.TradingSymbol ?? r.tradingSymbol ?? "—")}</td>
                  <td className="px-2 py-1.5 text-center text-foreground">{String(r.ExchangeSegment ?? r.exchangeSegment ?? "")}</td>
                  <td className={`px-2 py-1.5 text-center font-semibold ${String(r.OrderSide ?? r.orderSide ?? "").toUpperCase() === "BUY" ? "text-blue-500" : "text-red-500"}`}>{String(r.OrderSide ?? r.orderSide ?? "—")}</td>
                  <td className="px-2 py-1.5 text-center text-foreground">{String(r.LastTradedPrice ?? r.TradePrice ?? r.tradePrice ?? "")}</td>
                  <td className="px-2 py-1.5 text-center text-foreground">{String(r.LastTradedQuantity ?? r.TradedQuantity ?? r.tradedQty ?? "")}</td>
                  <td className="px-2 py-1.5 text-center text-foreground">{String(r.OrderQuantity ?? r.orderQuantity ?? "")}</td>
                  <td className="px-2 py-1.5 text-center text-green-500">{String(r.OrderStatus ?? r.orderStatus ?? "")}</td>
                  <td className="px-2 py-1.5 text-center whitespace-nowrap text-foreground text-[13px]">{String(r.LastExecutionTransactTime ?? r.ExchangeTransactTime ?? "")}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <BookPaginationBar
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

/* ── Main component ──────────────────────────────────────────── */
export default function PositionsTable() {
  const [activeTab, setActiveTab] = useState("Positions");
  const [paneOpen, setPaneOpen] = useState(false);
  const [posMode, setPosMode] = useState<"Open" | "Closed">("Open");
  const [pct, setPct] = useState("100%");

  const [orderCount, setOrderCount] = useState<number>(0);
  const [tradeCount, setTradeCount] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ob = (await fetchIxOrderBook()) as AnyObj;
        const arr = asArray(ob?.raw) || asArray(ob);
        if (!cancelled) setOrderCount(arr.length);
      } catch {
        /* keep last count — do not hit /orders/trades on every dashboard load */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col sow-glass-positions">
      {/* Tabs */}
      <div
        className="sow-glass-positions-tabs outline-none focus:outline-none focus-visible:outline-none"
        onClick={() => setPaneOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setPaneOpen((v) => !v);
          }
        }}
        role="button"
        tabIndex={0}
        title={paneOpen ? "Collapse positions" : "Expand positions"}
      >
        {TABS.map(tab => {
          const badge = tab === "Order Book" ? orderCount : tab === "Trade Book" ? tradeCount : null;
          return (
            <button
              key={tab}
              onClick={(e) => {
                e.stopPropagation();
                setActiveTab(tab);
                setPaneOpen((open) => (activeTab === tab ? !open : true));
              }}
              className={`flex cursor-pointer items-center gap-1 ${activeTab === tab ? "sow-glass-tab sow-glass-tab--active" : "sow-glass-tab"}`}
            >
              {tab}
              {badge !== null && (
                <span className="bg-blue-600 text-white rounded-full text-[9px] px-1.5 py-0.5 leading-none">{badge}</span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className="ml-auto mr-2 cursor-pointer p-1 text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh positions / books"
          onClick={(e) => {
            e.stopPropagation();
            bumpPositionsRefresh();
            void (async () => {
              try {
                const ob = (await fetchIxOrderBook()) as AnyObj;
                const arr = asArray(ob?.raw) || asArray(ob);
                setOrderCount(arr.length);
              } catch {
                /* keep last count */
              }
              try {
                const tb = (await fetchIxTradeBook()) as AnyObj;
                const arr = asArray(tb?.raw) || asArray(tb);
                setTradeCount(arr.length);
              } catch {
                /* keep last count */
              }
            })();
          }}
        >
          <RefreshCw className="w-3 h-3" />
        </button>
        <button
          type="button"
          className="sow-glass-positions-toggle"
          title={paneOpen ? "Collapse positions" : "Expand positions"}
          onClick={(e) => {
            e.stopPropagation();
            setPaneOpen((v) => !v);
          }}
        >
          {paneOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {paneOpen && activeTab === "Positions" && (
        <div className="px-2 py-2 space-y-2">
          {posMode === "Open" ? (
            <>
              <SellPositionsSection />
              <BoughtPositionsSection />
            </>
          ) : (
            <ClosedPositionsSection />
          )}
        </div>
      )}

      {paneOpen && activeTab === "Order Book" && <OrderBookSection />}
      {paneOpen && activeTab === "Trade Book" && <TradeBookSection />}
    </div>
  );
}
