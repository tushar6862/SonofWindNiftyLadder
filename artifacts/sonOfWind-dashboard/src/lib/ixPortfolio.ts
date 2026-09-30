import { apiFetch } from "@/lib/backend";

export const POSITIONS_REFRESH_EVENT = "sow:positions_refresh";

type DayOrNet = "NetWise" | "DayWise";
type CacheRow = { at: number; data: unknown };

const mem = new Map<string, CacheRow>();
const inflight = new Map<string, Promise<unknown>>();

function freshMs(key: string): number {
  if (key === "tradebook") return 20_000;
  if (key === "pos:DayWise") return 90_000;
  if (key === "orderbook") return 8_000;
  return 12_000;
}

const STALE_MS = 90_000;

function cachedGet(key: string, path: string): Promise<unknown> {
  const now = Date.now();
  const hit = mem.get(key);
  if (hit && now - hit.at < freshMs(key)) return Promise.resolve(hit.data);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = apiFetch(path)
    .then((data) => {
      mem.set(key, { at: Date.now(), data });
      return data;
    })
    .catch((err: unknown) => {
      if (hit && Date.now() - hit.at < STALE_MS) return hit.data;
      throw err;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export function fetchIxPositions(
  dayOrNet: DayOrNet = "NetWise",
  opts?: { bypassCache?: boolean },
): Promise<unknown> {
  const key = `pos:${dayOrNet}`;
  const path = `/api/ix/positions?dayOrNet=${dayOrNet}`;
  if (opts?.bypassCache) {
    return apiFetch(path).then((data) => {
      mem.set(key, { at: Date.now(), data });
      inflight.delete(key);
      return applyLocalPositionOverlay(data);
    });
  }
  return cachedGet(key, path).then(applyLocalPositionOverlay);
}

export function fetchIxOrderBook(): Promise<unknown> {
  return cachedGet("orderbook", "/api/ix/orderbook");
}

export function fetchIxTradeBook(): Promise<unknown> {
  return cachedGet("tradebook", "/api/ix/tradebook");
}

function invalidatePortfolioCache(kind: "positions" | "all" = "positions"): void {
  for (const key of Array.from(mem.keys())) {
    if (kind === "positions" && (key === "tradebook" || key === "pos:DayWise" || key === "orderbook")) continue;
    const row = mem.get(key);
    if (row) mem.set(key, { at: 0, data: row.data });
  }
}

let bumpSoon: number | null = null;
let bumpLate: number | null = null;

/** One coalesced NetWise refresh now, one after broker snapshot. DayWise/tradebook stay cached. */
export function bumpPositionsRefresh(): void {
  if (typeof window === "undefined") return;
  if (bumpSoon == null) {
    bumpSoon = window.setTimeout(() => {
      bumpSoon = null;
      window.dispatchEvent(new CustomEvent(POSITIONS_REFRESH_EVENT));
    }, 180);
  }
  if (bumpLate == null) {
    bumpLate = window.setTimeout(() => {
      bumpLate = null;
      invalidatePortfolioCache("positions");
      window.dispatchEvent(new CustomEvent(POSITIONS_REFRESH_EVENT));
    }, 1600);
  }
}

const SEG_NAME: Record<number, string> = {
  1: "NSECM",
  2: "NSEFO",
  3: "NSECD",
  11: "BSECM",
  12: "BSEFO",
  51: "MCXFO",
};

const localShorts = new Map<number, Record<string, unknown>>();
/** Closed here, but the broker snapshot can still show the old qty while positions are rate-limited. */
const SQUARED_KEY = "sow_squared_mtm_v1";
const squaredBook = new Map<number, number | null>();

function loadSquaredBook(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    const raw = JSON.parse(sessionStorage.getItem(SQUARED_KEY) || "[]") as Array<{ iid?: number; pnl?: number | null }>;
    if (!Array.isArray(raw)) return;
    for (const row of raw) {
      const iid = Math.floor(Number(row?.iid) || 0);
      if (!(iid > 0)) continue;
      const pnl = row?.pnl;
      squaredBook.set(iid, typeof pnl === "number" && Number.isFinite(pnl) ? pnl : null);
    }
  } catch {
    /* ignore */
  }
}

function saveSquaredBook(): void {
  if (typeof sessionStorage === "undefined") return;
  const rows = Array.from(squaredBook.entries()).map(([iid, pnl]) => ({ iid, pnl }));
  try {
    sessionStorage.setItem(SQUARED_KEY, JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

loadSquaredBook();

function forceBookFlat(row: Record<string, unknown>, pnl: number | null): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...row,
    NetPosition: 0,
    netPosition: 0,
    Quantity: 0,
    quantity: 0,
    NetQuantity: 0,
    netQuantity: 0,
    OpenSellQuantity: 0,
    openSellQuantity: 0,
    OpenBuyQuantity: 0,
    openBuyQuantity: 0,
    ShortPosition: 0,
    LongPosition: 0,
  };
  if (pnl != null && Number.isFinite(pnl)) {
    next.ActualMarkToMarket = pnl;
    next.actualMarkToMarket = pnl;
    next.MarkToMarket = pnl;
    next.markToMarket = pnl;
    next.MTM = pnl;
    next.mtm = pnl;
    next.NetAmount = pnl;
    next.netAmount = pnl;
  }
  return next;
}

function overlayIid(row: Record<string, unknown>): number | null {
  const v = row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID ?? row.exchangeInstrumentId;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function overlayNet(row: Record<string, unknown>): number {
  const raw = row.NetPosition ?? row.netPosition ?? row.Quantity ?? row.quantity;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(n) && n !== 0) return n;
  const osq = Number(row.OpenSellQuantity ?? row.openSellQuantity ?? 0);
  const obq = Number(row.OpenBuyQuantity ?? row.openBuyQuantity ?? 0);
  return obq - osq;
}

function clonePositionsPayload(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return data;
  }
}

function patchPositionList(data: unknown, list: Record<string, unknown>[]): unknown {
  const obj = data as Record<string, unknown>;
  const raw = (obj.raw && typeof obj.raw === "object" ? obj.raw : obj) as Record<string, unknown>;
  const res = (raw.result ?? raw.Result ?? raw) as Record<string, unknown>;
  if (res && typeof res === "object" && !Array.isArray(res)) {
    if ("positionList" in res) res.positionList = list;
    else if ("PositionList" in res) res.PositionList = list;
    else res.positionList = list;
    return data;
  }
  if (Array.isArray(raw.result)) {
    raw.result = list;
    return data;
  }
  return { ...(obj as object), raw: { type: "success", result: { positionList: list } } };
}

function readPositionList(data: unknown): Record<string, unknown>[] {
  const obj = (data && typeof data === "object" ? data : null) as Record<string, unknown> | null;
  if (!obj) return [];
  const raw = (obj.raw && typeof obj.raw === "object" ? obj.raw : obj) as Record<string, unknown>;
  const res = raw.result ?? raw.Result ?? raw;
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  if (res && typeof res === "object") {
    const rec = res as Record<string, unknown>;
    const lst = rec.positionList ?? rec.PositionList ?? rec.positions;
    if (Array.isArray(lst)) return lst as Record<string, unknown>[];
  }
  return [];
}

function applyLocalPositionOverlay(data: unknown): unknown {
  if (localShorts.size === 0 && squaredBook.size === 0) return data;
  const cloned = clonePositionsPayload(data);
  const broker = readPositionList(cloned);
  const keepBroker: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  for (const row of broker) {
    const iid = overlayIid(row);
    const net = overlayNet(row);
    if (iid != null && squaredBook.has(iid)) {
      // Keep the freeze until a new short is taken. A later stale snapshot
      // often brings the old qty back after one flat read.
      if (net === 0) keepBroker.push(row);
      else keepBroker.push(forceBookFlat(row, squaredBook.get(iid) ?? null));
      seen.add(iid);
      continue;
    }
    if (iid != null && net < 0) {
      localShorts.delete(iid);
      seen.add(iid);
    }
    keepBroker.push(row);
  }
  const extra: Record<string, unknown>[] = [];
  for (const [iid, row] of localShorts) {
    if (seen.has(iid)) continue;
    extra.push(row);
  }
  const flattened = keepBroker.some((row, i) => row !== broker[i]);
  if (!extra.length && !flattened) return cloned;
  return patchPositionList(cloned, [...keepBroker, ...extra]);
}

function emitPosRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(POSITIONS_REFRESH_EVENT));
}

