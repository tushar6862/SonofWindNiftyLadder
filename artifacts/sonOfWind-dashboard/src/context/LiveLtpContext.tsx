import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiFetch, getAuthToken, getMdStreamOrigin, mdStartOnce } from "@/lib/backend";

export type LtpMapState = Record<number, number>;
export type AtpMapState = Record<number, number>;
export type Ema21MapState = Record<number, number>;
export type HiLoMapState = Record<number, { h: number; l: number }>;
/** Touchline anchors: prev close / % / open / exchange day H·L — streamed per token for TopBar. */
export type SpotDayRefMap = Record<
  number,
  { prevClose?: number; percentChange?: number; dayOpen?: number; dayHigh?: number; dayLow?: number }
>;

const LiveLtpContext = createContext<LtpMapState>({});
const LiveAtpContext = createContext<AtpMapState>({});
const LiveEma21Context = createContext<Ema21MapState>({});
const LiveHiLoContext = createContext<HiLoMapState>({});
const LiveSpotDayRefContext = createContext<SpotDayRefMap>({});

export function useLiveLtp() {
  return useContext(LiveLtpContext);
}

export function useLiveAtp() {
  return useContext(LiveAtpContext);
}

export function useLiveEma21() {
  return useContext(LiveEma21Context);
}

export function useLiveHiLo() {
  return useContext(LiveHiLoContext);
}

export function useLiveSpotDayRef() {
  return useContext(LiveSpotDayRefContext);
}

/** Latest streamed tick without waiting for React flush — ladder clock reads this. */
export type LiveTickPeek = {
  ltp: number;
  bid: number | null;
  ask: number | null;
  ltpAt: number;
  bookAt: number;
};

const liveTickPeek = new Map<number, LiveTickPeek>();
const ltpPaintListeners = new Map<number, Set<(ltp: number) => void>>();
/** Socket last-trade time only. REST must not stamp this — a slow quote was rewinding the print. */
const socketPrintAt = new Map<number, number>();

/** Ms since the last socket last-trade for this token. null if the socket has not printed. */
export function socketPrintAgeMs(id: number): number | null {
  if (!Number.isFinite(id) || id <= 0) return null;
  const t = socketPrintAt.get(id);
  if (t == null) return null;
  return performance.now() - t;
}

export function peekLiveTick(id: number): LiveTickPeek | null {
  if (!Number.isFinite(id) || id <= 0) return null;
  return liveTickPeek.get(id) ?? null;
}

export function peekLiveLtp(id: number): number | null {
  const row = peekLiveTick(id);
  return row && row.ltp > 0 ? row.ltp : null;
}

/** Fires on every last-trade print — paint DOM without waiting for React. */
export function subscribeLiveLtp(id: number, onLtp: (ltp: number) => void): () => void {
  if (!Number.isFinite(id) || id <= 0) return () => {};
  let set = ltpPaintListeners.get(id);
  if (!set) {
    set = new Set();
    ltpPaintListeners.set(id, set);
  }
  set.add(onLtp);
  const cur = peekLiveLtp(id);
  if (cur != null) onLtp(cur);
  return () => {
    const s = ltpPaintListeners.get(id);
    if (!s) return;
    s.delete(onLtp);
    if (!s.size) ltpPaintListeners.delete(id);
  };
}

/** Tick-to-tick LTP for a token — bypasses the React map flush. */
export function useTickLtp(id: number | null | undefined): number | null {
  const [px, setPx] = useState<number | null>(() => (typeof id === "number" ? peekLiveLtp(id) : null));
  useLayoutEffect(() => {
    if (typeof id !== "number" || id <= 0) {
      setPx(null);
      return;
    }
    setPx(peekLiveLtp(id));
    return subscribeLiveLtp(id, setPx);
  }, [id]);
  return px;
}

