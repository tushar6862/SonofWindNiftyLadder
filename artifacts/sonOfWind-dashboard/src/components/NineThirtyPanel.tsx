import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainExpiriesResponse, ChainResolved, ChainResolveResponse } from "@/types/market";
import { peekLiveTick, useLiveLtp } from "@/context/LiveLtpContext";
import { FastLtp } from "@/components/FastLtp";
import { setHotFocus } from "@/lib/hotFocus";
import { peekTouchPx } from "@/lib/liveQuote";
import { fmtPnl, fmtPrice, fmtQty } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, clearLocalPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import {
  cdSellPricing,
  ixOrderRejectedMessage,
  marketableLimitPrice,
  orderLooksFilled,
  orderTradedQty,
  xtsOrderFillPx,
  XTS_IX_ORDER_BASE,
} from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import type { IndexName } from "@/pages/Dashboard";
import { lotSizeForIndex } from "@/lib/lot";
import { shortMtm, type FlipSide } from "@/lib/niftyFlipRules";
import { cdChainIsPick, istClock, type CdExpiryPick } from "@/lib/cdRangeRules";
import { subscribeMdTouchline } from "@/lib/mdRegistry";
import { seedChainSpotFromResolve } from "@/lib/seedChainSpot";
import {
  N930,
  N930_NO_EXPIRY,
  bookLots,
  closeBlocksResell,
  dayBookHit,
  dayMtm,
  liveMark,
  loserHit,
  loserPx,
  maxStopHit,
  maxStopPx,
  parseLots,
  pickNearestExpiry,
  pickSellStrike,
  sellQty,
  trailArmPx,
  trailCoverPx,
  trailStep,
  type BookLeg,
  type CloseReason,
  type MtmLeg,
  type PremiumQuote,
} from "@/lib/nineThirtyRules";

const SESSION_KEY = "sow_930_v1";
const GUARD_MS = 200;

type LogKind = "entry" | "exit" | "error" | "info";
type LogRow = { id: number; ts: number; text: string; kind: LogKind };
type ExpiryState = "idle" | "loading" | "ready" | "none" | "error";

type Leg = {
  key: string;
  index: IndexName;
  side: FlipSide;
  strike: number;
  qty: number;
  fill: number;
  iid: number;
  segment: number;
  expiry: string;
  lotSize: number;
  status: "open" | "closed";
  mark: number | null;
  closeReason: CloseReason | null;
  trailArmed: boolean;
  trailLow: number | null;
  openedAt: number;
};

type Store = {
  sessionDate: string;
  lots: number;
  legs: Leg[];
  logs: LogRow[];
  logId: number;
  started: boolean;
  dayBlocked: boolean;
  retryCe: number;
  retryPe: number;
};

const SIDES: FlipSide[] = ["CE", "PE"];

function px2(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

function inr(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-6) return Math.round(rounded).toLocaleString("en-IN");
  return rounded.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function chainIndex(chain: ChainResolved | null): IndexName | null {
  const key = String(chain?.index || "").trim().toUpperCase();
  if (key === "SENSEX" || key === "NIFTY" || key === "BANKNIFTY") return key;
  return null;
}

function emptyStore(today: string): Store {
  return {
    sessionDate: today,
    lots: N930.lotsDefault,
    legs: [],
    logs: [],
    logId: 1,
    started: false,
    dayBlocked: false,
    retryCe: 0,
    retryPe: 0,
  };
}

function readLeg(raw: unknown): Leg | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<Leg>;
  const index = String(row.index || "").toUpperCase();
  const side = row.side;
  const strike = Number(row.strike);
  const qty = Number(row.qty);
  const fill = Number(row.fill);
  const iid = Number(row.iid);
  const segment = Number(row.segment);
  const lotSize = Number(row.lotSize);
  const openedAt = Number(row.openedAt);
  if (index !== "SENSEX" && index !== "NIFTY" && index !== "BANKNIFTY") return null;
  if (side !== "CE" && side !== "PE") return null;
  if (!Number.isFinite(strike) || strike <= 0 || !Number.isSafeInteger(qty) || qty <= 0) return null;
  if (!Number.isFinite(fill) || fill <= 0 || !Number.isFinite(iid) || iid <= 0) return null;
  if (!Number.isFinite(segment) || segment <= 0 || !Number.isFinite(lotSize) || lotSize <= 0) return null;
  const status = row.status === "closed" ? "closed" : "open";
  const mark = Number(row.mark);
  const closeReason =
    row.closeReason === "DAY" ||
    row.closeReason === "LOSS125" ||
    row.closeReason === "STOP15" ||
    row.closeReason === "TRAIL" ||
    row.closeReason === "STOP"
      ? row.closeReason
      : null;
  const trailLow = Number(row.trailLow);
  return {
    key: String(row.key || `${status}:${iid}:${openedAt || 0}`),
    index,
    side,
    strike: Math.round(strike),
    qty,
    fill: px2(fill),
    iid: Math.round(iid),
    segment: Math.round(segment),
    expiry: String(row.expiry || ""),
    lotSize: Math.round(lotSize),
    status,
    mark: Number.isFinite(mark) && mark > 0 ? px2(mark) : null,
    closeReason: status === "closed" ? closeReason : null,
    trailArmed: row.trailArmed === true,
    trailLow: Number.isFinite(trailLow) && trailLow > 0 ? px2(trailLow) : null,
    openedAt: Number.isFinite(openedAt) ? openedAt : Date.now(),
  };
}

