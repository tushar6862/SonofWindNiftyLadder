import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";
import { apiFetch } from "@/lib/backend";
import { bumpPositionsRefresh, fetchIxPositions, POSITIONS_REFRESH_EVENT } from "@/lib/ixPortfolio";
import { subscribeMdTouchline } from "@/lib/mdRegistry";
import { useLiveLtp, peekLiveLtp } from "@/context/LiveLtpContext";
import { toast } from "@/hooks/use-toast";
import { fmtInrShort, fmtMtm } from "@/lib/formatNumber";
import { EV_NIFTY_LADDER_FLAT } from "@/lib/niftyLadderRules";

const MTM_STAR_COUNT = 6;
const MTM_ARM_KEY = "sow_mtm_arm_v1";
const MTM_WATCH_MS = 100;

function toNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = v.replace(/,/g, "").replace(/[₹]/g, "").replace(/\b(rs|inr)\b/gi, "").trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function positionNetQty(p: Record<string, unknown>): number {
  const qtyRaw =
    toNum(p.NetPosition ?? p.netPosition ?? p.Quantity ?? p.quantity ?? p.NetQuantity ?? p.netQuantity) ??
    ((toNum(p.LongPosition) ?? 0) - (toNum(p.ShortPosition) ?? 0));
  const obq = toNum(p.OpenBuyQuantity ?? p.openBuyQuantity) ?? 0;
  const osq = toNum(p.OpenSellQuantity ?? p.openSellQuantity) ?? 0;
  const qty = qtyRaw && qtyRaw !== 0 ? qtyRaw : obq - osq;
  return typeof qty === "number" && Number.isFinite(qty) ? qty : 0;
}

function positionIid(p: Record<string, unknown>): number | null {
  return toNum(p.ExchangeInstrumentId ?? p.ExchangeInstrumentID ?? p.exchangeInstrumentId ?? p.exchangeInstrumentID);
}

function brokerDayMtm(p: Record<string, unknown>): number | null {
  const keys: unknown[] = [
    p.ActualMarkToMarket,
    p.actualMarkToMarket,
    p["Actual Mark To Market"],
    p.MarkToMarket,
    p.markToMarket,
    p.MTM,
    p.mtm,
    p["Mark To Market"],
    p.NetAmount,
    p.netAmount,
    p.NetValue,
    p.netValue,
  ];
  let zero: number | null = null;
  for (const v of keys) {
    const n = toNum(v);
    if (n == null || !Number.isFinite(n)) continue;
    if (Math.abs(n) > 1e-9) return n;
    zero = n;
  }
  return zero;
}

function positionLiveMtm(p: Record<string, unknown>, ltpMap: Record<number, number>): number {
  const qty = positionNetQty(p);
  const broker = brokerDayMtm(p);
  // Squared books (NetQty 0) still carry day MTM in XTS — that is the 7,042.75 total.
  if (!qty) return broker ?? 0;

  const iid = positionIid(p);
  const peeked = iid != null ? peekLiveLtp(iid) : null;
  const mapped = iid != null ? ltpMap[iid] : undefined;
  const ltp =
    peeked != null && peeked > 0
      ? peeked
      : typeof mapped === "number" && Number.isFinite(mapped) && mapped > 0
        ? mapped
        : null;

  const actSell = toNum(p.ActualSellAmount ?? p.actualSellAmount);
  const actBuy = toNum(p.ActualBuyAmount ?? p.actualBuyAmount);
  if (ltp != null && ltp > 0) {
    if (actSell != null && actBuy != null) return actSell - actBuy + qty * ltp;
    const avg =
      qty < 0
        ? (toNum(p.SellAveragePrice ?? p.sellAvgPrice ?? p.SellAvgPrice) ??
            toNum(p.AveragePrice ?? p.avgPrice))
        : (toNum(p.BuyAveragePrice ?? p.buyAvgPrice ?? p.BuyAvgPrice) ??
            toNum(p.AveragePrice ?? p.avgPrice));
    if (avg != null && avg > 0) return qty * (ltp - avg);
    const netAmt = toNum(p.NetAmount ?? p.netAmount ?? p.NetValue ?? p.netValue);
    if (netAmt != null) return netAmt + qty * ltp;
  }
  return broker ?? 0;
}