function rememberLiveTick(
  id: number,
  ltp: number | null,
  bid: number | null,
  ask: number | null,
  fromRest = false,
): void {
  const prev = liveTickPeek.get(id);
  const now = performance.now();
  const nextLtp = ltp != null && ltp > 0 ? ltp : prev?.ltp ?? 0;
  const nextBid = bid != null && bid > 0 ? bid : prev?.bid ?? null;
  const nextAsk = ask != null && ask > 0 ? ask : prev?.ask ?? null;
  if (!(nextLtp > 0) && nextBid == null && nextAsk == null) return;
  const ltpChanged = nextLtp > 0 && nextLtp !== prev?.ltp;
  const bookChanged = nextBid !== prev?.bid || nextAsk !== prev?.ask;
  if (ltpChanged && !fromRest) socketPrintAt.set(id, now);
  liveTickPeek.set(id, {
    ltp: nextLtp,
    bid: nextBid,
    ask: nextAsk,
    ltpAt: ltpChanged ? now : prev?.ltpAt ?? (nextLtp > 0 ? now : 0),
    bookAt: bookChanged ? now : prev?.bookAt ?? 0,
  });
  if (ltpChanged) {
    const subs = ltpPaintListeners.get(id);
    if (subs) {
      for (const cb of subs) cb(nextLtp);
    }
  }
}

function walkNumbers(obj: unknown, out: Array<[string, number]>): void {
  if (obj && typeof obj === "object") {
    if (Array.isArray(obj)) {
      for (const v of obj) walkNumbers(v, out);
      return;
    }
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      walkNumbers(v, out);
      if (typeof v === "number" && Number.isFinite(v)) out.push([k, v]);
      else if (typeof v === "string") {
        const s = v.trim().replace(/,/g, "");
        if (!s) continue;
        const n = Number(s);
        if (Number.isFinite(n)) out.push([k, n]);
      }
    }
  }
}

function normFieldKey(k: string): string {
  return String(k).trim().toLowerCase().replace(/\s+/g, "").replace(/_/g, "");
}

function pickBest(pairs: Array<[string, number]>, keys: Set<string>): number | null {
  let best: number | null = null;
  for (const [k, v] of pairs) {
    const kn = normFieldKey(k);
    if (!keys.has(kn)) continue;
    if (best == null || v > best) best = v;
  }
  return best;
}

/** LTP must not use max() across fields — prefer explicit touchline keys in order. */
const LTP_FIELD_PRIORITY = [
  "ltp",
  "lasttradedprice",
  "lasttradeprice",
  "lastprice",
  "lasttraded",
  "ltpprice",
  "lasttradedrate",
];

