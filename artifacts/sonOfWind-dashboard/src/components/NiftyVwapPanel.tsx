import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainResolved } from "@/types/market";
import { peekLiveTick, useLiveLtp } from "@/context/LiveLtpContext";
import { FastLtp } from "@/components/FastLtp";
import { setHotFocus } from "@/lib/hotFocus";
import { peekTouchPx } from "@/lib/liveQuote";
import { liveAtmStrikeForChain, plausibleSpotPx } from "@/lib/liveAtmStrike";
import { fmtPnl, fmtPrice, fmtQty } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, clearLocalPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import { expectedLadderFill, ixOrderRejectedMessage, ladderOrderPricing, XTS_IX_ORDER_BASE } from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import {
  DEFAULT_QTY,
  LOT_SIZE,
  SIZE_MULTS,
  UNDERLYING,
  isSizeMult,
  orderQuantity,
  parseQty,
  shortMtm,
  type FlipSide,
  type SizeMult,
} from "@/lib/niftyFlipRules";

const SESSION_KEY = "sow_nifty_vwap_v1";
const POLL_MS = 10000;
const DEFAULT_TARGET = "10";
const GUARD_MS = 200;
/** 0 = both sides ATM. 1 = CE one strike up, PE one strike down. Up to 5. */
const STRIKE_WINGS = [0, 1, 2, 3, 4, 5] as const;
type StrikeWing = (typeof STRIKE_WINGS)[number];

type VwapSignal = "SELL_PE" | "SELL_CE" | "NONE";

type VwapTail = {
  minute: string;
  close: number;
  vwap: number | null;
  futVolume: number;
};

type VwapAnchor = {
  minute: string;
  high: number;
  low: number;
  close: number;
  vwap: number | null;
  expected: number;
  near: boolean;
};

type VwapPayload = {
  ok?: boolean;
  error?: string;
  stale?: boolean;
  source?: string;
  sessionDate?: string;
  futureSymbol?: string;
  futureExpiry?: string;
  vwap?: number | null;
  liveVwap?: number | null;
  lastClose?: number | null;
  lastMinute?: string | null;
  signal?: VwapSignal;
  signalLabel?: string;
  barsUsed?: number;
  formingDropped?: boolean;
  formingMinute?: string | null;
  tail?: VwapTail[];
  anchor?: VwapAnchor | null;
  at0952?: { minute: string; high: number | null; low: number | null; close: number; vwap: number | null } | null;
};

type VwapLog = { id: number; ts: number; text: string; kind: "entry" | "exit" | "error" | "info" };

type VwapPosition = {
  strike: number;
  side: FlipSide;
  qty: number;
  fill: number;
  iid: number;
  segment: number;
};

type SessionBlob = {
  qtyText: string;
  size: SizeMult;
  wing: StrikeWing;
  targetText: string;
  slText: string;
  position: VwapPosition | null;
  logs: VwapLog[];
  logId: number;
};

function isNiftyChain(chain: ChainResolved): boolean {
  return String(chain.index || "").trim().toUpperCase() === UNDERLYING;
}

function positivePx(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function px2(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

function isStrikeWing(value: number): value is StrikeWing {
  return (STRIKE_WINGS as readonly number[]).includes(value);
}

function readWing(raw: unknown): StrikeWing {
  const n = typeof raw === "number" ? raw : Number(raw);
  return isStrikeWing(n) ? n : 0;
}

/** ATM keeps both sides on the ATM strike. Wing N sells CE N strikes above and PE N strikes below. */
function wingStrike(atm: number, side: FlipSide, wing: StrikeWing, step: number): number {
  const s = step > 0 ? step : 50;
  if (!(wing > 0)) return atm;
  return side === "CE" ? atm + wing * s : atm - wing * s;
}

function fmtStrike(strike: number | null): string {
  return strike != null && Number.isFinite(strike) ? Math.round(strike).toLocaleString("en-IN") : "—";
}

/** Premium points. Blank or zero turns that exit off. */
function parsePoints(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const points = Number(text);
  if (!Number.isFinite(points) || points <= 0) return null;
  return points;
}

function readPosition(raw: unknown): VwapPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<VwapPosition>;
  const strike = Number(row.strike);
  const qty = Number(row.qty);
  const fill = Number(row.fill);
  const iid = Number(row.iid);
  const segment = Number(row.segment);
  if (row.side !== "CE" && row.side !== "PE") return null;
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
    const size = typeof parsed.size === "number" && isSizeMult(parsed.size) ? parsed.size : 1;
    const wing = readWing(parsed.wing);
    const targetText = typeof parsed.targetText === "string" ? parsed.targetText : DEFAULT_TARGET;
    const slText = typeof parsed.slText === "string" ? parsed.slText : "";
    const logs = Array.isArray(parsed.logs)
      ? parsed.logs.filter(
          (row): row is VwapLog =>
            !!row &&
            typeof row === "object" &&
            typeof (row as VwapLog).id === "number" &&
            typeof (row as VwapLog).text === "string",
        )
      : [];
    const logId = logs.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    return {
      qtyText,
      size,
      wing,
      targetText,
      slText,
      position: readPosition(parsed.position),
      logs: logs.slice(0, 80),
      logId,
    };
  } catch {
    return null;
  }
}