function portfolioLiveMtm(positions: unknown[], ltpMap: Record<number, number>): number {
  let sum = 0;
  for (const row of positions || []) {
    if (!row || typeof row !== "object") continue;
    const n = positionLiveMtm(row as Record<string, unknown>, ltpMap);
    if (Number.isFinite(n)) sum += n;
  }
  return Number.isFinite(sum) ? sum : 0;
}

function mtmTargetHit(mtm: number, t: number): boolean {
  return t >= 0 ? mtm >= t : mtm <= t;
}

function mtmSlHit(mtm: number, s: number): boolean {
  const thresh = s >= 0 ? -s : s;
  return mtm <= thresh;
}

type MtmArmStore = {
  draftTarget?: string;
  draftSl?: string;
  target: number | null;
  sl: number | null;
  armTarget: boolean;
  armSl: boolean;
};

function loadMtmArm(): MtmArmStore | null {
  try {
    const raw = sessionStorage.getItem(MTM_ARM_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as MtmArmStore;
    if (!j || typeof j !== "object") return null;
    return j;
  } catch {
    return null;
  }
}

function saveMtmArm(row: MtmArmStore): void {
  try {
    sessionStorage.setItem(MTM_ARM_KEY, JSON.stringify(row));
  } catch {
    /* ignore */
  }
}

function MtmStarMask() {
  return (
    <span className="mtm-star-mask" aria-hidden>
      {Array.from({ length: MTM_STAR_COUNT }, (_, i) => (
        <span key={i} className="mtm-star-char">
          ✦
        </span>
      ))}
    </span>
  );
}

export default function LeftPanel() {
  const restoredArm = useMemo(() => loadMtmArm(), []);
  const [mtmExpanded, setMtmExpanded] = useState(true);
  const [mtmHidden, setMtmHidden] = useState(false);
  /** Input fields only — changing these does not change armed thresholds. */
  const [draftMtmTarget, setDraftMtmTarget] = useState(() => restoredArm?.draftTarget ?? "");
  const [draftMtmSl, setDraftMtmSl] = useState(() => restoredArm?.draftSl ?? "");
  /** Thresholds used by the MTM watcher; set only when user taps TARGET / SL to arm. */
  const [armedMtmTarget, setArmedMtmTarget] = useState<number | null>(() =>
    restoredArm?.armTarget ? restoredArm.target ?? null : null,
  );
  const [armedMtmSl, setArmedMtmSl] = useState<number | null>(() =>
    restoredArm?.armSl ? restoredArm.sl ?? null : null,
  );
  const [armTarget, setArmTarget] = useState(() => Boolean(restoredArm?.armTarget && restoredArm.target != null));
  const [armSl, setArmSl] = useState(() => Boolean(restoredArm?.armSl && restoredArm.sl != null));
  const [mtmExitBusy, setMtmExitBusy] = useState(false);
  const ltps = useLiveLtp();
  const [positions, setPositions] = useState<any[]>([]);
  const [margin, setMargin] = useState<{
    available: number;
    used: number;
    free: number;
    used_pct: number;
    free_pct: number;
    hidden: boolean;
  } | null>(null);
  const marginBusyRef = useRef(false);
  const posBusyRef = useRef(false);
  const positionsRef = useRef<any[]>([]);
  const ltpsRef = useRef(ltps);
  const armTargetRef = useRef(armTarget);
  const armSlRef = useRef(armSl);
  const armedTargetRef = useRef(armedMtmTarget);
  const armedSlRef = useRef(armedMtmSl);
  const mtmExitBusyRef = useRef(mtmExitBusy);
  const lastExitFailAtRef = useRef(0);

  positionsRef.current = positions;
  ltpsRef.current = ltps;
  armTargetRef.current = armTarget;
  armSlRef.current = armSl;
  armedTargetRef.current = armedMtmTarget;
  armedSlRef.current = armedMtmSl;
  mtmExitBusyRef.current = mtmExitBusy;

  const extractPosList = (raw: any): any[] => {
    const roots = [raw, raw?.raw, raw?.data, raw?.Data];
    for (const obj of roots) {
      if (!obj) continue;
      if (Array.isArray(obj)) return obj;
      const res = obj.result ?? obj.Result ?? obj;
      if (Array.isArray(res)) return res;
      const lst =
        res?.positionList ?? res?.PositionList ?? obj.positionList ?? obj.PositionList ?? res?.positions;
      if (Array.isArray(lst)) return lst;
    }
    return [];
  };

  const fetchMargin = async () => {
    if (marginBusyRef.current) return;
    marginBusyRef.current = true;
    try {
      const r = (await apiFetch("/api/margin", { method: "GET" })) as {
        status: "ok";
        available: number;
        used: number;
        free: number;
        used_pct: number;
        free_pct: number;
        hidden: boolean;
      };
      setMargin({
        available: r.available,
        used: r.used,
        free: r.free,
        used_pct: r.used_pct,
        free_pct: r.free_pct,
        hidden: r.hidden,
      });
    } finally {
      marginBusyRef.current = false;
    }
  };

  const fetchPositions = async () => {
    if (posBusyRef.current) return;
    posBusyRef.current = true;
    try {
      const netR = (await fetchIxPositions("NetWise")) as any;
      const list = extractPosList(netR);
      const stale = Boolean(netR?.stale);
      if (stale && list.length === 0 && positionsRef.current.length) return;
      setPositions(list);

      const segMap: Record<string, number> = {
        NSECM: 1,
        NSEFO: 2,
        NSECD: 3,
        MCXFO: 51,
        BSECM: 11,
        BSEFO: 12,
      };
      const instruments = (list || [])
        .map((p: any) => {
          const segName = String(p.ExchangeSegment ?? p.exchangeSegment ?? "").trim().toUpperCase();
          const seg = segMap[segName];
          const id = toNum(p.ExchangeInstrumentId ?? p.ExchangeInstrumentID ?? p.exchangeInstrumentId ?? p.exchangeInstrumentID);
          if (!seg || !id) return null;
          return { exchangeSegment: seg, exchangeInstrumentID: id };
        })
        .filter(Boolean) as Array<{ exchangeSegment: number; exchangeInstrumentID: number }>;

      const uniq: Record<string, { exchangeSegment: number; exchangeInstrumentID: number }> = {};
      for (const inst of instruments) uniq[`${inst.exchangeSegment}:${inst.exchangeInstrumentID}`] = inst;
      const deduped = Object.values(uniq);
      if (deduped.length) void subscribeMdTouchline(deduped);
    } catch {
      /* keep last good positions so MTM does not snap to 0 */
    } finally {
      posBusyRef.current = false;
    }
  };

  useEffect(() => {
    void fetchMargin();
    void fetchPositions();
    const onPosRefresh = () => {
      if (document.visibilityState === "visible") void fetchPositions();
    };
    window.addEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh as EventListener);
    const marginIv = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchMargin();
    }, 10000);
    const posIv = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchPositions();
    }, 12000);
    return () => {
      window.removeEventListener(POSITIONS_REFRESH_EVENT, onPosRefresh as EventListener);
      window.clearInterval(marginIv);
      window.clearInterval(posIv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mtm = useMemo(() => portfolioLiveMtm(positions || [], ltps), [positions, ltps]);

  const disarmMtm = useCallback(() => {
    setArmedMtmTarget(null);
    setArmedMtmSl(null);
    setArmTarget(false);
    setArmSl(false);
    setDraftMtmTarget("");
    setDraftMtmSl("");
    saveMtmArm({
      draftTarget: "",
      draftSl: "",
      target: null,
      sl: null,
      armTarget: false,
      armSl: false,
    });
  }, []);

  const exitAllPositions = useCallback(async (reason: string) => {
    if (mtmExitBusyRef.current) return;
    mtmExitBusyRef.current = true;
    setMtmExitBusy(true);
    try {
      window.dispatchEvent(new CustomEvent(EV_NIFTY_LADDER_FLAT));
      const r = (await apiFetch("/api/ix/exit_open_positions", {
        method: "POST",
        body: JSON.stringify({ percent: 100 }),
      })) as {
        ok?: boolean;
        error?: string;
        counts?: { exited?: number; skipped?: number; errors?: number };
        errors?: Array<{ error?: string }>;
      };
      const exited = Number(r?.counts?.exited ?? 0);
      const errN = Number(r?.counts?.errors ?? (Array.isArray(r?.errors) ? r.errors.length : 0));
      const firstErr = Array.isArray(r?.errors) && r.errors[0]?.error ? String(r.errors[0].error) : "";
      if (!r?.ok || (exited <= 0 && errN > 0)) {
        throw new Error(firstErr || r?.error || "Exit All rejected by broker");
      }
      if (exited <= 0) {
        throw new Error("No open lots to exit — check Positions qty");
      }
      toast({ title: "Exit All sent", description: `${reason} · ${exited} order(s)` });
      disarmMtm();
      bumpPositionsRefresh();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast({ title: "Exit All failed", description: msg, variant: "destructive" });
      lastExitFailAtRef.current = Date.now();
    } finally {
      mtmExitBusyRef.current = false;
      setMtmExitBusy(false);
    }
  }, [disarmMtm]);

  const setSignedNumberString = (prev: string, sign: 1 | -1) => {
    const n = toNum(prev);
    if (n == null) return sign < 0 ? "-" : "";
    const abs = Math.abs(n);
    const next = sign < 0 ? -abs : abs;
    return String(next);
  };

  const persistArm = useCallback(
    (next: Partial<MtmArmStore> = {}) => {
      saveMtmArm({
        draftTarget: next.draftTarget ?? draftMtmTarget,
        draftSl: next.draftSl ?? draftMtmSl,
        target: next.target !== undefined ? next.target : armedMtmTarget,
        sl: next.sl !== undefined ? next.sl : armedMtmSl,
        armTarget: next.armTarget !== undefined ? next.armTarget : armTarget,
        armSl: next.armSl !== undefined ? next.armSl : armSl,
      });
    },
    [armSl, armTarget, armedMtmSl, armedMtmTarget, draftMtmSl, draftMtmTarget],
  );

  const armTargetFromDraft = useCallback(() => {
    if (armTarget) {
      setArmTarget(false);
      setArmedMtmTarget(null);
      persistArm({ armTarget: false, target: null });
      toast({ title: "MTM target disarmed" });
      return;
    }
    const parsed = toNum(draftMtmTarget);
    if (parsed == null || !Number.isFinite(parsed)) {
      toast({
        title: "Invalid target",
        description: "Enter a numeric MTM target, then tap TARGET (or Enter).",
        variant: "destructive",
      });
      return;
    }
    setArmedMtmTarget(parsed);
    setArmTarget(true);
    persistArm({ armTarget: true, target: parsed });
    toast({
      title: "MTM target armed",
      description:
        parsed >= 0
          ? `Exit All when MTM ≥ ${fmtMtm(parsed)}`
          : `Exit All when MTM ≤ ${fmtMtm(parsed)}`,
    });
  }, [armTarget, draftMtmTarget, persistArm]);

  const armSlFromDraft = useCallback(() => {
    if (armSl) {
      setArmSl(false);
      setArmedMtmSl(null);
      persistArm({ armSl: false, sl: null });
      toast({ title: "MTM SL disarmed" });
      return;
    }
    const parsed = toNum(draftMtmSl);
    if (parsed == null || !Number.isFinite(parsed)) {
      toast({
        title: "Invalid SL",
        description: "Enter a numeric MTM stop, then tap SL (or Enter).",
        variant: "destructive",
      });
      return;
    }
    setArmedMtmSl(parsed);
    setArmSl(true);
    persistArm({ armSl: true, sl: parsed });
    const thresh = parsed >= 0 ? -parsed : parsed;
    toast({
      title: "MTM SL armed",
      description: `Exit All when MTM ≤ ${fmtMtm(thresh)}`,
    });
  }, [armSl, draftMtmSl, persistArm]);

  useEffect(() => {
    const tick = () => {
      if (mtmExitBusyRef.current) return;
      if (Date.now() - lastExitFailAtRef.current < 2500) return;
      const tOn = armTargetRef.current;
      const sOn = armSlRef.current;
      if (!tOn && !sOn) return;
      const live = portfolioLiveMtm(positionsRef.current || [], ltpsRef.current);
      const t = armedTargetRef.current;
      const s = armedSlRef.current;
      if (tOn && t != null && Number.isFinite(t) && mtmTargetHit(live, t)) {
        const reason =
          t >= 0
            ? `MTM target hit: ${fmtMtm(live)} ≥ ${fmtMtm(t)}`
            : `MTM target hit: ${fmtMtm(live)} ≤ ${fmtMtm(t)}`;
        void exitAllPositions(reason);
        return;
      }
      if (sOn && s != null && Number.isFinite(s) && mtmSlHit(live, s)) {
        const thresh = s >= 0 ? -s : s;
        void exitAllPositions(`MTM SL hit: ${fmtMtm(live)} ≤ ${fmtMtm(thresh)}`);
      }
    };
    const id = window.setInterval(tick, MTM_WATCH_MS);
    tick();
    return () => window.clearInterval(id);
  }, [exitAllPositions]);

  const mtmTone =
    mtm > 0 ? "mtm-amount-pill--profit" : mtm < 0 ? "mtm-amount-pill--loss" : "mtm-amount-pill--flat";
  const mtmAmountText = fmtMtm(mtm);

  const targetDraftParsed = toNum(draftMtmTarget.trim());
  const targetArmable = targetDraftParsed != null && Number.isFinite(targetDraftParsed);
  const slDraftParsed = toNum(draftMtmSl.trim());
  const slArmable = slDraftParsed != null && Number.isFinite(slDraftParsed);

  return (
    <div className="flex flex-col h-full min-h-0 sow-glass-left-panel">
      {/* ATM / MTM */}
      <div className="shrink-0 sow-glass-mtm-block">
        <div
          className="flex items-center justify-between cursor-pointer transition-colors -mx-1 px-1 py-0.5 rounded-md hover:bg-foreground/5"
          onClick={() => setMtmExpanded(!mtmExpanded)}
        >
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-muted-foreground">MTM</span>
              <RefreshCw className="w-2.5 h-2.5 text-muted-foreground" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {mtmHidden ? (
              <span className={`mtm-amount-pill ${mtmTone}`}>
                <MtmStarMask />
              </span>
            ) : (
              <span key="mtm-visible" className={`mtm-amount-pill mtm-value-reveal ${mtmTone}`}>
                <span className="mtm-amount-pill__value">{mtmAmountText}</span>
              </span>
            )}
            <button
              type="button"
              className="p-0.5 hover:bg-accent/40 rounded cursor-pointer transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                setMtmHidden((v) => !v);
              }}
              title={mtmHidden ? "Show MTM" : "Hide MTM"}
              aria-label={mtmHidden ? "Show MTM" : "Hide MTM"}
            >
              {mtmHidden ? <EyeOff className="w-3 h-3 text-muted-foreground" /> : <Eye className="w-3 h-3 text-muted-foreground" />}
            </button>
            {mtmExpanded ? <ChevronUp className="w-3 h-3 text-muted-foreground" /> : <ChevronDown className="w-3 h-3 text-muted-foreground" />}
          </div>
        </div>

        {mtmExpanded && (
          <div className="px-2 pb-2 space-y-1.5">
            <div className="grid grid-cols-[52px_1fr_auto_auto] items-center gap-2 text-[12px]">
              <span className="text-muted-foreground">Target</span>
              <input
                type="text"
                placeholder="Enter TP"
                value={draftMtmTarget}
                onChange={(e) => setDraftMtmTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    armTargetFromDraft();
                  }
                }}
                className="sow-glass-input"
              />
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setDraftMtmTarget((p) => setSignedNumberString(p, 1))}
                  className="sow-glass-mini-btn cursor-pointer hover:brightness-105"
                  title="Set +"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setDraftMtmTarget((p) => setSignedNumberString(p, -1))}
                  className="sow-glass-mini-btn cursor-pointer hover:brightness-105"
                  title="Set -"
                >
                  -
                </button>
              </div>
              <button
                type="button"
                disabled={mtmExitBusy || (!armTarget && !targetArmable)}
                onClick={() => armTargetFromDraft()}
                className={`sow-mtm-arm-btn h-7 px-3 rounded text-[11px] font-semibold text-white transition-[opacity,box-shadow] enabled:cursor-pointer disabled:!cursor-not-allowed disabled:opacity-45 disabled:shadow-[inset_0_0_0_2px_rgba(220,38,38,0.85)] disabled:hover:brightness-100 ${
                  armTarget ? "bg-blue-600 hover:bg-blue-500" : "bg-gray-700 hover:bg-gray-600"
                }`}
                title={
                  armTarget
                    ? `Armed at ${fmtMtm(armedMtmTarget ?? 0)} — tap to disarm.`
                    : targetArmable
                      ? "Arm MTM target to Exit All when hit (or press Enter)."
                      : "Enter a numeric target first — button disabled until then."
                }
              >
                {armTarget ? "ARMED" : "TARGET"}
              </button>
            </div>
            <div className="grid grid-cols-[52px_1fr_auto_auto] items-center gap-2 text-[12px]">
              <span className="text-muted-foreground">SL</span>
              <input
                type="text"
                placeholder="Enter SL"
                value={draftMtmSl}
                onChange={(e) => setDraftMtmSl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    armSlFromDraft();
                  }
                }}
                className="sow-glass-input"
              />
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setDraftMtmSl((p) => setSignedNumberString(p, 1))}
                  className="sow-glass-mini-btn cursor-pointer hover:brightness-105"
                  title="Set +"
                >
                  +
                </button>
                <button
                  type="button"
                  onClick={() => setDraftMtmSl((p) => setSignedNumberString(p, -1))}
                  className="sow-glass-mini-btn cursor-pointer hover:brightness-105"
                  title="Set -"
                >
                  -
                </button>
              </div>
              <button
                type="button"
                disabled={mtmExitBusy || (!armSl && !slArmable)}
                onClick={() => armSlFromDraft()}
                className={`sow-mtm-arm-btn h-7 px-3 rounded text-[11px] font-semibold text-white transition-[opacity,box-shadow] enabled:cursor-pointer disabled:!cursor-not-allowed disabled:opacity-45 disabled:shadow-[inset_0_0_0_2px_rgba(220,38,38,0.85)] disabled:hover:brightness-100 ${
                  armSl ? "bg-red-600 hover:bg-red-500" : "bg-gray-700 hover:bg-gray-600"
                }`}
                title={
                  armSl
                    ? `Armed at ${fmtMtm(armedMtmSl != null ? (armedMtmSl >= 0 ? -armedMtmSl : armedMtmSl) : 0)} — tap to disarm.`
                    : slArmable
                      ? "Arm MTM stop to Exit All when hit (or press Enter)."
                      : "Enter a numeric SL first — button disabled until then."
                }
              >
                {armSl ? "ARMED" : "SL"}
              </button>
            </div>

            {/* Margin */}
            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">Margin</span>
              <button
                type="button"
                className="p-0.5 hover:bg-accent/40 rounded"
                onClick={() => void fetchMargin()}
                title="Refresh margin"
              >
                <RefreshCw className="w-2.5 h-2.5 text-muted-foreground" />
              </button>
              <div className="flex items-center gap-3 ml-auto">
                <div className="text-center">
                  <div className="text-muted-foreground text-[10px]">Total</div>
                  <div className={`font-semibold ${margin?.hidden ? "text-muted-foreground" : "text-foreground"}`}>
                    {margin ? (margin.hidden ? "──" : fmtInrShort(margin.available)) : "──"}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-muted-foreground text-[10px]">Available</div>
                  <div className={`font-semibold ${margin?.hidden ? "text-muted-foreground" : "text-margin-available"}`}>
                    {margin ? (margin.hidden ? "──" : fmtInrShort(margin.free)) : "──"}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-muted-foreground text-[10px]">Utilized</div>
                  <div className={`font-semibold ${margin?.hidden ? "text-muted-foreground" : "text-foreground"}`}>
                    {margin ? (margin.hidden ? "──" : fmtInrShort(margin.used)) : "──"}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 flex flex-col min-h-0 sow-glass-left-tabs mx-2 mb-2 rounded-lg overflow-hidden">
        <div className="flex shrink-0 border-b border-border/50 px-2 py-1.5 items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Nifty Ladder
          </span>
        </div>
        <div className="flex-1 overflow-auto p-2 text-[11px] min-h-0">
          <div className="ramsetu-glass-wrap -m-2 p-2 space-y-3">
            <div className="ramsetu-glass-header">
              <div className="ramsetu-glass-header__title">Same-strike short grid</div>
              <div className="ramsetu-glass-header__note">Hunt 98–105 · T1 cover 30% · hard SL 70%</div>
            </div>
            <p className="ramsetu-glass-empty">
              START AGAIN after 09:16 IST. Exit All / MTM target-SL yahan se ladder session clear karte hain.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
