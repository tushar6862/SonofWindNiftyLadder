import { fmtNum, fmtPnl, fmtQty } from "@/lib/formatNumber";
import { CHARGES_NOTE, computeTradeCharges, type ChargeBreakup } from "@/lib/tradeCharges";

type TradeRow = Record<string, unknown>;

export type TradeBookPdfRow = {
  symbol: string;
  segment: string;
  side: string;
  price: string;
  tradedQty: string;
  qty: string;
  status: string;
  date: string;
};

export type DayPnlSymbol = { symbol: string; qty: number; pnl: number };

export function tradeBookPdfRow(r: TradeRow): TradeBookPdfRow {
  const s = (v: unknown, fallback = "") => (v == null || v === "" ? fallback : String(v));
  return {
    symbol: s(r.TradingSymbol ?? r.tradingSymbol, "—"),
    segment: s(r.ExchangeSegment ?? r.exchangeSegment),
    side: s(r.OrderSide ?? r.orderSide, "—"),
    price: s(r.LastTradedPrice ?? r.TradePrice ?? r.tradePrice),
    tradedQty: s(r.LastTradedQuantity ?? r.TradedQuantity ?? r.tradedQty),
    qty: s(r.OrderQuantity ?? r.orderQuantity),
    status: s(r.OrderStatus ?? r.orderStatus),
    date: s(r.LastExecutionTransactTime ?? r.ExchangeTransactTime),
  };
}

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function instrumentId(p: TradeRow): number | null {
  return toNum(
    p.ExchangeInstrumentId ?? p.ExchangeInstrumentID ?? p.exchangeInstrumentId ?? p.exchangeInstrumentID,
  );
}

function netQty(p: TradeRow): number {
  const qtyRaw =
    toNum(p.NetPosition ?? p.netPosition ?? p.Quantity ?? p.quantity) ??
    ((toNum(p.LongPosition) ?? 0) - (toNum(p.ShortPosition) ?? 0));
  const obq = toNum(p.OpenBuyQuantity ?? p.openBuyQuantity) ?? 0;
  const osq = toNum(p.OpenSellQuantity ?? p.openSellQuantity) ?? 0;
  const q = qtyRaw != null && Number.isFinite(qtyRaw) && qtyRaw !== 0 ? qtyRaw : obq - osq;
  return Number.isFinite(q) ? q : 0;
}

/** Same basis as dashboard MTM / Positions PnL. */
function positionPnl(p: TradeRow, ltpLive?: number): number {
  const qty = netQty(p);
  const mtmBroker = toNum(
    p.MarkToMarket ??
      p.markToMarket ??
      p.MTM ??
      p.mtm ??
      p["Mark To Market"] ??
      p["Actual Mark To Market"] ??
      p.ActualMarkToMarket ??
      p.UnrealizedMTM ??
      p.unrealizedMTM,
  );
  if (mtmBroker != null && Math.abs(mtmBroker) > 1e-9) return mtmBroker;

  if (!qty) {
    const netAmt = toNum(p.NetAmount ?? p.netAmount ?? p.NetValue ?? p.netValue);
    return netAmt ?? 0;
  }

  const ltpBroker = toNum(p.LastTradePrice ?? p.lastTradePrice ?? p.LastTradedPrice ?? p.lastTradedPrice ?? p.ltp);
  const ltp =
    typeof ltpLive === "number" && Number.isFinite(ltpLive) && ltpLive > 0 ? ltpLive : (ltpBroker ?? 0);

  const actSell = toNum(p.ActualSellAmount ?? p.actualSellAmount);
  const actBuy = toNum(p.ActualBuyAmount ?? p.actualBuyAmount);
  if (actSell != null && actBuy != null && ltp) return actSell - actBuy + qty * ltp;

  const netAmt = toNum(p.NetAmount ?? p.netAmount ?? p.NetValue ?? p.netValue);
  if (netAmt != null && ltp) return netAmt + qty * ltp;

  const buyAvg = toNum(p.BuyAveragePrice ?? p.buyAvgPrice ?? p.BuyAvgPrice);
  const sellAvg = toNum(p.SellAveragePrice ?? p.sellAvgPrice ?? p.SellAvgPrice);
  const avg =
    qty < 0
      ? (sellAvg ?? buyAvg ?? toNum(p.AveragePrice ?? p.avgPrice))
      : (buyAvg ?? sellAvg ?? toNum(p.AveragePrice ?? p.avgPrice));
  if (avg && ltp) return (ltp - avg) * qty;
  return 0;
}

