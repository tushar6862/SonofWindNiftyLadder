import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChainResolved, ChainExpiriesResponse, ChainResolveResponse } from "@/types/market";
import { peekLiveTick, useLiveLtp } from "@/context/LiveLtpContext";
import { FastLtp } from "@/components/FastLtp";
import { setHotFocus } from "@/lib/hotFocus";
import { peekTouchPx } from "@/lib/liveQuote";
import { liveAtmStrikeForChain, plausibleSpotPx, spotPxFloor } from "@/lib/liveAtmStrike";
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
import { shortMtm, type FlipSide } from "@/lib/niftyFlipRules";
import { subscribeMdTouchline } from "@/lib/mdRegistry";
import { seedChainSpotFromResolve } from "@/lib/seedChainSpot";

const SESSION_KEY = "sow_custom_vwap_v1";
const WING = 7;
const INDEXES = ["NIFTY", "SENSEX"] as const;

type CustomIndex = (typeof INDEXES)[number];
type OrderStatus = "Filled" | "Partial" | "Rejected";
type PositionStatus = "Open" | "Closed";
type RowAction = "add" | "exit";

type CustomPosition = {
  key: string;
  index: CustomIndex;
  strike: number;
  side: FlipSide;
  qty: number;
  entry: number;
  iid: number;
  segment: number;
  expiry: string;
  orderStatus: OrderStatus;
  positionStatus: PositionStatus;
  bookedPnl: number | null;
  openedAt: number;
  targetText: string;
  slText: string;
};

type RowDraft = { action: RowAction; qty: string };

type Store = {
  index: CustomIndex;
  qtyText: string;
  targetText: string;
  slText: string;
  positions: CustomPosition[];
};

function isCustomIndex(value: string): value is CustomIndex {
  return value === "NIFTY" || value === "SENSEX";
}

function indexLabel(index: CustomIndex): string {
  return index === "SENSEX" ? "Sensex" : "Nifty";
}

function px2(value: number): number {
  return Math.round((value + 1e-9) * 100) / 100;
}

function wingLabel(off: number): string {
  if (off === 0) return "ATM";
  return off > 0 ? `ATM +${off}` : `ATM ${off}`;
}

function fmtStrike(strike: number): string {
  return Math.round(strike).toLocaleString("en-IN");
}

function chainIndexOf(chain: ChainResolved | null): CustomIndex | null {
  const key = String(chain?.index || "").trim().toUpperCase();
  return isCustomIndex(key) ? key : null;
}

function defaultStep(index: CustomIndex): number {
  return index === "NIFTY" ? 50 : 100;
}

function parseQty(raw: string, lot: number): { ok: true; qty: number } | { ok: false; error: string } {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return { ok: false, error: "Quantity must be a positive whole number." };
  const qty = Number(text);
  if (!Number.isSafeInteger(qty) || qty <= 0) return { ok: false, error: "Quantity must be a positive whole number." };
  if (!(lot > 0) || qty % lot !== 0) return { ok: false, error: `Quantity must be a multiple of ${lot}.` };
  return { ok: true, qty };
}

function statusFromFill(filled: number, requested: number): OrderStatus {
  return filled >= requested ? "Filled" : "Partial";
}

/** Premium points. Blank turns that exit off. */
function parsePoints(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const points = Number(text);
  if (!Number.isFinite(points) || points <= 0) return null;
  return points;
}

function rowPnl(pos: CustomPosition, live: number | null): number | null {
  if (pos.positionStatus === "Closed") return pos.bookedPnl;
  const open = live != null ? shortMtm(pos.entry, live, pos.qty) : null;
  if (pos.bookedPnl == null) return open;
  if (open == null) return pos.bookedPnl;
  return pos.bookedPnl + open;
}

function readPosition(raw: unknown): CustomPosition | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<CustomPosition>;
  const index = String(row.index || "").toUpperCase();
  const side = row.side;
  const strike = Number(row.strike);
  const qty = Number(row.qty);
  const entry = Number(row.entry);
  const iid = Number(row.iid);
  const segment = Number(row.segment);
  if (!isCustomIndex(index) || (side !== "CE" && side !== "PE")) return null;
  if (!Number.isFinite(strike) || strike <= 0 || !Number.isFinite(qty) || qty < 0) return null;
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(iid) || iid <= 0) return null;
  if (!Number.isFinite(segment) || segment <= 0) return null;
  const positionStatus: PositionStatus = row.positionStatus === "Closed" ? "Closed" : "Open";
  const orderStatus: OrderStatus =
    row.orderStatus === "Partial" || row.orderStatus === "Rejected" ? row.orderStatus : "Filled";
  const openedAt = Number(row.openedAt);
  const booked = Number(row.bookedPnl);
  return {
    key: String(row.key || `${positionStatus === "Open" ? "open" : "closed"}:${iid}:${openedAt || 0}`),
    index,
    strike: Math.round(strike),
    side,
    qty: Math.round(qty),
    entry: px2(entry),
    iid: Math.round(iid),
    segment: Math.round(segment),
    expiry: String(row.expiry || ""),
    orderStatus,
    positionStatus,
    bookedPnl: Number.isFinite(booked) ? booked : null,
    openedAt: Number.isFinite(openedAt) ? openedAt : Date.now(),
    targetText: typeof row.targetText === "string" ? row.targetText : "",
    slText: typeof row.slText === "string" ? row.slText : "",
  };
}

