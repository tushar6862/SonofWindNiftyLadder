import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChainResolved } from "@/types/market";
import { peekLiveTick, useLiveLtp } from "@/context/LiveLtpContext";
import { FastLtp } from "@/components/FastLtp";
import { setHotFocus } from "@/lib/hotFocus";
import { peekTouchPx } from "@/lib/liveQuote";
import { liveAtmStrikeForChain, plausibleSpotPx } from "@/lib/liveAtmStrike";
import { fmtPnl, fmtPrice, fmtQty } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, clearLocalPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import {
  ixOrderRejectedMessage,
  ladderOrderPricing,
  orderLooksFilled,
  orderTradedQty,
  xtsOrderFillPx,
  XTS_IX_ORDER_BASE,
} from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import type { IndexName } from "@/pages/Dashboard";
import { lotSizeForIndex } from "@/lib/lot";
import {
  SIZE_MULTS,
  isSizeMult,
  orderQuantity,
  shortMtm,
  type FlipSide,
  type SizeMult,
} from "@/lib/niftyFlipRules";

const SESSION_KEY = "sow_nifty_fast920_v1";
const POLL_MS = 10000;
const DEFAULT_TARGET = "10";
const GUARD_MS = 200;
/** 0 = both sides ATM. 1 = CE one strike up, PE one strike down. Up to 5. */
const STRIKE_WINGS = [0, 1, 2, 3, 4, 5] as const;
type StrikeWing = (typeof STRIKE_WINGS)[number];

const INDEXES: readonly IndexName[] = ["SENSEX", "NIFTY", "BANKNIFTY"];

function isIndexName(value: string): value is IndexName {
  return (INDEXES as readonly string[]).includes(value);
}

function indexLabel(index: IndexName): string {
  if (index === "SENSEX") return "Sensex";
  if (index === "BANKNIFTY") return "Bank Nifty";
  return "Nifty";
}

function defaultQty(index: IndexName): string {
  return index === "NIFTY" ? "780" : String(lotSizeForIndex(index));
}

function defaultStep(index: IndexName): number {
  return index === "NIFTY" ? 50 : 100;
}

function chainIndexOf(chain: ChainResolved | null): IndexName | null {
  const key = String(chain?.index || "").trim().toUpperCase();
  return isIndexName(key) ? key : null;
}

type CustomPick = { strike: number; side: FlipSide };

type IndexSettings = {
  qtyText: string;
  size: SizeMult;
  wing: StrikeWing;
  targetText: string;
  slText: string;
  custom: CustomPick | null;
};

function defaultSettings(index: IndexName): IndexSettings {
  return { qtyText: defaultQty(index), size: 1, wing: 0, targetText: DEFAULT_TARGET, slText: "", custom: null };
}

function parseIndexQty(raw: string, lot: number): { ok: true; qty: number } | { ok: false; error: string } {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: "Qty must be a positive whole number." };
  const qty = Number(text);
  if (!Number.isSafeInteger(qty) || qty <= 0) return { ok: false, error: "Qty must be a positive whole number." };
  if (!(lot > 0) || qty % lot !== 0) return { ok: false, error: `Qty must be a multiple of ${lot}.` };
  return { ok: true, qty };
}

type VwapSignal = "SELL_PE" | "SELL_CE" | "NONE";

type VwapPayload = {
  ok?: boolean;
  index?: string;
  error?: string;
  waiting?: boolean;
  stale?: boolean;
  source?: string;
  sessionDate?: string;
  futureSymbol?: string;
  open920?: number | null;
  high920?: number | null;
  low920?: number | null;
  close920?: number | null;
  minute?: string | null;
  lastClose?: number | null;
  lastMinute?: string | null;
  signal?: VwapSignal;
  signalLabel?: string;
};

type VwapLog = { id: number; ts: number; text: string; kind: "entry" | "exit" | "error" | "info" };

type VwapPosition = {
  strike: number;
  side: FlipSide;
  qty: number;
  fill: number;
  iid: number;
  segment: number;
  index: IndexName;
  targetText: string;
  slText: string;
};

type SessionStore = {
  settings: Partial<Record<IndexName, IndexSettings>>;
  position: VwapPosition | null;
  logs: VwapLog[];
  logId: number;
};

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

/** Custom replaces the wing on the chosen side. The other side stays ATM. */
function strikeForSide(atm: number, side: FlipSide, wing: StrikeWing, step: number, custom: CustomPick | null): number | null {
  if (custom && custom.side === side) return custom.strike;
  if (!Number.isFinite(atm)) return null;
  return wingStrike(atm, side, custom ? 0 : wing, step);
}

function readCustom(raw: unknown): CustomPick | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<CustomPick>;
  const strike = Number(row.strike);
  if (row.side !== "CE" && row.side !== "PE") return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { strike: Math.round(strike), side: row.side };
}

function parseCustomStrike(raw: string, step: number): { ok: true; strike: number } | { ok: false; error: string } {
  const text = raw.trim().replace(/,/g, "");
  if (!/^\d+$/.test(text)) return { ok: false, error: "Strike likho." };
  const strike = Number(text);
  if (!Number.isSafeInteger(strike) || strike <= 0) return { ok: false, error: "Strike likho." };
  if (step > 0 && strike % step !== 0) return { ok: false, error: `Strike ${step} ke multiple hona chahiye.` };
  return { ok: true, strike };
}