function pickLtpFromPairs(pairs: Array<[string, number]>): number | null {
  const byKey = new Map<string, number>();
  for (const [k, v] of pairs) {
    const kn = normFieldKey(k);
    if (!byKey.has(kn)) byKey.set(kn, v);
  }
  for (const key of LTP_FIELD_PRIORITY) {
    const v = byKey.get(key);
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function extractId(t: Record<string, unknown>): number {
  // Different feeds may put the instrument id at top-level or nested (e.g. Touchline.ExchangeInstrumentID).
  const idRaw =
    t.exchangeInstrumentID ??
    t.exchangeInstrumentId ??
    t.ExchangeInstrumentID ??
    t.ExchangeInstrumentId ??
    t.instrumentId ??
    t.InstrumentId ??
    t.token;

  const toId = (v: unknown): number => {
    const id = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(id) && id > 0 ? id : NaN;
  };

  const direct = toId(idRaw);
  if (Number.isFinite(direct)) return direct;

  const pairs: Array<[string, number]> = [];
  walkNumbers(t, pairs);
  const idKeys = new Set([
    "exchangeinstrumentid",
    "exchangeinstrumentid", // normalized already (kept for clarity)
    "instrumentid",
    "token",
  ]);
  const best = pickBest(pairs, idKeys);
  return typeof best === "number" && Number.isFinite(best) && best > 0 ? best : NaN;
}

function extractLtpBidAskAtp(
  t: Record<string, unknown>,
): { ltp: number | null; bid: number | null; ask: number | null; atp: number | null } {
  const toNum = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v.trim().replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  const atpKeys = new Set([
    "atp",
    "avgtradedprice",
    "averagetradedprice",
    "averageprice",
    "avgprice",
    "vwap",
  ]);
  const bidKeys = new Set(["bid", "bidprice", "bestbid", "bestbidprice", "buyprice", "bp"]);
  const askKeys = new Set(["ask", "askprice", "bestask", "bestaskprice", "sellprice", "sp", "offerprice"]);

  // Prefer explicit top-level values if present, else fall back to best matches.
  const ltpTop = t.ltp ?? t.LTP ?? t.lastTradedPrice ?? t.LastTradedPrice;
  const atpTop =
    (t as any).atp ??
    (t as any).ATP ??
    (t as any).avgTradedPrice ??
    (t as any).AvgTradedPrice ??
    (t as any).averageTradedPrice ??
    (t as any).AverageTradedPrice ??
    (t as any).vwap ??
    (t as any).VWAP;
  const bidTop = t.bid ?? t.bidPrice ?? t.BidPrice ?? t.bestBid ?? t.BestBid;
  const askTop = t.ask ?? t.askPrice ?? t.AskPrice ?? t.bestAsk ?? t.BestAsk;

  const ltpTopNum = toNum(ltpTop);
  const atpTopNum = toNum(atpTop);
  const bidTopNum = toNum(bidTop);
  const askTopNum = toNum(askTop);

  // Fast path with correctness: keep top-level values when present, fallback only for missing fields.
  let pairs: Array<[string, number]> | null = null;
  const ensurePairs = (): Array<[string, number]> => {
    if (!pairs) {
      pairs = [];
      walkNumbers(t, pairs);
    }
    return pairs;
  };

  const ltp = ltpTopNum ?? pickLtpFromPairs(ensurePairs());
  const atp = atpTopNum ?? pickBest(ensurePairs(), atpKeys);
  const bid = bidTopNum ?? pickBest(ensurePairs(), bidKeys);
  const ask = askTopNum ?? pickBest(ensurePairs(), askKeys);
  return { ltp, bid, ask, atp };
}

/** REST must not rewind a token that still has SSE prints. */
const STREAM_GLOBAL_STALE_MS = 2500;
/** Reconnect md/start when no streamed LTP for this long (do not thrash SSE). */
const STREAM_STALE_MS = 30_000;

function cancelScheduledFlush(scheduled: { current: boolean }, rafId?: { current: number | null }) {
  scheduled.current = false;
  if (rafId && rafId.current != null) {
    window.cancelAnimationFrame(rafId.current);
    rafId.current = null;
  }
}

function scheduleFlushSoon(
  scheduled: { current: boolean },
  rafId: { current: number | null },
  flush: () => void,
): void {
  if (scheduled.current) return;
  scheduled.current = true;
  rafId.current = window.requestAnimationFrame(() => {
    scheduled.current = false;
    rafId.current = null;
    flush();
  });
}

type PendingTick = {
  ltp?: number;
  atp?: number;
  ema21?: number;
  hiLo?: { h: number; l: number };
  spotDay?: SpotDayRefMap[number];
};

export function LiveLtpProvider({ children }: { children: ReactNode }) {
  const [map, setMap] = useState<LtpMapState>({});
  const [atpMap, setAtpMap] = useState<AtpMapState>({});
  const [ema21Map, setEma21Map] = useState<Ema21MapState>({});
  const [hiLoMap, setHiLoMap] = useState<HiLoMapState>({});
  const [spotDayRef, setSpotDayRef] = useState<SpotDayRefMap>({});
  const [token, setToken] = useState<string>(() => getAuthToken());
  const pendingRef = useRef<Map<number, PendingTick>>(new Map());
  const streamLtpAtRef = useRef<Map<number, number>>(new Map());
  const flushScheduledRef = useRef(false);
  const flushRafRef = useRef<number | null>(null);
  const lastStreamLtpAtRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const staleWatchRef = useRef<number | null>(null);

  useEffect(() => {
    const onAuth = () => setToken(getAuthToken());
    const onStorage = (ev: StorageEvent) => {
      if (!ev.key || ev.key === "sonofwind_auth_token") onAuth();
    };
    window.addEventListener("sonofwind_auth", onAuth as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("sonofwind_auth", onAuth as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    const onAtpSnapshot = (ev: Event) => {
      const ce = ev as CustomEvent<{ map?: Record<number, number> }>;
      const snap = ce?.detail?.map;
      if (!snap || typeof snap !== "object") return;
      setAtpMap((prev) => {
        let changed = false;
        const next: AtpMapState = { ...prev };
        for (const [k, v] of Object.entries(snap)) {
          const id = Number(k);
          if (!Number.isFinite(id) || id <= 0) continue;
          if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
          if (next[id] !== v) {
            next[id] = v;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    window.addEventListener("sonofwind_atp_snapshot", onAtpSnapshot as EventListener);
    return () => window.removeEventListener("sonofwind_atp_snapshot", onAtpSnapshot as EventListener);
  }, []);

  useEffect(() => {
    const onEma21Snapshot = (ev: Event) => {
      const ce = ev as CustomEvent<{ map?: Record<string, number> }>;
      const snap = ce?.detail?.map;
      if (!snap || typeof snap !== "object") return;
      setEma21Map((prev) => {
        let changed = false;
        const next: Ema21MapState = { ...prev };
        for (const [k, v] of Object.entries(snap)) {
          const id = Number(k);
          if (!Number.isFinite(id) || id <= 0) continue;
          if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
          if (next[id] !== v) {
            next[id] = v;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    window.addEventListener("sonofwind_ema21_snapshot", onEma21Snapshot as EventListener);
    return () => window.removeEventListener("sonofwind_ema21_snapshot", onEma21Snapshot as EventListener);
  }, []);

  useEffect(() => {
    const onSpotDayRefSnapshot = (ev: Event) => {
      const ce = ev as CustomEvent<{ map?: SpotDayRefMap }>;
      const snap = ce?.detail?.map;
      if (!snap || typeof snap !== "object") return;
      setSpotDayRef((prev) => {
        let changed = false;
        const next: SpotDayRefMap = { ...prev };
        for (const [k, v] of Object.entries(snap)) {
          const id = Number(k);
          if (!Number.isFinite(id) || id <= 0) continue;
          if (!v || typeof v !== "object") continue;
          const cur = next[id] ?? {};
          const merged: SpotDayRefMap[number] = { ...cur };
          if (typeof v.prevClose === "number" && Number.isFinite(v.prevClose) && v.prevClose > 0) {
            merged.prevClose = v.prevClose;
          }
          if (typeof v.percentChange === "number" && Number.isFinite(v.percentChange)) {
            merged.percentChange = v.percentChange;
          }
          if (typeof v.dayOpen === "number" && Number.isFinite(v.dayOpen) && v.dayOpen > 0) {
            merged.dayOpen = v.dayOpen;
          }
          if (
            cur?.prevClose === merged.prevClose &&
            cur?.percentChange === merged.percentChange &&
            cur?.dayOpen === merged.dayOpen
          ) {
            continue;
          }
          next[id] = merged;
          changed = true;
        }
        return changed ? next : prev;
      });
    };
    window.addEventListener("sonofwind_spot_day_ref_snapshot", onSpotDayRefSnapshot as EventListener);
    return () => window.removeEventListener("sonofwind_spot_day_ref_snapshot", onSpotDayRefSnapshot as EventListener);
  }, []);

  useEffect(() => {
    const onLtpSnapshot = (ev: Event) => {
      const ce = ev as CustomEvent<{ map?: Record<number, number>; source?: string }>;
      const snap = ce?.detail?.map;
      const source = ce?.detail?.source === "focus" ? "focus" : "batch";
      if (!snap || typeof snap !== "object") return;
      setMap((prev) => {
        let changed = false;
        const next: LtpMapState = { ...prev };
        for (const [k, v] of Object.entries(snap)) {
          const id = Number(k);
          if (!Number.isFinite(id) || id <= 0) continue;
          if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
          const sockAge = socketPrintAgeMs(id);
          // Focus REST used to always win. A quote that left 300ms ago then painted 108 over a 106.80 print.
          if (sockAge != null && sockAge < 500) continue;
          if (source !== "focus" && sockAge != null && sockAge < 1500) continue;
          rememberLiveTick(id, v, null, null, true);
          if (next[id] !== v) {
            next[id] = v;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };
    window.addEventListener("sonofwind_ltp_snapshot", onLtpSnapshot as EventListener);
    return () => window.removeEventListener("sonofwind_ltp_snapshot", onLtpSnapshot as EventListener);
  }, []);

  const streamUrl = useMemo(() => {
    if (!token) return "";
    return `${getMdStreamOrigin()}/api/md/stream?token=${encodeURIComponent(token)}`;
  }, [token]);

  useEffect(() => {
    // Token changed (login/logout): reset map and reconnect stream.
    setMap({});
    setAtpMap({});
    setEma21Map({});
    setHiLoMap({});
    setSpotDayRef({});
    liveTickPeek.clear();
    socketPrintAt.clear();
    pendingRef.current.clear();
    cancelScheduledFlush(flushScheduledRef, flushRafRef);
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (!streamUrl) return;

    void mdStartOnce();

    const flushPending = () => {
      const batch = pendingRef.current;
      if (!batch.size) return;
      pendingRef.current = new Map();

      setMap((m) => {
        let next: LtpMapState | null = null;
        for (const [id, p] of batch) {
          if (p.ltp == null || !Number.isFinite(p.ltp)) continue;
          streamLtpAtRef.current.set(id, performance.now());
          lastStreamLtpAtRef.current = Date.now();
          const cur = (next ?? m)[id];
          if (cur === p.ltp) continue;
          if (!next) next = { ...m };
          next[id] = p.ltp;
        }
        return next ?? m;
      });
      setHiLoMap((m) => {
        let next: HiLoMapState | null = null;
        for (const [id, p] of batch) {
          if (!p.hiLo) continue;
          const prev = (next ?? m)[id];
          if (!prev) {
            if (!next) next = { ...m };
            next[id] = p.hiLo;
            continue;
          }
          const h = p.hiLo.h > prev.h ? p.hiLo.h : prev.h;
          const l = p.hiLo.l < prev.l ? p.hiLo.l : prev.l;
          if (h === prev.h && l === prev.l) continue;
          if (!next) next = { ...m };
          next[id] = { h, l };
        }
        return next ?? m;
      });
      setAtpMap((m) => {
        let next: AtpMapState | null = null;
        for (const [id, p] of batch) {
          if (p.atp == null || !Number.isFinite(p.atp) || p.atp <= 0) continue;
          if ((next ?? m)[id] === p.atp) continue;
          if (!next) next = { ...m };
          next[id] = p.atp;
        }
        return next ?? m;
      });
      setEma21Map((m) => {
        let next: Ema21MapState | null = null;
        for (const [id, p] of batch) {
          if (p.ema21 == null || !Number.isFinite(p.ema21) || p.ema21 <= 0) continue;
          if ((next ?? m)[id] === p.ema21) continue;
          if (!next) next = { ...m };
          next[id] = p.ema21;
        }
        return next ?? m;
      });
      setSpotDayRef((prev) => {
        let next: SpotDayRefMap | null = null;
        for (const [id, p] of batch) {
          if (!p.spotDay) continue;
          const cur = (next ?? prev)[id] ?? {};
          const merged: SpotDayRefMap[number] = { ...cur, ...p.spotDay };
          if (
            cur?.prevClose === merged.prevClose &&
            cur?.percentChange === merged.percentChange &&
            cur?.dayOpen === merged.dayOpen &&
            cur?.dayHigh === merged.dayHigh &&
            cur?.dayLow === merged.dayLow
          ) {
            continue;
          }
          if (!next) next = { ...prev };
          next[id] = merged;
        }
        return next ?? prev;
      });
    };

    const applyStreamTick = (t: Record<string, unknown>) => {
        if (t._ema21Only === true) {
          const id = extractId(t);
          if (!Number.isFinite(id) || id <= 0) return;
          const emaRaw = t.ema21 ?? (t as { EMA21?: unknown }).EMA21;
          const emaNum =
            typeof emaRaw === "number" && Number.isFinite(emaRaw) && emaRaw > 0
              ? emaRaw
              : typeof emaRaw === "string"
                ? (() => {
                    const n = Number(emaRaw.trim().replace(/,/g, ""));
                    return Number.isFinite(n) && n > 0 ? n : null;
                  })()
                : null;
          if (emaNum == null) return;
          const pending = pendingRef.current;
          let row = pending.get(id);
          if (!row) {
            row = {};
            pending.set(id, row);
          }
          row.ema21 = emaNum;
          scheduleFlushSoon(flushScheduledRef, flushRafRef, flushPending);
          return;
        }

        if (t._atpOnly === true) {
          const id = extractId(t);
          if (!Number.isFinite(id) || id <= 0) return;
          const atpRaw = t.atp ?? (t as { ATP?: unknown }).ATP;
          const atpNum =
            typeof atpRaw === "number" && Number.isFinite(atpRaw) && atpRaw > 0
              ? atpRaw
              : typeof atpRaw === "string"
                ? (() => {
                    const n = Number(atpRaw.trim().replace(/,/g, ""));
                    return Number.isFinite(n) && n > 0 ? n : null;
                  })()
                : null;
          if (atpNum == null) return;
          const pending = pendingRef.current;
          let row = pending.get(id);
          if (!row) {
            row = {};
            pending.set(id, row);
          }
          row.atp = atpNum;
          scheduleFlushSoon(flushScheduledRef, flushRafRef, flushPending);
          return;
        }

        const id = extractId(t);
        if (!Number.isFinite(id) || id <= 0) return;

        const mcFast =
          typeof t.messageCode === "number"
            ? t.messageCode
            : typeof (t as { MessageCode?: unknown }).MessageCode === "number"
              ? (t as { MessageCode: number }).MessageCode
              : 0;
        const ltpFastRaw =
          typeof t.ltp === "number" && Number.isFinite(t.ltp) && t.ltp > 0
            ? t.ltp
            : typeof t.LastTradedPrice === "number" && Number.isFinite(t.LastTradedPrice) && t.LastTradedPrice > 0
              ? t.LastTradedPrice
              : null;
        const restPrint = t._fromRestQuote === true || t._snapshot === true || t._atpOnly === true;
        const ltpFast = mcFast === 1502 || restPrint ? null : ltpFastRaw;
        const bidFast = typeof t.bid === "number" && t.bid > 0 ? t.bid : null;
        const askFast = typeof t.ask === "number" && t.ask > 0 ? t.ask : null;
        if (ltpFast != null || bidFast != null || askFast != null) {
          rememberLiveTick(id, ltpFast, bidFast, askFast);
        }
        // Paint already hit the DOM. Do not walk the packet or re-render the chain on this tick —
        // that freeze is why a fast drop stayed on 97.85 while XTS had already printed 96.25.
        if (ltpFast != null) {
          streamLtpAtRef.current.set(id, performance.now());
          lastStreamLtpAtRef.current = Date.now();
          const pending = pendingRef.current;
          let row = pending.get(id);
          if (!row) {
            row = {};
            pending.set(id, row);
          }
          row.ltp = ltpFast;
          if (typeof t.atp === "number" && t.atp > 0) row.atp = t.atp;
          return;
        }

        const pcRaw = t.prevClose;
        const pctRaw = t.percentChange;
        const prevClose =
          typeof pcRaw === "number" && Number.isFinite(pcRaw) && pcRaw > 0
            ? pcRaw
            : typeof pcRaw === "string"
              ? (() => {
                  const n = Number(pcRaw.trim().replace(/,/g, ""));
                  return Number.isFinite(n) && n > 0 ? n : undefined;
                })()
              : undefined;
        const pctFeed =
          typeof pctRaw === "number" && Number.isFinite(pctRaw)
            ? pctRaw
            : typeof pctRaw === "string"
              ? (() => {
                  const n = Number(pctRaw.trim().replace(/,/g, ""));
                  return Number.isFinite(n) ? n : undefined;
                })()
              : undefined;
        const dopRaw = t.dayOpen;
        const dayOpen =
          typeof dopRaw === "number" && Number.isFinite(dopRaw) && dopRaw > 0
            ? dopRaw
            : typeof dopRaw === "string"
              ? (() => {
                  const n = Number(dopRaw.trim().replace(/,/g, ""));
                  return Number.isFinite(n) && n > 0 ? n : undefined;
                })()
              : undefined;

        const parsePx = (raw: unknown): number | undefined => {
          if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
          if (typeof raw === "string") {
            const n = Number(raw.trim().replace(/,/g, ""));
            return Number.isFinite(n) && n > 0 ? n : undefined;
          }
          return undefined;
        };
        let dayHigh = parsePx(t.dayHigh);
        let dayLow = parsePx(t.dayLow);
        if (
          dayHigh !== undefined &&
          dayLow !== undefined &&
          dayHigh + 1e-9 < dayLow
        ) {
          [dayHigh, dayLow] = [dayLow, dayHigh];
        }

        if (!Number.isFinite(id) || id <= 0) return;

        const pending = pendingRef.current;
        let row = pending.get(id);
        if (!row) {
          row = {};
          pending.set(id, row);
        }

        if (
          prevClose !== undefined ||
          pctFeed !== undefined ||
          dayOpen !== undefined ||
          dayHigh !== undefined ||
          dayLow !== undefined
        ) {
          const spotDay: SpotDayRefMap[number] = { ...row.spotDay };
          if (prevClose !== undefined) spotDay.prevClose = prevClose;
          if (pctFeed !== undefined) spotDay.percentChange = pctFeed;
          if (dayOpen !== undefined) spotDay.dayOpen = dayOpen;
          if (dayHigh !== undefined) spotDay.dayHigh = dayHigh;
          if (dayLow !== undefined) spotDay.dayLow = dayLow;
          row.spotDay = spotDay;
        }

        const { ltp: ltpPicked, bid, ask, atp } = extractLtpBidAskAtp(t);
        if (typeof atp === "number" && Number.isFinite(atp) && atp > 0) row.atp = atp;

        const emaRaw = t.ema21 ?? (t as { EMA21?: unknown }).EMA21;
        const emaNum =
          typeof emaRaw === "number" && Number.isFinite(emaRaw) && emaRaw > 0
            ? emaRaw
            : typeof emaRaw === "string"
              ? (() => {
                  const n = Number(emaRaw.trim().replace(/,/g, ""));
                  return Number.isFinite(n) && n > 0 ? n : null;
                })()
              : null;
        if (emaNum != null) row.ema21 = emaNum;

        let ltp = restPrint ? NaN : typeof ltpPicked === "number" ? ltpPicked : NaN;
        if (!restPrint && !(Number.isFinite(ltp) && ltp > 0) && Number.isFinite(ltpFast as number) && (ltpFast as number) > 0) {
          ltp = ltpFast as number;
        }

        /** Subnormal decoded noise often prints as `0.00` after fixing binary overlap in backend — drop it. */
        if (ltp !== 0 && Number.isFinite(ltp) && Math.abs(ltp) < 1e-9) {
          return;
        }

        const bidN = typeof bid === "number" && Number.isFinite(bid) && bid > 0 ? bid : NaN;
        const askN = typeof ask === "number" && Number.isFinite(ask) && ask > 0 ? ask : NaN;

        rememberLiveTick(
          id,
          mcFast !== 1502 && Number.isFinite(ltp) && ltp > 0 ? ltp : null,
          Number.isFinite(bidN) ? bidN : null,
          Number.isFinite(askN) ? askN : null,
        );
        if (mcFast !== 1502 && Number.isFinite(ltp) && ltp > 0) {
          streamLtpAtRef.current.set(id, performance.now());
          lastStreamLtpAtRef.current = Date.now();
        }

        if (mcFast !== 1502 && Number.isFinite(ltp) && ltp > 0) {
          row.ltp = ltp;
          const prevHiLo = row.hiLo;
          if (!prevHiLo) row.hiLo = { h: ltp, l: ltp };
          else {
            row.hiLo = {
              h: ltp > prevHiLo.h ? ltp : prevHiLo.h,
              l: ltp < prevHiLo.l ? ltp : prevHiLo.l,
            };
          }
        }
        scheduleFlushSoon(flushScheduledRef, flushRafRef, flushPending);
    };

    let backoffMs = 500;

    const connect = () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      const es = new EventSource(streamUrl);
      esRef.current = es;

      es.onopen = () => {
        backoffMs = 500;
      };

      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as Record<string, unknown>;
          const batchRaw = parsed.batch;
          const ticks = Array.isArray(batchRaw)
            ? (batchRaw as Record<string, unknown>[])
            : [parsed];
          for (const t of ticks) {
            if (!t || typeof t !== "object") continue;
            applyStreamTick(t);
          }
        } catch {
          /* ignore */
        }
      };

      es.onerror = () => {
        es.close();
        if (esRef.current === es) esRef.current = null;
        if (reconnectTimerRef.current != null) return;
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          backoffMs = Math.min(backoffMs * 2, 8000);
          connect();
        }, backoffMs);
      };
    };

    connect();

    let lastResumeReconnectAt = 0;
    const streamLooksDead = () => {
      const es = esRef.current;
      if (!es || es.readyState === EventSource.CLOSED) return true;
      if (es.readyState === EventSource.CONNECTING) return false;
      const last = lastStreamLtpAtRef.current;
      return Boolean(last) && Date.now() - last > STREAM_GLOBAL_STALE_MS;
    };

    const resumeStream = () => {
      flushPending();
      if (!streamLooksDead()) return;
      const now = Date.now();
      if (now - lastResumeReconnectAt < 2000) return;
      lastResumeReconnectAt = now;
      void mdStartOnce({ force: true });
      connect();
    };

    const flushIv = window.setInterval(() => {
      flushPending();
    }, 50);

    staleWatchRef.current = window.setInterval(() => {
      const last = lastStreamLtpAtRef.current;
      if (!last) return;
      if (Date.now() - last < STREAM_STALE_MS) return;
      void mdStartOnce({ force: true });
      if (!esRef.current || esRef.current.readyState !== EventSource.OPEN) {
        connect();
      }
    }, 15_000);

    const onVis = () => {
      if (document.visibilityState === "visible") resumeStream();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", resumeStream);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", resumeStream);
      if (staleWatchRef.current != null) {
        window.clearInterval(staleWatchRef.current);
        staleWatchRef.current = null;
      }
      window.clearInterval(flushIv);
      if (reconnectTimerRef.current != null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      cancelScheduledFlush(flushScheduledRef, flushRafRef);
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [streamUrl]);

  return (
    <LiveLtpContext.Provider value={map}>
      <LiveAtpContext.Provider value={atpMap}>
        <LiveEma21Context.Provider value={ema21Map}>
          <LiveHiLoContext.Provider value={hiLoMap}>
            <LiveSpotDayRefContext.Provider value={spotDayRef}>{children}</LiveSpotDayRefContext.Provider>
          </LiveHiLoContext.Provider>
        </LiveEma21Context.Provider>
      </LiveAtpContext.Provider>
    </LiveLtpContext.Provider>
  );
}
