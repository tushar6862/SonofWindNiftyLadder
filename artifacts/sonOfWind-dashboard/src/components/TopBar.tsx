import { useState, useEffect, useRef, useMemo, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Settings, RefreshCw, Sun, Moon, ExternalLink, ChevronUp, ChevronDown } from "lucide-react";
import type { IndexName } from "@/pages/Dashboard";
import { useAuth } from "@/auth/AuthContext";
import { useLiveHiLo, useLiveSpotDayRef, useTickLtp } from "@/context/LiveLtpContext";
import { FastLtp } from "@/components/FastLtp";
import type { ChainResolved } from "@/types/market";
import { liveAtmStrikeForChain } from "@/lib/liveAtmStrike";
import { fmtPct, fmtPrice } from "@/lib/formatNumber";
import { useLocation } from "wouter";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { apiFetch } from "@/lib/backend";
import { setFyersTopbarFocus } from "@/lib/hotFocus";

const INDICES: readonly IndexName[] = ["SENSEX", "NIFTY", "BANKNIFTY"];

const MANTRA_TICKER =
  "वक्रतुण्ड महाकाय सूर्यकोटि समप्रभ। निर्विघ्नं कुरु मे देव सर्वकार्येषु सर्वदा॥";

/** One “half” of the seamless row: many repeats so strip width ≥ typical viewport (avoids empty gaps while scrolling). */
const MANTRA_TICKER_WIDE = Array.from({ length: 48 }, () => MANTRA_TICKER).join("   ·   ");

interface TopBarProps {
  theme: "dark" | "light";
  onThemeToggle: () => void;
  index: IndexName;
  onIndexChange: (idx: IndexName) => void;
  expiry: string;
  onExpiryChange: (v: string) => void;
  expiryOptions: readonly string[];
  chain: ChainResolved | null;
  chainError: string | null;
  /** Separate from resolve — e.g. chunked subscribe/market-feed issues. */
  subscribeError?: string | null;
  /** Broker expiry list fetch failed — static fallback may be in use. */
  expiryHint?: string | null;
}

