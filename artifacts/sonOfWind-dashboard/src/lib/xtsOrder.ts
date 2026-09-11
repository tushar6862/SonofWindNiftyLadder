/** ALGO-enabled XTS accounts reject MARKET and limitPrice 0. Use IOC LIMIT instead. */
export const XTS_IX_ORDER_BASE = {
  orderType: "LIMIT",
  productType: "NRML",
  timeInForce: "IOC",
  apiOrderSource: "WEBAPI",
  disclosedQuantity: 0,
  limitPrice: 0,
  stopPrice: 0,
} as const;

export const OPTION_TICK = 0.05;
/** Percent away from LTP so the LIMIT behaves like a market fill. */
const ALGO_LIMIT_BUF = 0.05;
/** Ladder LIMIT: ~0.4% of premium, clamped 0.20–0.50 so the book cannot walk 2–3 pts. */
const LADDER_BUF_PCT = 0.004;
const LADDER_BUF_TICKS_MIN = 4;
const LADDER_BUF_TICKS_MAX = 10;

export function roundOptionTick(px: number): number {
  return Math.round(px * 20) / 20;
}

function roundLimitToTick(px: number, side: "BUY" | "SELL"): number {
  const ticks = px / OPTION_TICK;
  const n = side === "BUY" ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
  return Math.max(OPTION_TICK, Math.round(n * OPTION_TICK * 100) / 100);
}

export function marketableLimitPrice(side: "BUY" | "SELL", ltp: number): number {
  const raw = side === "BUY" ? ltp * (1 + ALGO_LIMIT_BUF) : ltp * (1 - ALGO_LIMIT_BUF);
  return roundLimitToTick(raw, side);
}

export function ladderSlippage(px: number): number {
  const base = Number.isFinite(px) && px > 0 ? px : 100;
  const ticks = Math.round((base * LADDER_BUF_PCT) / OPTION_TICK);
  const n = Math.max(LADDER_BUF_TICKS_MIN, Math.min(LADDER_BUF_TICKS_MAX, ticks));
  return n * OPTION_TICK;
}

/** Tight LIMIT around live bid (sell) / ask (buy). Prevents 5% book-walk on T8+ size. */
export function ladderLimitPrice(
  side: "BUY" | "SELL",
  ltp: number | null | undefined,
  bid?: number | null,
  ask?: number | null,
): number {
  const live = typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0 ? ltp : 0;
  const bidN = typeof bid === "number" && Number.isFinite(bid) && bid > 0 ? bid : 0;
  const askN = typeof ask === "number" && Number.isFinite(ask) && ask > 0 ? ask : 0;
  const ref = side === "SELL" ? bidN || live : askN || live;
  if (!(ref > 0)) return 0;
  const buf = ladderSlippage(ref);
  return roundLimitToTick(side === "BUY" ? ref + buf : ref - buf, side);
}

export function expectedLadderFill(
  side: "BUY" | "SELL",
  ltp: number | null | undefined,
  bid?: number | null,
  ask?: number | null,
): number {
  const live = typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0 ? ltp : 0;
  const bidN = typeof bid === "number" && Number.isFinite(bid) && bid > 0 ? bid : 0;
  const askN = typeof ask === "number" && Number.isFinite(ask) && ask > 0 ? ask : 0;
  if (side === "SELL") return bidN || live;
  return askN || live;
}

export function ixOrderPricing(side: "BUY" | "SELL", ltp: number | null | undefined) {
  const live = typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0 ? ltp : 0;
  return {
    orderType: "LIMIT" as const,
    timeInForce: "IOC" as const,
    limitPrice: live > 0 ? marketableLimitPrice(side, live) : 0,
    ...(live > 0 ? { ltp: live } : {}),
  };
}

export function ladderOrderPricing(
  side: "BUY" | "SELL",
  ltp: number | null | undefined,
  bid?: number | null,
  ask?: number | null,
) {
  const live = typeof ltp === "number" && Number.isFinite(ltp) && ltp > 0 ? ltp : 0;
  const limit = ladderLimitPrice(side, ltp, bid, ask);
  return {
    orderType: "LIMIT" as const,
    timeInForce: "EOS" as const,
    limitPrice: limit,
    liveReprice: true as const,
    ...(live > 0 ? { ltp: live } : {}),
    ...(typeof bid === "number" && bid > 0 ? { bid } : {}),
    ...(typeof ask === "number" && ask > 0 ? { ask } : {}),
  };
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function orderRowsFromPlaceRaw(raw: unknown): Record<string, unknown>[] {
  const top = asRec(raw);
  if (!top) return [];
  const src = asRec(top.raw) ?? top;
  const inner = src.result ?? src.Result ?? src;
  if (Array.isArray(inner)) return inner.map(asRec).filter((r): r is Record<string, unknown> => r != null);
  const innerRec = asRec(inner);
  if (!innerRec) return [];
  const list = innerRec.list ?? innerRec.orderList ?? innerRec.OrderList;
  if (Array.isArray(list)) return list.map(asRec).filter((r): r is Record<string, unknown> => r != null);
  return [innerRec];
}

/** XTS may return HTTP 200 with OrderStatus Cancelled/Rejected (16388 IOC unfilled). */
export function ixOrderRejectedMessage(raw: unknown): string | null {
  const top = asRec(raw);
  if (!top) return null;
  const typ = String(top.type ?? "").toLowerCase();
  if (typ === "error") {
    const data = asRec(top.data);
    const desc = String(
      top.description ?? data?.description ?? top.error ?? data?.code ?? "Order rejected",
    );
    return desc.trim() || "Order rejected";
  }
  for (const row of orderRowsFromPlaceRaw(raw)) {
    const st = String(row.OrderStatus ?? row.orderStatus ?? "").toUpperCase();
    const reason = String(
      row.CancelRejectReason ??
        row.cancelRejectReason ??
        row.OrderRejectReason ??
        row.RejectReason ??
        row.Reason ??
        row.description ??
        "",
    ).trim();
    const blob = `${st} ${reason}`;
    if (st.includes("REJECT") || st === "CANCELLED" || st === "CANCELED" || /16388|cancelled by system/i.test(blob)) {
      return reason || `Order ${st || "rejected"}`;
    }
  }
  return null;
}