export function summarizeDayPnl(
  positions: TradeRow[],
  ltps: Record<number, number> = {},
): { total: number; plus: number; minus: number; symbols: DayPnlSymbol[] } {
  const symbols: DayPnlSymbol[] = [];
  let total = 0;
  let plus = 0;
  let minus = 0;
  for (const p of positions) {
    const iid = instrumentId(p);
    const ltp = iid != null ? ltps[iid] : undefined;
    const pnl = positionPnl(p, ltp);
    const qty = netQty(p);
    if (Math.abs(pnl) < 1e-9 && !qty) continue;
    const symbol = String(p.TradingSymbol ?? p.tradingSymbol ?? p.Symbol ?? p.symbol ?? "—");
    symbols.push({ symbol, qty, pnl });
    total += pnl;
    if (pnl > 0) plus += pnl;
    else if (pnl < 0) minus += pnl;
  }
  symbols.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  return { total: r2(total), plus: r2(plus), minus: r2(minus), symbols };
}

function tradeTimeMs(r: TradeRow): number {
  const t = String(r.LastExecutionTransactTime ?? r.ExchangeTransactTime ?? "");
  const n = Date.parse(t);
  return Number.isFinite(n) ? n : 0;
}

/** FIFO realized P&L from today's fills — used only if broker positions are missing. */
export function realizedPnlFromTrades(rows: TradeRow[]): number {
  const sorted = [...rows].sort((a, b) => tradeTimeMs(a) - tradeTimeMs(b));
  type Lot = { dir: 1 | -1; qty: number; px: number };
  const books = new Map<string, Lot[]>();
  let realized = 0;
  for (const r of sorted) {
    const symbol = String(r.TradingSymbol ?? r.tradingSymbol ?? "").trim();
    const sideRaw = String(r.OrderSide ?? r.orderSide ?? "").toUpperCase();
    const dir: 1 | -1 | 0 = sideRaw === "BUY" ? 1 : sideRaw === "SELL" ? -1 : 0;
    const qty = toNum(r.LastTradedQuantity ?? r.TradedQuantity ?? r.tradedQty) ?? 0;
    const px = toNum(r.LastTradedPrice ?? r.TradePrice ?? r.tradePrice) ?? 0;
    if (!symbol || !dir || !(qty > 0) || !(px > 0)) continue;
    const book = books.get(symbol) ?? [];
    let left = qty;
    while (left > 0 && book.length && book[0].dir !== dir) {
      const lot = book[0];
      const m = Math.min(left, lot.qty);
      realized += lot.dir === 1 ? (px - lot.px) * m : (lot.px - px) * m;
      lot.qty -= m;
      left -= m;
      if (lot.qty <= 1e-9) book.shift();
    }
    if (left > 0) book.push({ dir, qty: left, px });
    books.set(symbol, book);
  }
  return realized;
}

function istStamp(): { title: string; file: string } {
  const now = new Date();
  const title = now.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(now);
  return { title: `${title} IST`, file: `TradeBook_${parts.replace(/\//g, "-")}.pdf` };
}

function ascii(s: string): string {
  return Array.from(s)
    .map((ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 32 && c <= 126) return ch;
      if (c === 8211 || c === 8212) return "-";
      if (c === 8216 || c === 8217) return "'";
      if (c === 8220 || c === 8221) return '"';
      return "?";
    })
    .join("");
}

