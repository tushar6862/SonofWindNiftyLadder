import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { shortMtm, type FlipSide } from "@/lib/niftyFlipRules";
import {
  CD_RULES,
  CD_TIMEFRAMES,
  addScore,
  breakSide,
  dayStopHit,
  decideCdAction,
  defaultCdParams,
  draftFromParams,
  entryWindowOpen,
  expiryIsSameIstDay,
  firstEntryClock,
  formatHm,
  insideRange,
  istClock,
  orderQty,
  parseCdParams,
  readCdParams,
  scoreClose,
  squareTime,
  stopPx,
  targetPx,
  trailArmPx,
  trailCoverPx,
  type CdCloseKind,
  type CdParamDraft,
  type CdParams,
} from "@/lib/cdRangeRules";

const SESSION_KEY = "sow_cd_range_v1";
const POLL_MS = 10000;
const GUARD_MS = 200;

type RangeBar = { minute: string; high: number; low: number; close: number };

type RangePayload = {
  ok?: boolean;
  index?: string;
  error?: string;
  waiting?: boolean;
  sessionDate?: string;
  futureSymbol?: string;
  closedCount?: number;
  liveSession?: boolean;
  formingMinute?: string | null;
  tradable?: boolean;
  high?: number | null;
  low?: number | null;
  mid?: number | null;
  gap?: number | null;
  bars?: RangeBar[];
};

type CdLog = { id: number; ts: number; text: string; kind: "entry" | "exit" | "error" | "info" };

type CdPosition = {
  strike: number;
  side: FlipSide;
  qty: number;
  fill: number;
  iid: number;
  segment: number;
  trailArmed: boolean;
};

type SessionStore = {
  sessionDate: string;
  lots: number;
  params: CdParams;
  position: CdPosition | null;
  logs: CdLog[];
  logId: number;
  score: number;
  squared: boolean;
  needInside: boolean;
  insideSeen: boolean;
  sellRetryAt: number;
  started: boolean;
};

function px2(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

function chainIndexOf(chain: ChainResolved | null): IndexName | null {
  const key = String(chain?.index || "").trim().toUpperCase();
  if (key === "SENSEX" || key === "NIFTY" || key === "BANKNIFTY") return key;
  return null;
}

function emptyStore(today: string, params: CdParams = defaultCdParams()): SessionStore {
  return {
    sessionDate: today,
    lots: params.lots,
    params,
    position: null,
    logs: [],
    logId: 1,
    score: 0,
    squared: false,
    needInside: false,
    insideSeen: false,
    sellRetryAt: 0,
    started: false,
  };
}

function readLogs(raw: unknown): CdLog[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (row): row is CdLog =>
        !!row &&
        typeof row === "object" &&
        typeof (row as CdLog).id === "number" &&
        typeof (row as CdLog).text === "string",
    )
    .slice(0, 80);
}

function readPosition(raw: unknown): CdPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<CdPosition>;
  const strike = Number(row.strike);
  const qty = Number(row.qty);
  const fill = Number(row.fill);
  const iid = Number(row.iid);
  const segment = Number(row.segment);
  if (row.side !== "CE" && row.side !== "PE") return null;
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
    trailArmed: row.trailArmed === true,
  };
}

function loadStore(): SessionStore {
  const today = istClock().date;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return emptyStore(today);
    const parsed = JSON.parse(raw) as Partial<SessionStore>;
    const params = readCdParams(parsed.params, parsed.lots);
    if (parsed.sessionDate !== today) return emptyStore(today, params);
    const logs = readLogs(parsed.logs);
    const logId = logs.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    const score = Number(parsed.score);
    return {
      sessionDate: today,
      lots: params.lots,
      params,
      position: readPosition(parsed.position),
      logs,
      logId,
      score: Number.isFinite(score) ? score : 0,
      squared: parsed.squared === true,
      needInside: parsed.needInside === true,
      insideSeen: parsed.insideSeen === true,
      sellRetryAt: Number(parsed.sellRetryAt) > 0 ? Number(parsed.sellRetryAt) : 0,
      started: parsed.started === true,
    };
  } catch {
    return emptyStore(today);
  }
}

function fmtStrike(strike: number | null): string {
  return strike != null && Number.isFinite(strike) ? Math.round(strike).toLocaleString("en-IN") : "—";
}

function qtyNote(filled: number, requested: number): string {
  return filled === requested ? fmtQty(filled) : `${fmtQty(filled)} of ${fmtQty(requested)}`;
}

function CdField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="cd-field">
      <span className="cd-field__label">{label}</span>
      {children}
    </label>
  );
}

function fmtScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function rememberShort(chain: ChainResolved | null, pos: CdPosition) {
  const expiry = chain && chain.expiryApi ? ` ${chain.expiryApi}` : "";
  setLocalShortPosition({
    exchangeInstrumentID: pos.iid,
    exchangeSegment: pos.segment,
    qty: pos.qty,
    fillPx: pos.fill,
    tradingSymbol: `SENSEX${expiry} ${pos.strike} ${pos.side}`,
  });
}

