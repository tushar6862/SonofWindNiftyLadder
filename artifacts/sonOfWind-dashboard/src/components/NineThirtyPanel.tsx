import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChainExpiriesResponse, ChainResolved, ChainResolveResponse } from "@/types/market";
import { peekFyersWsLtp, peekLiveLtp, subscribeLiveLtp } from "@/context/LiveLtpContext";
import { setHotFocus } from "@/lib/hotFocus";
import { fmtPnl, fmtPrice, fmtQty } from "@/lib/formatNumber";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, clearLocalPosition, setLocalShortPosition } from "@/lib/ixPortfolio";
import { subscribeMdTouchline } from "@/lib/mdRegistry";
import {
  ixOrderPricing,
  ixOrderRejectedMessage,
  orderLooksFilled,
  xtsOwnOrderFill,
  XTS_IX_ORDER_BASE,
} from "@/lib/xtsOrder";
import { toast } from "@/hooks/use-toast";
import type { IndexName } from "@/pages/Dashboard";
import {
  chargeBreakup,
  clockMinutes,
  cutoffFromStart,
  dayLine,
  dayMtm,
  defaultN930Params,
  draftFromParams,
  entryWindow,
  eodDue,
  expiryDayKey,
  fillCounts,
  formatHm,
  goodPremium,
  istClock,
  N930,
  netPnl,
  orderQty,
  pairFillPlan,
  parseN930Params,
  pickCheapest,
  pickNiftyWeek,
  readN930Params,
  slPrice,
  tickActions,
  warmupDue,
  type IstClock,
  type N930Action,
  type N930Draft,
  type N930ExpiryPick,
  type N930Fill,
  type N930LegSnap,
  type N930Params,
  type N930Side,
  type WeekPick,
} from "@/lib/nineThirtyRules";

const SESSION_KEY = "sow_930_v2";
const GUARD_MS = 200;
const CHAIN_MS = 5000;
const ENTRY_BACKOFF_MS = 15_000;
const EXIT_BACKOFF_MS = 2_000;
const TRADE_STRIKES = 30;
const OTHER_STRIKES = 12;
const WINGS = 16;

type LogKind = "entry" | "exit" | "error" | "info";
type N930Log = { id: number; ts: number; text: string; kind: LogKind };
type ClosedBy = "sl" | "leftover" | "square";

type BookLeg = {
  side: N930Side;
  strike: number;
  iid: number;
  segment: number;
  qty: number;
  sold: number;
  slPx: number;
  slOn: boolean;
  lockArmed: boolean;
  lockPct: number;
  open: boolean;
  closedBy: ClosedBy | null;
  coverPx: number | null;
};

type NakedLeg = { side: N930Side; strike: number; iid: number; segment: number; qty: number };

type Quote = { strike: number; iid: number; ltp: number };

type OrderSent = {
  filledQty: number;
  fillPx: number | null;
  rate: number | null;
  counted: boolean;
  foreign: boolean;
  error: string | null;
};

type SessionStore = {
  sessionDate: string;
  params: N930Params;
  legs: BookLeg[];
  fills: N930Fill[];
  realized: number;
  entered: boolean;
  squared: boolean;
  started: boolean;
  logs: N930Log[];
  logId: number;
};

function emptyStore(today: string, params = defaultN930Params()): SessionStore {
  return {
    sessionDate: today,
    params,
    legs: [],
    fills: [],
    realized: 0,
    entered: false,
    squared: false,
    started: false,
    logs: [],
    logId: 1,
  };
}

function fmtStrike(strike: number): string {
  return Math.round(strike).toLocaleString("en-IN");
}

function readLegs(raw: unknown): BookLeg[] {
  if (!Array.isArray(raw)) return [];
  const out: BookLeg[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const leg = row as Partial<BookLeg>;
    if (leg.side !== "CE" && leg.side !== "PE") continue;
    const strike = Number(leg.strike);
    const iid = Number(leg.iid);
    const segment = Number(leg.segment);
    const qty = Number(leg.qty);
    const sold = Number(leg.sold);
    const slPx = Number(leg.slPx);
    if (!(strike > 0) || !(iid > 0) || !(segment > 0) || !(qty > 0) || !(sold > 0) || !(slPx > 0)) continue;
    out.push({
      side: leg.side,
      strike,
      iid,
      segment,
      qty,
      sold,
      slPx,
      slOn: leg.slOn !== false && leg.open !== false,
      lockArmed: leg.lockArmed === true,
      lockPct: Number(leg.lockPct) > 0 ? Number(leg.lockPct) : 0,
      open: leg.open !== false,
      closedBy: leg.closedBy === "sl" || leg.closedBy === "leftover" || leg.closedBy === "square" ? leg.closedBy : null,
      coverPx: Number(leg.coverPx) > 0 ? Number(leg.coverPx) : null,
    });
  }
  return out.slice(0, 2);
}

function readFills(raw: unknown): N930Fill[] {
  if (!Array.isArray(raw)) return [];
  const out: N930Fill[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const fill = row as Partial<N930Fill>;
    if (fill.side !== "BUY" && fill.side !== "SELL") continue;
    const premium = Number(fill.premium);
    const qty = Number(fill.qty);
    if (!(premium > 0) || !(qty > 0)) continue;
    out.push({ side: fill.side, premium, qty });
  }
  return out.slice(0, 8);
}