function pdfStr(s: string): string {
  return `(${ascii(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

function fit(s: string, maxChars: number): string {
  const t = ascii(s).trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(1, maxChars - 1))}.`;
}

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 32;
const HEADER_H = 52;
const ROW_H = 16;
const SYM_ROW_H = 14;
const MAX_SYM_ROWS = 5;
const PNL_BOX_W = 196;
const CHARGE_ROW_H = 13;
const COLS: Array<{ key: keyof TradeBookPdfRow; label: string; w: number; chars: number }> = [
  { key: "symbol", label: "Symbol", w: 168, chars: 28 },
  { key: "segment", label: "Segment", w: 78, chars: 12 },
  { key: "side", label: "Side", w: 48, chars: 8 },
  { key: "price", label: "Trade Price", w: 78, chars: 12 },
  { key: "tradedQty", label: "Traded Qty", w: 72, chars: 11 },
  { key: "qty", label: "Qty", w: 56, chars: 9 },
  { key: "status", label: "Status", w: 88, chars: 14 },
  { key: "date", label: "Date", w: 190, chars: 32 },
];

function tableWidth(): number {
  return COLS.reduce((n, c) => n + c.w, 0);
}

function symbolBlockHeight(symbolCount: number, show: boolean): number {
  if (!show || symbolCount <= 0) return 0;
  const vis = Math.min(symbolCount, MAX_SYM_ROWS);
  return 8 + 16 + 14 + (vis + 1) * SYM_ROW_H + 10;
}

function chargesBlockHeight(show: boolean): number {
  if (!show) return 0;
  return 8 + 14 + 14 + 4 * CHARGE_ROW_H + 12 + 8;
}

function plusMinusBarHeight(show: boolean): number {
  return show ? 42 : 0;
}

function tradesPerPage(pageIndex: number, symbolCount: number): number {
  const extra =
    pageIndex === 0
      ? symbolBlockHeight(symbolCount, true) + chargesBlockHeight(true) + plusMinusBarHeight(true)
      : 0;
  const usable = PAGE_H - MARGIN - HEADER_H - 16 - extra - MARGIN - 8;
  return Math.max(1, Math.floor(usable / ROW_H));
}

function pnlFill(pnl: number): string {
  if (pnl > 0) return "0.08 0.42 0.24 rg";
  if (pnl < 0) return "0.58 0.12 0.14 rg";
  return "0.22 0.28 0.36 rg";
}

function pnlTextColor(pnl: number): string {
  if (pnl > 0) return "0.06 0.42 0.22 rg";
  if (pnl < 0) return "0.72 0.12 0.14 rg";
  return "0.12 0.14 0.18 rg";
}

