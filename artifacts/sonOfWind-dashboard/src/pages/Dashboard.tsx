import { useEffect, useMemo, useRef, useState } from "react";
import TopBar from "@/components/TopBar";
import LeftPanel from "@/components/LeftPanel";
import OptionsChain from "@/components/OptionsChain";
import PositionsTable from "@/components/PositionsTable";
import { LiveLtpProvider } from "@/context/LiveLtpContext";
import { apiFetch, mdStartOnce } from "@/lib/backend";
import { subscribeMdTouchline } from "@/lib/mdRegistry";
import { refreshQuotesFromRest } from "@/lib/atpSeed";
import { seedChainSpotFromResolve } from "@/lib/seedChainSpot";
import type { ChainExpiriesResponse, ChainResolved, ChainResolveResponse, ExpiryRow } from "@/types/market";

function FyersMorningConnect() {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = (await apiFetch("/api/fyers/status")) as { ok?: boolean; authed?: boolean };
        if (!cancelled && res?.ok) {
          setAuthed(Boolean(res.authed));
          setReady(true);
        }
      } catch {
        /* ignore */
      }
    };
    void poll();
    const iv = window.setInterval(poll, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  if (!ready || authed) return null;

  return (
    <div className="mx-3 mt-2 flex items-center justify-between gap-3 rounded-md border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-[13px]">
      <span>Roz subah naya Fyers login chahiye. Connect karo, tab LIVE LTP XTS se match karega.</span>
      <button
        type="button"
        disabled={busy}
        className="shrink-0 rounded-md bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-black disabled:opacity-60"
        onClick={async () => {
          setBusy(true);
          try {
            const res = (await apiFetch("/api/fyers/login_url")) as { url?: string; error?: string };
            if (res?.url) {
              window.location.href = res.url;
              return;
            }
            window.alert(res?.error || "Fyers login URL nahi mila");
          } catch (e) {
            window.alert(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Opening…" : "Connect Fyers"}
      </button>
    </div>
  );
}

export type IndexName = "SENSEX" | "NIFTY" | "BANKNIFTY";

export const EXPIRY_BY_INDEX: Record<IndexName, string[]> = {
  SENSEX: ["7 May", "14 May", "21 May", "28 May"],
  NIFTY: ["12 May", "19 May", "26 May", "2 Jun"],
  BANKNIFTY: ["26 May", "2 Jun", "9 Jun", "16 Jun"],
};

function fmtExpiryLabel(label: string, year = new Date().getFullYear()): string {
  const m = String(label).trim().match(/^(\d{1,2})\s*([A-Za-z]{3,9})/);
  if (!m) return String(label).trim();
  const day = Number(m[1]);
  const mon = String(m[2]).slice(0, 3).toLowerCase();
  const months: Record<string, string> = {
    jan: "Jan",
    feb: "Feb",
    mar: "Mar",
    apr: "Apr",
    may: "May",
    jun: "Jun",
    jul: "Jul",
    aug: "Aug",
    sep: "Sep",
    oct: "Oct",
    nov: "Nov",
    dec: "Dec",
  };
  const monT = months[mon] ?? String(m[2]).slice(0, 3);
  return `${String(day).padStart(2, "0")}${monT}${year}`;
}

function fallbackExpiryRows(idx: IndexName): ExpiryRow[] {
  // Only current + next 2; format as 07May2026
  return EXPIRY_BY_INDEX[idx]
    .slice(0, 3)
    .map((label) => ({ label: fmtExpiryLabel(label), api: label }));
}


function spotInstrumentsFromChain(raw: ChainResolved): { exchangeSegment: number; exchangeInstrumentID: number }[] {
  const out: { exchangeSegment: number; exchangeInstrumentID: number }[] = [
    { exchangeSegment: raw.spotSegment, exchangeInstrumentID: raw.spotToken },
  ];
  if (typeof raw.vixInstrumentId === "number" && raw.vixInstrumentId > 0) {
    const vixSeg = typeof raw.vixSegment === "number" && raw.vixSegment > 0 ? raw.vixSegment : 1;
    out.push({ exchangeSegment: vixSeg, exchangeInstrumentID: raw.vixInstrumentId });
  }
  return out;
}

export default function DashboardPage() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = localStorage.getItem("sow-theme");
      if (saved === "dark" || saved === "light") return saved;
    } catch {
      /* ignore */
    }
    return "light";
  });
  const defaultIndex: IndexName = useMemo(() => "NIFTY", []);
  const [index, setIndex] = useState<IndexName>(defaultIndex);
  const [expiryRows, setExpiryRows] = useState<ExpiryRow[]>(() => fallbackExpiryRows(defaultIndex));
  const [expiry, setExpiry] = useState<string>(() => fallbackExpiryRows(defaultIndex)[0]?.label ?? "");
  const [expiryApi, setExpiryApi] = useState<string>(() => fallbackExpiryRows(defaultIndex)[0]?.api ?? "");
  const [strikeFocus, setStrikeFocus] = useState<number | null>(null);
  const [range, setRange] = useState<number>(1); // UI filter only
  const [wings, setWings] = useState<number>(12); // ATM ±12 — enough for ~100 hunt, not the full 45-wing chain
  const [expiryFetchError, setExpiryFetchError] = useState<string | null>(null);
  const [chain, setChain] = useState<ChainResolved | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const chainRef = useRef<ChainResolved | null>(null);
  chainRef.current = chain;

  const selectedExpiryApi = useMemo(() => {
    const sel = expiryRows.find((r) => r.label === expiry);
    return sel?.api ?? (expiryApi || null);
  }, [expiryRows, expiry, expiryApi]);

  const handleExpiryChange = (label: string) => {
    setExpiry(label);
    const sel = expiryRows.find((r) => r.label === label);
    if (sel?.api) setExpiryApi(sel.api);
  };

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "light") {
      root.classList.add("light-theme");
      root.classList.remove("dark-theme");
    } else {
      root.classList.remove("light-theme");
      root.classList.add("dark-theme");
    }
    try {
      localStorage.setItem("sow-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    document.body.classList.add("sow-has-dashboard-bg");
    return () => document.body.classList.remove("sow-has-dashboard-bg");
  }, []);

  useEffect(() => {
    setStrikeFocus(null);
    setRange(1);
    setWings(12);
    const fb = fallbackExpiryRows(index);
    setExpiryRows(fb);
    setExpiry(fb[0]?.label ?? "");
    setExpiryApi(fb[0]?.api ?? "");
    setExpiryFetchError(null);
  }, [index]);

  useEffect(() => {
    let cancelled = false;
    setExpiryFetchError(null);

    (async () => {
      try {
        const body: Record<string, unknown> = { index };
        if (
          strikeFocus != null &&
          chain?.optionSeries != null &&
          chain.optionSeries !== "" &&
          chain?.optionSymbol != null &&
          chain.optionSymbol !== ""
        ) {
          body.strike = strikeFocus;
          body.optionSegment = chain.optionSegment;
          body.optionSeries = chain.optionSeries;
          body.optionSymbol = chain.optionSymbol;
        }

        const raw = (await apiFetch("/api/chain/expiries", {
          method: "POST",
          body: JSON.stringify(body),
        })) as ChainExpiriesResponse;

        if (cancelled) return;

        if (!raw.ok) {
          setExpiryFetchError(raw.error || "Expiry list failed");
          setExpiryRows(fallbackExpiryRows(index));
          return;
        }

        if (raw.strikeFilterEmpty && strikeFocus != null) {
          return;
        }

        if (raw.expiries?.length) {
          setExpiryRows(raw.expiries);
          const labels = raw.expiries.map((r) => r.label);
          setExpiry((prev) => (labels.includes(prev) ? prev : labels[0]!));
          // keep api token in sync with selected label
          const pick = raw.expiries.find((r) => r.label === (labels.includes(expiry) ? expiry : labels[0]!));
          if (pick?.api) setExpiryApi(pick.api);
        } else if (!strikeFocus) {
          setExpiryRows(fallbackExpiryRows(index));
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setExpiryFetchError(e instanceof Error ? e.message : String(e));
          setExpiryRows(fallbackExpiryRows(index));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [index, strikeFocus, chain?.optionSegment, chain?.optionSeries, chain?.optionSymbol]);

  useEffect(() => {
    let cancelled = false;
    setChain(null);
    setChainError(null);
    setSubscribeError(null);

    (async () => {
      try {
        await mdStartOnce();
        // Guard: after index switch, expiryRows updates async; don't resolve using stale expiry token.
        if (!selectedExpiryApi) return;
        const raw = (await apiFetch("/api/chain/resolve", {
          method: "POST",
          body: JSON.stringify({ index, expiry: selectedExpiryApi, wings }),
        })) as ChainResolveResponse;

        if (cancelled) return;

        if (!raw.ok) {
          setChainError(raw.error || "Chain resolve failed");
          return;
        }

        setChain(raw);
        seedChainSpotFromResolve(raw);

        try {
          await subscribeMdTouchline(spotInstrumentsFromChain(raw), () => cancelled, { force: true });
        } catch (subErr: unknown) {
          if (!cancelled) setSubscribeError(subErr instanceof Error ? subErr.message : String(subErr));
        }
      } catch (e: unknown) {
        if (!cancelled) setChainError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [index, selectedExpiryApi, wings]);

  useEffect(() => {
    const onResub = () => {
      const raw = chainRef.current;
      if (!raw) return;
      void subscribeMdTouchline(spotInstrumentsFromChain(raw), undefined, { force: true }).catch(() => {});
    };
    window.addEventListener("sonofwind_md_resubscribe", onResub);
    return () => window.removeEventListener("sonofwind_md_resubscribe", onResub);
  }, []);

  /** REST touchline poll for spot/VIX. Ladder options are polled from NiftyLadderPanel. */
  const spotInstruments = useMemo(
    () => (chain ? spotInstrumentsFromChain(chain) : []),
    [chain],
  );

  useEffect(() => {
    if (!spotInstruments.length) return;
    let cancelled = false;
    const poll = () => {
      void refreshQuotesFromRest(spotInstruments, () => cancelled);
    };
    poll();
    const iv = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [spotInstruments]);

  const expiryOptions = useMemo(() => expiryRows.map((r) => r.label), [expiryRows]);
  const dashboardBgUrl = `${import.meta.env.BASE_URL}dashboard-bg.png`.replace(/\/{2,}/g, "/");

  return (
    <LiveLtpProvider>
      <div
        className={`sow-dashboard-bg relative flex flex-col h-screen w-full overflow-hidden text-foreground ${theme === "light" ? "light-theme" : "dark-theme"}`}
      >
        <img src={dashboardBgUrl} alt="" className="sow-dashboard-bg__image" aria-hidden draggable={false} />
        <div className="sow-dashboard-bg__overlay" aria-hidden />

        <div className="relative z-10 flex flex-col h-full w-full min-h-0 overflow-hidden">
        <TopBar
          theme={theme}
          onThemeToggle={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
          index={index}
          onIndexChange={setIndex}
          expiry={expiry}
          onExpiryChange={handleExpiryChange}
          expiryOptions={expiryOptions}
          chain={chain}
          chainError={chainError}
          subscribeError={subscribeError}
          expiryHint={expiryFetchError}
        />

        <FyersMorningConnect />

        <div className="flex flex-1 overflow-hidden">
          <div className="w-[420px] min-w-[300px] flex flex-col overflow-hidden">
            <div className="flex-1 overflow-auto">
              <LeftPanel />
            </div>
          </div>
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
              <OptionsChain
                index={index}
                resolved={chain}
                error={chainError}
                range={range}
                onRangeChange={setRange}
                wings={wings}
                onWingsChange={setWings}
                selectedStrike={strikeFocus}
                onStrikeSelect={(s) => setStrikeFocus((prev) => (prev === s ? null : s))}
                expiryRows={expiryRows}
                expiry={expiry}
                onExpiryChange={handleExpiryChange}
              />
            </div>
          </div>
        </div>

        <div>
          <PositionsTable />
        </div>
        </div>
      </div>
    </LiveLtpProvider>
  );
}