function rememberShort(chain: ChainResolved, pos: VwapPosition) {
  const expiry = chain.expiryApi ? ` ${chain.expiryApi}` : "";
  setLocalShortPosition({
    exchangeInstrumentID: pos.iid,
    exchangeSegment: pos.segment,
    qty: pos.qty,
    fillPx: pos.fill,
    tradingSymbol: `NIFTY${expiry} ${pos.strike} ${pos.side}`,
  });
}

export default function NiftyVwapPanel({ chain, active }: { chain: ChainResolved; active: boolean }) {
  const boot = useMemo(() => loadSession(), []);
  const [qtyText, setQtyText] = useState(boot?.qtyText ?? String(DEFAULT_QTY));
  const [size, setSize] = useState<SizeMult>(boot?.size ?? 1);
  const [wing, setWing] = useState<StrikeWing>(boot?.wing ?? 0);
  const [targetText, setTargetText] = useState(boot?.targetText ?? DEFAULT_TARGET);
  const [armedTargetText, setArmedTargetText] = useState(boot?.targetText ?? DEFAULT_TARGET);
  const [targetLocked, setTargetLocked] = useState(true);
  const [slText, setSlText] = useState(boot?.slText ?? "");
  const [armedSlText, setArmedSlText] = useState(boot?.slText ?? "");
  const [slLocked, setSlLocked] = useState(parsePoints(boot?.slText ?? "") != null);
  const [addQtyText, setAddQtyText] = useState("");
  const [outQtyText, setOutQtyText] = useState("");
  const [position, setPosition] = useState<VwapPosition | null>(boot?.position ?? null);
  const [logs, setLogs] = useState<VwapLog[]>(boot?.logs ?? []);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<VwapPayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const ltps = useLiveLtp();
  const chainRef = useRef(chain);
  const qtyRef = useRef(qtyText);
  const sizeRef = useRef(size);
  const wingRef = useRef(wing);
  const targetRef = useRef(armedTargetText);
  const slRef = useRef(armedSlText);
  const slFloorKeyRef = useRef("");
  const slFloorLiveRef = useRef(false);
  const positionRef = useRef(position);
  const quoteRef = useRef(quote);
  const liveSpotRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const flipHoldRef = useRef(false);
  const flipKeyRef = useRef("");
  const flipRetryAtRef = useRef(0);
  const logIdRef = useRef(boot?.logId ?? 1);
  const restoredRef = useRef(false);

  chainRef.current = chain;
  qtyRef.current = qtyText;
  sizeRef.current = size;
  wingRef.current = wing;
  positionRef.current = position;
  quoteRef.current = quote;

  const nifty = isNiftyChain(chain);
  const parsed = parseQty(qtyText);
  const liveOrderQty = parsed.ok ? orderQuantity(parsed.qty, size) : null;

  const liveSpot = useMemo(() => {
    const spotToken = chain.spotToken;
    if (typeof spotToken === "number" && spotToken > 0) {
      const live = plausibleSpotPx(chain.index, peekTouchPx(spotToken, ltps) ?? ltps[spotToken]);
      if (live != null) return live;
    }
    return plausibleSpotPx(chain.index, chain.spotLtp) ?? null;
  }, [chain.index, chain.spotLtp, chain.spotToken, ltps]);
  liveSpotRef.current = liveSpot;

  const sessionVwap = typeof quote?.vwap === "number" && Number.isFinite(quote.vwap) && quote.vwap > 0 ? quote.vwap : null;
  const spotPx = liveSpot != null ? px2(liveSpot) : null;
  const vwapPx = sessionVwap != null ? px2(sessionVwap) : null;
  const signal: VwapSignal =
    spotPx == null || vwapPx == null ? "NONE" : spotPx > vwapPx ? "SELL_PE" : spotPx < vwapPx ? "SELL_CE" : "NONE";
  const side: FlipSide | null = signal === "SELL_PE" ? "PE" : signal === "SELL_CE" ? "CE" : null;

  const atm = useMemo(() => {
    const basis = liveSpot ?? (typeof quote?.lastClose === "number" ? quote.lastClose : undefined);
    return liveAtmStrikeForChain(chain, basis);
  }, [chain, liveSpot, quote?.lastClose]);

  const step = typeof chain.step === "number" && chain.step > 0 ? chain.step : 50;
  const ceStrike = Number.isFinite(atm) ? wingStrike(atm, "CE", wing, step) : null;
  const peStrike = Number.isFinite(atm) ? wingStrike(atm, "PE", wing, step) : null;
  const tradeStrike = side === "CE" ? ceStrike : side === "PE" ? peStrike : null;
  const tradeRow = tradeStrike != null ? chain.instrumentMap?.[String(tradeStrike)] : undefined;
  const tradeIid = side === "CE" ? tradeRow?.ce ?? 0 : side === "PE" ? tradeRow?.pe ?? 0 : 0;
  const tradeLtp = tradeIid > 0 ? peekTouchPx(tradeIid, ltps) : null;
  const signalLabel =
    side == null
      ? "No trade"
      : wing > 0 && tradeStrike != null
        ? `Sell ${side} ${fmtStrike(tradeStrike)}`
        : side === "PE"
          ? "Sell ATM PE"
          : "Sell ATM CE";

  const liveLtp = position ? peekTouchPx(position.iid, ltps) : null;
  const mtm = position && liveLtp != null ? shortMtm(position.fill, liveLtp, position.qty) : null;
  const gap = spotPx != null && vwapPx != null ? px2(spotPx - vwapPx) : null;

  const pushLog = useCallback((text: string, kind: VwapLog["kind"]) => {
    const id = logIdRef.current++;
    setLogs((prev) => [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 80));
  }, []);

  const fail = useCallback(
    (text: string) => {
      pushLog(text, "error");
      toast({ title: "Nifty VWAP", description: text, variant: "destructive" });
    },
    [pushLog],
  );

  const loadQuote = useCallback(async () => {
    try {
      const res = (await apiFetch("/api/vwap/data")) as VwapPayload;
      if (res?.ok) {
        setQuote(res);
        setFetchError(res.stale ? res.error || "Showing the last Fyers session." : null);
      } else {
        setFetchError(res?.error || "Fyers VWAP unavailable");
      }
    } catch (err: unknown) {
      setFetchError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!active && !position) return;
    void loadQuote();
    const id = window.setInterval(() => void loadQuote(), POLL_MS);
    return () => window.clearInterval(id);
  }, [active, position, loadQuote]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const pos = positionRef.current;
    if (pos) rememberShort(chainRef.current, pos);
  }, []);

  useEffect(() => {
    const blob: SessionBlob = {
      qtyText,
      size,
      wing,
      targetText: armedTargetText,
      slText: armedSlText,
      position,
      logs,
      logId: logIdRef.current,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(blob));
    } catch {
      /* ignore quota */
    }
  }, [qtyText, size, wing, armedTargetText, armedSlText, position, logs]);

  useEffect(() => {
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (segment: number, iid: number | undefined) => {
      if (!(segment > 0) || typeof iid !== "number" || !(iid > 0) || seen.has(iid)) return;
      seen.add(iid);
      instruments.push({ exchangeSegment: segment, exchangeInstrumentID: iid });
    };
    if (position) add(position.segment, position.iid);
    if (active && nifty && side) add(chain.optionSegment, tradeIid);
    setHotFocus("vwap", instruments);
    return () => setHotFocus("vwap", []);
  }, [active, nifty, chain.optionSegment, position, side, tradeIid]);

  const placeOrder = useCallback(async (orderSide: "BUY" | "SELL", instrumentId: number, qty: number, segment: number) => {
    const tick = peekLiveTick(instrumentId);
    const ltp = peekTouchPx(instrumentId);
    const response = (await apiFetch("/api/ix/place_order", {
      method: "POST",
      body: JSON.stringify({
        ...XTS_IX_ORDER_BASE,
        ...ladderOrderPricing(orderSide, ltp, tick?.bid, tick?.ask),
        exchangeSegment: segment,
        exchangeInstrumentID: instrumentId,
        orderSide,
        orderQuantity: qty,
      }),
    })) as { ok?: boolean; error?: string; raw?: unknown; fillHint?: { ltp?: number; bid?: number; ask?: number } };
    const rejected = ixOrderRejectedMessage(response?.raw) || ixOrderRejectedMessage(response);
    if (rejected) throw new Error(rejected);
    bumpPositionsRefresh();
    return {
      ltp: positivePx(response?.fillHint?.ltp) ?? ltp,
      bid: positivePx(response?.fillHint?.bid) ?? positivePx(tick?.bid),
      ask: positivePx(response?.fillHint?.ask) ?? positivePx(tick?.ask),
    };
  }, []);

  const sellSide = useCallback(
    async (snapSide: FlipSide, note: string): Promise<boolean> => {
      if (busyRef.current || positionRef.current) return false;
      if (!isNiftyChain(chainRef.current)) {
        fail("Nifty VWAP trades NIFTY options only. Order refused.");
        return false;
      }
      const parsedQty = parseQty(qtyRef.current);
      if (!parsedQty.ok) {
        fail(parsedQty.error);
        return false;
      }
      const sellQty = orderQuantity(parsedQty.qty, sizeRef.current);
      if (!Number.isSafeInteger(sellQty) || sellQty <= 0 || sellQty % LOT_SIZE !== 0) {
        fail("Order qty must be a positive multiple of 65.");
        return false;
      }
      const segment = chainRef.current.optionSegment;
      if (!(segment > 0)) {
        fail("Missing option segment. Order not sent.");
        return false;
      }
      const snap = quoteRef.current;
      const wingNow = wingRef.current;
      const stepNow = typeof chainRef.current.step === "number" && chainRef.current.step > 0 ? chainRef.current.step : 50;
      const atmNow = liveAtmStrikeForChain(
        chainRef.current,
        liveSpotRef.current ?? snap?.lastClose ?? undefined,
      );
      const strike = wingStrike(atmNow, snapSide, wingNow, stepNow);
      const row = chainRef.current.instrumentMap?.[String(strike)];
      const iid = snapSide === "CE" ? row?.ce : row?.pe;
      if (typeof iid !== "number" || !(iid > 0)) {
        fail(`${Math.round(strike)} ${snapSide} is not in the chain. Order not sent.`);
        return false;
      }
      const seen = peekTouchPx(iid);
      busyRef.current = true;
      setBusy(true);
      try {
        const hint = await placeOrder("SELL", iid, sellQty, segment);
        const fill = positivePx(expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask)) ?? seen;
        if (fill == null) throw new Error("Sell sent, but no fill price came back.");
        const next: VwapPosition = { strike, side: snapSide, qty: sellQty, fill, iid, segment };
        positionRef.current = next;
        setPosition(next);
        rememberShort(chainRef.current, next);
        const strikeText = Math.round(strike).toLocaleString("en-IN");
        const armedTarget = parsePoints(targetRef.current);
        const strikeTag = wingNow > 0 ? `${snapSide} ${strikeText}` : `ATM ${snapSide} ${strikeText}`;
        pushLog(
          `${note}: SELL ${strikeTag} × ${fmtQty(sellQty)} @ ${fmtPrice(fill)} · target ${armedTarget ?? "off"}`,
          "entry",
        );
        toast({
          title: `Nifty VWAP SELL ${snapSide}`,
          description: `${strikeText} @ ${fmtPrice(fill)} · ${fmtQty(sellQty)}`,
        });
        return true;
      } catch (err: unknown) {
        fail(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fail, placeOrder, pushLog],
  );

  const sellSignal = useCallback(async () => {
    if (busyRef.current || flipHoldRef.current) return;
    if (positionRef.current) {
      fail("One short only. The open side books first when Nifty crosses VWAP.");
      return;
    }
    const spot = liveSpotRef.current;
    const vwap = quoteRef.current?.vwap;
    if (spot == null || typeof vwap !== "number" || !(vwap > 0)) {
      fail("No trade. Nifty spot or VWAP is missing.");
      return;
    }
    const spotNow = px2(spot);
    const vwapNow = px2(vwap);
    if (spotNow === vwapNow) {
      fail("No trade. Nifty is equal to VWAP.");
      return;
    }
    const snapSide: FlipSide = spotNow > vwapNow ? "PE" : "CE";
    await sellSide(snapSide, `spot ${fmtPrice(spotNow)} vs VWAP ${fmtPrice(vwapNow)}`);
  }, [fail, sellSide]);

  const bookOpen = useCallback(
    async (reason: string): Promise<boolean> => {
      if (busyRef.current) return false;
      const open = positionRef.current;
      if (!open) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const hint = await placeOrder("BUY", open.iid, open.qty, open.segment);
        const bookPx =
          positivePx(expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask)) ??
          positivePx(peekTouchPx(open.iid)) ??
          open.fill;
        const booked = shortMtm(open.fill, bookPx, open.qty);
        clearLocalPosition(open.iid, booked);
        positionRef.current = null;
        setPosition(null);
        const strike = Math.round(open.strike).toLocaleString("en-IN");
        const points = open.fill - bookPx;
        pushLog(
          `${reason}: BUY ${strike} ${open.side} × ${fmtQty(open.qty)} @ ${fmtPrice(bookPx)} · ${points >= 0 ? "+" : ""}${points.toFixed(2)} pts · MTM ${fmtPnl(booked)}`,
          "exit",
        );
        toast({
          title: reason.startsWith("STOP")
            ? "Nifty VWAP stop"
            : reason.startsWith("TARGET")
              ? "Nifty VWAP target"
              : reason.startsWith("SL")
                ? "Nifty VWAP SL"
                : reason.startsWith("NIKAL")
                  ? "Nifty VWAP nikal"
                  : reason.startsWith("FLIP")
                  ? "Nifty VWAP flip"
                  : "Nifty VWAP booked",
          description: `${strike} ${open.side} @ ${fmtPrice(bookPx)} · MTM ${fmtPnl(booked)}`,
          variant: reason.startsWith("STOP") ? "destructive" : "default",
        });
        return true;
      } catch (err: unknown) {
        fail(`${reason} book failed. Short still open. ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fail, placeOrder, pushLog],
  );

  const bookRef = useRef(bookOpen);
  bookRef.current = bookOpen;

  useEffect(() => {
    const id = window.setInterval(() => {
      const open = positionRef.current;
      if (!open || busyRef.current || flipHoldRef.current) return;
      const ltp = peekTouchPx(open.iid);
      if (ltp == null || !(ltp > 0)) return;
      if (open.fill >= 5 && ltp < 0.5) return;
      const target = parsePoints(targetRef.current);
      const sl = parsePoints(slRef.current);
      const profitPts = open.fill - ltp;
      const floorKey = `${open.iid}|${open.qty}|${open.fill}|${sl ?? ""}`;
      if (slFloorKeyRef.current !== floorKey) {
        slFloorKeyRef.current = floorKey;
        slFloorLiveRef.current = false;
      }
      if (sl != null && profitPts > sl) slFloorLiveRef.current = true;
      if (target != null && profitPts >= target) {
        void bookRef.current(`TARGET ${target} pts`);
      } else if (sl != null && slFloorLiveRef.current && profitPts <= sl) {
        void bookRef.current(`SL ${sl} pts`);
      }
    }, GUARD_MS);
    return () => window.clearInterval(id);
  }, []);

  const flipMismatch = useCallback(
    async (want: FlipSide, minute: string): Promise<boolean> => {
      const open = positionRef.current;
      if (!open || open.side === want || busyRef.current || flipHoldRef.current) return false;
      flipHoldRef.current = true;
      const snap = quoteRef.current;
      const booked = await bookOpen(`FLIP ${minute}`);
      if (!booked || positionRef.current) {
        flipHoldRef.current = false;
        return false;
      }
      const spotNow = liveSpotRef.current != null ? px2(liveSpotRef.current) : null;
      const vwapNow = typeof snap?.vwap === "number" ? px2(snap.vwap) : null;
      const note = `${minute} spot ${fmtPrice(spotNow)} vs VWAP ${fmtPrice(vwapNow)} · booked ${open.side}, sell ${want}`;
      const sold = await sellSide(want, note);
      flipHoldRef.current = false;
      if (!sold) {
        pushLog(`FLIP ${minute}: short booked, new ${want} sell failed. Flat.`, "error");
      }
      return sold;
    },
    [bookOpen, pushLog, sellSide],
  );

  useEffect(() => {
    if (spotPx == null || vwapPx == null || spotPx === vwapPx || side == null) return;
    const open = positionRef.current;
    if (!open || open.side === side) return;
    if (busyRef.current || flipHoldRef.current || Date.now() < flipRetryAtRef.current) return;
    const key = `${quote?.sessionDate ?? ""}|${open.iid}|${side}`;
    if (flipKeyRef.current === key) return;
    flipKeyRef.current = key;
    const stamp = new Date().toLocaleTimeString("en-IN", { hour12: false });
    void flipMismatch(side, stamp).then((ok) => {
      if (!ok) {
        flipKeyRef.current = "";
        flipRetryAtRef.current = Date.now() + 3000;
      }
    });
  }, [spotPx, vwapPx, side, quote?.sessionDate, position?.side, position?.iid, flipMismatch]);

  const lockTarget = () => {
    const text = targetText.trim();
    if (text && parsePoints(text) == null) {
      toast({
        title: "Target",
        description: "Points likho. Khali chhod ke lock karoge to target off.",
        variant: "destructive",
      });
      return;
    }
    const points = parsePoints(text);
    const next = points == null ? "" : String(points);
    setTargetText(next);
    setArmedTargetText(next);
    targetRef.current = next;
    setTargetLocked(true);
    toast({
      title: "Target locked",
      description: points == null ? "Target off." : `${points} pts`,
    });
  };

  const unlockTarget = () => {
    setTargetText(armedTargetText);
    setTargetLocked(false);
  };

  const lockSl = () => {
    const text = slText.trim();
    if (text && parsePoints(text) == null) {
      toast({
        title: "SL",
        description: "Points likho. Khali chhod ke lock karoge to SL off.",
        variant: "destructive",
      });
      return;
    }
    const points = parsePoints(text);
    const next = points == null ? "" : String(points);
    setSlText(next);
    setArmedSlText(next);
    slRef.current = next;
    setSlLocked(true);
    toast({
      title: points == null ? "SL off" : "SL locked",
      description: points == null ? "Koi SL nahi." : `${points} pts. Points yahan tak girenge to book.`,
    });
  };

  const unlockSl = () => {
    setSlText(armedSlText);
    setSlLocked(false);
  };

  const addToOpen = useCallback(async () => {
    if (busyRef.current || flipHoldRef.current) return;
    const open = positionRef.current;
    if (!open) {
      fail("Add — pehle trade open karo.");
      return;
    }
    if (!addQtyText.trim()) {
      fail("Add qty likho, phir Add dabao.");
      return;
    }
    const parsedAdd = parseQty(addQtyText);
    if (!parsedAdd.ok) {
      fail(parsedAdd.error);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const hint = await placeOrder("SELL", open.iid, parsedAdd.qty, open.segment);
      const addFill =
        positivePx(expectedLadderFill("SELL", hint.ltp, hint.bid, hint.ask)) ?? positivePx(peekTouchPx(open.iid));
      if (addFill == null) throw new Error("Add sell sent, but no fill price came back.");
      const totalQty = open.qty + parsedAdd.qty;
      const avg = px2((open.fill * open.qty + addFill * parsedAdd.qty) / totalQty);
      const next: VwapPosition = { ...open, qty: totalQty, fill: avg };
      positionRef.current = next;
      setPosition(next);
      rememberShort(chainRef.current, next);
      const strike = Math.round(open.strike).toLocaleString("en-IN");
      pushLog(
        `ADD: SELL ${strike} ${open.side} × ${fmtQty(parsedAdd.qty)} @ ${fmtPrice(addFill)} · qty ${fmtQty(open.qty)} → ${fmtQty(totalQty)} · avg ${fmtPrice(avg)}`,
        "entry",
      );
      toast({
        title: "Nifty VWAP add",
        description: `${strike} ${open.side} +${fmtQty(parsedAdd.qty)} · now ${fmtQty(totalQty)} @ ${fmtPrice(avg)}`,
      });
      setAddQtyText("");
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [addQtyText, fail, placeOrder, pushLog]);

  const takeOut = useCallback(async () => {
    if (busyRef.current || flipHoldRef.current) return;
    const open = positionRef.current;
    if (!open) {
      fail("Nikal — pehle trade open karo.");
      return;
    }
    if (!outQtyText.trim()) {
      fail("Nikal qty likho, phir Nikal dabao.");
      return;
    }
    const parsedOut = parseQty(outQtyText);
    if (!parsedOut.ok) {
      fail(parsedOut.error);
      return;
    }
    if (parsedOut.qty > open.qty) {
      fail(`Nikal ${fmtQty(parsedOut.qty)} open qty ${fmtQty(open.qty)} se zyada hai.`);
      return;
    }
    if (parsedOut.qty === open.qty) {
      const booked = await bookOpen("NIKAL");
      if (booked) setOutQtyText("");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const hint = await placeOrder("BUY", open.iid, parsedOut.qty, open.segment);
      const bookPx =
        positivePx(expectedLadderFill("BUY", hint.ltp, hint.bid, hint.ask)) ??
        positivePx(peekTouchPx(open.iid)) ??
        open.fill;
      const left = open.qty - parsedOut.qty;
      const next: VwapPosition = { ...open, qty: left };
      positionRef.current = next;
      setPosition(next);
      rememberShort(chainRef.current, next);
      const strike = Math.round(open.strike).toLocaleString("en-IN");
      const points = open.fill - bookPx;
      const booked = shortMtm(open.fill, bookPx, parsedOut.qty);
      pushLog(
        `NIKAL: BUY ${strike} ${open.side} × ${fmtQty(parsedOut.qty)} @ ${fmtPrice(bookPx)} · ${points >= 0 ? "+" : ""}${points.toFixed(2)} pts · MTM ${fmtPnl(booked)} · left ${fmtQty(left)}`,
        "exit",
      );
      toast({
        title: "Nifty VWAP nikal",
        description: `${strike} ${open.side} −${fmtQty(parsedOut.qty)} · left ${fmtQty(left)} · MTM ${fmtPnl(booked)}`,
      });
      setOutQtyText("");
    } catch (err: unknown) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bookOpen, fail, outQtyText, placeOrder, pushLog]);

  const squareAll = useCallback(async () => {
    if (busyRef.current) return;
    if (!positionRef.current) {
      pushLog("Square All — flat.", "info");
      toast({ title: "Nifty VWAP", description: "Flat." });
      return;
    }
    await bookOpen("SQUARE ALL");
  }, [bookOpen, pushLog]);

  const crossed = position != null && side != null && position.side !== side;
  const sellStrikeText = tradeStrike != null ? ` ${fmtStrike(tradeStrike)}` : "";
  const sellPxText = tradeLtp != null ? ` @ ${tradeLtp.toFixed(2)}` : "";
  const sellText = crossed
    ? `BOOK ${position.side} · SELL ${side}${sellStrikeText}`
    : side == null
      ? "NO TRADE"
      : position
        ? `${position.side} OPEN`
        : `SELL ${wing > 0 ? "" : "ATM "}${side}${sellStrikeText}${sellPxText}`;

  const futureName = (quote?.futureSymbol || "").replace(/^NSE:/, "") || "front month";

  const gapClass = gap != null && gap > 0 ? "text-cd-green" : gap != null && gap < 0 ? "text-cd-red" : "";
  const gapText = gap == null ? "—" : `${gap > 0 ? "+" : ""}${gap.toFixed(2)} pts`;
  const targetPts = parsePoints(armedTargetText);
  const draftPts = parsePoints(targetText);
  const draftPending = !targetLocked && targetText.trim() !== armedTargetText.trim();
  const slPts = parsePoints(armedSlText);
  const slDraftPts = parsePoints(slText);
  const slDraftPending = !slLocked && slText.trim() !== armedSlText.trim();
  const targetPx = position && targetPts != null ? position.fill - targetPts : null;
  const slPx = position && slPts != null ? position.fill - slPts : null;
  const livePoints = position && liveLtp != null ? position.fill - liveLtp : null;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[13px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar">
        <div className="nv-stats">
          <div className="nv-stat">
            <div className="nv-kicker">Session VWAP</div>
            <div className="nv-value">{fmtPrice(quote?.vwap)}</div>
            <div className="nv-sub">
              {quote?.liveVwap != null && quote.liveVwap !== quote.vwap
                ? `Forming ${quote.formingMinute || ""} ${fmtPrice(quote.liveVwap)}`
                : futureName}
            </div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">Nifty</div>
            <div className={`nv-value ${gapClass}`}>{fmtPrice(spotPx)}</div>
            <div className={`nv-sub ${gapClass}`}>
              {gapText}
              {quote?.lastMinute ? ` · close ${quote.lastMinute} ${fmtPrice(quote.lastClose)}` : ""}
            </div>
          </div>
          <div className={`nv-stat${signal === "SELL_CE" ? " nv-stat--ce" : signal === "SELL_PE" ? " nv-stat--pe" : ""}`}>
            <div className="nv-kicker">Signal</div>
            <div className={`nv-value nv-value--signal ${gapClass}`}>{signalLabel}</div>
            <div className="nv-sub">
              {futureName}
              {quote?.barsUsed != null ? ` · ${quote.barsUsed} min` : ""}
            </div>
          </div>
        </div>

        {fetchError && <p className="mt-2 text-[13px] font-semibold text-amber-500">{fetchError}</p>}
        {quote?.at0952 && (
          <p className="nv-check">
            09:52 H {fmtPrice(quote.at0952.high)} · L {fmtPrice(quote.at0952.low)} · C {fmtPrice(quote.at0952.close)} · VWAP{" "}
            <span className={quote.anchor?.near ? "text-cd-green" : ""}>{fmtPrice(quote.at0952.vwap)}</span>
            {quote.anchor?.near ? " matches 22,558.77" : ""}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-3">
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
          <label className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Target</span>
            <div className="flex items-center gap-1">
              <input
                aria-label="Target points"
                inputMode="decimal"
                autoComplete="off"
                value={targetText}
                disabled={targetLocked}
                onChange={(e) => setTargetText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !targetLocked) {
                    e.preventDefault();
                    lockTarget();
                  }
                }}
                className="ramsetu-glass-select nf-qty"
              />
              <button
                type="button"
                disabled={targetLocked}
                onClick={lockTarget}
                className="ramsetu-glass-exec nv-lock"
              >
                Lock
              </button>
              <button
                type="button"
                disabled={!targetLocked}
                onClick={unlockTarget}
                className="ramsetu-glass-stop nv-lock"
              >
                Unlock
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">SL</span>
            <div className="flex items-center gap-1">
              <input
                aria-label="SL points"
                inputMode="decimal"
                autoComplete="off"
                placeholder="pts"
                value={slText}
                disabled={slLocked}
                onChange={(e) => setSlText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !slLocked) {
                    e.preventDefault();
                    lockSl();
                  }
                }}
                className="ramsetu-glass-select nf-qty"
              />
              <button type="button" disabled={slLocked} onClick={lockSl} className="ramsetu-glass-exec nv-lock">
                Lock
              </button>
              <button type="button" disabled={!slLocked} onClick={unlockSl} className="ramsetu-glass-stop nv-lock">
                Unlock
              </button>
            </div>
          </label>
          <div className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Order qty</span>
            <span className="nf-order-qty tabular-nums">
              {parsed.ok && liveOrderQty != null ? `${fmtQty(parsed.qty)} × ${size} = ${fmtQty(liveOrderQty)}` : "—"}
            </span>
          </div>
        </div>

        <div className="nv-strike">
          <div className="nv-strike__pick">
            <span className="ramsetu-glass-toolbar__label">Strike</span>
            <div className="nv-strike__wings">
              {STRIKE_WINGS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setWing(n)}
                  className={`nv-strike__btn${wing === n ? " nv-strike__btn--on" : ""}`}
                >
                  {n === 0 ? "ATM" : n}
                </button>
              ))}
            </div>
          </div>
          <div className="nv-strike__legs">
            <div className={`nv-leg nv-leg--ce${side === "CE" ? " nv-leg--live" : ""}`}>
              <span className="nv-leg__k">CE</span>
              <span className="nv-leg__px">{fmtStrike(ceStrike)}</span>
            </div>
            <div className={`nv-leg nv-leg--pe${side === "PE" ? " nv-leg--live" : ""}`}>
              <span className="nv-leg__k">PE</span>
              <span className="nv-leg__px">{fmtStrike(peStrike)}</span>
            </div>
          </div>
        </div>

        {!parsed.ok && <p className="mt-2 text-[12px] font-semibold text-amber-500">{parsed.error}</p>}
        <p className="mt-2 text-[13px] font-semibold tabular-nums text-cd-green">
          Target {targetPts == null ? "off" : `${targetPts} pts`}
          {targetLocked ? " · locked" : ""}
          {targetPx != null ? ` · book ≤ ${fmtPrice(targetPx)}` : ""}
          {draftPending ? (
            <span className="text-amber-500">
              {" "}
              · lock to set {draftPts == null ? "off" : `${draftPts} pts`}
            </span>
          ) : null}
          {livePoints != null ? ` · now ${livePoints >= 0 ? "+" : ""}${livePoints.toFixed(2)} pts` : ""}
        </p>
        <p className={`mt-1 text-[13px] font-semibold tabular-nums ${slPts == null ? "text-muted-foreground" : "text-cd-red"}`}>
          SL {slPts == null ? "off" : `${slPts} pts`}
          {slLocked && slPts != null ? " · locked" : ""}
          {slPx != null ? ` · book if points fall to ${slPts}` : ""}
          {slDraftPending ? (
            <span className="text-amber-500">
              {" "}
              · lock to set {slDraftPts == null ? "off" : `${slDraftPts} pts`}
            </span>
          ) : null}
        </p>

        <div className="nv-trade">
          <label className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Add qty</span>
            <div className="flex items-center gap-1">
              <input
                aria-label="Add qty"
                inputMode="numeric"
                autoComplete="off"
                placeholder="qty"
                value={addQtyText}
                onChange={(e) => setAddQtyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void addToOpen();
                  }
                }}
                className="ramsetu-glass-select nf-qty"
              />
              <button
                type="button"
                disabled={busy || !position}
                onClick={() => void addToOpen()}
                className="ramsetu-glass-exec nv-lock"
              >
                Add
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1">
            <span className="ramsetu-glass-toolbar__label">Nikal qty</span>
            <div className="flex items-center gap-1">
              <input
                aria-label="Nikal qty"
                inputMode="numeric"
                autoComplete="off"
                placeholder="qty"
                value={outQtyText}
                onChange={(e) => setOutQtyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void takeOut();
                  }
                }}
                className="ramsetu-glass-select nf-qty"
              />
              <button
                type="button"
                disabled={busy || !position}
                onClick={() => void takeOut()}
                className="ramsetu-glass-stop nv-lock"
              >
                Nikal
              </button>
            </div>
          </label>
          <button
            type="button"
            disabled={busy || side == null || (position != null && !crossed)}
            onClick={() => {
              if (crossed && side) {
                void flipMismatch(side, new Date().toLocaleTimeString("en-IN", { hour12: false }));
                return;
              }
              void sellSignal();
            }}
            className={`nf-btn nv-trade__sell ${side === "PE" ? "nf-bull" : side === "CE" ? "nf-bear" : "nf-flip"}`}
          >
            {sellText}
          </button>
          <button
            type="button"
            disabled={busy || !position}
            onClick={() => void bookOpen("STOP")}
            className="ramsetu-glass-stop nv-stop"
          >
            STOP
          </button>
          <button type="button" disabled={busy} onClick={() => void squareAll()} className="ramsetu-glass-stop nv-stop">
            SQUARE ALL
          </button>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex min-h-0 flex-1 flex-col gap-3">
        {!nifty && (
          <div className="ramsetu-glass-empty">Nifty VWAP trades NIFTY options only. Switch the top index to NIFTY.</div>
        )}

        <div className="ramsetu-glass-card">
          <div className="ramsetu-glass-card__badge">Position</div>
          {!position ? (
            <div className="nv-flat mt-1">Flat</div>
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
                  {livePoints != null ? ` · ${livePoints >= 0 ? "+" : ""}${livePoints.toFixed(2)} pts` : ""}
                </div>
              </div>
              <div>
                <div className="ramsetu-glass-toolbar__label">Target</div>
                <div className="text-[14px] font-extrabold tabular-nums text-cd-green">
                  {targetPx == null ? "Off" : `≤ ${fmtPrice(targetPx)}`}
                </div>
              </div>
              <div>
                <div className="ramsetu-glass-toolbar__label">SL</div>
                <div className="text-[14px] font-extrabold tabular-nums text-cd-red">
                  {slPx == null ? "Off" : `≥ ${fmtPrice(slPx)}`}
                </div>
              </div>
            </div>
          )}
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
                Nifty above VWAP sells the selected PE. Nifty below VWAP sells the selected CE. ATM keeps both
                sides on the ATM strike. 1 sells CE one strike above and PE one strike below, up to 5. A CE short
                books as soon as Nifty crosses above VWAP, then the selected PE is sold. A PE short does the opposite.
                The 1-minute close is not required. CE and PE are never open together.
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