function readLogs(raw: unknown): LogRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (row): row is LogRow =>
        !!row && typeof row === "object" && typeof (row as LogRow).id === "number" && typeof (row as LogRow).text === "string",
    )
    .slice(0, 80);
}

function loadStore(): Store {
  const today = istClock().date;
  const empty = emptyStore(today);
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") as Partial<Store> | null;
    if (!parsed || typeof parsed !== "object") return empty;
    const lots = parseLots(String(parsed.lots ?? "")) ?? N930.lotsDefault;
    const legs = Array.isArray(parsed.legs) ? parsed.legs.map(readLeg).filter((leg): leg is Leg => leg != null) : [];
    if (parsed.sessionDate !== today) {
      return { ...empty, lots, legs: legs.filter((leg) => leg.status === "open") };
    }
    const logs = readLogs(parsed.logs);
    return {
      sessionDate: today,
      lots,
      legs,
      logs,
      logId: logs.reduce((max, row) => Math.max(max, row.id), 0) + 1,
      started: parsed.started === true,
      dayBlocked: parsed.dayBlocked === true,
      retryCe: Number(parsed.retryCe) > 0 ? Number(parsed.retryCe) : 0,
      retryPe: Number(parsed.retryPe) > 0 ? Number(parsed.retryPe) : 0,
    };
  } catch {
    return empty;
  }
}

function quotePx(iid: number): number | null {
  const px = peekTouchPx(iid);
  if (px == null || !Number.isFinite(px) || !(px > 0)) return null;
  return px;
}

function chainQuotes(chain: ChainResolved, side: FlipSide): PremiumQuote[] {
  const out: PremiumQuote[] = [];
  for (const [key, row] of Object.entries(chain.instrumentMap || {})) {
    const strike = Number(key);
    const iid = side === "CE" ? row?.ce : row?.pe;
    if (!Number.isFinite(strike) || strike <= 0 || typeof iid !== "number" || !(iid > 0)) continue;
    const premium = quotePx(iid);
    if (premium == null) continue;
    out.push({ strike, premium, iid });
  }
  return out;
}

function legTitle(leg: Leg): string {
  const expiry = leg.expiry ? ` ${leg.expiry}` : "";
  return `${leg.index}${expiry} ${Math.round(leg.strike).toLocaleString("en-IN")} ${leg.side}`;
}

function rememberShort(leg: Leg) {
  setLocalShortPosition({
    exchangeInstrumentID: leg.iid,
    exchangeSegment: leg.segment,
    qty: leg.qty,
    fillPx: leg.fill,
    tradingSymbol: legTitle(leg),
    productType: "NRML",
  });
}

function bookView(legs: Leg[]): { mtm: number; lots: number } | null {
  const mtmLegs: MtmLeg[] = [];
  const bookLegs: BookLeg[] = [];
  for (const leg of legs) {
    const open = leg.status === "open";
    const mark = open ? liveMark(leg.fill, quotePx(leg.iid)) : leg.mark;
    if (mark == null) return null;
    mtmLegs.push({ sold: leg.fill, mark, qty: leg.qty, open });
    bookLegs.push({ side: leg.side, qty: leg.qty, lotSize: leg.lotSize, open, openedAt: leg.openedAt });
  }
  const mtm = dayMtm(mtmLegs);
  if (mtm == null) return null;
  return { mtm, lots: bookLots(bookLegs) };
}

function loss125(legs: Leg[], side: FlipSide): boolean {
  return legs.some((leg) => leg.side === side && leg.status === "closed" && leg.closeReason === "LOSS125");
}

function sideBlocked(legs: Leg[], side: FlipSide): boolean {
  return legs.some((leg) => leg.side === side && leg.status === "closed" && closeBlocksResell(leg.closeReason));
}

function openLeg(legs: Leg[], side: FlipSide): Leg | null {
  return legs.find((leg) => leg.side === side && leg.status === "open") ?? null;
}

function reasonLabel(reason: CloseReason): string {
  if (reason === "DAY") return "DAY BOOK";
  if (reason === "LOSS125") return "125%";
  if (reason === "STOP15") return "15% STOP";
  if (reason === "TRAIL") return "TRAIL";
  return "STOP";
}