function loadStore(): SessionStore {
  const today = istClock().date;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return emptyStore(today);
    const parsed = JSON.parse(raw) as Partial<SessionStore>;
    const params = readN930Params(parsed.params);
    if (parsed.sessionDate !== today) return emptyStore(today, params);
    const legacy = parsed as Partial<SessionStore> & { armed?: boolean; live?: boolean };
    const started = legacy.started === true || (legacy.started == null && legacy.armed === true && legacy.live === true);
    const logs = Array.isArray(parsed.logs)
      ? parsed.logs.filter(
          (row): row is N930Log =>
            !!row && typeof row === "object" && typeof row.id === "number" && typeof row.text === "string",
        )
      : [];
    return {
      sessionDate: today,
      params,
      legs: readLegs(parsed.legs),
      fills: readFills(parsed.fills),
      realized: Number(parsed.realized) || 0,
      entered: parsed.entered === true,
      squared: parsed.squared === true,
      started,
      logs: logs.slice(0, 80),
      logId: logs.reduce((max, row) => Math.max(max, row.id), 0) + 1,
    };
  } catch {
    return emptyStore(today);
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="cd-field">
      <span className="cd-field__label">{label}</span>
      {children}
    </label>
  );
}

function FyersPx({ iid }: { iid: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const paint = () => {
      const node = ref.current;
      if (!node) return;
      const px = livePremium(iid);
      node.textContent = px == null ? "—" : px.toFixed(2);
    };
    paint();
    return subscribeLiveLtp(iid, paint);
  }, [iid]);
  return <span ref={ref} className="tabular-nums" />;
}

function chainMatches(chain: ChainResolved, pick: N930ExpiryPick): boolean {
  if (String(chain.expiryApi || "") === pick.api) return true;
  const want = expiryDayKey(pick.label);
  const ui = expiryDayKey(String(chain.expiryUi || ""));
  const api = expiryDayKey(String(chain.expiryApi || ""));
  return want != null && (ui === want || api === want);
}

function livePremium(iid: number): number | null {
  return goodPremium(peekFyersWsLtp(iid)) ?? goodPremium(peekLiveLtp(iid));
}

function quotesFor(chain: ChainResolved, side: N930Side): Quote[] {
  const out: Quote[] = [];
  for (const [key, row] of Object.entries(chain.instrumentMap || {})) {
    const strike = Number(key);
    if (!Number.isFinite(strike) || strike <= 0 || strike % N930.strikeStep !== 0) continue;
    const iid = side === "CE" ? row?.ce : row?.pe;
    if (typeof iid !== "number" || !(iid > 0)) continue;
    const ltp = livePremium(iid);
    if (ltp == null) continue;
    out.push({ strike, iid, ltp });
  }
  return out;
}

function snapOf(leg: BookLeg): N930LegSnap {
  return {
    side: leg.side,
    open: leg.open,
    sold: leg.sold,
    qty: leg.qty,
    ltp: leg.open ? livePremium(leg.iid) : null,
    slPx: leg.slPx,
    slOn: leg.open && leg.slOn,
    lockArmed: leg.lockArmed,
    lockPct: leg.lockPct,
    closedBy: leg.closedBy,
  };
}

function withSavedSl(legs: BookLeg[], params: N930Params): BookLeg[] {
  const open = legs.filter((leg) => leg.open);
  if (open.length < 2) return legs;
  return legs.map((leg) => (leg.open ? { ...leg, slPx: slPrice(leg.sold, params.slPct), slOn: true } : leg));
}