function pageContent(
  rows: TradeBookPdfRow[],
  page: number,
  pageCount: number,
  generated: string,
  totalTrades: number,
  dayPnl: number,
  netPnl: number,
  plusPnl: number,
  minusPnl: number,
  charges: ChargeBreakup,
  symbols: DayPnlSymbol[],
  showSummary: boolean,
): string {
  const cmds: string[] = [];
  const tableW = tableWidth();
  const tableX = MARGIN;
  const barY = PAGE_H - MARGIN - 44;
  const pnlBoxX = MARGIN + tableW - PNL_BOX_W;

  cmds.push("0.07 0.16 0.36 rg");
  cmds.push(`${MARGIN} ${barY} ${tableW - PNL_BOX_W} 44 re f`);
  cmds.push(pnlFill(netPnl));
  cmds.push(`${pnlBoxX} ${barY} ${PNL_BOX_W} 44 re f`);

  cmds.push("BT");
  cmds.push("/F2 13 Tf");
  cmds.push("1 1 1 rg");
  cmds.push(`1 0 0 1 ${MARGIN + 10} ${barY + 24} Tm`);
  cmds.push(`${pdfStr("SON OF WIND  —  TRADE BOOK")} Tj`);
  cmds.push("/F1 8 Tf");
  cmds.push(`1 0 0 1 ${MARGIN + 10} ${barY + 9} Tm`);
  cmds.push(`${pdfStr(`${totalTrades} trade${totalTrades === 1 ? "" : "s"}  |  ${generated}`)} Tj`);
  cmds.push("/F1 6 Tf");
  cmds.push(`1 0 0 1 ${pnlBoxX + 10} ${barY + 32} Tm`);
  cmds.push(`${pdfStr("PLUS " + fmtPnl(plusPnl) + "   MINUS " + (minusPnl === 0 ? "0.00" : fmtPnl(minusPnl)))} Tj`);
  cmds.push("/F1 6 Tf");
  cmds.push(`1 0 0 1 ${pnlBoxX + 10} ${barY + 21} Tm`);
  cmds.push(`${pdfStr("NET AFTER CHARGES")} Tj`);
  cmds.push("/F2 12 Tf");
  cmds.push(`1 0 0 1 ${pnlBoxX + 10} ${barY + 7} Tm`);
  cmds.push(`${pdfStr(fmtPnl(netPnl))} Tj`);
  cmds.push("ET");

  let cursorY = PAGE_H - MARGIN - HEADER_H;

  if (showSummary) {
    const cellW = tableW / 4;
    const barH = 30;
    cursorY -= 8;
    const cells: Array<{ label: string; value: string; fill: string }> = [
      { label: "PLUS", value: fmtPnl(plusPnl), fill: "0.08 0.42 0.24 rg" },
      { label: "MINUS", value: minusPnl === 0 ? "0.00" : fmtPnl(minusPnl), fill: "0.58 0.12 0.14 rg" },
      { label: "GROSS", value: fmtPnl(dayPnl), fill: pnlFill(dayPnl) },
      { label: "NET", value: fmtPnl(netPnl), fill: pnlFill(netPnl) },
    ];
    cells.forEach((cell, i) => {
      const x = tableX + i * cellW;
      cmds.push(cell.fill);
      cmds.push(`${x} ${cursorY - barH + 8} ${cellW - (i === 3 ? 0 : 3)} ${barH} re f`);
      cmds.push("BT /F1 6 Tf 1 1 1 rg");
      cmds.push(`1 0 0 1 ${x + 8} ${cursorY - 2} Tm ${pdfStr(cell.label)} Tj`);
      cmds.push("/F2 11 Tf");
      cmds.push(`1 0 0 1 ${x + 8} ${cursorY - 16} Tm ${pdfStr(cell.value)} Tj`);
      cmds.push("ET");
    });
    cursorY -= barH + 6;
  }

  if (showSummary && symbols.length) {
    const vis = symbols.slice(0, MAX_SYM_ROWS);
    const hidden = symbols.length - vis.length;
    cursorY -= 8;
    cmds.push("BT /F2 8 Tf 0.07 0.16 0.36 rg");
    cmds.push(`1 0 0 1 ${tableX} ${cursorY} Tm ${pdfStr("Day P&L by symbol")} Tj`);
    cmds.push("ET");
    cursorY -= 16;

    const sw = [420, 140, tableW - 560];
    cmds.push("0.10 0.22 0.46 rg");
    cmds.push(`${tableX} ${cursorY} ${tableW} 14 re f`);
    cmds.push("BT /F2 7 Tf 1 1 1 rg");
    cmds.push(`1 0 0 1 ${tableX + 4} ${cursorY + 4} Tm ${pdfStr("Symbol")} Tj`);
    cmds.push(`1 0 0 1 ${tableX + sw[0] + 4} ${cursorY + 4} Tm ${pdfStr("Qty")} Tj`);
    cmds.push(`1 0 0 1 ${tableX + sw[0] + sw[1] + 4} ${cursorY + 4} Tm ${pdfStr("Day P&L")} Tj`);
    cmds.push("ET");

    vis.forEach((row, i) => {
      const y = cursorY - (i + 1) * SYM_ROW_H;
      if (i % 2 === 0) {
        cmds.push("0.94 0.96 0.98 rg");
        cmds.push(`${tableX} ${y} ${tableW} ${SYM_ROW_H} re f`);
      }
      cmds.push("BT /F1 7 Tf 0.12 0.14 0.18 rg");
      cmds.push(`1 0 0 1 ${tableX + 4} ${y + 4} Tm ${pdfStr(fit(row.symbol, 52))} Tj`);
      cmds.push(`1 0 0 1 ${tableX + sw[0] + 4} ${y + 4} Tm ${pdfStr(fmtQty(row.qty))} Tj`);
      cmds.push("ET");
      cmds.push("BT /F2 7 Tf");
      cmds.push(pnlTextColor(row.pnl));
      cmds.push(`1 0 0 1 ${tableX + sw[0] + sw[1] + 4} ${y + 4} Tm ${pdfStr(fmtPnl(row.pnl))} Tj`);
      cmds.push("ET");
    });

    const totalY = cursorY - (vis.length + 1) * SYM_ROW_H;
    cmds.push("0.88 0.91 0.95 rg");
    cmds.push(`${tableX} ${totalY} ${tableW} ${SYM_ROW_H} re f`);
    cmds.push("BT /F2 7 Tf 0.07 0.16 0.36 rg");
    const totalLabel = hidden > 0 ? `TOTAL  (+${hidden} more)` : "TOTAL";
    cmds.push(`1 0 0 1 ${tableX + 4} ${totalY + 4} Tm ${pdfStr(totalLabel)} Tj`);
    cmds.push("ET");
    cmds.push("BT /F2 7 Tf");
    cmds.push(pnlTextColor(dayPnl));
    cmds.push(`1 0 0 1 ${tableX + sw[0] + sw[1] + 4} ${totalY + 4} Tm ${pdfStr(fmtPnl(dayPnl))} Tj`);
    cmds.push("ET");
    cmds.push("0.10 0.22 0.46 RG 0.6 w");
    cmds.push(`${tableX} ${cursorY + 14} ${tableW} ${-(14 + (vis.length + 1) * SYM_ROW_H)} re S`);
    cursorY = totalY - 10;
  }

  if (showSummary) {
    cursorY -= 8;
    cmds.push("BT /F2 8 Tf 0.07 0.16 0.36 rg");
    cmds.push(`1 0 0 1 ${tableX} ${cursorY} Tm ${pdfStr("STT and other charges (estimate, brokerage not included)")} Tj`);
    cmds.push("ET");
    cursorY -= 14;
    cmds.push("0.10 0.22 0.46 rg");
    cmds.push(`${tableX} ${cursorY} ${tableW} 14 re f`);
    cmds.push("BT /F2 7 Tf 1 1 1 rg");
    cmds.push(`1 0 0 1 ${tableX + 4} ${cursorY + 4} Tm ${pdfStr("Charge")} Tj`);
    cmds.push(`1 0 0 1 ${tableX + 200} ${cursorY + 4} Tm ${pdfStr("Amount")} Tj`);
    cmds.push(`1 0 0 1 ${tableX + tableW / 2 + 4} ${cursorY + 4} Tm ${pdfStr("Charge")} Tj`);
    cmds.push(`1 0 0 1 ${tableX + tableW / 2 + 200} ${cursorY + 4} Tm ${pdfStr("Amount")} Tj`);
    cmds.push("ET");

    const pairs: Array<[string, number]> = [
      ["STT (sell)", charges.stt],
      ["Stamp duty (buy)", charges.stamp],
      ["Exchange txn", charges.exchange],
      ["SEBI", charges.sebi],
      ["IPFT", charges.ipft],
      ["GST 18% (exch+SEBI+IPFT)", charges.gst],
    ];
    for (let i = 0; i < 3; i++) {
      const y = cursorY - (i + 1) * CHARGE_ROW_H;
      const left = pairs[i];
      const right = pairs[i + 3];
      if (i % 2 === 0) {
        cmds.push("0.94 0.96 0.98 rg");
        cmds.push(`${tableX} ${y} ${tableW} ${CHARGE_ROW_H} re f`);
      }
      cmds.push("BT /F1 7 Tf 0.12 0.14 0.18 rg");
      cmds.push(`1 0 0 1 ${tableX + 4} ${y + 3} Tm ${pdfStr(left[0])} Tj`);
      cmds.push(`1 0 0 1 ${tableX + 200} ${y + 3} Tm ${pdfStr(fmtNum(left[1], { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} Tj`);
      cmds.push(`1 0 0 1 ${tableX + tableW / 2 + 4} ${y + 3} Tm ${pdfStr(right[0])} Tj`);
      cmds.push(`1 0 0 1 ${tableX + tableW / 2 + 200} ${y + 3} Tm ${pdfStr(fmtNum(right[1], { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} Tj`);
      cmds.push("ET");
    }

    const totY = cursorY - 4 * CHARGE_ROW_H;
    cmds.push("0.88 0.91 0.95 rg");
    cmds.push(`${tableX} ${totY} ${tableW} ${CHARGE_ROW_H} re f`);
    cmds.push("BT /F2 7 Tf 0.07 0.16 0.36 rg");
    cmds.push(`1 0 0 1 ${tableX + 4} ${totY + 3} Tm ${pdfStr("Total charges")} Tj`);
    cmds.push(`1 0 0 1 ${tableX + 200} ${totY + 3} Tm ${pdfStr(fmtNum(charges.total, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))} Tj`);
    cmds.push("ET");
    cmds.push("BT /F2 7 Tf");
    cmds.push(pnlTextColor(netPnl));
    cmds.push(`1 0 0 1 ${tableX + tableW / 2 + 4} ${totY + 3} Tm ${pdfStr("Net P&L")} Tj`);
    cmds.push(`1 0 0 1 ${tableX + tableW / 2 + 200} ${totY + 3} Tm ${pdfStr(fmtPnl(netPnl))} Tj`);
    cmds.push("ET");
    cmds.push("0.10 0.22 0.46 RG 0.6 w");
    cmds.push(`${tableX} ${cursorY + 14} ${tableW} ${-(14 + 4 * CHARGE_ROW_H)} re S`);
    cursorY = totY - 12;
    cmds.push("BT /F1 6 Tf 0.40 0.45 0.50 rg");
    cmds.push(`1 0 0 1 ${tableX} ${cursorY} Tm ${pdfStr(fit(CHARGES_NOTE, 140))} Tj`);
    cmds.push("ET");
    cursorY -= 8;
  }

  const headY = cursorY - 16;
  let x = tableX;
  cmds.push("0.10 0.22 0.46 rg");
  cmds.push(`${tableX} ${headY} ${tableW} 16 re f`);
  cmds.push("BT /F2 7 Tf 1 1 1 rg");
  for (const col of COLS) {
    cmds.push(`1 0 0 1 ${x + 4} ${headY + 5} Tm ${pdfStr(col.label)} Tj`);
    x += col.w;
  }
  cmds.push("ET");

  rows.forEach((row, i) => {
    const y = headY - (i + 1) * ROW_H;
    if (i % 2 === 0) {
      cmds.push("0.94 0.96 0.98 rg");
      cmds.push(`${tableX} ${y} ${tableW} ${ROW_H} re f`);
    }
    cmds.push("0.82 0.86 0.90 RG 0.4 w");
    cmds.push(`${tableX} ${y} m ${tableX + tableW} ${y} l S`);

    let cx = tableX;
    cmds.push("BT /F1 7 Tf 0.12 0.14 0.18 rg");
    for (const col of COLS) {
      const val = fit(row[col.key], col.chars);
      cmds.push(`1 0 0 1 ${cx + 4} ${y + 5} Tm ${pdfStr(val)} Tj`);
      cx += col.w;
    }
    cmds.push("ET");
  });

  cmds.push("0.10 0.22 0.46 RG 0.8 w");
  cmds.push(`${tableX} ${headY + 16} ${tableW} ${-(16 + rows.length * ROW_H)} re S`);

  cmds.push("BT /F1 7 Tf 0.40 0.45 0.50 rg");
  cmds.push(`1 0 0 1 ${MARGIN} ${MARGIN - 4} Tm ${pdfStr("Confidential  |  Son of Wind  |  Charges exclude brokerage")} Tj`);
  cmds.push(
    `1 0 0 1 ${PAGE_W - MARGIN - 90} ${MARGIN - 4} Tm ${pdfStr(`Page ${page} of ${pageCount}`)} Tj`,
  );
  cmds.push("ET");

  return cmds.join("\n");
}