/** NRML limit that trades like a market order. EOS stays on the order. */
function n930Pricing(side: "BUY" | "SELL", ltp: number | null, bid?: number | null, ask?: number | null) {
  if (side === "SELL") return { ...cdSellPricing(ltp, bid), timeInForce: "EOS" as const };
  const live = typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0 ? ltp : 0;
  const askN = typeof ask === "number" && Number.isFinite(ask) && ask > 0 ? ask : 0;
  const ref = askN > 0 && live > 0 ? Math.max(askN, live) : askN || live;
  return {
    orderType: "LIMIT" as const,
    timeInForce: "EOS" as const,
    limitPrice: ref > 0 ? marketableLimitPrice("BUY", ref) : 0,
    ...(ref > 0 ? { ltp: ref } : {}),
  };
}

export default function NineThirtyPanel({ index, active }: { index: IndexName; active: boolean }) {
  const boot = useMemo(() => loadStore(), []);
  const [lotsText, setLotsText] = useState(String(boot.lots));
  const [legs, setLegs] = useState<Leg[]>(boot.legs);
  const [logs, setLogs] = useState<LogRow[]>(boot.logs);
  const [started, setStarted] = useState(boot.started);
  const [dayBlocked, setDayBlocked] = useState(boot.dayBlocked);
  const [retryCe, setRetryCe] = useState(boot.retryCe);
  const [retryPe, setRetryPe] = useState(boot.retryPe);
  const [chain, setChain] = useState<ChainResolved | null>(null);
  const [pick, setPick] = useState<CdExpiryPick | null>(null);
  const [expiryState, setExpiryState] = useState<ExpiryState>("idle");
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const ltps = useLiveLtp();
  const activeRef = useRef(active);
  const indexRef = useRef(index);
  const legsRef = useRef(legs);
  const startedRef = useRef(started);
  const dayBlockedRef = useRef(dayBlocked);
  const retryRef = useRef({ CE: boot.retryCe, PE: boot.retryPe });
  const chainRef = useRef<ChainResolved | null>(null);
  const pickRef = useRef<CdExpiryPick | null>(null);
  const expiryStateRef = useRef<ExpiryState>("idle");
  const lotsTextRef = useRef(lotsText);
  const busyRef = useRef(false);
  const tickingRef = useRef(false);
  const logIdRef = useRef(boot.logId);
  const sessionDateRef = useRef(boot.sessionDate);
  const notedRef = useRef<Record<string, string>>({});
  const restoredRef = useRef(false);
  const runRef = useRef<() => Promise<void>>(async () => {});

  activeRef.current = active;
  indexRef.current = index;
  legsRef.current = legs;
  startedRef.current = started;
  dayBlockedRef.current = dayBlocked;
  retryRef.current = { CE: retryCe, PE: retryPe };
  chainRef.current = chain;
  pickRef.current = pick;
  expiryStateRef.current = expiryState;
  lotsTextRef.current = lotsText;

  const istDate = istClock(new Date(nowMs)).date;
  const lotSize = lotSizeForIndex(index);
  const lotsNow = parseLots(lotsText);
  const qtyNow = lotsNow == null ? null : sellQty(lotSize, lotsNow);

  const pushLog = useCallback((text: string, kind: LogKind) => {
    const id = logIdRef.current++;
    setLogs((prev) => [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 80));
  }, []);

  const noteOnce = useCallback(
    (key: string, text: string, kind: LogKind) => {
      if (notedRef.current[key] === text) return;
      notedRef.current[key] = text;
      pushLog(text, kind);
    },
    [pushLog],
  );

  const commitLegs = useCallback((next: Leg[]) => {
    legsRef.current = next;
    setLegs(next);
  }, []);

  const markRetry = useCallback((side: FlipSide, at: number) => {
    retryRef.current = { ...retryRef.current, [side]: at };
    if (side === "CE") setRetryCe(at);
    else setRetryPe(at);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    for (const leg of legsRef.current) {
      if (leg.status === "open") rememberShort(leg);
    }
  }, []);

  useEffect(() => {
    const store: Store = {
      sessionDate: sessionDateRef.current,
      lots: parseLots(lotsText) ?? N930.lotsDefault,
      legs,
      logs,
      logId: logIdRef.current,
      started,
      dayBlocked,
      retryCe,
      retryPe,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(store));
    } catch {
      /* ignore quota */
    }
  }, [lotsText, legs, logs, started, dayBlocked, retryCe, retryPe]);

  useEffect(() => {
    if (!active && !startedRef.current && !legsRef.current.some((leg) => leg.status === "open")) return;
    let cancelled = false;
    const want = index;
    const logOnce = (text: string, kind: LogKind) => {
      if (notedRef.current.expiry === text) return;
      notedRef.current.expiry = text;
      pushLog(text, kind);
    };
    const run = async () => {
      if (!chainRef.current) setExpiryState((prev) => (prev === "ready" ? prev : "loading"));
      let raw: ChainExpiriesResponse;
      try {
        raw = (await apiFetch("/api/chain/expiries", {
          method: "POST",
          body: JSON.stringify({ index: want }),
        })) as ChainExpiriesResponse;
      } catch (err: unknown) {
        if (cancelled || indexRef.current !== want) return;
        setPick(null);
        setChain(null);
        setExpiryState("error");
        logOnce(err instanceof Error ? err.message : "Expiry list failed. No entry.", "error");
        return;
      }
      if (cancelled || indexRef.current !== want) return;
      if (!raw.ok) {
        setPick(null);
        setChain(null);
        setExpiryState("error");
        logOnce(raw.error || "Expiry list failed. No entry.", "error");
        return;
      }
      const nextPick = pickNearestExpiry(raw.expiries ?? []);
      if (!nextPick) {
        setPick(null);
        setChain(null);
        setExpiryState("none");
        logOnce(N930_NO_EXPIRY, "info");
        return;
      }
      setPick(nextPick);
      const held = chainRef.current;
      if (held && chainIndex(held) === want && cdChainIsPick(String(held.expiryApi || ""), String(held.expiryUi || ""), nextPick)) {
        setExpiryState("ready");
        if (notedRef.current.expiry === N930_NO_EXPIRY) notedRef.current.expiry = "";
        return;
      }
      setExpiryState("loading");
      let resolved: ChainResolveResponse;
      try {
        resolved = (await apiFetch("/api/chain/resolve", {
          method: "POST",
          body: JSON.stringify({ index: want, expiry: nextPick.api, wings: N930.wings, skipNotify: true }),
        })) as ChainResolveResponse;
      } catch (err: unknown) {
        if (cancelled || indexRef.current !== want) return;
        setChain(null);
        setExpiryState("error");
        logOnce(err instanceof Error ? err.message : "Nearest expiry chain failed. No entry.", "error");
        return;
      }
      if (cancelled || indexRef.current !== want) return;
      if (!resolved.ok || chainIndex(resolved) !== want || !cdChainIsPick(String(resolved.expiryApi || ""), String(resolved.expiryUi || ""), nextPick)) {
        setChain(null);
        setExpiryState("error");
        logOnce(!resolved.ok ? resolved.error || "Nearest expiry chain failed. No entry." : "Nearest expiry chain failed. No entry.", "error");
        return;
      }
      setChain(resolved);
      seedChainSpotFromResolve(resolved);
      setExpiryState("ready");
      notedRef.current.expiry = "";
      pushLog(`Nearest expiry ${nextPick.label}.`, "info");
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [index, active, istDate, pushLog]);

  useEffect(() => {
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (segment: number, iid: number | undefined) => {
      if (!(segment > 0) || typeof iid !== "number" || !(iid > 0) || seen.has(iid)) return;
      seen.add(iid);
      instruments.push({ exchangeSegment: segment, exchangeInstrumentID: iid });
    };
    const watching = active || started || legs.some((leg) => leg.status === "open");
    if (watching && chain && chain.optionSegment > 0 && chainIndex(chain) === index) {
      for (const row of Object.values(chain.instrumentMap || {})) {
        add(chain.optionSegment, row?.ce);
        add(chain.optionSegment, row?.pe);
      }
    }
    for (const leg of legs) {
      if (leg.status === "open") add(leg.segment, leg.iid);
    }
    let cancelled = false;
    if (instruments.length) void subscribeMdTouchline(instruments, () => cancelled);
    setHotFocus("930", instruments);
    return () => {
      cancelled = true;
      setHotFocus("930", []);
    };
  }, [active, started, chain, legs, index]);

  const sendOrder = useCallback(
    async (
      orderSide: "BUY" | "SELL",
      instrumentId: number,
      orderQuantity: number,
      segment: number,
    ): Promise<{ ok: true; filledQty: number; fillPx: number } | { ok: false; error: string }> => {
      const tick = peekLiveTick(instrumentId);
      const ltp = peekTouchPx(instrumentId);
      const priced = n930Pricing(orderSide, ltp, tick?.bid, tick?.ask);
      if (!(priced.limitPrice > 0)) return { ok: false, error: "No live premium. Order not sent." };
      let response: { ok?: boolean; error?: string; raw?: unknown } | null = null;
      try {
        response = (await apiFetch("/api/ix/place_order", {
          method: "POST",
          body: JSON.stringify({
            ...XTS_IX_ORDER_BASE,
            ...priced,
            exchangeSegment: segment,
            exchangeInstrumentID: instrumentId,
            orderSide,
            orderQuantity,
            productType: "NRML",
            bookOnlyIfFilled: true,
          }),
        })) as { ok?: boolean; error?: string; raw?: unknown };
      } catch (err: unknown) {
        bumpPositionsRefresh();
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      bumpPositionsRefresh();
      const raw = response?.raw ?? response;
      const filledQty = orderTradedQty(raw, orderQuantity);
      if (!orderLooksFilled(raw) || filledQty <= 0) {
        const rejected = ixOrderRejectedMessage(raw) || ixOrderRejectedMessage(response);
        return { ok: false, error: rejected || "Order not filled" };
      }
      const fillPx = xtsOrderFillPx(raw);
      if (fillPx == null) return { ok: false, error: "Order traded, but XTS sent no average traded price." };
      return { ok: true, filledQty, fillPx };
    },
    [],
  );

  const coverLeg = useCallback(
    async (leg: Leg, reason: CloseReason): Promise<"flat" | "open" | "failed"> => {
      if (busyRef.current) return "failed";
      const open = legsRef.current.find((row) => row.key === leg.key && row.status === "open");
      if (!open) return "flat";
      busyRef.current = true;
      setBusy(true);
      try {
        const sent = await sendOrder("BUY", open.iid, open.qty, open.segment);
        if (!sent.ok) {
          pushLog(`${reasonLabel(reason)} cover failed. ${open.side} still open. ${sent.error}`, "error");
          return "failed";
        }
        const closedQty = Math.min(sent.filledQty, open.qty);
        const latest = legsRef.current.find((row) => row.key === open.key) ?? open;
        if (closedQty < latest.qty) {
          const left: Leg = { ...latest, qty: latest.qty - closedQty };
          commitLegs(legsRef.current.map((row) => (row.key === left.key ? left : row)));
          rememberShort(left);
          pushLog(
            `${reasonLabel(reason)}: BUY ${legTitle(open)} × ${fmtQty(closedQty)} of ${fmtQty(open.qty)} @ ${fmtPrice(sent.fillPx)}. Left ${fmtQty(left.qty)}.`,
            "exit",
          );
          return "open";
        }
        const booked = shortMtm(latest.fill, sent.fillPx, closedQty);
        const closed: Leg = {
          ...latest,
          qty: closedQty,
          status: "closed",
          mark: px2(sent.fillPx),
          closeReason: reason,
        };
        commitLegs(legsRef.current.map((row) => (row.key === closed.key ? closed : row)));
        clearLocalPosition(open.iid, booked);
        pushLog(
          `${reasonLabel(reason)}: BUY ${legTitle(open)} × ${fmtQty(closedQty)} @ ${fmtPrice(sent.fillPx)} · sold ${fmtPrice(latest.fill)} · MTM ${fmtPnl(booked)}`,
          "exit",
        );
        toast({
          title: `9:30 ${reasonLabel(reason)}`,
          description: `${legTitle(open)} @ ${fmtPrice(sent.fillPx)}`,
          variant: reason === "LOSS125" || reason === "STOP15" || reason === "STOP" ? "destructive" : "default",
        });
        return "flat";
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [commitLegs, pushLog, sendOrder],
  );

  const sellSide = useCallback(
    async (side: FlipSide): Promise<void> => {
      if (busyRef.current || !startedRef.current || dayBlockedRef.current) return;
      if (Date.now() < retryRef.current[side]) return;
      const book = legsRef.current;
      if (openLeg(book, side)) return;
      if (sideBlocked(book, side)) {
        noteOnce(`block:${side}`, `${side} is booked today. Not sold again.`, "info");
        return;
      }
      if (book.some((leg) => leg.status === "open" && leg.index !== indexRef.current)) {
        noteOnce("index", "Top bar index changed. No new entry while a leg is open.", "info");
        return;
      }
      const lots = parseLots(lotsTextRef.current);
      const qty = lots == null ? null : sellQty(lotSizeForIndex(indexRef.current), lots);
      if (lots == null || qty == null) {
        noteOnce("lots", "Lots must be a whole number from 1 to 50.", "error");
        return;
      }
      notedRef.current.lots = "";
      const chosen = pickRef.current;
      if (!chosen) {
        if (expiryStateRef.current === "none") noteOnce("expiry", N930_NO_EXPIRY, "info");
        return;
      }
      const current = chainRef.current;
      if (!current || chainIndex(current) !== indexRef.current || !cdChainIsPick(String(current.expiryApi || ""), String(current.expiryUi || ""), chosen)) {
        return;
      }
      const quotes = chainQuotes(current, side);
      if (!quotes.length) return;
      const choice = pickSellStrike(quotes);
      if (!choice) {
        noteOnce(`hunt:${side}`, `${side} has no premium at or above 100.`, "info");
        return;
      }
      notedRef.current[`hunt:${side}`] = "";
      const segment = current.optionSegment;
      if (!(segment > 0)) {
        noteOnce("segment", "Missing option segment. Order not sent.", "error");
        return;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        const sent = await sendOrder("SELL", choice.iid, qty, segment);
        if (!sent.ok) {
          markRetry(side, Date.now() + N930.sellRetryMs);
          pushLog(`${side} sell failed. Next try in 3s. ${sent.error}`, "error");
          return;
        }
        const leg: Leg = {
          key: `open:${choice.iid}:${Date.now()}`,
          index: indexRef.current,
          side,
          strike: Math.round(choice.strike),
          qty: sent.filledQty,
          fill: px2(sent.fillPx),
          iid: choice.iid,
          segment,
          expiry: current.expiryUi || chosen.label,
          lotSize: lotSizeForIndex(indexRef.current),
          status: "open",
          mark: null,
          closeReason: null,
          trailArmed: false,
          trailLow: null,
          openedAt: Date.now(),
        };
        commitLegs([leg, ...legsRef.current.filter((row) => row.key !== leg.key)]);
        rememberShort(leg);
        const strikeText = Math.round(choice.strike).toLocaleString("en-IN");
        pushLog(
          `SELL ${side} ${strikeText} × ${fmtQty(sent.filledQty)} of ${fmtQty(qty)} @ ${fmtPrice(sent.fillPx)} · ${chosen.label}`,
          "entry",
        );
        toast({
          title: `9:30 SELL ${side}`,
          description: `${strikeText} @ ${fmtPrice(sent.fillPx)} · ${fmtQty(sent.filledQty)}`,
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [commitLegs, markRetry, noteOnce, pushLog, sendOrder],
  );

  const maybeDayBook = useCallback(async (): Promise<boolean> => {
    if (dayBlockedRef.current) return false;
    const view = bookView(legsRef.current);
    if (!view) return false;
    const hit = dayBookHit(view.mtm, view.lots);
    if (!hit) return false;
    dayBlockedRef.current = true;
    setDayBlocked(true);
    startedRef.current = false;
    setStarted(false);
    const line = (hit === "win" ? N930.dayWinPerLot : N930.dayLossPerLot) * view.lots;
    pushLog(
      `Day book ${hit === "win" ? "+" : "−"}${inr(line)}. Covering open legs. No new entry today.`,
      "info",
    );
    const opens = legsRef.current.filter((leg) => leg.status === "open");
    for (const leg of opens) await coverLeg(leg, "DAY");
    return true;
  }, [coverLeg, pushLog]);

  const maybeSingleLeg = useCallback(async () => {
    const before = legsRef.current;
    const queued: Leg[] = [];
    for (const leg of before) {
      if (leg.status !== "open") continue;
      const other: FlipSide = leg.side === "CE" ? "PE" : "CE";
      if (loss125(before, other)) continue;
      const ltp = liveMark(leg.fill, quotePx(leg.iid));
      if (ltp == null || !loserHit(leg.fill, ltp)) continue;
      queued.push(leg);
    }
    for (const leg of queued) await coverLeg(leg, "LOSS125");

    for (const leg of legsRef.current) {
      if (leg.status !== "open") continue;
      const other: FlipSide = leg.side === "CE" ? "PE" : "CE";
      if (!loss125(legsRef.current, other)) continue;
      const ltp = liveMark(leg.fill, quotePx(leg.iid));
      if (ltp == null) continue;
      if (maxStopHit(leg.fill, ltp)) {
        await coverLeg(leg, "STOP15");
        continue;
      }
      const step = trailStep(leg.fill, ltp, leg.trailArmed, leg.trailLow);
      if (step.armed !== leg.trailArmed || step.low !== leg.trailLow) {
        const next: Leg = { ...leg, trailArmed: step.armed, trailLow: step.low };
        commitLegs(legsRef.current.map((row) => (row.key === next.key ? next : row)));
        if (step.justArmed && step.low != null) {
          pushLog(`${leg.side} trail armed at ${fmtPrice(step.low)}. Cover at ${fmtPrice(trailCoverPx(step.low))}.`, "info");
        }
      }
      if (step.cover) await coverLeg(leg, "TRAIL");
    }
  }, [commitLegs, coverLeg, pushLog]);

  const runGuard = useCallback(async () => {
    if (tickingRef.current || busyRef.current) return;
    tickingRef.current = true;
    try {
      const today = istClock().date;
      if (sessionDateRef.current !== today) {
        sessionDateRef.current = today;
        const kept = legsRef.current.filter((leg) => leg.status === "open");
        commitLegs(kept);
        dayBlockedRef.current = false;
        setDayBlocked(false);
        startedRef.current = false;
        setStarted(false);
        retryRef.current = { CE: 0, PE: 0 };
        setRetryCe(0);
        setRetryPe(0);
        notedRef.current = {};
        pushLog(kept.length ? "New session. Open legs are still managed." : "New session.", "info");
        return;
      }
      if (await maybeDayBook()) return;
      await maybeSingleLeg();
      if (await maybeDayBook()) return;
      if (!startedRef.current || dayBlockedRef.current) return;
      for (const side of SIDES) await sellSide(side);
    } finally {
      tickingRef.current = false;
    }
  }, [commitLegs, maybeDayBook, maybeSingleLeg, pushLog, sellSide]);

  runRef.current = runGuard;

  useEffect(() => {
    const id = window.setInterval(() => {
      void runRef.current();
    }, GUARD_MS);
    return () => window.clearInterval(id);
  }, []);

  const arm = useCallback(() => {
    if (busyRef.current) return;
    if (startedRef.current) {
      startedRef.current = false;
      setStarted(false);
      pushLog("START off. No new sell.", "info");
      toast({ title: "9:30", description: "START is off. No new sell." });
      return;
    }
    if (dayBlockedRef.current) {
      pushLog("Day book exit. No new entry today.", "info");
      toast({ title: "9:30", description: "Day book exit. No new entry today.", variant: "destructive" });
      return;
    }
    startedRef.current = true;
    setStarted(true);
    pushLog("START. Selling both sides now.", "info");
    toast({ title: "9:30 START", description: "Selling CE and PE on the nearest expiry." });
    void runRef.current();
  }, [pushLog]);

  const stopAll = useCallback(async () => {
    if (busyRef.current) return;
    startedRef.current = false;
    setStarted(false);
    const opens = legsRef.current.filter((leg) => leg.status === "open");
    if (!opens.length) {
      pushLog("STOP. Flat. START is off.", "info");
      toast({ title: "9:30", description: "Flat. START is off." });
      return;
    }
    pushLog("STOP. Covering open legs.", "info");
    for (const leg of opens) await coverLeg(leg, "STOP");
  }, [coverLeg, pushLog]);

  const ready =
    !!chain &&
    !!pick &&
    chainIndex(chain) === index &&
    cdChainIsPick(String(chain.expiryApi || ""), String(chain.expiryUi || ""), pick);
  const cePick = ready && chain ? pickSellStrike(chainQuotes(chain, "CE")) : null;
  const pePick = ready && chain ? pickSellStrike(chainQuotes(chain, "PE")) : null;
  const view = bookView(legs);
  const winLine = view && view.lots > 0 ? N930.dayWinPerLot * view.lots : null;
  const lossLine = view && view.lots > 0 ? N930.dayLossPerLot * view.lots : null;
  const foreign = legs.some((leg) => leg.status === "open" && leg.index !== index);
  const retryLeft = (side: FlipSide) => Math.max(0, Math.ceil(((side === "CE" ? retryCe : retryPe) - nowMs) / 1000));
  const ceWait = !openLeg(legs, "CE") && !sideBlocked(legs, "CE") ? retryLeft("CE") : 0;
  const peWait = !openLeg(legs, "PE") && !sideBlocked(legs, "PE") ? retryLeft("PE") : 0;
  const retryWait = Math.max(ceWait, peWait);

  const status = dayBlocked
    ? "Day book exit. No new entry today."
    : expiryState === "none"
      ? N930_NO_EXPIRY
      : expiryState === "error"
        ? "Nearest expiry chain failed. No entry."
        : !ready
          ? pick
            ? `Loading ${pick.label}.`
            : "Loading the nearest expiry."
          : foreign
            ? "Top bar index changed. Open legs still exit. No new entry."
            : lotsNow == null
              ? "Lots must be a whole number from 1 to 50."
              : !started
                ? "Press START. Both sides sell immediately."
                : retryWait > 0
                  ? `Failed sell. Next try in ${retryWait}s.`
                  : "START is on. Selling the cheapest premium at or above 100.";

  const showPx = (iid: number): number | null => {
    const px = peekTouchPx(iid, ltps);
    return px != null && px > 0 ? px : null;
  };

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[13px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar">
        <div className="nv-stats">
          <div className="nv-stat">
            <div className="nv-kicker">Index</div>
            <div className="nv-value">{index}</div>
            <div className="nv-sub">lot {lotSize}</div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">Expiry</div>
            <div className="nv-value">{pick?.label || "—"}</div>
            <div className="nv-sub">nearest on or after today</div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">CE</div>
            <div className="nv-value">{cePick ? fmtPrice(cePick.premium) : "—"}</div>
            <div className="nv-sub">{cePick ? Math.round(cePick.strike).toLocaleString("en-IN") : "premium ≥ 100"}</div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">PE</div>
            <div className="nv-value">{pePick ? fmtPrice(pePick.premium) : "—"}</div>
            <div className="nv-sub">{pePick ? Math.round(pePick.strike).toLocaleString("en-IN") : "premium ≥ 100"}</div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">Day MTM</div>
            <div className={`nv-value ${view && view.mtm >= 0 ? "text-cd-green" : view ? "text-cd-red" : ""}`}>
              {view ? fmtPnl(view.mtm) : "—"}
            </div>
            <div className="nv-sub">
              {winLine != null && lossLine != null
                ? `+${inr(winLine)} / −${inr(lossLine)}`
                : "+500 / −700 per lot"}
            </div>
          </div>
        </div>

        <div className="cd-trade">
          <p className="cd-trade__status">{status}</p>
          <div className="cd-trade__actions">
            <button type="button" disabled={busy} onClick={arm} className="ramsetu-glass-exec">
              {started ? "ARMED" : "START"}
            </button>
            <button type="button" disabled={busy} onClick={() => void stopAll()} className="ramsetu-glass-stop nv-stop">
              STOP
            </button>
          </div>
        </div>

        <div className="cd-params">
          <div className="cd-params__grid">
            <label className="cd-field">
              <span className="cd-field__label">Lots</span>
              <input
                aria-label="Lots"
                inputMode="numeric"
                autoComplete="off"
                value={lotsText}
                onChange={(e) => setLotsText(e.target.value.replace(/[^\d]/g, "").slice(0, 2))}
                className="ramsetu-glass-select cd-field__control"
              />
            </label>
          </div>
          <div className="cd-params__bar">
            <span className="cd-params__qty">
              Order qty {lotsNow ?? "—"} × {lotSize} = {qtyNow == null ? "—" : fmtQty(qtyNow)}
            </span>
            <span className="cd-params__note">One short CE and one short PE. START sells both now.</span>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex min-h-0 flex-1 flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          {SIDES.map((side) => {
            const rows = legs.filter((leg) => leg.side === side);
            const other: FlipSide = side === "CE" ? "PE" : "CE";
            const otherBooked = loss125(legs, other);
            return (
              <div key={side} className="ramsetu-glass-card">
                <div className="ramsetu-glass-card__badge">{side}</div>
                {!rows.length ? (
                  <div className="nv-flat mt-1">Flat</div>
                ) : (
                  <div className="mt-2 flex flex-col gap-3">
                    {rows.map((leg) => {
                      const live = leg.status === "open" ? liveMark(leg.fill, showPx(leg.iid)) : leg.mark;
                      const mtm = live != null ? shortMtm(leg.fill, live, leg.qty) : null;
                      const trail = leg.trailLow != null ? trailCoverPx(leg.trailLow) : null;
                      return (
                        <div key={leg.key} className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
                          <div>
                            <div className="ramsetu-glass-toolbar__label">Strike</div>
                            <div className={`text-[14px] font-extrabold tabular-nums ${side === "PE" ? "ramsetu-glass-table__strike--pe" : "text-cd-green"}`}>
                              {legTitle(leg)}
                            </div>
                          </div>
                          <div>
                            <div className="ramsetu-glass-toolbar__label">Qty</div>
                            <div className="text-[14px] font-extrabold tabular-nums">{fmtQty(leg.qty)}</div>
                          </div>
                          <div>
                            <div className="ramsetu-glass-toolbar__label">Sold</div>
                            <div className="text-[14px] font-extrabold tabular-nums">{fmtPrice(leg.fill)}</div>
                          </div>
                          <div>
                            <div className="ramsetu-glass-toolbar__label">{leg.status === "open" ? "LTP" : "Cover"}</div>
                            {leg.status === "open" ? (
                              <FastLtp iid={leg.iid} as="div" className="text-[14px] font-extrabold tabular-nums" />
                            ) : (
                              <div className="text-[14px] font-extrabold tabular-nums">{fmtPrice(leg.mark)}</div>
                            )}
                          </div>
                          <div>
                            <div className="ramsetu-glass-toolbar__label">MTM</div>
                            <div className={`text-[14px] font-extrabold tabular-nums ${mtm != null && mtm >= 0 ? "text-cd-green" : mtm != null ? "text-cd-red" : ""}`}>
                              {fmtPnl(mtm)}
                            </div>
                          </div>
                          <div>
                            <div className="ramsetu-glass-toolbar__label">{leg.status === "open" ? "Exit" : "Booked"}</div>
                            <div className="text-[14px] font-extrabold tabular-nums">
                              {leg.status === "closed"
                                ? reasonLabel(leg.closeReason || "STOP")
                                : otherBooked
                                  ? `15% ${fmtPrice(maxStopPx(leg.fill))}${leg.trailArmed && trail != null ? ` · trail ${fmtPrice(trail)}` : ` · arm ${fmtPrice(trailArmPx(leg.fill))}`}`
                                  : `125% ${fmtPrice(loserPx(leg.fill))}`}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
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
                START sells one CE and one PE on the nearest broker expiry on or after today. The same day counts.
                The top bar picks the index. A later top-bar expiry is not the contract. Each side sells the cheapest
                live premium at or above 100. 99.99 is not a sell. The same premium sells the lower strike. A side
                with no such premium stays in the hunt while START is on. A failed sell waits 3 seconds. Day MTM is
                the rupee sum of every open and closed leg. At +500 per lot, or −700 per lot, every open leg is
                covered and this tab sends no new entry today. Before that, a leg covers at 125% of the sold premium
                and is not sold again. The remaining leg then stops at 15% above the sold premium. When that premium
                is 60% of the sold price the trail arms, and it covers 15% above the lowest premium after the arm.
                Sold 100 covers at 125, then the other leg covers at 115. The trail arms at 60. A low of 50 covers at
                57.50. STOP covers the open legs and does not block a new START.
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