function loadStore(): Store {
  const empty: Store = { index: "NIFTY", qtyText: String(lotSizeForIndex("NIFTY")), targetText: "", slText: "", positions: [] };
  try {
    const raw = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") as Partial<Store> | null;
    if (!raw || typeof raw !== "object") return empty;
    const savedIndex = String(raw.index || "").toUpperCase();
    const index: CustomIndex = isCustomIndex(savedIndex) ? savedIndex : "NIFTY";
    const qtyText = typeof raw.qtyText === "string" && raw.qtyText.trim() ? raw.qtyText : String(lotSizeForIndex(index));
    const targetText = typeof raw.targetText === "string" ? raw.targetText : "";
    const slText = typeof raw.slText === "string" ? raw.slText : "";
    const positions = Array.isArray(raw.positions)
      ? raw.positions.map(readPosition).filter((row): row is CustomPosition => row != null).slice(0, 40)
      : [];
    return { index, qtyText, targetText, slText, positions };
  } catch {
    return empty;
  }
}

function rememberShort(pos: CustomPosition) {
  const expiry = pos.expiry ? ` ${pos.expiry}` : "";
  setLocalShortPosition({
    exchangeInstrumentID: pos.iid,
    exchangeSegment: pos.segment,
    qty: pos.qty,
    fillPx: pos.entry,
    tradingSymbol: `${pos.index}${expiry} ${pos.strike} ${pos.side}`,
  });
}

type StrikeRow = { off: number; strike: number; ce: number; pe: number };