function segLabel(seg: number | string): string {
  if (typeof seg === "string" && seg.trim()) return seg.trim().toUpperCase();
  return SEG_NAME[Number(seg)] || "NSEFO";
}

/** Optimistic short so Positions/MTM show while GET /portfolio/positions is rate-limited. */
export function setLocalShortPosition(opts: {
  exchangeInstrumentID: number;
  exchangeSegment: number | string;
  qty: number;
  fillPx: number;
  tradingSymbol?: string;
  productType?: string;
}): void {
  const iid = Math.floor(opts.exchangeInstrumentID);
  const qty = Math.floor(Math.abs(opts.qty));
  if (!(iid > 0) || qty <= 0 || !(opts.fillPx > 0)) return;
  const prev = localShorts.get(iid);
  const row: Record<string, unknown> = {
    ExchangeInstrumentID: iid,
    ExchangeInstrumentId: iid,
    ExchangeSegment: segLabel(opts.exchangeSegment),
    TradingSymbol: opts.tradingSymbol || prev?.TradingSymbol || `IID ${iid}`,
    ProductType: opts.productType || "NRML",
    NetPosition: -qty,
    Quantity: -qty,
    ShortPosition: qty,
    LongPosition: 0,
    OpenSellQuantity: qty,
    OpenBuyQuantity: 0,
    SellAveragePrice: opts.fillPx,
    AveragePrice: opts.fillPx,
    _sowLocal: true,
  };
  const same = prev && JSON.stringify(prev) === JSON.stringify(row);
  squaredBook.delete(iid);
  saveSquaredBook();
  localShorts.set(iid, row);
  if (!same) emitPosRefresh();
}

/** Booked close for this instrument. Null pnl means flatten qty and keep the broker number. */
export function squaredMark(exchangeInstrumentID: number): { pnl: number | null } | null {
  const iid = Math.floor(exchangeInstrumentID);
  if (!(iid > 0) || !squaredBook.has(iid)) return null;
  const pnl = squaredBook.get(iid);
  return { pnl: typeof pnl === "number" && Number.isFinite(pnl) ? pnl : null };
}

export function clearLocalPosition(exchangeInstrumentID: number, bookedPnl?: number): void {
  const iid = Math.floor(exchangeInstrumentID);
  if (!(iid > 0)) return;
  localShorts.delete(iid);
  const prev = squaredBook.get(iid);
  const base = typeof prev === "number" && Number.isFinite(prev) ? prev : 0;
  if (typeof bookedPnl === "number" && Number.isFinite(bookedPnl)) squaredBook.set(iid, base + bookedPnl);
  else if (!squaredBook.has(iid)) squaredBook.set(iid, null);
  saveSquaredBook();
  emitPosRefresh();
}
