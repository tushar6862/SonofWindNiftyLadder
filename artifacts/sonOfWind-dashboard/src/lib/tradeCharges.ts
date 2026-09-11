/** Statutory + exchange charges for Indian F&O (estimate, brokerage excluded). */

export type FoKind = "option" | "future";
export type FoVenue = "nse" | "bse";

export type ChargeBreakup = {
  buyTurnover: number;
  sellTurnover: number;
  stt: number;
  stamp: number;
  exchange: number;
  sebi: number;
  ipft: number;
  gst: number;
  total: number;
};

type TradeRow = Record<string, unknown>;

/** Finance Act 2026 STT from 1 Apr 2026; NSE txn/IPFT from 1 Mar 2026 (Rs per crore). */
const STT_OPT_SELL = 0.0015; // 0.15% of premium
const STT_FUT_SELL = 0.0005; // 0.05% of turnover
const STAMP_OPT_BUY = 0.00003; // 0.003% of premium
const STAMP_FUT_BUY = 0.00002; // 0.002% of notional
const SEBI = 0.000001; // Rs 10 / crore, both sides
const GST = 0.18;

const NSE_FUT_TXN = 182.99 / 1e7;
const NSE_FUT_IPFT = 0.01 / 1e7;
const NSE_OPT_TXN = 3552 / 1e7;
const NSE_OPT_IPFT = 1 / 1e7;

/** BSE Sensex / Bankex options — typical published premium txn (no IPFT split used). */
const BSE_OPT_TXN = 0.000325;
const BSE_FUT_TXN = 182.99 / 1e7;

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function classifyFo(row: TradeRow): { kind: FoKind; venue: FoVenue } {
  const seg = String(row.ExchangeSegment ?? row.exchangeSegment ?? "").toUpperCase();
  const venue: FoVenue = seg.includes("BSE") ? "bse" : "nse";
  const inst = String(row.InstrumentType ?? row.instrumentType ?? "").toUpperCase();
  const ot = String(row.OptionType ?? row.optionType ?? "").toUpperCase();
  const sym = String(row.TradingSymbol ?? row.tradingSymbol ?? row.Name ?? "").toUpperCase().replace(/\s+/g, "");

  if (ot === "CE" || ot === "PE" || ot === "CALL" || ot === "PUT" || ot === "3" || ot === "4") {
    return { kind: "option", venue };
  }
  if (inst.includes("OPT")) return { kind: "option", venue };
  if (inst.includes("FUT")) return { kind: "future", venue };
  if (sym.includes("FUT")) return { kind: "future", venue };
  if (sym.endsWith("CE") || sym.endsWith("PE")) return { kind: "option", venue };
  return { kind: "option", venue };
}

function fillValue(row: TradeRow): { side: "BUY" | "SELL" | null; value: number } {
  const sideRaw = String(row.OrderSide ?? row.orderSide ?? "").toUpperCase();
  const side: "BUY" | "SELL" | null = sideRaw === "BUY" ? "BUY" : sideRaw === "SELL" ? "SELL" : null;
  const px = toNum(row.LastTradedPrice ?? row.TradePrice ?? row.tradePrice) ?? 0;
  const qty = toNum(row.LastTradedQuantity ?? row.TradedQuantity ?? row.tradedQty) ?? 0;
  const value = px > 0 && qty > 0 ? px * qty : 0;
  return { side, value };
}

function ratesFor(kind: FoKind, venue: FoVenue): { txn: number; ipft: number; sttSell: number; stampBuy: number } {
  if (kind === "future") {
    return {
      txn: venue === "bse" ? BSE_FUT_TXN : NSE_FUT_TXN,
      ipft: venue === "nse" ? NSE_FUT_IPFT : 0,
      sttSell: STT_FUT_SELL,
      stampBuy: STAMP_FUT_BUY,
    };
  }
  return {
    txn: venue === "bse" ? BSE_OPT_TXN : NSE_OPT_TXN,
    ipft: venue === "nse" ? NSE_OPT_IPFT : 0,
    sttSell: STT_OPT_SELL,
    stampBuy: STAMP_OPT_BUY,
  };
}

export function computeTradeCharges(rows: TradeRow[]): ChargeBreakup {
  let buyTurnover = 0;
  let sellTurnover = 0;
  let stt = 0;
  let stamp = 0;
  let exchange = 0;
  let sebi = 0;
  let ipft = 0;

  for (const row of rows) {
    const { side, value } = fillValue(row);
    if (!side || !(value > 0)) continue;
    const { kind, venue } = classifyFo(row);
    const { txn, ipft: ipftRate, sttSell, stampBuy } = ratesFor(kind, venue);

    if (side === "BUY") buyTurnover += value;
    else sellTurnover += value;

    exchange += value * txn;
    sebi += value * SEBI;
    ipft += value * ipftRate;
    if (side === "SELL") stt += value * sttSell;
    if (side === "BUY") stamp += value * stampBuy;
  }

  stt = r2(stt);
  stamp = r2(stamp);
  exchange = r2(exchange);
  sebi = r2(sebi);
  ipft = r2(ipft);
  const gst = r2((exchange + sebi + ipft) * GST);
  const total = r2(stt + stamp + exchange + sebi + ipft + gst);

  return {
    buyTurnover: r2(buyTurnover),
    sellTurnover: r2(sellTurnover),
    stt,
    stamp,
    exchange,
    sebi,
    ipft,
    gst,
    total,
  };
}

export const CHARGES_NOTE =
  "Estimate: STT from 1 Apr 2026 (Finance Act 2026). NSE txn/IPFT from 1 Mar 2026. GST 18% on exch+SEBI+IPFT. Brokerage not included.";