function assemblePdf(streams: string[]): Uint8Array {
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");

  const pageCount = streams.length;
  const pageIds: number[] = [];
  const fontRegularId = 3;
  const fontBoldId = 4;
  let nextId = 5;
  const pagePairs: Array<{ pageId: number; contentId: number; stream: string }> = [];
  for (const stream of streams) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    pagePairs.push({ pageId, contentId, stream });
  }

  objects.push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  const byId: string[] = ["", ...objects];
  while (byId.length < nextId) byId.push("");

  for (const { pageId, contentId, stream } of pagePairs) {
    byId[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`;
    byId[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id < byId.length; id++) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${byId[id]}\nendobj\n`;
  }
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${byId.length}\n`;
  pdf += "0000000000 65535 f \n";
  for (let id = 1; id < byId.length; id++) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${byId.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

export function buildTradeBookPdfBytes(
  rawRows: TradeRow[],
  opts?: { positions?: TradeRow[]; ltps?: Record<number, number> },
): Uint8Array {
  const rows = rawRows.map(tradeBookPdfRow);
  const { title } = istStamp();
  const fromPos = summarizeDayPnl(opts?.positions ?? [], opts?.ltps ?? {});
  const dayPnl = fromPos.symbols.length ? fromPos.total : realizedPnlFromTrades(rawRows);
  const plusPnl = fromPos.symbols.length ? fromPos.plus : dayPnl > 0 ? dayPnl : 0;
  const minusPnl = fromPos.symbols.length ? fromPos.minus : dayPnl < 0 ? dayPnl : 0;
  const charges = computeTradeCharges(rawRows);
  const netPnl = Math.round((dayPnl - charges.total + Number.EPSILON) * 100) / 100;
  const symbols = fromPos.symbols;
  const chunks: TradeBookPdfRow[][] = [];
  if (rows.length === 0) {
    chunks.push([]);
  } else {
    let i = 0;
    let pageIndex = 0;
    while (i < rows.length) {
      const n = tradesPerPage(pageIndex, symbols.length);
      chunks.push(rows.slice(i, i + n));
      i += n;
      pageIndex += 1;
    }
  }
  const streams = chunks.map((chunk, i) =>
    pageContent(
      chunk,
      i + 1,
      chunks.length,
      title,
      rows.length,
      dayPnl,
      netPnl,
      plusPnl,
      minusPnl,
      charges,
      symbols,
      i === 0,
    ),
  );
  return assemblePdf(streams);
}

export function openTradeBookPdf(
  rawRows: TradeRow[],
  opts?: { positions?: TradeRow[]; ltps?: Record<number, number> },
): { fileName: string } {
  const { file } = istStamp();
  const bytes = buildTradeBookPdfBytes(rawRows, opts);
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const blob = new Blob([copy], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const opened = window.open(url, "_blank", "noopener");
  if (!opened) {
    const a = document.createElement("a");
    a.href = url;
    a.download = file;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { fileName: file };
}