export default function CustomVwapPanel({
  parentIndex,
  parentChain,
  parentError,
  active,
}: {
  parentIndex: IndexName;
  parentChain: ChainResolved | null;
  parentError?: string | null;
  active: boolean;
}) {
  const boot = useMemo(() => loadStore(), []);
  const [index, setIndex] = useState<CustomIndex>(boot.index);
  const [qtyText, setQtyText] = useState(boot.qtyText);
  const [targetText, setTargetText] = useState(boot.targetText);
  const [slText, setSlText] = useState(boot.slText);
  const [positions, setPositions] = useState<CustomPosition[]>(boot.positions);
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [pick, setPick] = useState<{ strike: number; side: FlipSide } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [owned, setOwned] = useState<ChainResolved | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [chainLoading, setChainLoading] = useState(false);
  const [resolveTick, setResolveTick] = useState(0);
  const [busy, setBusy] = useState(false);

  const ltps = useLiveLtp();
  const indexRef = useRef(index);
  const qtyRef = useRef(qtyText);
  const targetRef = useRef(targetText);
  const slRef = useRef(slText);
  const positionsRef = useRef(positions);
  const busyRef = useRef(false);
  const coverRef = useRef<((pos: CustomPosition, qty: number, reason: string) => Promise<"filled" | "partial" | "failed">) | null>(null);
  const guardRef = useRef({
    floorKey: {} as Record<string, string>,
    floorLive: {} as Record<string, boolean>,
    armKey: {} as Record<string, string>,
    targetFired: {} as Record<string, boolean>,
    slFired: {} as Record<string, boolean>,
  });
  const menuRef = useRef<HTMLDivElement | null>(null);
  const resolveAtRef = useRef(0);
  const restoredRef = useRef(false);

  indexRef.current = index;
  qtyRef.current = qtyText;
  targetRef.current = targetText;
  slRef.current = slText;
  positionsRef.current = positions;

  const parentMatch = parentChain && chainIndexOf(parentChain) === index ? parentChain : null;
  const holdForParent = parentIndex === index && !parentChain && !parentError;
  const chain = parentMatch ?? (owned && chainIndexOf(owned) === index ? owned : null);

  const liveSpot = useMemo(() => {
    if (!chain) return null;
    const token = chain.spotToken;
    if (typeof token === "number" && token > 0) {
      const live = plausibleSpotPx(chain.index, peekTouchPx(token, ltps) ?? ltps[token]);
      if (live != null) return live;
    }
    return plausibleSpotPx(chain.index, chain.spotLtp) ?? null;
  }, [chain, ltps]);

  const step = chain && typeof chain.step === "number" && chain.step > 0 ? chain.step : defaultStep(index);
  const atm = chain ? liveAtmStrikeForChain(chain, liveSpot ?? undefined) : Number.NaN;
  const rows = useMemo<StrikeRow[]>(() => {
    if (!chain || !Number.isFinite(atm)) return [];
    const out: StrikeRow[] = [];
    for (let off = -WING; off <= WING; off += 1) {
      const strike = atm + off * step;
      const inst = chain.instrumentMap?.[String(strike)];
      out.push({ off, strike, ce: inst?.ce ?? 0, pe: inst?.pe ?? 0 });
    }
    return out;
  }, [chain, atm, step]);
  const ladderKey = rows.map((row) => `${row.strike}:${row.ce}:${row.pe}`).join("|");

  useEffect(() => {
    if (!rows.length) return;
    setPick((prev) => {
      if (prev && rows.some((row) => row.strike === prev.strike)) return prev;
      const atmRow = rows.find((row) => row.off === 0) ?? rows[Math.floor(rows.length / 2)];
      if (!atmRow) return prev;
      return { strike: atmRow.strike, side: prev?.side ?? "CE" };
    });
  }, [ladderKey, rows]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    for (const pos of positionsRef.current) {
      if (pos.positionStatus === "Open" && pos.qty > 0) rememberShort(pos);
    }
  }, []);

  useEffect(() => {
    const payload: Store = { index, qtyText, targetText, slText, positions };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      /* ignore quota */
    }
  }, [index, qtyText, targetText, slText, positions]);

  useEffect(() => {
    if (!active) return;
    if (parentMatch || holdForParent) {
      setOwned(null);
      setChainError(null);
      setChainLoading(holdForParent);
      return;
    }
    let cancelled = false;
    const want = index;
    setChainLoading(true);
    setChainError(null);
    resolveAtRef.current = Date.now();
    (async () => {
      try {
        const exp = (await apiFetch("/api/chain/expiries", {
          method: "POST",
          body: JSON.stringify({ index: want }),
        })) as ChainExpiriesResponse;
        if (cancelled || indexRef.current !== want) return;
        if (!exp.ok || !exp.expiries?.length) {
          setChainError(exp.ok === false ? exp.error || `${indexLabel(want)} expiries unavailable` : `${indexLabel(want)} expiries unavailable`);
          setChainLoading(false);
          return;
        }
        const raw = (await apiFetch("/api/chain/resolve", {
          method: "POST",
          body: JSON.stringify({ index: want, expiry: exp.expiries[0]!.api, wings: 10, skipNotify: true }),
        })) as ChainResolveResponse;
        if (cancelled || indexRef.current !== want) return;
        if (!raw.ok) {
          setOwned(null);
          setChainError(raw.error || `${indexLabel(want)} chain unavailable`);
        } else {
          setOwned(raw);
          seedChainSpotFromResolve(raw);
          setChainError(null);
        }
      } catch (err: unknown) {
        if (!cancelled && indexRef.current === want) {
          setChainError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled && indexRef.current === want) setChainLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, index, parentMatch, holdForParent, resolveTick]);

  useEffect(() => {
    if (!active || parentMatch || !owned || chainIndexOf(owned) !== index || liveSpot == null) return;
    const liveAtm = liveAtmStrikeForChain(owned, liveSpot);
    const ownedStep = owned.step > 0 ? owned.step : step;
    if (Math.abs(liveAtm - owned.atmStrike) <= 3 * ownedStep) return;
    if (Date.now() - resolveAtRef.current < 20000) return;
    setResolveTick((n) => n + 1);
  }, [active, parentMatch, owned, index, liveSpot, step]);

  useEffect(() => {
    const instruments: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    const seen = new Set<number>();
    const add = (segment: number, iid: number) => {
      if (!(segment > 0) || !(iid > 0) || seen.has(iid)) return;
      seen.add(iid);
      instruments.push({ exchangeSegment: segment, exchangeInstrumentID: iid });
    };
    if (active && chain && chain.optionSegment > 0) {
      if (chain.spotToken > 0 && chain.spotSegment > 0) add(chain.spotSegment, chain.spotToken);
      for (const row of rows) {
        add(chain.optionSegment, row.ce);
        add(chain.optionSegment, row.pe);
      }
    }
    for (const pos of positions) {
      if (pos.positionStatus === "Open") add(pos.segment, pos.iid);
    }
    let cancelled = false;
    if (instruments.length) void subscribeMdTouchline(instruments, () => cancelled);
    setHotFocus("custom", instruments);
    return () => {
      cancelled = true;
      setHotFocus("custom", []);
    };
  }, [active, chain, ladderKey, positions, rows]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const fail = useCallback((text: string) => {
    toast({ title: "Custom", description: text, variant: "destructive" });
  }, []);

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
      if (fillPx == null) return { ok: false, error: "Order traded, but no average traded price came back." };
      return { ok: true, filledQty, fillPx };
    },
    [],
  );

  const commit = useCallback((next: CustomPosition[]) => {
    positionsRef.current = next;
    setPositions(next);
  }, []);

  const sellStrike = useCallback(async () => {
    if (busyRef.current) return;
    const selected = indexRef.current;
    const current = chain;
    if (!current || chainIndexOf(current) !== selected) {
      fail(`${indexLabel(selected)} strikes are still loading.`);
      return;
    }
    const lot = lotSizeForIndex(selected);
    const parsed = parseQty(qtyRef.current, lot);
    if (!parsed.ok) {
      fail(parsed.error);
      return;
    }
    const chosen = pick;
    const row = chosen ? rows.find((item) => item.strike === chosen.strike) : undefined;
    const side = chosen?.side ?? "CE";
    const iid = side === "CE" ? row?.ce : row?.pe;
    if (!chosen || !row || typeof iid !== "number" || !(iid > 0) || !(current.optionSegment > 0)) {
      fail(`${chosen ? fmtStrike(chosen.strike) : "Strike"} ${side} is not in the chain.`);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const sent = await sendOrder("SELL", iid, parsed.qty, current.optionSegment);
      if (!sent.ok) {
        fail(sent.error);
        return;
      }
      const prev = positionsRef.current;
      const open = prev.find((pos) => pos.positionStatus === "Open" && pos.iid === iid);
      let nextPos: CustomPosition;
      if (open) {
        const total = open.qty + sent.filledQty;
        nextPos = {
          ...open,
          qty: total,
          entry: px2((open.entry * open.qty + sent.fillPx * sent.filledQty) / total),
          orderStatus: statusFromFill(sent.filledQty, parsed.qty),
          targetText: targetRef.current,
          slText: slRef.current,
        };
      } else {
        nextPos = {
          key: `open:${iid}`,
          index: selected,
          strike: chosen.strike,
          side,
          qty: sent.filledQty,
          entry: sent.fillPx,
          iid,
          segment: current.optionSegment,
          expiry: current.expiryUi || current.expiryApi || "",
          orderStatus: statusFromFill(sent.filledQty, parsed.qty),
          positionStatus: "Open",
          bookedPnl: null,
          openedAt: Date.now(),
          targetText: targetRef.current,
          slText: slRef.current,
        };
      }
      const rest = prev.filter((pos) => pos.key !== nextPos.key);
      commit([nextPos, ...rest]);
      rememberShort(nextPos);
      toast({
        title: `Custom SELL ${side}`,
        description: `${indexLabel(selected)} ${fmtStrike(chosen.strike)} ${side} × ${fmtQty(sent.filledQty)} @ ${fmtPrice(sent.fillPx)}`,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [chain, commit, fail, pick, rows, sendOrder]);

  const cover = useCallback(
    async (pos: CustomPosition, qty: number, reason: string): Promise<"filled" | "partial" | "failed"> => {
      const sent = await sendOrder("BUY", pos.iid, qty, pos.segment);
      if (!sent.ok) {
        fail(sent.error);
        commit(positionsRef.current.map((row) => (row.key === pos.key ? { ...row, orderStatus: "Rejected" } : row)));
        return "failed";
      }
      const closed = Math.min(sent.filledQty, pos.qty);
      const booked = shortMtm(pos.entry, sent.fillPx, closed);
      const realized = (pos.bookedPnl ?? 0) + booked;
      const prev = positionsRef.current;
      const full = closed >= pos.qty;
      if (full) {
        const done: CustomPosition = {
          ...pos,
          key: `closed:${pos.iid}:${Date.now()}`,
          positionStatus: "Closed",
          orderStatus: statusFromFill(sent.filledQty, qty),
          bookedPnl: realized,
        };
        commit(prev.map((row) => (row.key === pos.key ? done : row)));
        clearLocalPosition(pos.iid, booked);
      } else {
        const left: CustomPosition = {
          ...pos,
          qty: pos.qty - closed,
          orderStatus: "Partial",
          bookedPnl: realized,
        };
        commit(prev.map((row) => (row.key === pos.key ? left : row)));
        rememberShort(left);
      }
      toast({
        title: `Custom ${reason}`,
        description: `${indexLabel(pos.index)} ${fmtStrike(pos.strike)} ${pos.side} × ${fmtQty(closed)} @ ${fmtPrice(sent.fillPx)} · P&L ${fmtPnl(booked)}`,
      });
      return full ? "filled" : "partial";
    },
    [commit, fail, sendOrder],
  );
  coverRef.current = cover;

  const saveRow = useCallback(
    async (pos: CustomPosition) => {
      if (busyRef.current || pos.positionStatus !== "Open") return;
      const draft = drafts[pos.key] ?? { action: "add" as RowAction, qty: "" };
      const lot = lotSizeForIndex(pos.index);
      const parsed = parseQty(draft.qty, lot);
      if (!parsed.ok) {
        fail(parsed.error);
        return;
      }
      if (draft.action === "exit" && parsed.qty > pos.qty) {
        fail(`Exit quantity ${fmtQty(parsed.qty)} is above the open quantity ${fmtQty(pos.qty)}.`);
        return;
      }
      busyRef.current = true;
      setBusy(true);
      try {
        if (draft.action === "exit") {
          const result = await cover(pos, parsed.qty, "exit");
          if (result !== "failed") setDrafts((prev) => ({ ...prev, [pos.key]: { ...draft, qty: "" } }));
          return;
        }
        const sent = await sendOrder("SELL", pos.iid, parsed.qty, pos.segment);
        if (!sent.ok) {
          fail(sent.error);
          commit(positionsRef.current.map((row) => (row.key === pos.key ? { ...row, orderStatus: "Rejected" } : row)));
          return;
        }
        const total = pos.qty + sent.filledQty;
        const next: CustomPosition = {
          ...pos,
          qty: total,
          entry: px2((pos.entry * pos.qty + sent.fillPx * sent.filledQty) / total),
          orderStatus: statusFromFill(sent.filledQty, parsed.qty),
        };
        commit(positionsRef.current.map((row) => (row.key === pos.key ? next : row)));
        rememberShort(next);
        setDrafts((prev) => ({ ...prev, [pos.key]: { ...draft, qty: "" } }));
        toast({
          title: "Custom add",
          description: `${fmtStrike(pos.strike)} ${pos.side} +${fmtQty(sent.filledQty)} · now ${fmtQty(total)} @ ${fmtPrice(next.entry)}`,
        });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [commit, cover, drafts, fail, sendOrder],
  );

  const squareOne = useCallback(
    async (pos: CustomPosition) => {
      if (busyRef.current || pos.positionStatus !== "Open" || pos.qty <= 0) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await cover(pos, pos.qty, "square off");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [cover],
  );

  const squareAll = useCallback(async () => {
    if (busyRef.current) return;
    const open = positionsRef.current.filter((pos) => pos.index === indexRef.current && pos.positionStatus === "Open" && pos.qty > 0);
    if (!open.length) {
      toast({ title: "Custom", description: `No open ${indexLabel(indexRef.current)} positions.` });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      for (const pos of open) {
        let guard = 0;
        while (guard < 4) {
          const fresh = positionsRef.current.find((row) => row.key === pos.key && row.positionStatus === "Open");
          if (!fresh || fresh.qty <= 0) break;
          const result = await cover(fresh, fresh.qty, "square off");
          if (result === "failed") return;
          if (result === "filled") break;
          guard += 1;
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [cover]);

  const applyExit = useCallback(
    (kind: "target" | "sl") => {
      const raw = kind === "target" ? targetText : slText;
      if (raw.trim() && parsePoints(raw) == null) {
        fail(kind === "target" ? "Target points must be a number above 0. Leave it blank to turn Target off." : "SL points must be a number above 0. Leave it blank to turn SL off.");
        return;
      }
      const points = parsePoints(raw);
      const next = points == null ? "" : String(points);
      if (kind === "target") {
        setTargetText(next);
        targetRef.current = next;
      } else {
        setSlText(next);
        slRef.current = next;
      }
      const selected = indexRef.current;
      commit(
        positionsRef.current.map((pos) =>
          pos.index === selected && pos.positionStatus === "Open"
            ? { ...pos, ...(kind === "target" ? { targetText: next } : { slText: next }) }
            : pos,
        ),
      );
      toast({
        title: kind === "target" ? "Target" : "SL",
        description: points == null ? `${kind === "target" ? "Target" : "SL"} off.` : `${points} pts on open ${indexLabel(selected)} shorts.`,
      });
    },
    [commit, fail, slText, targetText],
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      if (busyRef.current) return;
      const book = coverRef.current;
      if (!book) return;
      const guard = guardRef.current;
      for (const pos of positionsRef.current) {
        if (pos.positionStatus !== "Open" || pos.qty <= 0) continue;
        const ltp = peekTouchPx(pos.iid);
        if (ltp == null || !(ltp > 0)) continue;
        if (pos.entry >= 5 && ltp < 0.5) continue;
        const target = parsePoints(pos.targetText);
        const sl = parsePoints(pos.slText);
        const profitPts = pos.entry - ltp;
        const floorKey = `${pos.key}|${pos.qty}|${pos.entry}|${sl ?? ""}`;
        if (guard.floorKey[pos.key] !== floorKey) {
          guard.floorKey[pos.key] = floorKey;
          guard.floorLive[pos.key] = false;
        }
        const armKey = `${pos.key}|${pos.entry}|${target ?? ""}|${sl ?? ""}`;
        if (guard.armKey[pos.key] !== armKey) {
          guard.armKey[pos.key] = armKey;
          guard.targetFired[pos.key] = false;
          guard.slFired[pos.key] = false;
        }
        if (sl != null && profitPts > sl) guard.floorLive[pos.key] = true;
        let reason: string | null = null;
        if (target != null && profitPts >= target) {
          if (!guard.targetFired[pos.key]) {
            guard.targetFired[pos.key] = true;
            reason = `TARGET ${target} pts`;
          }
        } else if (sl != null && guard.floorLive[pos.key] && profitPts <= sl) {
          if (!guard.slFired[pos.key]) {
            guard.slFired[pos.key] = true;
            reason = `SL ${sl} pts`;
          }
        } else {
          guard.targetFired[pos.key] = false;
          if (sl == null || profitPts > sl) guard.slFired[pos.key] = false;
        }
        if (!reason) continue;
        busyRef.current = true;
        setBusy(true);
        void book(pos, pos.qty, reason).finally(() => {
          busyRef.current = false;
          setBusy(false);
        });
        return;
      }
    }, 200);
    return () => window.clearInterval(id);
  }, []);

  const selectedRow = pick ? rows.find((row) => row.strike === pick.strike) : undefined;
  const selectedIid = pick?.side === "PE" ? selectedRow?.pe ?? 0 : selectedRow?.ce ?? 0;
  const lot = lotSizeForIndex(index);
  const parsedQty = parseQty(qtyText, lot);
  const visible = positions
    .filter((pos) => pos.index === index)
    .slice()
    .sort((a, b) => {
      if (a.positionStatus !== b.positionStatus) return a.positionStatus === "Open" ? -1 : 1;
      return b.openedAt - a.openedAt;
    });
  const openCount = visible.filter((pos) => pos.positionStatus === "Open").length;
  const otherIndex: CustomIndex = index === "NIFTY" ? "SENSEX" : "NIFTY";
  const otherOpen = positions.filter((pos) => pos.index === otherIndex && pos.positionStatus === "Open").length;
  let openPnl = 0;
  let openPnlKnown = false;
  for (const pos of visible) {
    if (pos.positionStatus !== "Open") continue;
    const pnl = rowPnl(pos, peekTouchPx(pos.iid, ltps));
    if (pnl == null) continue;
    openPnl += pnl;
    openPnlKnown = true;
  }

  const chooseIndex = (next: CustomIndex) => {
    if (next === index) return;
    setIndex(next);
    setMenuOpen(false);
    setQtyText((prev) => {
      const nextLot = lotSizeForIndex(next);
      const parsed = parseQty(prev, nextLot);
      return parsed.ok ? prev : String(nextLot);
    });
  };

  return (
    <div className="cv-root ramsetu-glass-panel">
      <div className="cv-bar ramsetu-glass-toolbar">
        <div className="cv-bar__row">
          <div className="cv-field">
            <span className="ramsetu-glass-toolbar__label">Index</span>
            <div className="cv-pills" role="group" aria-label="Index">
              {INDEXES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={`cv-pill${index === name ? " cv-pill--on" : ""}`}
                  onClick={() => chooseIndex(name)}
                >
                  {name === "NIFTY" ? "Nifty" : "Sensex"}
                </button>
              ))}
            </div>
          </div>

          <div className="cv-field">
            <span className="ramsetu-glass-toolbar__label">Spot</span>
            <div className="cv-spot">
              <FastLtp iid={chain?.spotToken} min={spotPxFloor(index)} className="cv-spot__px" />
              <span className="cv-spot__meta">{chain?.expiryUi || (chainLoading ? "Loading…" : "—")}</span>
            </div>
          </div>

          <div className="cv-field">
            <span className="ramsetu-glass-toolbar__label">Side</span>
            <div className="cv-pills" role="group" aria-label="Option side">
              {(["CE", "PE"] as const).map((side) => (
                <button
                  key={side}
                  type="button"
                  className={`cv-pill cv-pill--${side.toLowerCase()}${pick?.side === side ? " cv-pill--on" : ""}`}
                  onClick={() => setPick((prev) => (prev ? { ...prev, side } : prev))}
                >
                  {side}
                </button>
              ))}
            </div>
          </div>

          <div className="cv-field cv-field--strike" ref={menuRef}>
            <span className="ramsetu-glass-toolbar__label">Strike · ATM ± {WING}</span>
            <button
              type="button"
              className="cv-strike-btn ramsetu-glass-select"
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              disabled={!rows.length}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {selectedRow && pick ? (
                <>
                  <span>{wingLabel(selectedRow.off)}</span>
                  <span className="cv-strike-btn__num">{fmtStrike(selectedRow.strike)}</span>
                  <span className={`cv-strike-btn__side cv-strike-btn__side--${pick.side.toLowerCase()}`}>{pick.side}</span>
                  <FastLtp iid={selectedIid} className="cv-strike-btn__px" />
                </>
              ) : (
                <span>{chainLoading ? "Loading strikes…" : "Select strike"}</span>
              )}
            </button>
            {menuOpen && rows.length > 0 && (
              <div className="cv-menu" role="listbox" aria-label="Strikes">
                <div className="cv-menu__head">
                <span>Band</span>
                <span>Strike</span>
                <span>CE</span>
                <span>PE</span>
                </div>
                {rows.map((row) => {
                  const selected = pick?.strike === row.strike;
                  return (
                    <div key={row.strike} className={`cv-menu__row${selected ? " cv-menu__row--on" : ""}${row.off === 0 ? " cv-menu__row--atm" : ""}`} role="option" aria-selected={selected}>
                      <span className="cv-menu__off">{wingLabel(row.off)}</span>
                      <span className="cv-menu__strike">{fmtStrike(row.strike)}</span>
                      {(["CE", "PE"] as const).map((side) => {
                        const iid = side === "CE" ? row.ce : row.pe;
                        const on = selected && pick?.side === side;
                        return (
                          <button
                            key={side}
                            type="button"
                            disabled={!(iid > 0)}
                            className={`cv-menu__px cv-menu__px--${side.toLowerCase()}${on ? " cv-menu__px--on" : ""}`}
                            onClick={() => {
                              setPick({ strike: row.strike, side });
                              setMenuOpen(false);
                            }}
                          >
                            <span>{side}</span>
                            <FastLtp iid={iid} />
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <label className="cv-field">
            <span className="ramsetu-glass-toolbar__label">Qty · lot {lot}</span>
            <input
              aria-label="Quantity"
              inputMode="numeric"
              autoComplete="off"
              value={qtyText}
              onChange={(event) => setQtyText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void sellStrike();
                }
              }}
              className="ramsetu-glass-select cv-qty"
            />
          </label>

          <label className="cv-field">
            <span className="ramsetu-glass-toolbar__label">Target pts</span>
            <input
              aria-label="Target points"
              inputMode="decimal"
              autoComplete="off"
              placeholder="pts"
              value={targetText}
              onChange={(event) => setTargetText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyExit("target");
                }
              }}
              className="ramsetu-glass-select cv-qty cv-qty--pts"
            />
          </label>

          <label className="cv-field">
            <span className="ramsetu-glass-toolbar__label">SL pts</span>
            <input
              aria-label="SL points"
              inputMode="decimal"
              autoComplete="off"
              placeholder="pts"
              value={slText}
              onChange={(event) => setSlText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyExit("sl");
                }
              }}
              className="ramsetu-glass-select cv-qty cv-qty--pts"
            />
          </label>

          <div className="cv-field cv-field--actions">
            <span className="ramsetu-glass-toolbar__label">Order</span>
            <div className="cv-actions-top">
              <button type="button" className={`cv-arm${parsePoints(targetText) != null ? " cv-arm--on" : ""}`} disabled={busy} onClick={() => applyExit("target")}>
                Target
              </button>
              <button type="button" className={`cv-arm cv-arm--sl${parsePoints(slText) != null ? " cv-arm--on" : ""}`} disabled={busy} onClick={() => applyExit("sl")}>
                SL
              </button>
              <button type="button" className="cv-sell" disabled={busy || !parsedQty.ok || !(selectedIid > 0)} onClick={() => void sellStrike()}>
                Save · SELL
              </button>
              <button type="button" className="cv-buy" disabled={busy || openCount === 0} onClick={() => void squareAll()}>
                Square Off All
              </button>
            </div>
          </div>
        </div>

        <div className="cv-note">
          {chainError ? (
            <span className="cv-note__err">{chainError}</span>
          ) : parsedQty.ok && pick && selectedRow ? (
            <span>
              SELL {indexLabel(index)} {fmtStrike(selectedRow.strike)} {pick.side} × {fmtQty(parsedQty.qty)}
              {chain?.expiryUi ? ` · ${chain.expiryUi}` : ""}
              {` · Target ${parsePoints(targetText) ?? "off"} · SL ${parsePoints(slText) ?? "off"}`}
            </span>
          ) : !parsedQty.ok ? (
            <span className="cv-note__err">{parsedQty.error}</span>
          ) : (
            <span>Pick a strike to sell.</span>
          )}
          <span className={`cv-note__pnl${openPnlKnown && openPnl > 0 ? " text-cd-green" : ""}${openPnlKnown && openPnl < 0 ? " text-cd-red" : ""}`}>
            Open {openCount}
            {openPnlKnown ? ` · P&L ${fmtPnl(openPnl)}` : ""}
          </span>
        </div>
        {otherOpen > 0 && (
          <p className="cv-other">
            {otherOpen} {indexLabel(otherIndex)} position{otherOpen === 1 ? "" : "s"} still open. Switch the index to manage them.
          </p>
        )}
      </div>

      <div className="cv-book">
        <div className="cv-book__title">Live trades</div>
        <div className="ramsetu-glass-table-wrap cv-table-wrap">
          <table className="ramsetu-glass-table cv-table">
            <thead>
              <tr>
                <th>Instrument</th>
                <th>Entry</th>
                <th>Live</th>
                <th>Qty</th>
                <th>P&L</th>
                <th>Order</th>
                <th>Position</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={8} className="cv-empty">
                    No {indexLabel(index)} trades yet. Choose a strike, enter quantity, and Save to sell.
                  </td>
                </tr>
              )}
              {visible.map((pos) => {
                const pnl = rowPnl(pos, peekTouchPx(pos.iid, ltps));
                const draft = drafts[pos.key] ?? { action: "add" as RowAction, qty: "" };
                const pnlClass = pnl == null ? "" : pnl > 0 ? "text-cd-green" : pnl < 0 ? "text-cd-red" : "";
                return (
                  <tr key={pos.key} className={pos.positionStatus === "Closed" ? "cv-row--closed" : undefined}>
                    <td>
                      <div className="cv-inst">
                        <span>{indexLabel(pos.index)}</span>
                        <span className="cv-inst__strike">{fmtStrike(pos.strike)}</span>
                        <span className={`cv-side cv-side--${pos.side.toLowerCase()}`}>{pos.side}</span>
                        {pos.positionStatus === "Open" && (parsePoints(pos.targetText) != null || parsePoints(pos.slText) != null) && (
                          <span className="cv-levels">
                            T {parsePoints(pos.targetText) ?? "—"} · SL {parsePoints(pos.slText) ?? "—"}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="ramsetu-glass-table__num">{fmtPrice(pos.entry)}</td>
                    <td className="ramsetu-glass-table__num">
                      <FastLtp iid={pos.iid} />
                    </td>
                    <td className="ramsetu-glass-table__num">{fmtQty(pos.qty)}</td>
                    <td className={`ramsetu-glass-table__num ${pnlClass}`}>{fmtPnl(pnl)}</td>
                    <td>
                      <span className={`cv-status cv-status--${pos.orderStatus.toLowerCase()}`}>{pos.orderStatus}</span>
                    </td>
                    <td>
                      <span className={`cv-status cv-status--${pos.positionStatus.toLowerCase()}`}>{pos.positionStatus}</span>
                    </td>
                    <td>
                      {pos.positionStatus === "Open" ? (
                        <div className="cv-row-actions">
                          <div className="cv-pills">
                            <button
                              type="button"
                              className={`cv-pill cv-pill--sell${draft.action === "add" ? " cv-pill--on" : ""}`}
                              onClick={() => setDrafts((prev) => ({ ...prev, [pos.key]: { ...draft, action: "add" } }))}
                            >
                              Add Qty
                            </button>
                            <button
                              type="button"
                              className={`cv-pill cv-pill--buy${draft.action === "exit" ? " cv-pill--on" : ""}`}
                              onClick={() => setDrafts((prev) => ({ ...prev, [pos.key]: { ...draft, action: "exit" } }))}
                            >
                              Exit Qty
                            </button>
                          </div>
                          <input
                            aria-label={draft.action === "add" ? "Add quantity" : "Exit quantity"}
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder="Qty"
                            value={draft.qty}
                            onChange={(event) =>
                              setDrafts((prev) => ({ ...prev, [pos.key]: { ...draft, qty: event.target.value } }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                void saveRow(pos);
                              }
                            }}
                            className="ramsetu-glass-select cv-qty cv-qty--row"
                          />
                          <button
                            type="button"
                            className={draft.action === "add" ? "cv-sell" : "cv-buy"}
                            disabled={busy}
                            onClick={() => void saveRow(pos)}
                          >
                            Save
                          </button>
                          <button type="button" className="cv-buy" disabled={busy} onClick={() => void squareOne(pos)}>
                            Square Off
                          </button>
                        </div>
                      ) : (
                        <span className="cv-done">Booked</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