function fmtStrike(strike: number | null): string {
  return strike != null && Number.isFinite(strike) ? Math.round(strike).toLocaleString("en-IN") : "—";
}

function qtyNote(filled: number, requested: number): string {
  return filled === requested ? fmtQty(filled) : `${fmtQty(filled)} of ${fmtQty(requested)}`;
}

/** Premium points. Blank or zero turns that exit off. */
function parsePoints(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const points = Number(text);
  if (!Number.isFinite(points) || points <= 0) return null;
  return points;
}

function readSettings(raw: unknown, index: IndexName): IndexSettings {
  const base = defaultSettings(index);
  if (!raw || typeof raw !== "object") return base;
  const row = raw as Partial<IndexSettings>;
  return {
    qtyText: typeof row.qtyText === "string" ? row.qtyText : base.qtyText,
    size: typeof row.size === "number" && isSizeMult(row.size) ? row.size : base.size,
    wing: readWing(row.wing),
    targetText: typeof row.targetText === "string" ? row.targetText : base.targetText,
    slText: typeof row.slText === "string" ? row.slText : base.slText,
    custom: readCustom(row.custom),
  };
}

function readLogs(raw: unknown): VwapLog[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (row): row is VwapLog =>
        !!row &&
        typeof row === "object" &&
        typeof (row as VwapLog).id === "number" &&
        typeof (row as VwapLog).text === "string",
    )
    .slice(0, 80);
}

function readPosition(raw: unknown, fallback: IndexSettings, fallbackIndex: IndexName = "NIFTY"): VwapPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<VwapPosition>;
  const strike = Number(row.strike);
  const qty = Number(row.qty);
  const fill = Number(row.fill);
  const iid = Number(row.iid);
  const segment = Number(row.segment);
  const tagged = String(row.index || fallbackIndex).trim().toUpperCase();
  if (row.side !== "CE" && row.side !== "PE") return null;
  if (!isIndexName(tagged)) return null;
  if (!Number.isFinite(strike) || strike <= 0) return null;
  if (!Number.isSafeInteger(qty) || qty <= 0) return null;
  if (!Number.isFinite(fill) || fill <= 0) return null;
  if (!Number.isFinite(iid) || iid <= 0) return null;
  if (!Number.isFinite(segment) || segment <= 0) return null;
  return {
    strike,
    side: row.side,
    qty,
    fill,
    iid,
    segment,
    index: tagged,
    targetText: typeof row.targetText === "string" ? row.targetText : fallback.targetText,
    slText: typeof row.slText === "string" ? row.slText : fallback.slText,
  };
}

function loadStore(): SessionStore {
  const empty: SessionStore = { settings: {}, position: null, logs: [], logId: 1 };
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const logs = readLogs(parsed.logs);
    const logId = logs.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    if (parsed.settings && typeof parsed.settings === "object") {
      const settings: Partial<Record<IndexName, IndexSettings>> = {};
      for (const name of INDEXES) {
        const row = (parsed.settings as Record<string, unknown>)[name];
        if (row) settings[name] = readSettings(row, name);
      }
      const niftySettings = settings.NIFTY ?? defaultSettings("NIFTY");
      return {
        settings,
        position: readPosition(parsed.position, niftySettings),
        logs,
        logId,
      };
    }
    const niftySettings = readSettings(parsed, "NIFTY");
    return {
      settings: { NIFTY: niftySettings },
      position: readPosition(parsed.position, niftySettings, "NIFTY"),
      logs,
      logId,
    };
  } catch {
    return empty;
  }
}

function rememberShort(chain: ChainResolved | null, pos: VwapPosition) {
  const expiry = chain && chainIndexOf(chain) === pos.index && chain.expiryApi ? ` ${chain.expiryApi}` : "";
  setLocalShortPosition({
    exchangeInstrumentID: pos.iid,
    exchangeSegment: pos.segment,
    qty: pos.qty,
    fillPx: pos.fill,
    tradingSymbol: `${pos.index}${expiry} ${pos.strike} ${pos.side}`,
  });
}

