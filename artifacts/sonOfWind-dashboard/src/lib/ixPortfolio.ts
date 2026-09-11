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

function overlayIid(row: Record<string, unknown>): number | null {
  const v = row.ExchangeInstrumentID ?? row.ExchangeInstrumentId ?? row.exchangeInstrumentID;
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
  if (localShorts.size === 0) return data;
  const cloned = clonePositionsPayload(data);
  const broker = readPositionList(cloned);
  const keepBroker: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  for (const row of broker) {
    const iid = overlayIid(row);
    const net = overlayNet(row);
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
  if (!extra.length) return cloned;
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
  };
  const same = prev && JSON.stringify(prev) === JSON.stringify(row);
  localShorts.set(iid, row);
  if (!same) emitPosRefresh();
}

export function clearLocalPosition(exchangeInstrumentID: number): void {
  const iid = Math.floor(exchangeInstrumentID);
  if (!localShorts.delete(iid)) return;
  emitPosRefresh();
}
