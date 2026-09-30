import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainResolved } from "@/types/market";
import { peekLiveTick } from "@/context/LiveLtpContext";
import { FastLtp } from "@/components/FastLtp";
import { setHotFocus } from "@/lib/hotFocus";
import { peekTouchPx } from "@/lib/liveQuote";
import { fmtPnl, fmtPrice, fmtQty } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, clearLocalPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import { expectedLadderFill, ixOrderRejectedMessage, ladderOrderPricing, XTS_IX_ORDER_BASE } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import {
  DEFAULT_QTY,
  FLIP_RATIOS,
  LOT_SIZE,
  SIZE_MULTS,
  UNDERLYING,
  buttonLabel,
  isRatioId,
  isSizeMult,
  oppositeSide,
  orderQuantity,
  parseQty,
  pickHighestLtp,
  ratioById,
  shortMtm,
  type FlipSide,
  type RatioId,
  type SizeMult,
} from "@/lib/niftyFlipRules";

const SESSION_KEY = "sow_nifty_flip_v1";
const PREVIEW_MS = 150;

type FlipLog = { id: number; ts: number; text: string; kind: "entry" | "exit" | "error" | "info" };

type FlipPosition = {
  strike: number;
  side: FlipSide;
  qty: number;
  fill: number;
  iid: number;
  segment: number;
};

type SideQuote = { strike: number; ltp: number; iid: number };

type SessionBlob = {
  qtyText: string;
  ratio: RatioId;
  size: SizeMult;
  position: FlipPosition | null;
  logs: FlipLog[];
  logId: number;
};

function isNiftyChain(chain: ChainResolved): boolean {
  return String(chain.index || "").trim().toUpperCase() === UNDERLYING;
}

function positivePx(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sideQuotes(chain: ChainResolved, side: FlipSide): SideQuote[] {
  const out: SideQuote[] = [];
  for (const [key, inst] of Object.entries(chain.instrumentMap || {})) {
    const strike = Number(key);
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const iid = side === "CE" ? inst?.ce : inst?.pe;
    if (typeof iid !== "number" || !Number.isFinite(iid) || iid <= 0) continue;
    const ltp = peekTouchPx(iid);
    if (ltp == null || !(ltp > 0)) continue;
    out.push({ strike, ltp, iid });
  }
  return out;
}

function isSide(value: unknown): value is FlipSide {
  return value === "CE" || value === "PE";
}

function readPosition(raw: unknown): FlipPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<FlipPosition>;
  const strike = Number(row.strike);
  const qty = Number(row.qty);
  const fill = Number(row.fill);
  const iid = Number(row.iid);
  const segment = Number(row.segment);
  if (!isSide(row.side)) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isSafeInteger(qty) || qty <= 0 || qty % LOT_SIZE !== 0) return null;
  if (!Number.isFinite(fill) || fill <= 0) return null;
  if (!Number.isFinite(iid) || iid <= 0) return null;
  if (!Number.isFinite(segment) || segment <= 0) return null;
  return { strike, side: row.side, qty, fill, iid, segment };
}

function loadSession(): SessionBlob | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionBlob>;
    const qtyText = typeof parsed.qtyText === "string" ? parsed.qtyText : String(DEFAULT_QTY);
    const ratio = typeof parsed.ratio === "string" && isRatioId(parsed.ratio) ? parsed.ratio : "80-100";
    const size = typeof parsed.size === "number" && isSizeMult(parsed.size) ? parsed.size : 1;
    const logs = Array.isArray(parsed.logs)
      ? parsed.logs.filter(
          (row): row is FlipLog =>
            !!row &&
            typeof row === "object" &&
            typeof (row as FlipLog).id === "number" &&
            typeof (row as FlipLog).ts === "number" &&
            typeof (row as FlipLog).text === "string" &&
            ((row as FlipLog).kind === "entry" ||
              (row as FlipLog).kind === "exit" ||
              (row as FlipLog).kind === "error" ||
              (row as FlipLog).kind === "info"),
        )
      : [];
    const logId = logs.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    return { qtyText, ratio, size, position: readPosition(parsed.position), logs: logs.slice(0, 80), logId };
  } catch {
    return null;
  }
}

function rememberShort(chain: ChainResolved, pos: FlipPosition) {
  const expiry = chain.expiryApi ? ` ${chain.expiryApi}` : "";
  setLocalShortPosition({
    exchangeInstrumentID: pos.iid,
    exchangeSegment: pos.segment,
    qty: pos.qty,
    fillPx: pos.fill,
    tradingSymbol: `NIFTY${expiry} ${pos.strike} ${pos.side}`,
  });
}