export default function NineThirtyPanel({ index, active }: { index: IndexName; active: boolean }) {
  const boot = useRef<SessionStore | null>(null);
  if (!boot.current) boot.current = loadStore();
  const initial = boot.current;

  const [params, setParams] = useState<N930Params>(initial.params);
  const [draft, setDraft] = useState<N930Draft>(() => draftFromParams(initial.params));
  const [legs, setLegs] = useState<BookLeg[]>(initial.legs);
  const [fills, setFills] = useState<N930Fill[]>(initial.fills);
  const [realized, setRealized] = useState(initial.realized);
  const [entered, setEntered] = useState(initial.entered);
  const [squared, setSquared] = useState(initial.squared);
  const [started, setStarted] = useState(initial.started);
  const [logs, setLogs] = useState<N930Log[]>(initial.logs);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState<{ date: string; pick: WeekPick; trade: ChainResolved; other: ChainResolved | null } | null>(null);
  const [chainNote, setChainNote] = useState("");
  const [markTick, setMarkTick] = useState(0);
  const [focusMinute, setFocusMinute] = useState(() => clockMinutes(istClock()));

  const paramsRef = useRef(params);
  const legsRef = useRef(legs);
  const fillsRef = useRef(fills);
  const realizedRef = useRef(realized);
  const enteredRef = useRef(entered);
  const squaredRef = useRef(squared);
  const startedRef = useRef(started);
  const loadedRef = useRef(loaded);
  const indexRef = useRef(index);
  const activeRef = useRef(active);
  const busyRef = useRef(false);
  const tickingRef = useRef(false);
  const nakedRef = useRef<NakedLeg[]>([]);
  const backoffRef = useRef(0);
  const notedRef = useRef(new Map<string, string>());
  const logIdRef = useRef(initial.logId);
  const sessionDateRef = useRef(initial.sessionDate);
  const shownRef = useRef(0);
  paramsRef.current = params;
  legsRef.current = legs;
  fillsRef.current = fills;
  realizedRef.current = realized;
  enteredRef.current = entered;
  squaredRef.current = squared;
  startedRef.current = started;
  loadedRef.current = loaded;
  indexRef.current = index;
  activeRef.current = active;

  const pushLog = useCallback((text: string, kind: LogKind) => {
    const row: N930Log = { id: logIdRef.current++, ts: Date.now(), text, kind };
    setLogs((prev) => [row, ...prev].slice(0, 80));
  }, []);

  const note = useCallback(
    (key: string, text: string, kind: LogKind) => {
      if (notedRef.current.get(key) === text) return;
      notedRef.current.set(key, text);
      pushLog(text, kind);
    },
    [pushLog],
  );

  const commitLegs = useCallback((next: BookLeg[]) => {
    legsRef.current = next;
    setLegs(next);
  }, []);

  useEffect(() => {
    const store: SessionStore = {
      sessionDate: sessionDateRef.current,
      params,
      legs,
      fills,
      realized,
      entered,
      squared,
      started,
      logs,
      logId: logIdRef.current,
    };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(store));
    } catch {
      /* ignore quota */
    }
  }, [params, legs, fills, realized, entered, squared, started, logs]);

  useEffect(() => {
    if (index !== "NIFTY") return;
    let cancelled = false;
    const load = async () => {
      const clock = istClock();
      const rules = paramsRef.current;
      const mins = clockMinutes(clock);
      const open = legsRef.current.some((leg) => leg.open) || nakedRef.current.length > 0;
      const watching = activeRef.current || startedRef.current || warmupDue(mins, rules) || open || enteredRef.current;
      if (!watching) return;
      const have = loadedRef.current;
      if (have && have.date === clock.date) return;
      try {
        const exp = (await apiFetch("/api/chain/expiries", {
          method: "POST",
          body: JSON.stringify({ index: "NIFTY" }),
        })) as ChainExpiriesResponse;
        if (cancelled || indexRef.current !== "NIFTY") return;
        if (!exp.ok || !exp.expiries?.length) {
          setChainNote(exp.ok === false ? exp.error || "Expiry list failed." : "Expiry list failed.");
          return;
        }
        const pick = pickNiftyWeek(exp.expiries, clock);
        if (!pick) {
          setChainNote("No Tuesday remains. No entry.");
          return;
        }
        const resolveOne = async (row: N930ExpiryPick, wings: number) =>
          (await apiFetch("/api/chain/resolve", {
            method: "POST",
            body: JSON.stringify({ index: "NIFTY", expiry: row.api, wings, skipNotify: true }),
          })) as ChainResolveResponse;
        const tradeRaw = await resolveOne(pick.trade, WINGS);
        if (cancelled || indexRef.current !== "NIFTY") return;
        if (!tradeRaw.ok) {
          setChainNote(tradeRaw.error || "Weekly chain failed. No strikes yet.");
          return;
        }
        const otherPick = pick.trade.api === pick.thisWeek.api ? pick.nextWeek : pick.thisWeek;
        const first = { date: clock.date, pick, trade: tradeRaw, other: null as ChainResolved | null };
        loadedRef.current = first;
        setLoaded(first);
        setChainNote("");
        notedRef.current.delete("chain");
        if (otherPick.api === pick.trade.api) return;
        const otherRaw = await resolveOne(otherPick, 8);
        if (cancelled || indexRef.current !== "NIFTY" || !otherRaw.ok) return;
        const both = { date: clock.date, pick, trade: tradeRaw, other: otherRaw };
        loadedRef.current = both;
        setLoaded(both);
      } catch (err: unknown) {
        if (!cancelled) setChainNote(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const id = window.setInterval(() => void load(), CHAIN_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [index, active]);

  useEffect(() => {
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (segment: number, iid: number) => {
      if (!(segment > 0) || !(iid > 0) || seen.has(iid)) return;
      seen.add(iid);
      instruments.push({ exchangeSegment: segment, exchangeInstrumentID: iid });
    };
    const addChain = (chain: ChainResolved, count: number) => {
      const strikes = Object.keys(chain.instrumentMap || {})
        .map(Number)
        .filter((strike) => strike > 0 && strike % N930.strikeStep === 0)
        .sort((a, b) => Math.abs(a - chain.atmStrike) - Math.abs(b - chain.atmStrike));
      for (const strike of strikes.slice(0, count)) {
        const row = chain.instrumentMap[String(strike)];
        if (!row) continue;
        add(chain.optionSegment, row.ce);
        add(chain.optionSegment, row.pe);
      }
    };
    const book = loaded;
    const keepChains =
      active ||
      started ||
      warmupDue(focusMinute, params) ||
      entryWindow(focusMinute, params) ||
      legs.some((leg) => leg.open) ||
      nakedRef.current.length > 0;
    if (index === "NIFTY" && book && keepChains) {
      addChain(book.trade, TRADE_STRIKES);
      if (book.other) addChain(book.other, OTHER_STRIKES);
    }
    for (const leg of legs) add(leg.segment, leg.iid);
    for (const naked of nakedRef.current) add(naked.segment, naked.iid);
    let cancelled = false;
    if (instruments.length) void subscribeMdTouchline(instruments, () => cancelled);
    setHotFocus("930", instruments);
    return () => {
      cancelled = true;
      setHotFocus("930", []);
    };
  }, [index, active, started, loaded, legs, params, focusMinute]);

  const sendOrder = useCallback(
    async (
      orderSide: "BUY" | "SELL",
      instrumentId: number,
      orderQuantity: number,
      segment: number,
    ): Promise<OrderSent> => {
      const rate = livePremium(instrumentId);
      const blank = (error: string): OrderSent => ({
        filledQty: 0,
        fillPx: null,
        rate,
        counted: false,
        foreign: false,
        error,
      });
      if (rate == null) return blank("No tick. Order not sent.");
      if (orderSide === "SELL" && rate < paramsRef.current.minPremium) return blank("Quote under min. Order not sent.");
      let response: { ok?: boolean; error?: string; raw?: unknown } | null = null;
      try {
        response = (await apiFetch("/api/ix/place_order", {
          method: "POST",
          body: JSON.stringify({
            ...XTS_IX_ORDER_BASE,
            ...ixOrderPricing(orderSide, rate),
            exchangeSegment: segment,
            exchangeInstrumentID: instrumentId,
            orderSide,
            orderQuantity,
            bookOnlyIfFilled: true,
          }),
        })) as { ok?: boolean; error?: string; raw?: unknown };
      } catch (err: unknown) {
        bumpPositionsRefresh();
        return blank(err instanceof Error ? err.message : String(err));
      }
      bumpPositionsRefresh();
      const raw = response?.raw ?? response;
      const own = xtsOwnOrderFill(raw, instrumentId);
      const rejected = ixOrderRejectedMessage(raw) || ixOrderRejectedMessage(response) || response?.error || null;
      if (own && fillCounts(own.px, rate)) {
        return { filledQty: own.qty, fillPx: own.px, rate, counted: true, foreign: false, error: null };
      }
      const foreign = (own != null && !fillCounts(own.px, rate)) || (own == null && orderLooksFilled(raw) && !rejected);
      return {
        filledQty: 0,
        fillPx: own?.px ?? null,
        rate,
        counted: false,
        foreign,
        error: rejected || (foreign ? "Not booked" : "Order not filled"),
      };
    },
    [],
  );

  const remember = useCallback((leg: BookLeg, expiry: string) => {
    setLocalShortPosition({
      exchangeInstrumentID: leg.iid,
      exchangeSegment: leg.segment,
      qty: leg.qty,
      fillPx: leg.sold,
      tradingSymbol: `NIFTY ${Math.round(leg.strike)} ${leg.side} ${expiry}`.trim(),
    });
  }, []);

  const coverLegs = useCallback(
    async (targets: BookLeg[], reason: string, kind: ClosedBy) => {
      const results = await Promise.all(
        targets.map(async (leg) => ({ leg, sent: await sendOrder("BUY", leg.iid, leg.qty, leg.segment) })),
      );
      let next = legsRef.current.slice();
      let realizedNow = realizedRef.current;
      const fillRows = fillsRef.current.slice();
      let failed = false;
      for (const { leg, sent } of results) {
        const rate = sent.rate ?? livePremium(leg.iid);
        if (!sent.counted || sent.fillPx == null) {
          failed = true;
          pushLog(
            `Not booked. ${leg.side} ${fmtStrike(leg.strike)} rate ${rate == null ? "—" : fmtPrice(rate)}.`,
            "error",
          );
          continue;
        }
        const qty = Math.min(sent.filledQty, leg.qty);
        const booked = (leg.sold - sent.fillPx) * qty;
        const left = leg.qty - qty;
        realizedNow += booked;
        fillRows.push({ side: "BUY", premium: sent.fillPx, qty });
        if (left <= 0) clearLocalPosition(leg.iid, booked);
        else {
          setLocalShortPosition({
            exchangeInstrumentID: leg.iid,
            exchangeSegment: leg.segment,
            qty: left,
            fillPx: leg.sold,
            tradingSymbol: `NIFTY ${Math.round(leg.strike)} ${leg.side}`,
          });
        }
        next = next.map((row) =>
          row.iid === leg.iid
            ? {
                ...row,
                open: left > 0,
                qty: left > 0 ? left : row.qty,
                slOn: left > 0,
                closedBy: left > 0 ? row.closedBy : kind,
                coverPx: sent.fillPx,
              }
            : row,
        );
        pushLog(`${reason} BUY ${leg.side} ${fmtStrike(leg.strike)} rate ${fmtPrice(rate ?? sent.fillPx)}`, "exit");
      }
      realizedRef.current = realizedNow;
      setRealized(realizedNow);
      fillsRef.current = fillRows;
      setFills(fillRows);
      commitLegs(next);
      if (!next.some((leg) => leg.open)) {
        squaredRef.current = true;
        setSquared(true);
        enteredRef.current = true;
        setEntered(true);
      }
      if (failed) backoffRef.current = Date.now() + EXIT_BACKOFF_MS;
      return !failed;
    },
    [commitLegs, pushLog, sendOrder],
  );

  const engineRef = useRef<() => Promise<void>>(async () => {});
  engineRef.current = async () => {
    if (tickingRef.current || busyRef.current) return;
    if (indexRef.current !== "NIFTY") return;
    const clock: IstClock = istClock();
    const minsNow = clockMinutes(clock);
    if (minsNow !== focusMinute) setFocusMinute(minsNow);
    if (sessionDateRef.current !== clock.date) {
      sessionDateRef.current = clock.date;
      enteredRef.current = false;
      squaredRef.current = false;
      startedRef.current = false;
      legsRef.current = [];
      fillsRef.current = [];
      realizedRef.current = 0;
      nakedRef.current = [];
      setEntered(false);
      setSquared(false);
      setStarted(false);
      commitLegs([]);
      setFills([]);
      setRealized(0);
      loadedRef.current = null;
      setLoaded(null);
      pushLog("New session. START is off.", "info");
      return;
    }

    tickingRef.current = true;
    try {
      const rules = paramsRef.current;
      const mins = clockMinutes(clock);
      const book = loadedRef.current;
      if (!startedRef.current) {
        const open = legsRef.current.filter((leg) => leg.open);
        if (!open.length && !nakedRef.current.length) return;
        if (Date.now() < backoffRef.current) return;
        busyRef.current = true;
        setBusy(true);
        if (open.length) await coverLegs(open, "STOP", "square");
        const left: NakedLeg[] = [];
        for (const naked of nakedRef.current) {
          const sent = await sendOrder("BUY", naked.iid, naked.qty, naked.segment);
          if (sent.counted && sent.fillPx != null) {
            clearLocalPosition(naked.iid);
            pushLog(`STOP BUY ${naked.side} ${fmtStrike(naked.strike)} rate ${fmtPrice(sent.rate ?? sent.fillPx)}`, "exit");
          } else {
            left.push(naked);
            pushLog(
              `Not booked. ${naked.side} ${fmtStrike(naked.strike)} rate ${sent.rate == null ? "—" : fmtPrice(sent.rate)}.`,
              "error",
            );
          }
        }
        nakedRef.current = left;
        if (left.length || legsRef.current.some((leg) => leg.open)) backoffRef.current = Date.now() + EXIT_BACKOFF_MS;
        return;
      }
      if (nakedRef.current.length) {
        if (Date.now() < backoffRef.current) return;
        busyRef.current = true;
        setBusy(true);
        const left: NakedLeg[] = [];
        for (const naked of nakedRef.current) {
          const sent = await sendOrder("BUY", naked.iid, naked.qty, naked.segment);
          if (sent.counted && sent.fillPx != null) {
            clearLocalPosition(naked.iid);
            pushLog(`BUY ${naked.side} ${fmtStrike(naked.strike)} rate ${fmtPrice(sent.rate ?? sent.fillPx)}`, "exit");
          } else {
            left.push(naked);
            pushLog(
              `Not booked. ${naked.side} ${fmtStrike(naked.strike)} rate ${sent.rate == null ? "—" : fmtPrice(sent.rate)}.`,
              "error",
            );
          }
        }
        nakedRef.current = left;
        if (left.length) backoffRef.current = Date.now() + EXIT_BACKOFF_MS;
        return;
      }

      let working = withSavedSl(legsRef.current, rules);
      if (working.some((leg, i) => leg.slPx !== legsRef.current[i]?.slPx)) commitLegs(working);
      const snaps = working.map(snapOf);
      const actions = tickActions({
        entered: enteredRef.current,
        squared: squaredRef.current,
        inWindow: entryWindow(mins, rules),
        eod: eodDue(mins, rules),
        legs: snaps,
        dayPlus: dayLine(rules.dayPlusPerLot, rules.lots),
        dayMinus: dayLine(rules.dayMinusPerLot, rules.lots),
        partnerPct: rules.partnerPct,
        realized: realizedRef.current,
      });
      const locals = actions.filter((row): row is Extract<N930Action, { type: "PARTNER" | "ARM_LOCK" }> => row.type === "PARTNER" || row.type === "ARM_LOCK");
      if (locals.length) {
        working = working.map((leg) => {
          let next = leg;
          for (const row of locals) {
            if (row.side !== leg.side || !leg.open) continue;
            if (row.type === "PARTNER") next = { ...next, slPx: row.slPx };
            else next = { ...next, lockArmed: true, lockPct: row.lockPct };
          }
          return next;
        });
        commitLegs(working);
        for (const row of locals) {
          if (row.type === "PARTNER") note(`partner-${row.side}`, `Partner ${rules.partnerPct}%. ${row.side} SL is ${fmtPrice(row.slPx)}.`, "info");
          else note(`lock-${row.side}-${row.lockPct}`, `Leftover lock ${row.lockPct}% on ${row.side}.`, "info");
        }
      }
      const orders = actions.filter((row) => row.type !== "PARTNER" && row.type !== "ARM_LOCK");

      if (!orders.length) return;
      const first = orders[0]!;
      if (first.type === "ENTER") {
        if (!book) {
          note("chain", chainNote || "Weekly chain is not ready.", "info");
          return;
        }
        const ce = pickCheapest(quotesFor(book.trade, "CE"), rules.minPremium);
        const pe = pickCheapest(quotesFor(book.trade, "PE"), rules.minPremium);
        if (!ce || !pe) {
          note("pick", `No ${rules.minPremium} premium on both sides of ${book.pick.trade.label}. No order.`, "info");
          return;
        }
        const ceNow = livePremium(ce.iid);
        const peNow = livePremium(pe.iid);
        if (ceNow == null || peNow == null || ceNow < rules.minPremium || peNow < rules.minPremium) {
          note("pick", "Quote fell under min before send. Pair not sent.", "info");
          return;
        }
        if (Date.now() < backoffRef.current) return;
        busyRef.current = true;
        setBusy(true);
        const qty = orderQty(rules.lots);
        const segment = book.trade.optionSegment;
        const [ceSent, peSent] = await Promise.all([
          sendOrder("SELL", ce.iid, qty, segment),
          sendOrder("SELL", pe.iid, qty, segment),
        ]);
        const plan = pairFillPlan(
          { filledQty: ceSent.counted ? ceSent.filledQty : 0, fillPx: ceSent.counted ? ceSent.fillPx : null, rate: ceSent.rate ?? ceNow },
          { filledQty: peSent.counted ? peSent.filledQty : 0, fillPx: peSent.counted ? peSent.fillPx : null, rate: peSent.rate ?? peNow },
        );
        if (ceSent.foreign || peSent.foreign) {
          pushLog(`Not booked. CE ${fmtStrike(ce.strike)} rate ${fmtPrice(ceNow)}. PE ${fmtStrike(pe.strike)} rate ${fmtPrice(peNow)}.`, "error");
          backoffRef.current = Date.now() + ENTRY_BACKOFF_MS;
          if (plan.type === "none") return;
        }
        if (plan.type === "book") {
          const expiry = book.trade.expiryUi || book.pick.trade.label;
          const booked: BookLeg[] = [
            {
              side: "CE",
              strike: ce.strike,
              iid: ce.iid,
              segment,
              qty: plan.ceQty,
              sold: plan.cePx,
              slPx: slPrice(plan.cePx, rules.slPct),
              slOn: true,
              lockArmed: false,
              lockPct: 0,
              open: true,
              closedBy: null,
              coverPx: null,
            },
            {
              side: "PE",
              strike: pe.strike,
              iid: pe.iid,
              segment,
              qty: plan.peQty,
              sold: plan.pePx,
              slPx: slPrice(plan.pePx, rules.slPct),
              slOn: true,
              lockArmed: false,
              lockPct: 0,
              open: true,
              closedBy: null,
              coverPx: null,
            },
          ];
          const nextFills: N930Fill[] = [
            ...fillsRef.current,
            { side: "SELL", premium: plan.cePx, qty: plan.ceQty },
            { side: "SELL", premium: plan.pePx, qty: plan.peQty },
          ];
          fillsRef.current = nextFills;
          setFills(nextFills);
          enteredRef.current = true;
          setEntered(true);
          commitLegs(booked);
          for (const leg of booked) remember(leg, expiry);
          pushLog(`SELL CE ${fmtStrike(ce.strike)} rate ${fmtPrice(ceNow)}`, "entry");
          pushLog(`SELL PE ${fmtStrike(pe.strike)} rate ${fmtPrice(peNow)}`, "entry");
          toast({ title: "9:30 sold", description: `CE ${ce.strike} and PE ${pe.strike}` });
          return;
        }
        const unwind = async (side: N930Side, iid: number, strike: number, qtyFilled: number, sold: number, rate: number) => {
          pushLog(`SELL ${side} ${fmtStrike(strike)} rate ${fmtPrice(rate)}`, "entry");
          const sent = await sendOrder("BUY", iid, qtyFilled, segment);
          if (sent.counted && sent.fillPx != null) {
            clearLocalPosition(iid);
            pushLog(`BUY ${side} ${fmtStrike(strike)} rate ${fmtPrice(sent.rate ?? rate)}`, "exit");
            return;
          }
          nakedRef.current = [...nakedRef.current, { side, strike, iid, segment, qty: qtyFilled }];
          setLocalShortPosition({
            exchangeInstrumentID: iid,
            exchangeSegment: segment,
            qty: qtyFilled,
            fillPx: sold,
            tradingSymbol: `NIFTY ${strike} ${side}`,
          });
          pushLog(`Not booked. ${side} ${fmtStrike(strike)} rate ${sent.rate == null ? fmtPrice(rate) : fmtPrice(sent.rate)}.`, "error");
        };
        if (plan.type === "unwind" && plan.side === "CE" && ceSent.counted && ceSent.fillPx != null) {
          await unwind("CE", ce.iid, ce.strike, ceSent.filledQty, ceSent.fillPx, ceNow);
          backoffRef.current = Date.now() + (nakedRef.current.length ? EXIT_BACKOFF_MS : ENTRY_BACKOFF_MS);
        } else if (plan.type === "unwind" && plan.side === "PE" && peSent.counted && peSent.fillPx != null) {
          await unwind("PE", pe.iid, pe.strike, peSent.filledQty, peSent.fillPx, peNow);
          backoffRef.current = Date.now() + (nakedRef.current.length ? EXIT_BACKOFF_MS : ENTRY_BACKOFF_MS);
        } else if (!ceSent.foreign && !peSent.foreign) {
          backoffRef.current = Date.now() + ENTRY_BACKOFF_MS;
          const why = ceSent.error || peSent.error || "Rejected.";
          pushLog(`${why} Not a position.`, "error");
        }
        return;
      }

      const openLegs = working.filter((leg) => leg.open);
      const targets =
        first.type === "SQUARE"
          ? openLegs
          : openLegs.filter((leg) => orders.some((row) => (row.type === "SL" || row.type === "LEFTOVER") && row.side === leg.side));
      if (!targets.length) return;
      const reason =
        first.type === "SQUARE"
          ? first.reason === "EOD"
            ? `EOD ${formatHm(rules.eodMin)}`
            : first.reason === "DAY_MINUS"
              ? "Day −"
              : "Day +"
          : first.type === "SL"
            ? `SL ${rules.slPct}%`
            : "Leftover";
      const kind: ClosedBy = first.type === "SL" ? "sl" : first.type === "LEFTOVER" ? "leftover" : "square";
      if (Date.now() < backoffRef.current) return;
      busyRef.current = true;
      setBusy(true);
      await coverLegs(targets, reason, kind);
    } finally {
      tickingRef.current = false;
      if (busyRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
      const now = Date.now();
      const showing =
        activeRef.current ||
        legsRef.current.some((leg) => leg.open) ||
        entryWindow(clockMinutes(istClock()), paramsRef.current);
      if (showing && now - shownRef.current > 400) {
        shownRef.current = now;
        setMarkTick((n) => (n + 1) % 1_000_000);
      }
    }
  };

  useEffect(() => {
    const id = window.setInterval(() => void engineRef.current(), GUARD_MS);
    return () => window.clearInterval(id);
  }, []);

  const saveParameters = () => {
    const parsed = parseN930Params(draft);
    if (!parsed.ok) {
      toast({ title: "9:30 parameters", description: parsed.error, variant: "destructive" });
      return;
    }
    paramsRef.current = parsed.params;
    setParams(parsed.params);
    pushLog(
      `Parameters saved. ${formatHm(parsed.params.startMin)}–${formatHm(parsed.params.cutoffMin)}, EOD ${formatHm(parsed.params.eodMin)}, ${parsed.params.lots} lots, min ${parsed.params.minPremium}.`,
      "info",
    );
    toast({ title: "9:30 parameters", description: "Saved. The live card uses this save." });
  };

  const bookIsFlat = () => !legsRef.current.some((leg) => leg.open) && nakedRef.current.length === 0;
  const bookWasUsed = () =>
    enteredRef.current || squaredRef.current || legsRef.current.length > 0 || fillsRef.current.length > 0;

  const clearBook = () => {
    enteredRef.current = false;
    squaredRef.current = false;
    legsRef.current = [];
    fillsRef.current = [];
    realizedRef.current = 0;
    nakedRef.current = [];
    setEntered(false);
    setSquared(false);
    commitLegs([]);
    setFills([]);
    setRealized(0);
  };

  const startDesk = () => {
    if (busyRef.current) return;
    if (!bookIsFlat()) {
      if (!startedRef.current) {
        startedRef.current = true;
        setStarted(true);
        pushLog("START. The open short stays. No second sell.", "info");
      }
      return;
    }
    const cleared = bookWasUsed();
    if (cleared) clearBook();
    const was = startedRef.current;
    startedRef.current = true;
    setStarted(true);
    if (was && !cleared) return;
    const mins = clockMinutes(istClock());
    const rules = paramsRef.current;
    const when =
      mins < rules.startMin
        ? `Waiting for ${formatHm(rules.startMin)}.`
        : entryWindow(mins, rules)
          ? "Selling on the next tick."
          : `Past ${formatHm(rules.cutoffMin)}. No new sell.`;
    pushLog(cleared ? `START. Old book cleared. ${when}` : `START. ${when}`, "info");
  };

  const stop = async () => {
    if (busyRef.current) return;
    startedRef.current = false;
    setStarted(false);
    const open = legsRef.current.filter((leg) => leg.open);
    const naked = nakedRef.current.slice();
    if (!open.length && !naked.length) {
      pushLog("STOP. No new sell.", "info");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      if (open.length) await coverLegs(open, "STOP", "square");
      const left: NakedLeg[] = [];
      for (const row of nakedRef.current) {
        const sent = await sendOrder("BUY", row.iid, row.qty, row.segment);
        if (sent.counted && sent.fillPx != null) {
          clearLocalPosition(row.iid);
          pushLog(`STOP BUY ${row.side} ${fmtStrike(row.strike)} rate ${fmtPrice(sent.rate ?? sent.fillPx)}`, "exit");
        } else {
          left.push(row);
          pushLog(
            `Not booked. ${row.side} ${fmtStrike(row.strike)} rate ${sent.rate == null ? "—" : fmtPrice(sent.rate)}.`,
            "error",
          );
        }
      }
      nakedRef.current = left;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const rules = params;
  const qty = orderQty(rules.lots);
  const snaps = legs.map(snapOf);
  void markTick;
  const ceOpen = legs.find((leg) => leg.side === "CE" && leg.open) ?? null;
  const peOpen = legs.find((leg) => leg.side === "PE" && leg.open) ?? null;
  const ceWatch = !ceOpen && loaded ? pickCheapest(quotesFor(loaded.trade, "CE"), rules.minPremium) : null;
  const peWatch = !peOpen && loaded ? pickCheapest(quotesFor(loaded.trade, "PE"), rules.minPremium) : null;
  const deskMode = started ? "START" : "STOP";
  const deskState = started ? "One sell at the saved time" : "No new sell";
  const mark = dayMtm(snaps, realized);
  const gross = mark.mtm;
  const money = netPnl(gross, fills);
  const charges = chargeBreakup(fills).total;
  const draftDirty =
    draft.start !== formatHm(rules.startMin) ||
    draft.cutoff !== formatHm(rules.cutoffMin) ||
    draft.eod !== formatHm(rules.eodMin) ||
    draft.lots !== String(rules.lots) ||
    draft.minPremium !== String(rules.minPremium) ||
    draft.slPct !== String(rules.slPct) ||
    draft.partnerPct !== String(rules.partnerPct) ||
    draft.dayPlusPerLot !== String(rules.dayPlusPerLot) ||
    draft.dayMinusPerLot !== String(rules.dayMinusPerLot);
  const clock = istClock();
  const mins = clockMinutes(clock);
  const status =
    index !== "NIFTY"
      ? "Select NIFTY. This desk does not trade another index."
      : !started
        ? "Stopped. No new sell."
        : legs.some((leg) => leg.open)
          ? "Short is open. STOP buys both legs back."
          : entered || squared
            ? "This START is used. Press START to clear the old book."
            : !loaded
              ? chainNote || "Resolving the Tuesday chain."
              : !entryWindow(mins, rules)
                ? mins < rules.startMin
                  ? `Waiting for ${formatHm(rules.startMin)}. Cutoff ${formatHm(rules.cutoffMin)}.`
                  : `Past ${formatHm(rules.cutoffMin)}. No new sell.`
                : `${loaded.pick.trade.label} CE and PE sell together on the next tick.`;

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-[13px] ramsetu-glass-panel">
      <div className="shrink-0 ramsetu-glass-toolbar">
        <div className="n930-tape">
          <div className="n930-cell">
            <div className="n930-kicker">Window</div>
            <div className="n930-px">
              {formatHm(rules.startMin)}–{formatHm(rules.cutoffMin)}
            </div>
            <div className="n930-meta">
              EOD {formatHm(rules.eodMin)} · {deskMode}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">CE</div>
            <div className="n930-px n930-px--ce">
              {ceOpen ? <FyersPx iid={ceOpen.iid} /> : ceWatch ? fmtPrice(ceWatch.ltp) : "—"}
            </div>
            <div className="n930-meta">
              {ceOpen
                ? `${Math.round(ceOpen.strike).toLocaleString("en-IN")} · SL ${fmtPrice(ceOpen.slPx)}`
                : ceWatch
                  ? `${Math.round(ceWatch.strike).toLocaleString("en-IN")} · cheapest ≥ min`
                  : chainNote || (loaded ? "waiting for LTP" : "—")}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">PE</div>
            <div className="n930-px n930-px--pe">
              {peOpen ? <FyersPx iid={peOpen.iid} /> : peWatch ? fmtPrice(peWatch.ltp) : "—"}
            </div>
            <div className="n930-meta">
              {peOpen
                ? `${Math.round(peOpen.strike).toLocaleString("en-IN")} · SL ${fmtPrice(peOpen.slPx)}`
                : peWatch
                  ? `${Math.round(peWatch.strike).toLocaleString("en-IN")} · cheapest ≥ min`
                  : chainNote || (loaded ? "waiting for LTP" : "—")}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">Day MTM</div>
            <div className={`n930-px ${gross > 0 ? "n930-px--up" : gross < 0 ? "n930-px--down" : ""}`}>{fmtPnl(gross)}</div>
            <div className="n930-meta">
              net {fmtPnl(money.net)} · charges {fmtPrice(charges)}
              {!mark.dayPlusReady ? " · mark incomplete" : ""}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">Nifty</div>
            <div className="n930-px">{loaded?.pick.trade.label ?? (chainNote ? "—" : "…")}</div>
            <div className="n930-meta">
              {rules.lots} × {N930.lotSize} = {fmtQty(qty)}
              {chainNote ? ` · ${chainNote}` : ""}
            </div>
          </div>
          <div className="n930-cell">
            <div className="n930-kicker">XTS</div>
            <div className="n930-px">{deskMode}</div>
            <div className="n930-meta">{deskState}</div>
          </div>
        </div>

        <div className="cd-trade">
          <p className="cd-trade__status">{status}</p>
          <div className="cd-trade__actions">
            <button type="button" disabled={busy} onClick={startDesk} className="ramsetu-glass-exec" aria-pressed={started}>
              START
            </button>
            <button type="button" disabled={busy} onClick={() => void stop()} className="ramsetu-glass-stop nv-stop">
              STOP
            </button>
          </div>
        </div>

        <div className="cd-params">
          <div className="cd-params__grid">
            <Field label="Start">
              <input
                aria-label="Start"
                value={draft.start}
                onChange={(e) => {
                  const start = e.target.value;
                  const cutoff = cutoffFromStart(start);
                  setDraft((row) => ({ ...row, start, ...(cutoff ? { cutoff } : {}) }));
                }}
                className="ramsetu-glass-select cd-field__control"
              />
            </Field>
            <Field label="Cutoff">
              <input aria-label="Cutoff" value={draft.cutoff} onChange={(e) => setDraft((row) => ({ ...row, cutoff: e.target.value }))} className="ramsetu-glass-select cd-field__control" />
            </Field>
            <Field label="EOD">
              <input aria-label="EOD" value={draft.eod} onChange={(e) => setDraft((row) => ({ ...row, eod: e.target.value }))} className="ramsetu-glass-select cd-field__control" />
            </Field>
            <Field label="Lots">
              <input aria-label="Lots" inputMode="numeric" value={draft.lots} onChange={(e) => setDraft((row) => ({ ...row, lots: e.target.value.replace(/[^\d]/g, "").slice(0, 2) }))} className="ramsetu-glass-select cd-field__control" />
            </Field>
            <Field label="Min premium">
              <input aria-label="Min premium" inputMode="decimal" value={draft.minPremium} onChange={(e) => setDraft((row) => ({ ...row, minPremium: e.target.value.replace(/[^\d.]/g, "").slice(0, 6) }))} className="ramsetu-glass-select cd-field__control" />
            </Field>
            <Field label="SL %">
              <input aria-label="SL %" inputMode="decimal" value={draft.slPct} onChange={(e) => setDraft((row) => ({ ...row, slPct: e.target.value.replace(/[^\d.]/g, "").slice(0, 6) }))} className="ramsetu-glass-select cd-field__control" />
            </Field>
            <Field label="Partner %">
              <input aria-label="Partner %" inputMode="decimal" value={draft.partnerPct} onChange={(e) => setDraft((row) => ({ ...row, partnerPct: e.target.value.replace(/[^\d.]/g, "").slice(0, 6) }))} className="ramsetu-glass-select cd-field__control" />
            </Field>
            <Field label="Day + ₹/lot">
              <input aria-label="Day + ₹/lot" inputMode="decimal" value={draft.dayPlusPerLot} onChange={(e) => setDraft((row) => ({ ...row, dayPlusPerLot: e.target.value.replace(/[^\d.]/g, "").slice(0, 8) }))} className="ramsetu-glass-select cd-field__control" />
            </Field>
            <Field label="Day − ₹/lot">
              <input aria-label="Day − ₹/lot" inputMode="decimal" value={draft.dayMinusPerLot} onChange={(e) => setDraft((row) => ({ ...row, dayMinusPerLot: e.target.value.replace(/[^\d.]/g, "").slice(0, 8) }))} className="ramsetu-glass-select cd-field__control" />
            </Field>
          </div>
          <div className="cd-params__bar">
            <span className="cd-params__qty">
              Order qty {rules.lots} × {N930.lotSize} = {fmtQty(qty)}
            </span>
            <span className="cd-params__note">
              {draftDirty ? "Not saved. The desk still uses the last save." : "Saved. The live card does not take edits."}
            </span>
            <button type="button" onClick={saveParameters} className="ramsetu-glass-exec">
              Save parameters
            </button>
          </div>
        </div>
      </div>

      <div className="ramsetu-glass-table-wrap flex min-h-0 flex-1 flex-col gap-3">
        <div className="ramsetu-glass-card">
          <div className="ramsetu-glass-card__badge">Live card</div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-2">
            {(["CE", "PE"] as const).map((side) => {
              const leg = legs.find((row) => row.side === side);
              const quote = side === "CE" ? ceWatch : peWatch;
              const strike = leg?.strike ?? quote?.strike;
              return (
                <div key={side}>
                  <div className="ramsetu-glass-toolbar__label">{side}</div>
                  <div className={`text-[14px] font-extrabold tabular-nums ${side === "PE" ? "ramsetu-glass-table__strike--pe" : "text-cd-green"}`}>
                    {strike != null ? strike.toLocaleString("en-IN") : "—"}
                    {leg ? (leg.open ? " short" : ` ${leg.closedBy || "closed"}`) : quote ? " watch" : ""}
                  </div>
                  <div className="text-[12px] tabular-nums text-muted-foreground">
                    LTP {leg ? <FyersPx iid={leg.iid} /> : quote ? fmtPrice(quote.ltp) : "—"}
                    {" · "}SL {leg ? fmtPrice(leg.slPx) : "—"}
                    {leg?.lockArmed ? ` · lock ${leg.lockPct}%` : ""}
                    {leg ? ` · sold ${fmtPrice(leg.sold)}` : ""}
                  </div>
                </div>
              );
            })}
          </div>
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
                NIFTY weekly, lot 65, step 50. START and STOP only. Wed–Fri sell the nearest Tuesday. Mon–Tue skip that Tuesday and sell the next one.
                Both legs use that expiry. Each side is the cheapest tick at or above the saved min. Equal rates keep the lower strike.
                CE and PE sell together. A fill counts only when it is this strike's own price. One real leg is bought back. After a stop that
                strike is done. Both open legs keep the saved SL. After one stop, the other stop tightens and the leftover ladder can lock.
                Day + and Day − use the saved rupees per lot. Orders go out only while START is on.
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