export default function CdRangePanel({
  index,
  chain,
  active,
}: {
  index: IndexName;
  chain: ChainResolved | null;
  active: boolean;
}) {
  const boot = useMemo(() => loadStore(), []);
  const [saved, setSaved] = useState<CdParams>(boot.params);
  const [draft, setDraft] = useState<CdParamDraft>(() => draftFromParams(boot.params));
  const [position, setPosition] = useState<CdPosition | null>(boot.position);
  const [logs, setLogs] = useState<CdLog[]>(boot.logs);
  const [score, setScore] = useState(boot.score);
  const [squared, setSquared] = useState(boot.squared);
  const [needInside, setNeedInside] = useState(boot.needInside);
  const [insideSeen, setInsideSeen] = useState(boot.insideSeen);
  const [sellRetryAt, setSellRetryAt] = useState(boot.sellRetryAt);
  const [started, setStarted] = useState(boot.started);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<RangePayload | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const ltps = useLiveLtp();
  const activeRef = useRef(active);
  const indexRef = useRef(index);
  const chainRef = useRef(chain);
  const lotsRef = useRef(boot.params.lots);
  const lotsOkRef = useRef(true);
  const paramsRef = useRef(boot.params);
  const positionRef = useRef(position);
  const quoteRef = useRef(quote);
  const scoreRef = useRef(score);
  const squaredRef = useRef(squared);
  const needInsideRef = useRef(needInside);
  const insideSeenRef = useRef(insideSeen);
  const sellRetryRef = useRef(sellRetryAt);
  const startedRef = useRef(started);
  const rangeKeyRef = useRef("");
  const liveSpotRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const flipHoldRef = useRef(false);
  const tickingRef = useRef(false);
  const logIdRef = useRef(boot.logId);
  const restoredRef = useRef(false);
  const sessionDateRef = useRef(boot.sessionDate);

  activeRef.current = active;
  indexRef.current = index;
  chainRef.current = chain;
  positionRef.current = position;
  quoteRef.current = quote;
  scoreRef.current = score;
  squaredRef.current = squared;
  needInsideRef.current = needInside;
  insideSeenRef.current = insideSeen;
  sellRetryRef.current = sellRetryAt;
  startedRef.current = started;

  const sensexChain = chain != null && chainIndexOf(chain) === "SENSEX" ? chain : null;
  const qty = orderQty(saved.lots);
  paramsRef.current = saved;
  lotsRef.current = saved.lots;
  lotsOkRef.current = true;

  const liveSpot = useMemo(() => {
    if (!sensexChain) return null;
    const spotToken = sensexChain.spotToken;
    if (typeof spotToken === "number" && spotToken > 0) {
      const live = plausibleSpotPx("SENSEX", peekTouchPx(spotToken, ltps) ?? ltps[spotToken]);
      if (live != null) return live;
    }
    return plausibleSpotPx("SENSEX", sensexChain.spotLtp) ?? null;
  }, [sensexChain, ltps]);
  liveSpotRef.current = liveSpot;

  const high = typeof quote?.high === "number" ? quote.high : null;
  const low = typeof quote?.low === "number" ? quote.low : null;
  const mid = typeof quote?.mid === "number" ? quote.mid : null;
  const gap = typeof quote?.gap === "number" ? quote.gap : null;
  const spotPx = liveSpot != null ? px2(liveSpot) : null;
  const entryFrom = firstEntryClock(saved.candles, saved.barMinutes);
  const side: FlipSide | null =
    spotPx != null && high != null && low != null ? breakSide(spotPx, high, low, saved.extraBreak) : null;
  const sameDayExpiry = sensexChain ? expiryIsSameIstDay(String(sensexChain.expiryApi || "")) : false;
  const stopped = dayStopHit(score);
  const windowOpen = entryWindowOpen(new Date(nowMs), entryFrom);
  const squaredNow = squared || squareTime(new Date(nowMs));

  const step = sensexChain && typeof sensexChain.step === "number" && sensexChain.step > 0 ? sensexChain.step : CD_RULES.strikeStep;
  const atm = useMemo(() => {
    if (!sensexChain) return Number.NaN;
    return liveAtmStrikeForChain(sensexChain, liveSpot ?? undefined);
  }, [sensexChain, liveSpot]);
  const tradeStrike = Number.isFinite(atm) ? atm : null;
  const tradeRow = tradeStrike != null ? sensexChain?.instrumentMap?.[String(tradeStrike)] : undefined;
  const tradeIid = side === "CE" ? tradeRow?.ce ?? 0 : side === "PE" ? tradeRow?.pe ?? 0 : 0;
  const tradeLtp = tradeIid > 0 ? peekTouchPx(tradeIid, ltps) : null;

  const liveLtp = position ? peekTouchPx(position.iid, ltps) : null;
  const mtm = position && liveLtp != null ? shortMtm(position.fill, liveLtp, position.qty) : null;
  const bookTarget = position ? targetPx(position.fill, saved.targetPct) : null;
  const bookStop = position ? stopPx(position.fill, saved.stopPct) : null;
  const bookArm = position ? trailArmPx(position.fill, saved.trailArmPct) : null;
  const bookTrail = position ? trailCoverPx(position.fill, saved.trailLockPct) : null;

  const pushLog = useCallback((text: string, kind: CdLog["kind"]) => {
    const id = logIdRef.current++;
    setLogs((prev) => [{ id, ts: Date.now(), text, kind }, ...prev].slice(0, 80));
  }, []);

  const fail = useCallback(
    (text: string) => {
      pushLog(text, "error");
      toast({ title: "CD", description: text, variant: "destructive" });
    },
    [pushLog],
  );

  const markInside = useCallback((seen: boolean) => {
    insideSeenRef.current = seen;
    setInsideSeen(seen);
  }, []);

  const markNeedInside = useCallback((need: boolean) => {
    needInsideRef.current = need;
    setNeedInside(need);
    if (need) markInside(false);
  }, [markInside]);

  const markSquared = useCallback((value: boolean) => {
    squaredRef.current = value;
    setSquared(value);
  }, []);

  const markRetry = useCallback((at: number) => {
    sellRetryRef.current = at;
    setSellRetryAt(at);
  }, []);

  const applyScore = useCallback(
    (kind: CdCloseKind, sold: number, cover: number) => {
      const points = scoreClose(kind, sold, cover, paramsRef.current.targetPct);
      const next = addScore(scoreRef.current, points);
      scoreRef.current = next;
      setScore(next);
      const label = points > 0 ? `+${fmtScore(points)}` : fmtScore(points);
      return `score ${label} · day ${fmtScore(next)}`;
    },
    [],
  );

  const loadQuote = useCallback(async () => {
    try {
      const rules = paramsRef.current;
      const res = (await apiFetch(
        `/api/cd/range?tf=${rules.barMinutes}&candles=${rules.candles}&gap=${encodeURIComponent(String(rules.minGap))}`,
      )) as RangePayload;
      if (res?.ok) {
        setQuote(res);
        setFetchError(res.error && !res.tradable ? res.error : null);
      } else {
        setQuote(null);
        setFetchError(res?.error || "Sensex range unavailable");
      }
    } catch (err: unknown) {
      setFetchError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const saveParameters = useCallback(() => {
    const parsed = parseCdParams(draft);
    if (!parsed.ok) {
      toast({ title: "Parameters not saved", description: parsed.error });
      return;
    }
    paramsRef.current = parsed.params;
    lotsRef.current = parsed.params.lots;
    setSaved(parsed.params);
    setDraft(draftFromParams(parsed.params));
    toast({ title: "Parameters saved", description: "The desk uses these numbers now. No order was sent." });
    void loadQuote();
  }, [draft, loadQuote]);

  useEffect(() => {
    if (!active && !position) return;
    void loadQuote();
    const id = window.setInterval(() => void loadQuote(), POLL_MS);
    return () => window.clearInterval(id);
  }, [active, position, loadQuote]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const pos = positionRef.current;
    if (pos) rememberShort(chainRef.current, pos);
  }, []);

  useEffect(() => {
    const store: SessionStore = {
      sessionDate: sessionDateRef.current,
      lots: saved.lots,
      params: saved,
      position,
      logs,
      logId: logIdRef.current,
      score,
      squared,
      needInside,
      insideSeen,
      sellRetryAt,
      started,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(store));
    } catch {
      /* ignore quota */
    }
  }, [saved, position, logs, score, squared, needInside, insideSeen, sellRetryAt, started]);

  useEffect(() => {
    if (high == null || low == null) return;
    const key = `${quote?.sessionDate ?? ""}|${high}|${low}`;
    if (rangeKeyRef.current === key) return;
    rangeKeyRef.current = key;
    if (!needInsideRef.current) return;
    const spot = liveSpotRef.current;
    markInside(spot != null && insideRange(spot, high, low));
  }, [high, low, quote?.sessionDate, markInside]);

  useEffect(() => {
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (segment: number, iid: number | undefined) => {
      if (!(segment > 0) || typeof iid !== "number" || !(iid > 0) || seen.has(iid)) return;
      seen.add(iid);
      instruments.push({ exchangeSegment: segment, exchangeInstrumentID: iid });
    };
    if (position) add(position.segment, position.iid);
    if (active && sensexChain && side) add(sensexChain.optionSegment, tradeIid);
    setHotFocus("cd", instruments);
    return () => setHotFocus("cd", []);
  }, [active, sensexChain, position, side, tradeIid]);

  const sendOrder = useCallback(
    async (
      orderSide: "BUY" | "SELL",
      instrumentId: number,
      orderQuantity: number,
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
            orderQuantity,
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
      if (Date.now() < sellRetryRef.current) return false;
      const deny = (text: string) => {
        markRetry(Date.now() + CD_RULES.sellRetryMs);
        fail(`${text} Next sell try in 60s.`);
        return false as const;
      };
      const current = chainRef.current;
      if (!current || chainIndexOf(current) !== "SENSEX") return deny("Select SENSEX. Order not sent.");
      if (expiryIsSameIstDay(String(current.expiryApi || ""))) {
        return deny("Expiry is today. CD uses the next Thursday. Order not sent.");
      }
      const sellQty = orderQty(lotsRef.current);
      if (!Number.isSafeInteger(sellQty) || sellQty <= 0 || sellQty % CD_RULES.lotSize !== 0) {
        return deny(`Qty must be ${CD_RULES.lotSize} times lots 1–${CD_RULES.lotsMax}.`);
      }
      const segment = current.optionSegment;
      if (!(segment > 0)) return deny("Missing option segment. Order not sent.");
      const atmNow = liveAtmStrikeForChain(current, liveSpotRef.current ?? undefined);
      const row = current.instrumentMap?.[String(atmNow)];
      const iid = snapSide === "CE" ? row?.ce : row?.pe;
      if (typeof iid !== "number" || !(iid > 0) || !Number.isFinite(atmNow)) {
        return deny(`ATM ${snapSide} is not in the chain. Order not sent.`);
      }
      busyRef.current = true;
      setBusy(true);
      try {
        const sent = await sendOrder("SELL", iid, sellQty, segment);
        if (!sent.ok) {
          markRetry(Date.now() + CD_RULES.sellRetryMs);
          fail(`${sent.error} Next sell try in 60s.`);
          return false;
        }
        const next: CdPosition = {
          strike: atmNow,
          side: snapSide,
          qty: sent.filledQty,
          fill: sent.fillPx,
          iid,
          segment,
          trailArmed: false,
        };
        positionRef.current = next;
        setPosition(next);
        rememberShort(chainRef.current, next);
        const strikeText = Math.round(atmNow).toLocaleString("en-IN");
        pushLog(
          `${note}: SELL ATM ${snapSide} ${strikeText} × ${qtyNote(sent.filledQty, sellQty)} @ ${fmtPrice(sent.fillPx)}`,
          "entry",
        );
        toast({
          title: `CD SELL ${snapSide}`,
          description: `${strikeText} @ ${fmtPrice(sent.fillPx)} · ${qtyNote(sent.filledQty, sellQty)}`,
        });
        return true;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [fail, markRetry, pushLog, sendOrder],
  );

  const cover = useCallback(
    async (kind: CdCloseKind, reason: string): Promise<boolean> => {
      if (busyRef.current) return false;
      const open = positionRef.current;
      if (!open) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const sent = await sendOrder("BUY", open.iid, open.qty, open.segment);
        if (!sent.ok) {
          fail(`${reason} cover failed. Short still open. ${sent.error}`);
          return false;
        }
        const closed = Math.min(sent.filledQty, open.qty);
        if (closed <= 0) {
          fail(`${reason} cover failed. Short still open. Order not filled`);
          return false;
        }
        const bookPx = sent.fillPx;
        const booked = shortMtm(open.fill, bookPx, closed);
        const strike = Math.round(open.strike).toLocaleString("en-IN");
        if (closed < open.qty) {
          const left = open.qty - closed;
          const next: CdPosition = { ...open, qty: left };
          positionRef.current = next;
          setPosition(next);
          rememberShort(chainRef.current, next);
          pushLog(
            `${reason}: BUY ${strike} ${open.side} × ${qtyNote(closed, open.qty)} @ ${fmtPrice(bookPx)} · left ${fmtQty(left)}. Short still open.`,
            "exit",
          );
          return false;
        }
        positionRef.current = null;
        setPosition(null);
        clearLocalPosition(open.iid, booked);
        if (kind === "TARGET" || kind === "SL" || kind === "TRAIL" || kind === "MID" || kind === "MANUAL") {
          markNeedInside(true);
        }
        if (kind === "SQUARE") markSquared(true);
        const scored = applyScore(kind, open.fill, bookPx);
        pushLog(
          `${reason}: BUY ${strike} ${open.side} × ${qtyNote(closed, open.qty)} @ ${fmtPrice(bookPx)} · sold ${fmtPrice(open.fill)} · MTM ${fmtPnl(booked)} · ${scored}`,
          "exit",
        );
        toast({
          title: `CD ${reason}`,
          description: `${strike} ${open.side} @ ${fmtPrice(bookPx)} · ${scored}`,
          variant: kind === "SL" ? "destructive" : "default",
        });
        if (dayStopHit(scoreRef.current)) {
          pushLog(`Day stop ${CD_RULES.dayStop}. No new entry and no flip.`, "info");
        }
        return true;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [applyScore, fail, markNeedInside, markSquared, pushLog, sendOrder],
  );

  const coverRef = useRef(cover);
  const sellRef = useRef(sellSide);
  const pushRef = useRef(pushLog);
  const markInsideRef = useRef(markInside);
  const markSquaredRef = useRef(markSquared);
  coverRef.current = cover;
  sellRef.current = sellSide;
  pushRef.current = pushLog;
  markInsideRef.current = markInside;
  markSquaredRef.current = markSquared;

  useEffect(() => {
    const id = window.setInterval(() => {
      void (async () => {
        if (tickingRef.current || busyRef.current || flipHoldRef.current) return;
        tickingRef.current = true;
        try {
          const today = istClock().date;
          if (sessionDateRef.current !== today) {
            sessionDateRef.current = today;
            scoreRef.current = 0;
            setScore(0);
            markSquaredRef.current(false);
            markNeedInside(false);
            markInsideRef.current(false);
            sellRetryRef.current = 0;
            setSellRetryAt(0);
            startedRef.current = false;
            setStarted(false);
            pushRef.current(
              positionRef.current
                ? "New session. Day score reset. The open short is still managed."
                : "New session. Day score reset.",
              "info",
            );
            return;
          }

          const open = positionRef.current;
          const spot = liveSpotRef.current;
          const snap = quoteRef.current;
          const rangeHigh = typeof snap?.high === "number" ? snap.high : null;
          const rangeLow = typeof snap?.low === "number" ? snap.low : null;
          const rangeMid = typeof snap?.mid === "number" ? snap.mid : null;
          const now = new Date();
          const rules = paramsRef.current;
          const from = firstEntryClock(rules.candles, rules.barMinutes);
          if (squareTime(now)) markSquaredRef.current(true);

          if (needInsideRef.current && spot != null && rangeHigh != null && rangeLow != null && insideRange(spot, rangeHigh, rangeLow)) {
            if (!insideSeenRef.current) markInsideRef.current(true);
          }

          if (open) {
            const ltp = peekTouchPx(open.iid);
            const sane = ltp != null && !(open.fill >= 5 && ltp < 0.5);
            const action = decideCdAction({
              squareTime: squareTime(now),
              side: open.side,
              spot,
              high: rangeHigh,
              low: rangeLow,
              mid: rangeMid,
              midOn: rules.midStop,
              sold: open.fill,
              ltp: sane ? ltp : null,
              trailArmed: open.trailArmed,
              extraBreak: rules.extraBreak,
              stopPct: rules.stopPct,
              targetPct: rules.targetPct,
              trailArmPct: rules.trailArmPct,
              trailLockPct: rules.trailLockPct,
            });
            if (!action) return;
            if (action.type === "ARM_TRAIL") {
              const next = { ...open, trailArmed: true };
              positionRef.current = next;
              setPosition(next);
              pushRef.current(
                `Trail armed at ${fmtPrice(trailArmPx(open.fill, rules.trailArmPct))}. Cover if LTP comes back to ${fmtPrice(trailCoverPx(open.fill, rules.trailLockPct))}.`,
                "info",
              );
              return;
            }
            if (action.type === "OPPOSITE") {
              flipHoldRef.current = true;
              try {
                const booked = await coverRef.current("OPPOSITE", "OPPOSITE");
                if (!booked || positionRef.current) return;
                const snapNow = quoteRef.current;
                const gapNow = typeof snapNow?.gap === "number" ? snapNow.gap : null;
                const chainNow = chainRef.current;
                const expiryToday = chainNow ? expiryIsSameIstDay(String(chainNow.expiryApi || "")) : true;
                const allowFlip =
                  startedRef.current &&
                  lotsOkRef.current &&
                  indexRef.current === "SENSEX" &&
                  chainIndexOf(chainNow) === "SENSEX" &&
                  snapNow?.liveSession === true &&
                  snapNow?.tradable === true &&
                  gapNow != null &&
                  gapNow >= rules.minGap &&
                  entryWindowOpen(now, from) &&
                  !squareTime() &&
                  !squaredRef.current &&
                  !dayStopHit(scoreRef.current) &&
                  !expiryToday &&
                  Date.now() >= sellRetryRef.current;
                if (!allowFlip) {
                  const why = !startedRef.current
                    ? "START is off."
                    : !entryWindowOpen(now, from) || squareTime()
                    ? "After 14:30."
                    : dayStopHit(scoreRef.current)
                      ? `Day stop ${CD_RULES.dayStop}.`
                      : gapNow != null && gapNow < rules.minGap
                        ? `Gap under ${rules.minGap}.`
                        : expiryToday
                          ? "Expiry is today."
                          : "Flip not allowed.";
                  pushRef.current(`OPPOSITE covered. ${why} No flip.`, "info");
                  return;
                }
                const sold = await sellRef.current(action.next, `FLIP spot ${fmtPrice(spot)} · booked ${open.side}, sell ${action.next}`);
                if (!sold && !positionRef.current) {
                  pushRef.current("Flip sell was not filled. Flat. Next sell try in 60s.", "error");
                }
              } finally {
                flipHoldRef.current = false;
              }
              return;
            }
            const kind: CdCloseKind =
              action.type === "SQUARE" ? "SQUARE" : action.type === "MID" ? "MID" : action.type === "SL" ? "SL" : action.type === "TARGET" ? "TARGET" : "TRAIL";
            const reason =
              kind === "SQUARE"
                ? "SQUARE 15:14"
                : kind === "MID"
                  ? "MID"
                  : kind === "SL"
                    ? `SL ${rules.stopPct}%`
                    : kind === "TARGET"
                      ? `TARGET ${rules.targetPct}%`
                      : "TRAIL";
            await coverRef.current(kind, reason);
            return;
          }

          if (!activeRef.current || !startedRef.current || indexRef.current !== "SENSEX" || !lotsOkRef.current) return;
          const chainNow = chainRef.current;
          if (!chainNow || chainIndexOf(chainNow) !== "SENSEX") return;
          if (!snap || snap.liveSession !== true || snap.tradable !== true || rangeHigh == null || rangeLow == null) return;
          if (spot == null) return;
          if (squaredRef.current || squareTime(now) || !entryWindowOpen(now, from)) return;
          if (dayStopHit(scoreRef.current)) return;
          if (expiryIsSameIstDay(String(chainNow.expiryApi || ""))) return;
          if (needInsideRef.current && !insideSeenRef.current) return;
          if (Date.now() < sellRetryRef.current) return;
          const want = breakSide(spot, rangeHigh, rangeLow, rules.extraBreak);
          if (!want) return;
          await sellRef.current(
            want,
            `spot ${fmtPrice(px2(spot))} ${want === "PE" ? "above HIGH" : "below LOW"} ${fmtPrice(want === "PE" ? rangeHigh : rangeLow)}`,
          );
        } finally {
          tickingRef.current = false;
        }
      })();
    }, GUARD_MS);
    return () => window.clearInterval(id);
  }, [markNeedInside]);

  const arm = useCallback(() => {
    if (busyRef.current) return;
    if (startedRef.current) {
      startedRef.current = false;
      setStarted(false);
      pushLog("START off. No new sell until START.", "info");
      toast({ title: "CD", description: "Disarmed. No new sell." });
      return;
    }
    if (squaredRef.current || squareTime()) {
      fail("15:14 square. No more orders today.");
      return;
    }
    if (dayStopHit(scoreRef.current)) {
      fail(`Day stop ${CD_RULES.dayStop}. No new entry.`);
      return;
    }
    startedRef.current = true;
    setStarted(true);
    pushLog("START. CD sells the next HIGH or LOW break.", "info");
    toast({ title: "CD START", description: "Armed. The next break sells the ATM." });
  }, [fail, pushLog]);

  const squareAll = useCallback(async () => {
    if (busyRef.current) return;
    startedRef.current = false;
    setStarted(false);
    if (!positionRef.current) {
      pushLog("STOP. Flat. START is off.", "info");
      toast({ title: "CD", description: "Flat. START is off." });
      return;
    }
    await cover("MANUAL", "STOP");
  }, [cover, pushLog]);

  const retryLeft = Math.max(0, Math.ceil((sellRetryAt - nowMs) / 1000));
  const rangeReady = (quote?.closedCount ?? 0) >= saved.candles && gap != null && gap >= saved.minGap;
  const tradeOn = rangeReady && side != null;
  const signalText = tradeOn ? "TRADE" : "NO TRADE";
  const signalSide = tradeOn ? side : null;
  const entryLabel = formatHm(entryFrom[0], entryFrom[1]);
  const draftDirty =
    draft.barMinutes !== String(saved.barMinutes) ||
    draft.candles !== String(saved.candles) ||
    draft.lots !== String(saved.lots) ||
    draft.minGap !== String(saved.minGap) ||
    draft.midStop !== saved.midStop ||
    draft.stopPct !== String(saved.stopPct) ||
    draft.trailArmPct !== String(saved.trailArmPct) ||
    draft.trailLockPct !== String(saved.trailLockPct) ||
    draft.extraBreak !== String(saved.extraBreak) ||
    draft.targetPct !== String(saved.targetPct);
  const block =
    index !== "SENSEX"
      ? "Select SENSEX on the top bar."
      : !sensexChain
        ? "Loading the Sensex chain."
        : sameDayExpiry
          ? "Expiry is today. CD uses the next Thursday."
          : quote?.liveSession === false
            ? "Not the live cash session."
            : (quote?.closedCount ?? 0) < saved.candles
              ? `Need ${saved.candles} closed ${saved.barMinutes}-minute bars. First entry is ${entryLabel}.`
              : gap != null && gap < saved.minGap
                ? `HIGH − LOW is under ${saved.minGap}. No trade.`
                : squaredNow
                  ? "15:14 square. No more orders today."
                  : !windowOpen
                    ? "No new entry after 14:30. An open short still exits."
                    : stopped
                      ? `Day stop ${fmtScore(score)} / ${CD_RULES.dayStop}. No new entry and no flip.`
                      : !started
                        ? "Press START. No sell until CD is armed."
                      : needInside && !insideSeen
                        ? "Wait for a print inside HIGH and LOW, then a new break."
                        : retryLeft > 0
                          ? `Failed sell. Next try in ${retryLeft}s.`
                          : position
                            ? `${position.side} short is open.`
                            : side
                              ? "Break is live. CD sells the ATM on this print."
                              : "Spot is inside the range.";

  const gapClass = side === "PE" ? "text-cd-green" : side === "CE" ? "text-cd-red" : "";
  const barText =
    quote?.bars && quote.bars.length
      ? quote.bars.map((bar) => bar.minute).join(" · ")
      : `${quote?.closedCount ?? 0} / ${saved.candles} closed`;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[13px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar">
        <div className="nv-stats">
          <div className="nv-stat">
            <div className="nv-kicker">HIGH</div>
            <div className="nv-value">{fmtPrice(high)}</div>
            <div className="nv-sub">{barText}</div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">LOW</div>
            <div className="nv-value">{fmtPrice(low)}</div>
            <div className="nv-sub">MID {fmtPrice(mid)}</div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">Sensex</div>
            <div className={`nv-value ${gapClass}`}>{fmtPrice(spotPx)}</div>
            <div className={`nv-sub ${gapClass}`}>
              {gap == null ? "Gap —" : `Gap ${gap.toFixed(2)}`}
              {quote?.formingMinute ? ` · forming ${quote.formingMinute} out` : ""}
            </div>
          </div>
          <div className={`nv-stat${signalSide === "CE" ? " nv-stat--ce" : signalSide === "PE" ? " nv-stat--pe" : ""}`}>
            <div className="nv-kicker">Signal</div>
            <div className={`nv-value nv-value--signal ${signalSide === "PE" ? "text-cd-green" : signalSide === "CE" ? "text-cd-red" : ""}`}>
              {signalText}
            </div>
            <div className={`nv-sub text-[18px] font-extrabold ${signalSide === "PE" ? "text-cd-green" : signalSide === "CE" ? "text-cd-red" : ""}`}>
              {signalSide == null
                ? "—"
                : `${signalSide}${tradeStrike != null ? ` ${fmtStrike(tradeStrike)}` : ""}`}
            </div>
          </div>
          <div className="nv-stat">
            <div className="nv-kicker">Day score</div>
            <div className={`nv-value ${stopped ? "text-cd-red" : ""}`}>{fmtScore(score)}</div>
            <div className="nv-sub">stop at {CD_RULES.dayStop}</div>
          </div>
        </div>

        <div className="cd-trade">
          <p className="cd-trade__status">{block}</p>
          <div className="cd-trade__actions">
            <button type="button" disabled={busy} onClick={arm} className="ramsetu-glass-exec">
              {started ? "ARMED" : "START"}
            </button>
            <button type="button" disabled={busy} onClick={() => void squareAll()} className="ramsetu-glass-stop nv-stop">
              STOP
            </button>
          </div>
        </div>

        {fetchError && <p className="mt-2 text-[13px] font-semibold text-amber-500">{fetchError}</p>}

        <div className="cd-params">
          <div className="cd-params__grid">
            <CdField label="Lots">
              <input
                aria-label="Lots"
                inputMode="numeric"
                autoComplete="off"
                value={draft.lots}
                onChange={(e) => setDraft((row) => ({ ...row, lots: e.target.value.replace(/[^\d]/g, "").slice(0, 2) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </CdField>
            <CdField label="Range timeframe (min)">
              <select
                aria-label="Range timeframe (min)"
                value={draft.barMinutes}
                onChange={(e) => setDraft((row) => ({ ...row, barMinutes: e.target.value }))}
                className="ramsetu-glass-select cd-field__control"
              >
                {CD_TIMEFRAMES.map((tf) => (
                  <option key={tf} value={String(tf)}>
                    {tf}
                  </option>
                ))}
              </select>
            </CdField>
            <CdField label="Range candles">
              <input
                aria-label="Range candles"
                inputMode="numeric"
                autoComplete="off"
                value={draft.candles}
                onChange={(e) => setDraft((row) => ({ ...row, candles: e.target.value.replace(/[^\d]/g, "").slice(0, 2) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </CdField>
            <CdField label="Min range gap (pts)">
              <input
                aria-label="Min range gap (pts)"
                inputMode="decimal"
                autoComplete="off"
                value={draft.minGap}
                onChange={(e) => setDraft((row) => ({ ...row, minGap: e.target.value.replace(/[^\d.]/g, "").slice(0, 8) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </CdField>
            <CdField label="Rolling MID stop-loss">
              <span className="cd-field__check">
                <input
                  aria-label="Rolling MID stop-loss"
                  type="checkbox"
                  checked={draft.midStop}
                  onChange={(e) => setDraft((row) => ({ ...row, midStop: e.target.checked }))}
                />
              </span>
            </CdField>
            <CdField label="SL % of premium sold">
              <input
                aria-label="SL % of premium sold"
                inputMode="decimal"
                autoComplete="off"
                value={draft.stopPct}
                onChange={(e) => setDraft((row) => ({ ...row, stopPct: e.target.value.replace(/[^\d.]/g, "").slice(0, 6) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </CdField>
            <CdField label="Trail arm (%)">
              <input
                aria-label="Trail arm (%)"
                inputMode="decimal"
                autoComplete="off"
                value={draft.trailArmPct}
                onChange={(e) => setDraft((row) => ({ ...row, trailArmPct: e.target.value.replace(/[^\d.]/g, "").slice(0, 6) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </CdField>
            <CdField label="Trail lock below cost (%)">
              <input
                aria-label="Trail lock below cost (%)"
                inputMode="decimal"
                autoComplete="off"
                value={draft.trailLockPct}
                onChange={(e) => setDraft((row) => ({ ...row, trailLockPct: e.target.value.replace(/[^\d.]/g, "").slice(0, 6) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </CdField>
            <CdField label="Extra break points (pts)">
              <input
                aria-label="Extra break points (pts)"
                inputMode="decimal"
                autoComplete="off"
                value={draft.extraBreak}
                onChange={(e) => setDraft((row) => ({ ...row, extraBreak: e.target.value.replace(/[^\d.]/g, "").slice(0, 8) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </CdField>
            <CdField label="Target % of premium sold">
              <input
                aria-label="Target % of premium sold"
                inputMode="decimal"
                autoComplete="off"
                value={draft.targetPct}
                onChange={(e) => setDraft((row) => ({ ...row, targetPct: e.target.value.replace(/[^\d.]/g, "").slice(0, 6) }))}
                className="ramsetu-glass-select cd-field__control"
              />
            </CdField>
          </div>
          <div className="cd-params__bar">
            <span className="cd-params__qty">
              Order qty {saved.lots} × {CD_RULES.lotSize} = {fmtQty(qty)}
            </span>
            <span className="cd-params__note">
              {draftDirty ? "Not saved. The desk still uses the last save." : "Saved. Editing a box does not send an order."}
            </span>
            <button type="button" onClick={saveParameters} className="ramsetu-glass-exec">
              Save parameters
            </button>
          </div>
        </div>

        {position && (
          <p className="mt-1 text-[13px] font-semibold tabular-nums text-cd-green">
            Target ≤ {fmtPrice(bookTarget)} · trail arms ≤ {fmtPrice(bookArm)}
            {position.trailArmed ? ` · trail stop ${fmtPrice(bookTrail)}` : ""} · SL ≥ {fmtPrice(bookStop)}
          </p>
        )}
      </div>

      <div className="ramsetu-glass-table-wrap flex min-h-0 flex-1 flex-col gap-3">
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
                  SENSEX {Math.round(position.strike).toLocaleString("en-IN")} {position.side}
                </div>
              </div>
              <div>
                <div className="ramsetu-glass-toolbar__label">Qty</div>
                <div className="text-[14px] font-extrabold tabular-nums">{fmtQty(position.qty)}</div>
              </div>
              <div>
                <div className="ramsetu-glass-toolbar__label">Sold</div>
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
              <div>
                <div className="ramsetu-glass-toolbar__label">Trail</div>
                <div className="text-[14px] font-extrabold tabular-nums">{position.trailArmed ? "Armed" : "Off"}</div>
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
                Entry is the live Sensex print, not the candle close. The forming 15-minute bar does not move HIGH or LOW. An opposite HIGH break
                while short the CE covers and sells the ATM PE. A LOW break while short the PE covers and sells the ATM CE. Flips run until 14:30.
                A failed sell waits 60 seconds. A target scores +1 only when the cover fill reached 10%, with one point of slack. Sold 772.32 covered
                766.10 scores 0. A trail scores 0. A losing opposite break scores −0.5. Any other losing exit scores −1.
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