export default function NiftyFastPanel({
  index,
  chain,
  active,
}: {
  index: IndexName;
  chain: ChainResolved | null;
  active: boolean;
}) {
  const boot = useMemo(() => loadStore(), []);
  const bootSettings = boot.settings[index] ?? defaultSettings(index);
  const [qtyText, setQtyText] = useState(bootSettings.qtyText);
  const [size, setSize] = useState<SizeMult>(bootSettings.size);
  const [wing, setWing] = useState<StrikeWing>(bootSettings.wing);
  const [custom, setCustom] = useState<CustomPick | null>(bootSettings.custom);
  const [customOpen, setCustomOpen] = useState(false);
  const [draftStrike, setDraftStrike] = useState("");
  const [draftSide, setDraftSide] = useState<FlipSide>("CE");
  const [customError, setCustomError] = useState<string | null>(null);
  const [targetText, setTargetText] = useState(bootSettings.targetText);
  const [armedTargetText, setArmedTargetText] = useState(bootSettings.targetText);
  const [targetLocked, setTargetLocked] = useState(true);
  const [slText, setSlText] = useState(bootSettings.slText);
  const [armedSlText, setArmedSlText] = useState(bootSettings.slText);
  const [slLocked, setSlLocked] = useState(parsePoints(bootSettings.slText) != null);
  const [addQtyText, setAddQtyText] = useState("");
  const [outQtyText, setOutQtyText] = useState("");
  const [position, setPosition] = useState<VwapPosition | null>(boot.position);
  const [logs, setLogs] = useState<VwapLog[]>(boot.logs);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<VwapPayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const ltps = useLiveLtp();
  const indexRef = useRef(index);
  const chainRef = useRef(chain);
  const qtyRef = useRef(qtyText);
  const sizeRef = useRef(size);
  const wingRef = useRef(wing);
  const customRef = useRef(custom);
  const targetRef = useRef(armedTargetText);
  const slRef = useRef(armedSlText);
  const slFloorKeyRef = useRef("");
  const slFloorLiveRef = useRef(false);
  const exitArmKeyRef = useRef("");
  const targetFiredRef = useRef(false);
  const slFiredRef = useRef(false);
  const positionRef = useRef(position);
  const quoteRef = useRef(quote);
  const liveSpotRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const flipHoldRef = useRef(false);
  const flipKeyRef = useRef("");
  const flipRetryAtRef = useRef(0);
  const logIdRef = useRef(boot.logId);
  const restoredRef = useRef(false);
  const storeRef = useRef(boot);
  const loadedIndexRef = useRef(index);

  indexRef.current = index;
  chainRef.current = chain;
  qtyRef.current = qtyText;
  sizeRef.current = size;
  wingRef.current = wing;
  customRef.current = custom;
  positionRef.current = position;
  quoteRef.current = quote;

  const lot = lotSizeForIndex(index);
  const chainReady = chain != null && chainIndexOf(chain) === index;
  const parsed = parseIndexQty(qtyText, lot);
  const liveOrderQty = parsed.ok ? orderQuantity(parsed.qty, size) : null;
  const shown = quote && String(quote.index || "").toUpperCase() === index ? quote : null;

  const liveSpot = useMemo(() => {
    if (!chainReady || !chain) return null;
    const spotToken = chain.spotToken;
    if (typeof spotToken === "number" && spotToken > 0) {
      const live = plausibleSpotPx(chain.index, peekTouchPx(spotToken, ltps) ?? ltps[spotToken]);
      if (live != null) return live;
    }
    return plausibleSpotPx(chain.index, chain.spotLtp) ?? null;
  }, [chainReady, chain, ltps]);
  liveSpotRef.current = liveSpot;

  const sessionOpen =
    typeof shown?.open920 === "number" && Number.isFinite(shown.open920) && shown.open920 > 0 ? shown.open920 : null;
  const spotPx = liveSpot != null ? px2(liveSpot) : null;
  const openPx = sessionOpen != null ? px2(sessionOpen) : null;
  const signal: VwapSignal =
    spotPx == null || openPx == null ? "NONE" : spotPx > openPx ? "SELL_PE" : spotPx < openPx ? "SELL_CE" : "NONE";
  const side: FlipSide | null = signal === "SELL_PE" ? "PE" : signal === "SELL_CE" ? "CE" : null;

  const atm = useMemo(() => {
    if (!chainReady || !chain) return Number.NaN;
    const basis = liveSpot ?? (typeof shown?.lastClose === "number" ? shown.lastClose : undefined);
    return liveAtmStrikeForChain(chain, basis);
  }, [chainReady, chain, liveSpot, shown?.lastClose]);

  const step = chainReady && chain && typeof chain.step === "number" && chain.step > 0 ? chain.step : defaultStep(index);
  const ceStrike = strikeForSide(atm, "CE", wing, step, custom);
  const peStrike = strikeForSide(atm, "PE", wing, step, custom);
  const tradeStrike = side === "CE" ? ceStrike : side === "PE" ? peStrike : null;
  const customLive = custom != null && side === custom.side;
  const tradeRow = chainReady && tradeStrike != null ? chain?.instrumentMap?.[String(tradeStrike)] : undefined;
  const tradeIid = side === "CE" ? tradeRow?.ce ?? 0 : side === "PE" ? tradeRow?.pe ?? 0 : 0;
  const tradeLtp = tradeIid > 0 ? peekTouchPx(tradeIid, ltps) : null;
  const signalLabel =
    side == null
      ? "No trade"
      : customLive && tradeStrike != null
        ? `Sell ${side} ${fmtStrike(tradeStrike)}`
        : custom == null && wing > 0 && tradeStrike != null
          ? `Sell ${side} ${fmtStrike(tradeStrike)}`
          : side === "PE"
            ? "Sell ATM PE"
            : "Sell ATM CE";

  const liveLtp = position ? peekTouchPx(position.iid, ltps) : null;
  const mtm = position && liveLtp != null ? shortMtm(position.fill, liveLtp, position.qty) : null;
  const gap = spotPx != null && openPx != null ? px2(spotPx - openPx) : null;

  const pushLog = useCallback((text: string, kind: VwapLog["kind"]) => {
    const id = logIdRef.current++;
    setLogs((prev) => [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 80));
  }, []);

  const fail = useCallback(
    (text: string) => {
      pushLog(text, "error");
      toast({ title: `${indexLabel(indexRef.current)} 1 min Fast`, description: text, variant: "destructive" });
    },
    [pushLog],
  );

  const loadQuote = useCallback(async () => {
    const want = indexRef.current;
    try {
      const res = (await apiFetch(`/api/fast/open920?index=${encodeURIComponent(want)}`)) as VwapPayload;
      if (indexRef.current !== want) return;
      if (res?.index && String(res.index).toUpperCase() !== want) return;
      if (res?.ok) {
        setQuote(res);
        setFetchError(res.stale ? res.error || "Showing the last Fyers session." : null);
      } else {
        setQuote(null);
        setFetchError(res?.error || `${indexLabel(want)} 9:20 open unavailable`);
      }
    } catch (err: unknown) {
      if (indexRef.current !== want) return;
      setFetchError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!active && !position) return;
    void loadQuote();
    const id = window.setInterval(() => void loadQuote(), POLL_MS);
    return () => window.clearInterval(id);
  }, [active, position, loadQuote, index]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const pos = positionRef.current;
    if (pos) rememberShort(chainRef.current, pos);
  }, []);

  useEffect(() => {
    const settingsNow: IndexSettings = {
      qtyText,
      size,
      wing,
      targetText: armedTargetText,
      slText: armedSlText,
      custom,
    };
    if (loadedIndexRef.current !== index) {
      storeRef.current = {
        ...storeRef.current,
        settings: { ...storeRef.current.settings, [loadedIndexRef.current]: settingsNow },
        position,
        logs,
        logId: logIdRef.current,
      };
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(storeRef.current));
      } catch {
        /* ignore quota */
      }
      const next = storeRef.current.settings[index] ?? defaultSettings(index);
      loadedIndexRef.current = index;
      setQtyText(next.qtyText);
      setSize(next.size);
      setWing(next.wing);
      setCustom(next.custom);
      setTargetText(next.targetText);
      setArmedTargetText(next.targetText);
      targetRef.current = next.targetText;
      setTargetLocked(true);
      setSlText(next.slText);
      setArmedSlText(next.slText);
      slRef.current = next.slText;
      setSlLocked(parsePoints(next.slText) != null);
      setQuote(null);
      setFetchError(null);
      return;
    }
    storeRef.current = {
      settings: { ...storeRef.current.settings, [index]: settingsNow },
      position,
      logs,
      logId: logIdRef.current,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(storeRef.current));
    } catch {
      /* ignore quota */
    }
  }, [index, qtyText, size, wing, custom, armedTargetText, armedSlText, position, logs]);

  useEffect(() => {
    setPosition((prev) => {
      if (!prev || prev.index !== index) return prev;
      if (prev.targetText === armedTargetText && prev.slText === armedSlText) return prev;
      return { ...prev, targetText: armedTargetText, slText: armedSlText };
    });
  }, [armedTargetText, armedSlText, index]);

  useEffect(() => {
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (segment: number, iid: number | undefined) => {
      if (!(segment > 0) || typeof iid !== "number" || !(iid > 0) || seen.has(iid)) return;
      seen.add(iid);
      instruments.push({ exchangeSegment: segment, exchangeInstrumentID: iid });
    };
    if (position) add(position.segment, position.iid);
    if (active && chainReady && chain && side) add(chain.optionSegment, tradeIid);
    setHotFocus("fast", instruments);
    return () => setHotFocus("fast", []);
  }, [active, chainReady, chain, position, side, tradeIid]);

  const sendOrder = useCallback(
    async (
      orderSide: "BUY" | "SELL",
      instrumentId: number,
      qty: number,
      segment: number,
    ): Promise<{ ok: true; filledQty: number; fillPx: number } | { ok: false; error: string }> => {
      const tick = peekLiveTick(instrumentId);
      const ltp = peekTouchPx(instrumentId);
      let response: { ok?: boolean; error?: string; raw?: unknown } | null = null;
      try {
        response = (await apiFetch("/api/ix/place_order", {
          method: "POST",
          body: JSON.stringify({
            ...XTS_IX_ORDER_BASE,
            ...ladderOrderPricing(orderSide, ltp, tick?.bid, tick?.ask),
            exchangeSegment: segment,
            exchangeInstrumentID: instrumentId,
            orderSide,
            orderQuantity: qty,
            bookOnlyIfFilled: true,
          }),
        })) as { ok?: boolean; error?: string; raw?: unknown };
      } catch (err: unknown) {
        bumpPositionsRefresh();
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      bumpPositionsRefresh();
      const raw = response?.raw ?? response;
      const filledQty = orderTradedQty(raw, qty);
      if (!orderLooksFilled(raw) || filledQty <= 0) {
        const rejected = ixOrderRejectedMessage(raw) || ixOrderRejectedMessage(response);
        return { ok: false, error: rejected || "Order not filled" };
      }
      const fillPx = xtsOrderFillPx(raw);
      if (fillPx == null) {
        return { ok: false, error: "Order traded, but XTS sent no average traded price. Book left unchanged." };
      }
      return { ok: true, filledQty, fillPx };
    },
    [],
  );

  const sellSide = useCallback(
    async (snapSide: FlipSide, note: string): Promise<boolean> => {
      if (busyRef.current || positionRef.current) return false;
      const selected = indexRef.current;
      const current = chainRef.current;
      if (!current || chainIndexOf(current) !== selected) {
        fail(`${indexLabel(selected)} chain is still loading. Order not sent.`);
        return false;
      }
      const lotNow = lotSizeForIndex(selected);
      const parsedQty = parseIndexQty(qtyRef.current, lotNow);
      if (!parsedQty.ok) {
        fail(parsedQty.error);
        return false;
      }
      const sellQty = orderQuantity(parsedQty.qty, sizeRef.current);
      if (!Number.isSafeInteger(sellQty) || sellQty <= 0 || sellQty % lotNow !== 0) {
        fail(`Order qty must be a positive multiple of ${lotNow}.`);
        return false;
      }
      const segment = current.optionSegment;
      if (!(segment > 0)) {
        fail("Missing option segment. Order not sent.");
        return false;
      }
      const snap = quoteRef.current;
      if (!snap || String(snap.index || "").toUpperCase() !== selected) {
        fail(`${indexLabel(selected)} 9:20 open is still loading. Order not sent.`);
        return false;
      }
      const wingNow = wingRef.current;
      const customNow = customRef.current;
      const stepNow = typeof current.step === "number" && current.step > 0 ? current.step : defaultStep(selected);
      const atmNow = liveAtmStrikeForChain(current, liveSpotRef.current ?? snap.lastClose ?? undefined);
      const picked = strikeForSide(atmNow, snapSide, wingNow, stepNow, customNow);
      const strike = picked ?? Number.NaN;
      const row = current.instrumentMap?.[String(strike)];
      const iid = snapSide === "CE" ? row?.ce : row?.pe;
      if (typeof iid !== "number" || !(iid > 0)) {
        fail(`${Math.round(strike)} ${snapSide} is not in the chain. Order not sent.`);
        return false;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        const sent = await sendOrder("SELL", iid, sellQty, segment);
        if (!sent.ok) {
          fail(sent.error);
          return false;
        }
        const next: VwapPosition = {
          strike,
          side: snapSide,
          qty: sent.filledQty,
          fill: sent.fillPx,
          iid,
          segment,
          index: selected,
          targetText: targetRef.current,
          slText: slRef.current,
        };
        positionRef.current = next;
        setPosition(next);
        rememberShort(chainRef.current, next);
        const strikeText = Math.round(strike).toLocaleString("en-IN");
        const armedTarget = parsePoints(targetRef.current);
        const customHit = customNow != null && customNow.side === snapSide;
        const strikeTag = customHit || (customNow == null && wingNow > 0) ? `${snapSide} ${strikeText}` : `ATM ${snapSide} ${strikeText}`;
        pushLog(
          `${note}: SELL ${strikeTag} × ${qtyNote(sent.filledQty, sellQty)} @ ${fmtPrice(sent.fillPx)} · target ${armedTarget ?? "off"}`,
          "entry",
        );
        toast({
          title: `${indexLabel(selected)} 1 min Fast SELL ${snapSide}`,
          description: `${strikeText} @ ${fmtPrice(sent.fillPx)} · ${qtyNote(sent.filledQty, sellQty)}`,
        });
        return true;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fail, pushLog, sendOrder],
  );

  const sellSignal = useCallback(async () => {
    if (busyRef.current || flipHoldRef.current) return;
    const selected = indexRef.current;
    const label = indexLabel(selected);
    const open = positionRef.current;
    if (open) {
      if (open.index !== selected) {
        fail(`Book the open ${indexLabel(open.index)} short before a ${label} trade.`);
      } else {
        fail(`One short only. The open side books first when ${label} crosses the 9:20 open.`);
      }
      return;
    }
    const snap = quoteRef.current;
    if (!snap || String(snap.index || "").toUpperCase() !== selected) {
      fail(`No trade. ${label} 9:20 open is still loading.`);
      return;
    }
    const spot = liveSpotRef.current;
    const level = snap.open920;
    if (spot == null || typeof level !== "number" || !(level > 0)) {
      fail(`No trade. ${label} spot or 9:20 open is missing.`);
      return;
    }
    const spotNow = px2(spot);
    const openNow = px2(level);
    if (spotNow === openNow) {
      fail(`No trade. ${label} is equal to the 9:20 open.`);
      return;
    }
    const snapSide: FlipSide = spotNow > openNow ? "PE" : "CE";
    await sellSide(snapSide, `spot ${fmtPrice(spotNow)} vs 9:20 open ${fmtPrice(openNow)}`);
  }, [fail, sellSide]);

  const bookOpen = useCallback(
    async (reason: string): Promise<boolean> => {
      if (busyRef.current) return false;
      const open = positionRef.current;
      if (!open) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const sent = await sendOrder("BUY", open.iid, open.qty, open.segment);
        if (!sent.ok) {
          fail(`${reason} book failed. Short still open. ${sent.error}`);
          return false;
        }
        const closed = Math.min(sent.filledQty, open.qty);
        if (closed <= 0) {
          fail(`${reason} book failed. Short still open. Order not filled`);
          return false;
        }
        const bookPx = sent.fillPx;
        const booked = shortMtm(open.fill, bookPx, closed);
        const strike = Math.round(open.strike).toLocaleString("en-IN");
        const points = open.fill - bookPx;
        const name = `${indexLabel(open.index)} 1 min Fast`;
        const title = reason.startsWith("STOP")
          ? `${name} stop`
          : reason.startsWith("TARGET")
            ? `${name} target`
            : reason.startsWith("SL")
              ? `${name} SL`
              : reason.startsWith("NIKAL")
                ? `${name} nikal`
                : reason.startsWith("FLIP")
                  ? `${name} flip`
                  : reason.startsWith("SQUARE")
                    ? `${name} square`
                    : `${name} booked`;
        if (closed < open.qty) {
          const left = open.qty - closed;
          const next: VwapPosition = { ...open, qty: left };
          positionRef.current = next;
          setPosition(next);
          rememberShort(chainRef.current, next);
          pushLog(
            `${reason}: BUY ${strike} ${open.side} × ${qtyNote(closed, open.qty)} @ ${fmtPrice(bookPx)} · ${points >= 0 ? "+" : ""}${points.toFixed(2)} pts · MTM ${fmtPnl(booked)} · left ${fmtQty(left)}. Short still open.`,
            "exit",
          );
          toast({
            title,
            description: `${strike} ${open.side} bought ${qtyNote(closed, open.qty)} · left ${fmtQty(left)}`,
            variant: reason.startsWith("STOP") ? "destructive" : "default",
          });
          return false;
        }
        clearLocalPosition(open.iid, booked);
        positionRef.current = null;
        setPosition(null);
        pushLog(
          `${reason}: BUY ${strike} ${open.side} × ${qtyNote(closed, open.qty)} @ ${fmtPrice(bookPx)} · ${points >= 0 ? "+" : ""}${points.toFixed(2)} pts · MTM ${fmtPnl(booked)}`,
          "exit",
        );
        toast({
          title,
          description: `${strike} ${open.side} @ ${fmtPrice(bookPx)} · MTM ${fmtPnl(booked)}`,
          variant: reason.startsWith("STOP") ? "destructive" : "default",
        });
        return true;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fail, pushLog, sendOrder],
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
      const target = parsePoints(open.targetText);
      const sl = parsePoints(open.slText);
      const profitPts = open.fill - ltp;
      const floorKey = `${open.iid}|${open.qty}|${open.fill}|${sl ?? ""}`;
      if (slFloorKeyRef.current !== floorKey) {
        slFloorKeyRef.current = floorKey;
        slFloorLiveRef.current = false;
      }
      const armKey = `${open.iid}|${open.fill}|${target ?? ""}|${sl ?? ""}`;
      if (exitArmKeyRef.current !== armKey) {
        exitArmKeyRef.current = armKey;
        targetFiredRef.current = false;
        slFiredRef.current = false;
      }
      if (sl != null && profitPts > sl) slFloorLiveRef.current = true;
      if (target != null && profitPts >= target) {
        if (!targetFiredRef.current) {
          targetFiredRef.current = true;
          void bookRef.current(`TARGET ${target} pts`);
        }
      } else if (sl != null && slFloorLiveRef.current && profitPts <= sl) {
        if (!slFiredRef.current) {
          slFiredRef.current = true;
          void bookRef.current(`SL ${sl} pts`);
        }
      } else {
        targetFiredRef.current = false;
        if (sl == null || profitPts > sl) slFiredRef.current = false;
      }
    }, GUARD_MS);
    return () => window.clearInterval(id);
  }, []);

  const flipMismatch = useCallback(
    async (want: FlipSide, minute: string): Promise<boolean> => {
      const open = positionRef.current;
      if (!open || open.index !== indexRef.current || open.side === want || busyRef.current || flipHoldRef.current) return false;
      const snap = quoteRef.current;
      if (!snap || String(snap.index || "").toUpperCase() !== open.index) return false;
      flipHoldRef.current = true;
      const booked = await bookOpen(`FLIP ${minute}`);
      if (!booked || positionRef.current) {
        flipHoldRef.current = false;
        return false;
      }
      const spotNow = liveSpotRef.current != null ? px2(liveSpotRef.current) : null;
      const openNow = typeof snap?.open920 === "number" ? px2(snap.open920) : null;
      const note = `${minute} spot ${fmtPrice(spotNow)} vs 9:20 open ${fmtPrice(openNow)} · booked ${open.side}, sell ${want}`;
      const sold = await sellSide(want, note);
      flipHoldRef.current = false;
      if (!sold) {
        pushLog(`FLIP ${minute}: short booked, new ${want} sell was not filled. Flat. No cover buy.`, "error");
      }
      return sold;
    },
    [bookOpen, pushLog, sellSide],
  );

  useEffect(() => {
    if (spotPx == null || openPx == null || spotPx === openPx || side == null) return;
    const open = positionRef.current;
    if (!open || open.index !== index || open.side === side) return;
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
  }, [index, spotPx, openPx, side, quote?.sessionDate, position?.side, position?.index, position?.iid, flipMismatch]);

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
    setPosition((prev) => {
      if (!prev || prev.index !== indexRef.current) return prev;
      const stamped = { ...prev, targetText: next };
      positionRef.current = stamped;
      return stamped;
    });
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
    setPosition((prev) => {
      if (!prev || prev.index !== indexRef.current) return prev;
      const stamped = { ...prev, slText: next };
      positionRef.current = stamped;
      return stamped;
    });
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
    const parsedAdd = parseIndexQty(addQtyText, lotSizeForIndex(open.index));
    if (!parsedAdd.ok) {
      fail(parsedAdd.error);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const sent = await sendOrder("SELL", open.iid, parsedAdd.qty, open.segment);
      if (!sent.ok) {
        fail(sent.error);
        return;
      }
      const totalQty = open.qty + sent.filledQty;
      const avg = px2((open.fill * open.qty + sent.fillPx * sent.filledQty) / totalQty);
      const next: VwapPosition = { ...open, qty: totalQty, fill: avg };
      positionRef.current = next;
      setPosition(next);
      rememberShort(chainRef.current, next);
      const strike = Math.round(open.strike).toLocaleString("en-IN");
      pushLog(
        `ADD: SELL ${strike} ${open.side} × ${qtyNote(sent.filledQty, parsedAdd.qty)} @ ${fmtPrice(sent.fillPx)} · qty ${fmtQty(open.qty)} → ${fmtQty(totalQty)} · avg ${fmtPrice(avg)}`,
        "entry",
      );
      toast({
        title: `${indexLabel(open.index)} 1 min Fast add`,
        description: `${strike} ${open.side} +${qtyNote(sent.filledQty, parsedAdd.qty)} · now ${fmtQty(totalQty)} @ ${fmtPrice(avg)}`,
      });
      setAddQtyText("");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [addQtyText, fail, pushLog, sendOrder]);

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
    const parsedOut = parseIndexQty(outQtyText, lotSizeForIndex(open.index));
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
      const sent = await sendOrder("BUY", open.iid, parsedOut.qty, open.segment);
      if (!sent.ok) {
        fail(`NIKAL book failed. Short still open. ${sent.error}`);
        return;
      }
      const closed = Math.min(sent.filledQty, open.qty);
      if (closed <= 0) {
        fail("NIKAL book failed. Short still open. Order not filled");
        return;
      }
      const bookPx = sent.fillPx;
      const left = open.qty - closed;
      const strike = Math.round(open.strike).toLocaleString("en-IN");
      const points = open.fill - bookPx;
      const booked = shortMtm(open.fill, bookPx, closed);
      if (left <= 0) {
        clearLocalPosition(open.iid, booked);
        positionRef.current = null;
        setPosition(null);
      } else {
        const next: VwapPosition = { ...open, qty: left };
        positionRef.current = next;
        setPosition(next);
        rememberShort(chainRef.current, next);
      }
      pushLog(
        `NIKAL: BUY ${strike} ${open.side} × ${qtyNote(closed, parsedOut.qty)} @ ${fmtPrice(bookPx)} · ${points >= 0 ? "+" : ""}${points.toFixed(2)} pts · MTM ${fmtPnl(booked)} · left ${fmtQty(left)}`,
        "exit",
      );
      toast({
        title: `${indexLabel(open.index)} 1 min Fast nikal`,
        description: `${strike} ${open.side} −${qtyNote(closed, parsedOut.qty)} · left ${fmtQty(left)} · MTM ${fmtPnl(booked)}`,
      });
      setOutQtyText("");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [bookOpen, fail, outQtyText, pushLog, sendOrder]);

  const squareAll = useCallback(async () => {
    if (busyRef.current) return;
    if (!positionRef.current) {
      pushLog("Square All — flat.", "info");
      toast({ title: `${indexLabel(indexRef.current)} 1 min Fast`, description: "Flat." });
      return;
    }
    await bookOpen("SQUARE ALL");
  }, [bookOpen, pushLog]);

  const crossed = position != null && position.index === index && side != null && position.side !== side;
  const sellStrikeText = tradeStrike != null ? ` ${fmtStrike(tradeStrike)}` : "";
  const sellPxText = tradeLtp != null ? ` @ ${tradeLtp.toFixed(2)}` : "";
  const sellText = crossed
    ? `BOOK ${position.side} · SELL ${side}${sellStrikeText}`
    : side == null
      ? "NO TRADE"
      : position
        ? `${position.side} OPEN`
        : `SELL ${customLive || (custom == null && wing > 0) ? "" : "ATM "}${side}${sellStrikeText}${sellPxText}`;

  const futureName = (shown?.futureSymbol || "").replace(/^(NSE|BSE):/, "") || indexLabel(index);

  const gapClass = gap != null && gap > 0 ? "text-cd-green" : gap != null && gap < 0 ? "text-cd-red" : "";
  const gapText = gap == null ? "—" : `${gap > 0 ? "+" : ""}${gap.toFixed(2)} pts`;
  const targetPts = parsePoints(armedTargetText);
  const draftPts = parsePoints(targetText);
  const draftPending = !targetLocked && targetText.trim() !== armedTargetText.trim();
  const slPts = parsePoints(armedSlText);
  const slDraftPts = parsePoints(slText);
  const slDraftPending = !slLocked && slText.trim() !== armedSlText.trim();
  const bookTargetPts = position ? parsePoints(position.index === index ? armedTargetText : position.targetText) : null;
  const bookSlPts = position ? parsePoints(position.index === index ? armedSlText : position.slText) : null;
  const targetPx = position && bookTargetPts != null ? position.fill - bookTargetPts : null;
  const slPx = position && bookSlPts != null ? position.fill - bookSlPts : null;
  const livePoints = position && liveLtp != null ? position.fill - liveLtp : null;

  const submitCustom = () => {
    const parsedStrike = parseCustomStrike(draftStrike, step);
    if (!parsedStrike.ok) {
      setCustomError(parsedStrike.error);
      return;
    }
    const row = chain?.instrumentMap?.[String(parsedStrike.strike)];
    const iid = draftSide === "CE" ? row?.ce : row?.pe;
    if (typeof iid !== "number" || !(iid > 0)) {
      setCustomError(`${parsedStrike.strike.toLocaleString("en-IN")} ${draftSide} is chain me nahi hai.`);
      return;
    }
    setCustom({ strike: parsedStrike.strike, side: draftSide });
    setCustomError(null);
    setCustomOpen(false);
  };

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[13px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar">
        <div className="nv-stats">
          <div className="nv-stat">
            <div className="nv-kicker">9:20 Open</div>
            <div className="nv-value">{fmtPrice(shown?.open920)}</div>
            <div className="nv-sub">
              {shown?.open920 != null
                ? `O ${fmtPrice(shown.open920)} · H ${fmtPrice(shown.high920)} · L ${fmtPrice(shown.low920)} · C ${fmtPrice(shown.close920)}`
                : futureName}
            </div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">{indexLabel(index)}</div>
            <div className={`nv-value ${gapClass}`}>{fmtPrice(spotPx)}</div>
            <div className={`nv-sub ${gapClass}`}>
              {gapText}
              {shown?.lastMinute ? ` · close ${shown.lastMinute} ${fmtPrice(shown.lastClose)}` : ""}
            </div>
          </div>
          <div className={`nv-stat${signal === "SELL_CE" ? " nv-stat--ce" : signal === "SELL_PE" ? " nv-stat--pe" : ""}`}>
            <div className="nv-kicker">Signal</div>
            <div className={`nv-value nv-value--signal ${gapClass}`}>{signalLabel}</div>
            <div className="nv-sub">
              {indexLabel(index)} vs 9:20 open
            </div>
          </div>
        </div>

        {fetchError && <p className="mt-2 text-[13px] font-semibold text-amber-500">{fetchError}</p>}

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
                  onClick={() => {
                    setCustom(null);
                    setWing(n);
                  }}
                  className={`nv-strike__btn${custom == null && wing === n ? " nv-strike__btn--on" : ""}`}
                >
                  {n === 0 ? "ATM" : n}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  setDraftStrike(custom ? String(custom.strike) : "");
                  setDraftSide(custom?.side ?? side ?? "CE");
                  setCustomError(null);
                  setCustomOpen(true);
                }}
                className={`nv-strike__btn${custom ? " nv-strike__btn--on" : ""}`}
              >
                Custom
              </button>
              <button
                type="button"
                onClick={() => {
                  setCustom(null);
                  setWing(0);
                  setCustomOpen(false);
                }}
                className="nv-strike__btn"
              >
                Reset
              </button>
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
          {custom && (
            <p className="nv-custom-note">
              Custom {custom.side} {fmtStrike(custom.strike)}
            </p>
          )}
        </div>

        {!parsed.ok && <p className="mt-2 text-[12px] font-semibold text-amber-500">{parsed.error}</p>}
        <p className="mt-2 text-[13px] font-semibold tabular-nums text-cd-green">
          Target {targetPts == null ? "off" : `${targetPts} pts`}
          {targetLocked ? " · locked" : ""}
          {position?.index === index && targetPx != null ? ` · book ≤ ${fmtPrice(targetPx)}` : ""}
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
          {position?.index === index && slPx != null ? ` · book if points fall to ${slPts}` : ""}
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
        {!chainReady && <div className="ramsetu-glass-empty">Loading {index} spot and strikes.</div>}
        {position && position.index !== index && (
          <div className="ramsetu-glass-empty">
            Open {indexLabel(position.index)} short. Book it before a {indexLabel(index)} trade.
          </div>
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
                  {position.index} {Math.round(position.strike).toLocaleString("en-IN")} {position.side}
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
                {indexLabel(index)} above the 9:20 open sells the selected PE. {indexLabel(index)} below the 9:20 open sells the selected CE. ATM keeps both
                sides on the ATM strike. 1 sells CE one strike above and PE one strike below, up to 5. A CE short
                books as soon as {indexLabel(index)} crosses above the 9:20 open, then the selected PE is sold. A PE short does the opposite.
                The 1-minute close is not required. CE and PE are never open together. Top bar {indexLabel(index)} trades {indexLabel(index)} only.
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
      {customOpen &&
        createPortal(
          <div className="nv-pop" role="presentation" onMouseDown={() => setCustomOpen(false)}>
            <div
              className="nv-pop__card"
              role="dialog"
              aria-label="Custom strike"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="nv-pop__title">Custom strike</div>
              <label className="flex flex-col gap-1">
                <span className="ramsetu-glass-toolbar__label">Strike</span>
                <input
                  aria-label="Custom strike"
                  inputMode="numeric"
                  autoComplete="off"
                  autoFocus
                  value={draftStrike}
                  onChange={(e) => {
                    setDraftStrike(e.target.value);
                    setCustomError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitCustom();
                    }
                    if (e.key === "Escape") setCustomOpen(false);
                  }}
                  className="ramsetu-glass-select nf-qty"
                />
              </label>
              <div className="nv-pop__sides">
                <button
                  type="button"
                  onClick={() => setDraftSide("CE")}
                  className={`nv-strike__btn nv-pop__side nv-pop__side--ce${draftSide === "CE" ? " nv-strike__btn--on" : ""}`}
                >
                  CE
                </button>
                <button
                  type="button"
                  onClick={() => setDraftSide("PE")}
                  className={`nv-strike__btn nv-pop__side nv-pop__side--pe${draftSide === "PE" ? " nv-strike__btn--on" : ""}`}
                >
                  PE
                </button>
              </div>
              {customError && <p className="nv-pop__error">{customError}</p>}
              <div className="nv-pop__actions">
                <button type="button" onClick={() => setCustomOpen(false)} className="ramsetu-glass-stop nv-lock">
                  Cancel
                </button>
                <button type="button" onClick={submitCustom} className="ramsetu-glass-exec nv-lock">
                  Submit
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