/* ── Spinner-style dropdown ─────────────────────────────── */
function SpinnerSelect<T extends string>({
  value,
  options,
  onChange,
  theme,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  theme: "dark" | "light";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 120 });

  const placeMenu = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 120) });
  };

  useLayoutEffect(() => {
    if (!open) return;
    placeMenu();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onWin = () => placeMenu();
    window.addEventListener("resize", onWin);
    window.addEventListener("scroll", onWin, true);
    return () => {
      window.removeEventListener("resize", onWin);
      window.removeEventListener("scroll", onWin, true);
    };
  }, [open]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const cycle = (dir: 1 | -1, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!options.length) return;
    const idx = (options.indexOf(value) + dir + options.length) % options.length;
    onChange(options[idx]);
  };

  return (
    <div ref={ref} className="relative select-none">
      <div
        className="sow-glass-spinner flex items-center gap-1 px-3 py-1.5 cursor-pointer hover:brightness-105 transition-all min-w-[100px]"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-semibold text-foreground flex-1 text-[13px]">{value}</span>
        <div className="flex flex-col ml-1">
          <button type="button" className="leading-none text-muted-foreground hover:text-foreground" onClick={(e) => cycle(-1, e)}>
            <ChevronUp className="w-3 h-3" />
          </button>
          <button type="button" className="leading-none text-muted-foreground hover:text-foreground" onClick={(e) => cycle(1, e)}>
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>
      </div>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[400] overflow-hidden rounded-lg border border-border/60 sow-glass-card shadow-xl"
            style={{ top: menuPos.top, left: menuPos.left, minWidth: menuPos.width }}
          >
            {options.map((opt) => (
              <button
                type="button"
                key={opt}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-[12px] cursor-pointer transition-colors whitespace-nowrap ${
                  opt === value
                    ? "bg-blue-600 text-white"
                    : theme === "dark"
                      ? "text-foreground hover:bg-accent"
                      : "text-slate-800 hover:bg-slate-100"
                }`}
              >
                {opt}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Two-letter avatar from broker / login id (e.g. SR01 → SR). */
function profileInitials(username: string): string {
  const s = username.trim();
  if (!s) return "?";
  const letters = s.match(/[a-zA-Z]/gi);
  if (letters && letters.length >= 2) return (letters[0] + letters[1]).toUpperCase();
  if (letters?.length === 1) {
    const digit = s.match(/\d/)?.[0];
    return (letters[0] + (digit ?? letters[0])).toUpperCase();
  }
  return s.slice(0, 2).toUpperCase();
}

export default function TopBar({
  theme,
  onThemeToggle,
  index,
  onIndexChange,
  expiry,
  onExpiryChange,
  expiryOptions,
  chain,
  chainError,
  subscribeError = null,
  expiryHint = null,
}: TopBarProps) {
  const [time, setTime] = useState(new Date());
  const { state, logout } = useAuth();
  const [, navigate] = useLocation();
  const hilo = useLiveHiLo();
  const spotDayRefByToken = useLiveSpotDayRef();
  const [fyersAuthed, setFyersAuthed] = useState(false);
  const [fyersBusy, setFyersBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (state.status !== "authed") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = (await apiFetch("/api/fyers/status")) as {
          ok?: boolean;
          authed?: boolean;
          enabled?: boolean;
        };
        if (!cancelled && res?.ok) setFyersAuthed(Boolean(res.authed));
      } catch {
        /* ignore */
      }
    };
    void poll();
    const iv = window.setInterval(poll, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [state.status]);

  const handleIndexChange = (idx: IndexName) => {
    onIndexChange(idx);
  };

  const fmtClock = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const spotToken = chain?.spotToken;
  const vixId = chain?.vixInstrumentId;
  const tickSpot = useTickLtp(typeof spotToken === "number" ? spotToken : null);
  const tickVix = useTickLtp(typeof vixId === "number" ? vixId : null);

  const rawSpotTick = tickSpot != null && tickSpot > 0 ? tickSpot : undefined;
  const stableSnap = typeof chain?.spotLtp === "number" ? chain!.spotLtp : undefined;
  const liveSpot =
    typeof rawSpotTick === "number" && rawSpotTick > 0
      ? rawSpotTick
      : typeof stableSnap === "number" && stableSnap > 0
        ? stableSnap
        : typeof rawSpotTick === "number"
          ? rawSpotTick
          : stableSnap;

  const liveAtmStrike = useMemo(() => {
    if (!chain) return undefined;
    const px =
      typeof liveSpot === "number" && Number.isFinite(liveSpot) && liveSpot > 0 ? liveSpot : undefined;
    return liveAtmStrikeForChain(chain, px);
  }, [chain, liveSpot]);

  const dayRef = typeof spotToken === "number" ? spotDayRefByToken[spotToken] : undefined;
  const streamPrev =
    typeof dayRef?.prevClose === "number" && dayRef.prevClose > 0 ? dayRef.prevClose : undefined;
  const chainPrev =
    typeof chain?.spotPrevClose === "number" && chain.spotPrevClose > 0 ? chain.spotPrevClose : undefined;
  const streamOpen =
    typeof dayRef?.dayOpen === "number" && dayRef.dayOpen > 0 ? dayRef.dayOpen : undefined;
  const chainOpen =
    typeof chain?.spotDayOpen === "number" && chain.spotDayOpen > 0 ? chain.spotDayOpen : undefined;
  /** Prefer prev. close (stream → chain resolve quote); else session open for a live move vs ref. */
  const refPx = streamPrev ?? chainPrev ?? streamOpen ?? chainOpen;
  const refIsPrevClose = streamPrev != null || chainPrev != null;
  let deltaAbs: number | undefined;
  let deltaPct: number | undefined;
  let spotChangeHint: string | undefined;
  if (typeof liveSpot === "number" && refPx != null && refPx > 0) {
    deltaAbs = liveSpot - refPx;
    deltaPct = (deltaAbs / refPx) * 100;
    if (!refIsPrevClose) {
      spotChangeHint = "Change from today's open (previous close not in quote/stream). Updates with live LTP.";
    } else {
      spotChangeHint = "Live LTP vs previous session close (stream Touchline or chain resolve quote).";
    }
  }
  const changeUp = typeof deltaAbs === "number" ? deltaAbs >= 0 : true;
  const spotBullActive =
    typeof liveSpot === "number" && Number.isFinite(liveSpot) && liveSpot > 0 && typeof deltaAbs === "number";

  /** Exchange day range from Touchline — not min/max since dashboard connected. */
  const dhStream =
    typeof dayRef?.dayHigh === "number" && dayRef.dayHigh > 0 ? dayRef.dayHigh : undefined;
  const dlStream =
    typeof dayRef?.dayLow === "number" && dayRef.dayLow > 0 ? dayRef.dayLow : undefined;
  const dhChain =
    typeof chain?.spotDayHigh === "number" && chain.spotDayHigh > 0 ? chain.spotDayHigh : undefined;
  const dlChain =
    typeof chain?.spotDayLow === "number" && chain.spotDayLow > 0 ? chain.spotDayLow : undefined;
  let exchangeHl: { h: number; l: number } | undefined;
  if (dhStream != null && dlStream != null && dhStream + 1e-9 >= dlStream) {
    exchangeHl = { h: dhStream, l: dlStream };
  } else {
    const mh = dhStream ?? dhChain;
    const ml = dlStream ?? dlChain;
    if (mh != null && ml != null && mh + 1e-9 >= ml) {
      exchangeHl = { h: mh, l: ml };
    }
  }
  const rollingHl =
    typeof spotToken === "number" && hilo[spotToken] ? hilo[spotToken] : undefined;
  /** Chain resolve H/L is a snapshot; stream may omit updates. Always fold in rolling LTP min/max so H/L move with ticks. */
  const spotHL =
    exchangeHl && rollingHl
      ? { h: Math.max(exchangeHl.h, rollingHl.h), l: Math.min(exchangeHl.l, rollingHl.l) }
      : (exchangeHl ?? rollingHl);
  const spotHlHint =
    exchangeHl !== undefined && rollingHl !== undefined
      ? "Today's high/low: exchange Touchline or chain quote, merged with live LTP high/low since connect so the strip updates every tick."
      : exchangeHl !== undefined
        ? "Today's high / low from exchange Touchline (or chain resolve quote)."
        : rollingHl !== undefined
          ? "High/low only since this dashboard connected — waits for Touchline High/Low on the index stream."
          : undefined;

  const atmStrikeDisplay = liveAtmStrike ?? chain?.atmStrike;

  const atmRow =
    chain && atmStrikeDisplay != null && chain.instrumentMap[String(atmStrikeDisplay)]
      ? chain.instrumentMap[String(atmStrikeDisplay)]
      : null;
  const tickCe = useTickLtp(atmRow?.ce ?? null);
  const tickPe = useTickLtp(atmRow?.pe ?? null);

  useEffect(() => {
    if (!chain || !fyersAuthed) return;
    const spotSeg = Number(chain.spotSegment) || 0;
    const spotTok = Number(chain.spotToken) || 0;
    const vixSeg =
      typeof chain.vixSegment === "number" && chain.vixSegment > 0 ? chain.vixSegment : 1;
    const vixTok = typeof chain.vixInstrumentId === "number" ? chain.vixInstrumentId : 0;
    const optSeg = Number(chain.optionSegment) || 2;
    const options: { exchangeSegment: number; exchangeInstrumentID: number }[] = [];
    if (atmRow?.ce && atmRow.ce > 0) {
      options.push({ exchangeSegment: optSeg, exchangeInstrumentID: atmRow.ce });
    }
    if (atmRow?.pe && atmRow.pe > 0) {
      options.push({ exchangeSegment: optSeg, exchangeInstrumentID: atmRow.pe });
    }
    setFyersTopbarFocus({
      index,
      spot: spotTok > 0 && spotSeg > 0 ? { exchangeSegment: spotSeg, exchangeInstrumentID: spotTok } : null,
      vix: vixTok > 0 ? { exchangeSegment: vixSeg, exchangeInstrumentID: vixTok } : null,
      options,
    });
  }, [chain, index, fyersAuthed, atmRow?.ce, atmRow?.pe]);

  const ceLt = tickCe != null && tickCe > 0 ? tickCe : undefined;
  const peLt = tickPe != null && tickPe > 0 ? tickPe : undefined;
  const atmStraddle =
    typeof ceLt === "number" && typeof peLt === "number" ? ceLt + peLt : undefined;
  /** Synthetic future at ATM: K + CE − PE (live LTPs). */
  const synFut =
    chain &&
    typeof atmStrikeDisplay === "number" &&
    Number.isFinite(atmStrikeDisplay) &&
    typeof ceLt === "number" &&
    typeof peLt === "number" &&
    Number.isFinite(ceLt) &&
    Number.isFinite(peLt)
      ? atmStrikeDisplay + ceLt - peLt
      : undefined;

  useEffect(() => {
    try {
      window.dispatchEvent(
        new CustomEvent("sow:syn_fut", {
          detail: {
            syn: typeof synFut === "number" && Number.isFinite(synFut) ? synFut : null,
            spot: typeof liveSpot === "number" && Number.isFinite(liveSpot) ? liveSpot : null,
            atm: typeof atmStrikeDisplay === "number" ? atmStrikeDisplay : null,
          },
        }),
      );
    } catch {
      // ignore
    }
  }, [synFut, liveSpot, atmStrikeDisplay]);

  const liveVix = tickVix != null && tickVix > 0 ? tickVix : undefined;

  const vixDayRef = typeof vixId === "number" ? spotDayRefByToken[vixId] : undefined;
  const vixStreamPrev =
    typeof vixDayRef?.prevClose === "number" && vixDayRef.prevClose > 0 ? vixDayRef.prevClose : undefined;
  const vixStreamOpen =
    typeof vixDayRef?.dayOpen === "number" && vixDayRef.dayOpen > 0 ? vixDayRef.dayOpen : undefined;
  const vixChainPrev =
    typeof chain?.vixPrevClose === "number" && chain.vixPrevClose > 0 ? chain.vixPrevClose : undefined;
  const vixChainOpen =
    typeof chain?.vixDayOpen === "number" && chain.vixDayOpen > 0 ? chain.vixDayOpen : undefined;
  /** Stream first (realtime anchors), then chain resolve REST quote (fixes blank when socket skips Close/Open). */
  const vixRefPx = vixStreamPrev ?? vixChainPrev ?? vixStreamOpen ?? vixChainOpen;
  const vixRefIsPrevClose = vixStreamPrev != null || vixChainPrev != null;
  let vixDeltaAbs: number | undefined;
  let vixDeltaPct: number | undefined;
  let vixChangeHint: string | undefined;
  if (typeof liveVix === "number" && Number.isFinite(liveVix) && liveVix > 0 && vixRefPx != null && vixRefPx > 0) {
    vixDeltaAbs = liveVix - vixRefPx;
    vixDeltaPct = (vixDeltaAbs / vixRefPx) * 100;
    vixChangeHint = vixRefIsPrevClose
      ? "India VIX vs previous session close (Touchline)."
      : "India VIX vs today's open — previous close missing in quote.";
  }
  const vixUp = typeof vixDeltaAbs === "number" ? vixDeltaAbs >= 0 : true;
  const vixShowDelta = typeof vixDeltaAbs === "number" && typeof vixDeltaPct === "number";

  const expirySelectOptions = expiryOptions.length > 0 ? expiryOptions : [expiry || "—"];

  return (
    <>
      <div className="sow-glass-topbar text-[15px]">
        <div className="sow-glass-topbar__inner">
          <SpinnerSelect value={index} options={INDICES} onChange={handleIndexChange} theme={theme} />
          <div className="flex flex-col gap-0">
            <SpinnerSelect value={expiry} options={expirySelectOptions} onChange={onExpiryChange} theme={theme} />
            {expiryHint ? <span className="text-[10px] text-amber-400/90 leading-tight max-w-[140px]">{expiryHint}</span> : null}
          </div>

          <div className="sow-glass-topbar-stat">
            <div className="flex flex-col">
              <div className="flex items-center gap-1 flex-wrap">
                <span className="sow-glass-topbar-stat__label">Spot:</span>
                <ExternalLink className="w-3 h-3 text-muted-foreground" />
                <span className="sow-glass-topbar-stat__value tabular-nums">
                  {typeof spotToken === "number" && spotToken > 0 ? (
                    <FastLtp iid={spotToken} className="sow-glass-topbar-stat__value tabular-nums" />
                  ) : (
                    fmtPrice(liveSpot)
                  )}
                </span>
                {typeof deltaAbs === "number" && typeof deltaPct === "number" ? (
                  <span
                    className={
                      changeUp
                        ? "sow-glass-topbar-stat__change sow-glass-topbar-stat__change--up tabular-nums"
                        : "sow-glass-topbar-stat__change sow-glass-topbar-stat__change--down tabular-nums"
                    }
                    title={spotChangeHint}
                  >
                    {changeUp ? "▲" : "▼"} {fmtPrice(deltaAbs)} ({fmtPct(deltaPct)})
                  </span>
                ) : typeof liveSpot === "number" ? (
                  <span
                    className="text-muted-foreground text-[11px]"
                    title="Waiting for prev. close or open from broker quotes / Touchline stream to compute change."
                  >
                    —
                  </span>
                ) : (
                  <span className="text-muted-foreground text-[11px]">—</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground" title={spotHlHint}>
                <span className="font-bold">
                  H:{" "}
                  <span className="sow-glass-topbar-stat__value tabular-nums">
                    {spotHL ? fmtPrice(spotHL.h) : "—"}
                  </span>
                </span>
                <span className="font-bold">
                  L:{" "}
                  <span className="sow-glass-topbar-stat__value tabular-nums">
                    {spotHL ? fmtPrice(spotHL.l) : "—"}
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div className="sow-glass-topbar-stat sow-glass-topbar-stat--row">
            <span className="sow-glass-topbar-stat__label">Syn. Fut.:</span>
            <span
              className="font-bold text-foreground text-[13px]"
              title="ATM strike + ATM CE LTP − ATM PE LTP (updates with option ticks)."
            >
              {synFut != null && Number.isFinite(synFut) ? fmtPrice(synFut) : "—"}
            </span>
          </div>

          <div className="sow-glass-topbar-stat sow-glass-topbar-stat--row">
            <span className="sow-glass-topbar-stat__label">ATM:</span>
            <span className="font-bold text-foreground text-[13px]">
              {atmStraddle != null ? fmtPrice(atmStraddle) : "—"}{" "}
              ({atmStrikeDisplay != null ? atmStrikeDisplay.toLocaleString("en-IN") : "—"})
            </span>
          </div>

          <div className="sow-glass-topbar-stat sow-glass-topbar-stat--row flex-wrap">
            <span className="sow-glass-topbar-stat__label">VIX:</span>
            {liveVix != null && Number.isFinite(liveVix) ? (
              <>
                <span
                  className={`font-bold tabular-nums text-[13px] ${vixShowDelta ? (vixUp ? "text-cd-green" : "text-cd-red") : "text-foreground"
                    }`}
                  title={
                    vixShowDelta
                      ? vixChangeHint
                      : "Refresh chain or wait for Touchline — prev close / open loaded from REST on resolve when socket omits fields."
                  }
                >
                  {typeof vixId === "number" && vixId > 0 ? (
                    <FastLtp
                      iid={vixId}
                      className={`font-bold tabular-nums text-[13px] ${
                        vixShowDelta ? (vixUp ? "text-cd-green" : "text-cd-red") : "text-foreground"
                      }`}
                    />
                  ) : (
                    fmtPrice(liveVix)
                  )}
                </span>
                {vixShowDelta ? (
                  <span
                    className={`font-semibold tabular-nums text-[12px] ${vixUp ? "text-cd-green" : "text-cd-red"}`}
                    title={vixChangeHint}
                  >
                    {vixUp ? "▲" : "▼"} {fmtPrice(vixDeltaAbs!)} ({fmtPct(vixDeltaPct!)})
                  </span>
                ) : (
                  <span
                    className="text-muted-foreground text-[11px] tabular-nums"
                    title="No VIX prev close/open yet — reconnect stream or reload chain (broker REST fills anchors on resolve)."
                  >
                    —
                  </span>
                )}
              </>
            ) : (
              <span className="font-bold text-foreground">—</span>
            )}
          </div>

          {chainError && (
            <span className="text-red-400 text-[11px] max-w-[200px]" title={chainError}>
              {chainError.slice(0, 80)}
              {chainError.length > 80 ? "…" : ""}
            </span>
          )}
          {subscribeError && (
            <span className="text-amber-500 text-[11px] max-w-[220px]" title={subscribeError}>
              Stream: {subscribeError.slice(0, 76)}
              {subscribeError.length > 76 ? "…" : ""}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            <span className="sow-glass-topbar-pill tabular-nums">{fmtClock(time)}</span>

            <button
              type="button"
              disabled={fyersBusy}
              title={
                fyersAuthed
                  ? "Spot / VIX / ATM / LIVE LTP = Fyers"
                  : "Connect Fyers for TopBar + LIVE LTP (once per day)"
              }
              className={`sow-glass-topbar-pill text-[11px] font-semibold ${
                fyersAuthed ? "text-emerald-600" : "text-amber-600"
              }`}
              onClick={async () => {
                if (fyersAuthed) return;
                setFyersBusy(true);
                try {
                  const res = (await apiFetch("/api/fyers/login_url")) as {
                    ok?: boolean;
                    url?: string;
                    error?: string;
                  };
                  if (res?.url) {
                    window.location.href = res.url;
                    return;
                  }
                  window.alert(res?.error || "Fyers login URL nahi mila");
                } catch (e) {
                  window.alert(e instanceof Error ? e.message : String(e));
                } finally {
                  setFyersBusy(false);
                }
              }}
            >
              {fyersAuthed ? "Fyers MD" : fyersBusy ? "Fyers…" : "Connect Fyers"}
            </button>

            {state.status === "authed" && (
              <div className="sow-glass-topbar-profile" title={`Signed in · ${state.username}`}>
                <span className="sow-glass-topbar-profile__avatar" aria-hidden>
                  {profileInitials(state.username)}
                </span>
                <span className="max-w-[120px] truncate text-[12px] font-semibold tracking-tight text-foreground">
                  {state.username}
                </span>
              </div>
            )}
            <button type="button" onClick={onThemeToggle} className="sow-glass-topbar-theme-btn">
              {theme === "dark" ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
              <span>{theme === "dark" ? "Light" : "Dark"}</span>
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="sow-glass-topbar-icon-btn"
              title="Reload (hard refresh)"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="sow-glass-topbar-icon-btn">
                  <Settings className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={async () => {
                    await logout();
                    navigate("/login");
                  }}
                >
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div
        // title={MANTRA_TICKER}
        className={`w-full shrink-0 overflow-hidden border-b border-border py-1 ${
          theme === "dark" ? "bg-[hsl(210,12%,10%)] text-[#ff6600]" : "bg-[hsl(28,40%,96%)] text-[#c2410c]"
        }`}
        style={{
          fontFamily: "'Noto Sans Devanagari', 'Mangal', 'Nirmala UI', 'Kohinoor Devanagari', system-ui, sans-serif",
        }}
      >
      </div>
    </>
  );
}