export default function NiftyFlipPanel({ chain, active }: { chain: ChainResolved; active: boolean }) {
  const boot = useMemo(() => loadSession(), []);
  const [qtyText, setQtyText] = useState(boot?.qtyText ?? String(DEFAULT_QTY));
  const [ratio, setRatio] = useState<RatioId>(boot?.ratio ?? "80-100");
  const [size, setSize] = useState<SizeMult>(boot?.size ?? 1);
  const [position, setPosition] = useState<FlipPosition | null>(boot?.position ?? null);
  const [logs, setLogs] = useState<FlipLog[]>(boot?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [pulse, setPulse] = useState(0);

  const chainRef = useRef(chain);
  const qtyRef = useRef(qtyText);
  const ratioRef = useRef(ratio);
  const sizeRef = useRef(size);
  const positionRef = useRef(position);
  const busyRef = useRef(false);
  const logIdRef = useRef(boot?.logId ?? 1);
  const restoredRef = useRef(false);

  chainRef.current = chain;
  qtyRef.current = qtyText;
  ratioRef.current = ratio;
  sizeRef.current = size;
  positionRef.current = position;

  const nifty = isNiftyChain(chain);
  const parsed = parseQty(qtyText);
  const band = ratioById(ratio);
  const liveOrderQty = parsed.ok ? orderQuantity(parsed.qty, size) : null;

  const bullPick = useMemo(() => {
    if (!nifty) return null;
    return pickHighestLtp(sideQuotes(chain, "PE"), band.low, band.high);
  }, [nifty, chain, band.low, band.high, pulse]);

  const bearPick = useMemo(() => {
    if (!nifty) return null;
    return pickHighestLtp(sideQuotes(chain, "CE"), band.low, band.high);
  }, [nifty, chain, band.low, band.high, pulse]);

  const liveLtp = position ? peekTouchPx(position.iid) : null;
  const mtm = position && liveLtp != null ? shortMtm(position.fill, liveLtp, position.qty) : null;

  const pushLog = useCallback((text: string, kind: FlipLog["kind"]) => {
    const id = logIdRef.current++;
    setLogs((prev) => [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 80));
  }, []);

  const fail = useCallback(
    (text: string) => {
      pushLog(text, "error");
      toast({ title: "Nifty Flip", description: text, variant: "destructive" });
    },
    [pushLog],
  );

  useEffect(() => {
    if (!active) return;
    setPulse((n) => n + 1);
    const id = window.setInterval(() => setPulse((n) => n + 1), PREVIEW_MS);
    return () => window.clearInterval(id);
  }, [active]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const pos = positionRef.current;
    if (pos) rememberShort(chainRef.current, pos);
  }, []);

  useEffect(() => {
    const blob: SessionBlob = {
      qtyText,
      ratio,
      size,
      position,
      logs,
      logId: logIdRef.current,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(blob));
    } catch {
      /* ignore quota */
    }
  }, [qtyText, ratio, size, position, logs]);

  useEffect(() => {
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (segment: number, iid: number) => {
      if (!(segment > 0) || !(iid > 0) || seen.has(iid)) return;
      seen.add(iid);
      instruments.push({ exchangeSegment: segment, exchangeInstrumentID: iid });
    };
    if (position) add(position.segment, position.iid);
    if (active && nifty) {
      if (bullPick) add(chain.optionSegment, bullPick.iid);
      if (bearPick) add(chain.optionSegment, bearPick.iid);
    }
    setHotFocus("flip", instruments);
    return () => setHotFocus("flip", []);
  }, [active, nifty, chain.optionSegment, position, bullPick, bearPick]);

  const placeOrder = useCallback(async (side: "BUY" | "SELL", instrumentId: number, qty: number, segment: number) => {
    const tick = peekLiveTick(instrumentId);
    const ltp = peekTouchPx(instrumentId);
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
  }, []);

  const resetControls = useCallback(() => {
    setQtyText(String(DEFAULT_QTY));
    setRatio("80-100");
    setSize(1);
  }, []);

  const bookOpen = useCallback(
    async (pos: FlipPosition) => {
      const hint = await placeOrder("BUY", pos.iid, pos.qty, pos.segment);
      const bookPx =
        positivePx(expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask)) ??
        positivePx(peekTouchPx(pos.iid)) ??
        pos.fill;
      const bookedMtm = shortMtm(pos.fill, bookPx, pos.qty);
      clearLocalPosition(pos.iid, bookedMtm);
      const strike = Math.round(pos.strike).toLocaleString("en-IN");
      pushLog(
        `BUY ${strike} ${pos.side} × ${fmtQty(pos.qty)} @ ${fmtPrice(bookPx)} · MTM ${fmtPnl(bookedMtm)}`,
        "exit",
      );
      toast({
        title: "Nifty Flip booked",
        description: `${strike} ${pos.side} @ ${fmtPrice(bookPx)} · MTM ${fmtPnl(bookedMtm)}`,
      });
      return bookPx;
    },
    [placeOrder, pushLog],
  );

  const sellLocked = useCallback(
    async (pick: SideQuote, side: FlipSide, qty: number, ratioId: RatioId, sizeMult: SizeMult) => {
      const segment = chainRef.current.optionSegment;
      const hint = await placeOrder("SELL", pick.iid, qty, segment);
      const fill = positivePx(expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask)) ?? pick.ltp;
      const next: FlipPosition = {
        strike: pick.strike,
        side,
        qty,
        fill,
        iid: pick.iid,
        segment,
      };
      positionRef.current = next;
      setPosition(next);
      rememberShort(chainRef.current, next);
      const strike = Math.round(pick.strike).toLocaleString("en-IN");
      const label = ratioById(ratioId).label;
      pushLog(
        `SELL ${strike} ${side} × ${fmtQty(qty)} @ ${fmtPrice(fill)} · ratio ${label} · size ${sizeMult}x`,
        "entry",
      );
      toast({
        title: `Nifty Flip SELL ${side}`,
        description: `${strike} @ ${fmtPrice(fill)} · ${fmtQty(qty)}`,
      });
    },
    [placeOrder, pushLog],
  );

  const guardClick = useCallback((): { qty: number; ratioId: RatioId; sizeMult: SizeMult } | null => {
    if (busyRef.current) return null;
    if (!isNiftyChain(chainRef.current)) {
      fail("Nifty Flip trades NIFTY options only. Order refused.");
      return null;
    }
    if (!(chainRef.current.optionSegment > 0)) {
      fail("Missing option segment. Order not sent.");
      return null;
    }
    const parsedQty = parseQty(qtyRef.current);
    if (!parsedQty.ok) {
      fail(parsedQty.error);
      return null;
    }
    const sellQty = orderQuantity(parsedQty.qty, sizeRef.current);
    if (!Number.isSafeInteger(sellQty) || sellQty <= 0 || sellQty % LOT_SIZE !== 0) {
      fail("Order qty must be a positive multiple of 65.");
      return null;
    }
    return { qty: sellQty, ratioId: ratioRef.current, sizeMult: sizeRef.current };
  }, [fail]);

  const sellFresh = useCallback(
    async (side: FlipSide) => {
      if (busyRef.current) return;
      if (positionRef.current) {
        fail("A short is already open. Use Flip or Square All.");
        return;
      }
      const ready = guardClick();
      if (!ready) return;
      const bandNow = ratioById(ready.ratioId);
      const pick = pickHighestLtp(sideQuotes(chainRef.current, side), bandNow.low, bandNow.high);
      if (!pick) {
        fail(`No ${side} inside ${bandNow.label}. Order not sent.`);
        return;
      }
      const locked: SideQuote = { strike: pick.strike, ltp: pick.ltp, iid: pick.iid };
      busyRef.current = true;
      setBusy(true);
      try {
        await sellLocked(locked, side, ready.qty, ready.ratioId, ready.sizeMult);
      } catch (err: unknown) {
        fail(err instanceof Error ? err.message : String(err));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fail, guardClick, sellLocked],
  );

  const flip = useCallback(async () => {
    if (busyRef.current) return;
    const open = positionRef.current;
    if (!open) {
      fail("Flip works only when a short is already open.");
      return;
    }
    const ready = guardClick();
    if (!ready) return;
    const nextSide = oppositeSide(open.side);
    const bandNow = ratioById(ready.ratioId);
    const pick = pickHighestLtp(sideQuotes(chainRef.current, nextSide), bandNow.low, bandNow.high);
    if (!pick) {
      fail(`No ${nextSide} inside ${bandNow.label}. Open short not booked.`);
      return;
    }
    const locked: SideQuote = { strike: pick.strike, ltp: pick.ltp, iid: pick.iid };
    busyRef.current = true;
    setBusy(true);
    try {
      await bookOpen(open);
      positionRef.current = null;
      setPosition(null);
    } catch (err: unknown) {
      fail(`Book failed. Short still open. ${err instanceof Error ? err.message : String(err)}`);
      busyRef.current = false;
      setBusy(false);
      return;
    }
    try {
      await sellLocked(locked, nextSide, ready.qty, ready.ratioId, ready.sizeMult);
    } catch (err: unknown) {
      fail(`Short booked, but the new sell failed. Flip is flat. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bookOpen, fail, guardClick, sellLocked]);

  const squareAll = useCallback(async () => {
    if (busyRef.current) return;
    const open = positionRef.current;
    if (!open) {
      resetControls();
      pushLog("Square All — flat. Qty, ratio, and size reset.", "info");
      toast({ title: "Nifty Flip", description: "Flat. Qty, ratio, and size reset." });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await bookOpen(open);
      positionRef.current = null;
      setPosition(null);
      resetControls();
    } catch (err: unknown) {
      fail(`Square All book failed. Controls not reset. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bookOpen, fail, pushLog, resetControls]);

  const clearLog = () => setLogs([]);

  const bullText = buttonLabel("BULL", "PE", bullPick);
  const bearText = buttonLabel("BEAR", "CE", bearPick);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[11px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Qty</span>
            <input
              aria-label="Qty"
              inputMode="numeric"
              autoComplete="off"
              value={qtyText}
              onChange={(e) => setQtyText(e.target.value)}
              className="ramsetu-glass-select nf-qty"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Ratio</span>
            <select
              aria-label="Ratio"
              value={ratio}
              onChange={(e) => {
                if (isRatioId(e.target.value)) setRatio(e.target.value);
              }}
              className="ramsetu-glass-select nf-ratio"
            >
              {FLIP_RATIOS.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Size</span>
            <div className="nl-toggle">
              {SIZE_MULTS.map((mult) => (
                <button
                  key={mult}
                  type="button"
                  onClick={() => setSize(mult)}
                  className={`nl-toggle__btn${size === mult ? " nl-toggle__btn--on" : ""}`}
                >
                  {mult}x
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Order qty</span>
            <span className="nf-order-qty tabular-nums">
              {parsed.ok && liveOrderQty != null ? `${fmtQty(parsed.qty)} × ${size} = ${fmtQty(liveOrderQty)}` : "—"}
            </span>
          </div>
        </div>

        {!parsed.ok && <p className="mt-2 text-[12px] font-semibold text-amber-500">{parsed.error}</p>}

        {position && (
          <p className="mt-2 text-[12px] font-semibold text-amber-500">
            One short is open. Use Flip or Square All.
          </p>
        )}

        <div className="mt-3 nf-actions">
          <button type="button" disabled={busy} onClick={() => void sellFresh("PE")} className="nf-btn nf-bull">
            {bullText}
          </button>
          <button type="button" disabled={busy} onClick={() => void sellFresh("CE")} className="nf-btn nf-bear">
            {bearText}
          </button>
          <button type="button" disabled={busy} onClick={() => void flip()} className="nf-btn nf-flip">
            FLIP
          </button>
        </div>

        <div className="mt-3">
          <button type="button" disabled={busy} onClick={() => void squareAll()} className="ramsetu-glass-stop">
            SQUARE ALL
          </button>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex min-h-0 flex-1 flex-col gap-3">
        {!nifty && (
          <div className="ramsetu-glass-empty">
            Nifty Flip trades NIFTY options only. Switch the top index to NIFTY.
          </div>
        )}

        <div className="ramsetu-glass-card">
          <div className="ramsetu-glass-card__badge">Position</div>
          {!position ? (
            <div className="mt-2 text-[13px] font-semibold text-muted-foreground">Flat</div>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
              <div>
                <div className="ramsetu-glass-toolbar__label">Strike</div>
                <div
                  className={`text-[14px] font-extrabold tabular-nums ${
                    position.side === "PE" ? "ramsetu-glass-table__strike--pe" : "text-cd-green"
                  }`}
                >
                  {Math.round(position.strike).toLocaleString("en-IN")} {position.side}
                </div>
              </div>
              <div>
                <div className="ramsetu-glass-toolbar__label">Qty</div>
                <div className="text-[14px] font-extrabold tabular-nums">{fmtQty(position.qty)}</div>
              </div>
              <div>
                <div className="ramsetu-glass-toolbar__label">Fill</div>
                <div className="text-[14px] font-extrabold tabular-nums">{fmtPrice(position.fill)}</div>
              </div>
              <div>
                <div className="ramsetu-glass-toolbar__label">LTP</div>
                <FastLtp iid={position.iid} as="div" className="text-[14px] font-extrabold tabular-nums" />
              </div>
              <div>
                <div className="ramsetu-glass-toolbar__label">MTM</div>
                <div
                  className={`text-[14px] font-extrabold tabular-nums ${
                    mtm != null && mtm >= 0 ? "text-cd-green" : mtm != null ? "text-cd-red" : ""
                  }`}
                >
                  {fmtPnl(mtm)}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="ramsetu-glass-toolbar__label">Log</span>
            <button type="button" onClick={clearLog} className="nl-btn-reset">
              Clear
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {!logs.length ? (
              <p className="text-[12px] text-muted-foreground">
                Bull sells the highest-LTP PE inside the ratio. Bear sells the highest-LTP CE. One short at a time.
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
