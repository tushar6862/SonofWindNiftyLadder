import { useState } from "react";
import type { IndexName } from "@/pages/Dashboard";
import { lotSizeForIndex } from "@/lib/lot";
import type { ChainResolved, ExpiryRow } from "@/types/market";
import { apiFetch } from "@/lib/backend";
import { toast } from "@/hooks/use-toast";
import NiftyLadderPanel from "@/components/NiftyLadderPanel";
import NiftySnakePanel from "@/components/NiftySnakePanel";
import NiftyBothSidePanel from "@/components/NiftyBothSidePanel";
import NiftySnakeBothSidePanel from "@/components/NiftySnakeBothSidePanel";
import { bumpPositionsRefresh } from "@/lib/ixPortfolio";

export default function OptionsChain({
  index,
  resolved,
  error,
}: {
  index: IndexName;
  resolved: ChainResolved | null;
  error?: string | null;
  range: number;
  onRangeChange?: (range: number) => void;
  wings?: number;
  onWingsChange?: (wings: number) => void;
  selectedStrike?: number | null;
  onStrikeSelect?: (strike: number) => void;
  expiryRows?: ExpiryRow[];
  expiry?: string;
  onExpiryChange?: (label: string) => void;
}) {
  const lotSize = lotSizeForIndex(index);
  const qty = Math.max(1, lotSize);
  const [desk, setDesk] = useState<"ladder" | "snake" | "bothside" | "snakebothside">("ladder");
  const [exitBusy, setExitBusy] = useState(false);
  const [exitSelected, setExitSelected] = useState<25 | 50 | 75 | 100 | null>(null);

  const exitOpenPositions = async (percent: 25 | 50 | 75 | 100) => {
    if (exitBusy) return;
    setExitBusy(true);
    setExitSelected(percent);
    const t0 = toast({
      title: "Exit request",
      description: percent === 100 ? "Exiting ALL open positions…" : `Exiting ${percent}% of all open positions…`,
    });
    window.setTimeout(() => t0.dismiss(), 2000);
    try {
      await apiFetch("/api/ix/exit_open_positions", {
        method: "POST",
        body: JSON.stringify({ percent }),
      });
      bumpPositionsRefresh();
      const t1 = toast({
        title: "Exit sent",
        description: percent === 100 ? "Exit ALL order(s) placed." : `Exit ${percent}% order(s) placed.`,
      });
      window.setTimeout(() => t1.dismiss(), 2000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const tErr = toast({
        title: "Exit failed",
        description: msg,
        variant: "destructive",
      });
      window.setTimeout(() => tErr.dismiss(), 2000);
      throw e;
    } finally {
      setExitBusy(false);
      window.setTimeout(() => {
        setExitSelected(null);
      }, 1200);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0 w-full h-full overflow-hidden sow-glass-shell border-l border-border/50">
      <div className="sow-glass-tabs shrink-0">
        <button
          type="button"
          className={`sow-glass-tab${desk === "ladder" ? " sow-glass-tab--active" : ""}`}
          onClick={() => setDesk("ladder")}
        >
          Nifty Ladder
        </button>
        <button
          type="button"
          className={`sow-glass-tab${desk === "snake" ? " sow-glass-tab--active" : ""}`}
          onClick={() => setDesk("snake")}
        >
          Nifty Snake
        </button>
        <button
          type="button"
          className={`sow-glass-tab${desk === "bothside" ? " sow-glass-tab--active" : ""}`}
          onClick={() => setDesk("bothside")}
        >
          Nifty Ladder Both Side
        </button>
        <button
          type="button"
          className={`sow-glass-tab${desk === "snakebothside" ? " sow-glass-tab--active" : ""}`}
          onClick={() => setDesk("snakebothside")}
        >
          Nifty Snake Both Side
        </button>
      </div>

      {!resolved && (
        <div className="flex-1 flex flex-col items-center justify-center gap-5 p-6 relative overflow-hidden">
          <div className="absolute -top-24 left-1/2 -translate-x-1/2 h-64 w-[620px] rounded-full blur-3xl opacity-30 bg-gradient-to-r from-blue-500/15 via-cyan-500/10 to-violet-500/15" />
          <div className="relative z-10">
            <div className="h-14 w-14 rounded-full border border-border/60 bg-background/70 backdrop-blur shadow-sm" />
            <div className="absolute inset-0 grid place-items-center">
              <div className="h-12 w-12 rounded-full border-2 border-muted-foreground/20 border-t-blue-500/90 animate-spin" />
            </div>
            <div className="absolute inset-0 grid place-items-center">
              <div className="h-2.5 w-2.5 rounded-full bg-blue-500/70 animate-pulse" />
            </div>
          </div>
          <div className="text-center z-10">
            <div className="text-[12px] font-medium text-foreground/90">
              {error ? "Chain load failed" : "Syncing option chain"}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {error || "Subscribing LTP and building NIFTY strikes…"}
            </div>
          </div>
          <div className="z-10 w-full max-w-[520px] flex flex-col items-center gap-3">
            <div className="w-full h-2 rounded-full border border-border/50 bg-secondary/20 overflow-hidden relative">
              <div className="absolute inset-y-0 -left-1/2 w-1/2 animate-[sowShimmer_1.25s_infinite] bg-gradient-to-r from-transparent via-foreground/10 to-transparent" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-[sowDot_1s_infinite]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-[sowDot_1s_infinite_0.2s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-[sowDot_1s_infinite_0.4s]" />
            </div>
          </div>
          <style>{`
            @keyframes sowShimmer { 100% { transform: translateX(200%); } }
            @keyframes sowDot { 0%, 100% { opacity: .35 } 50% { opacity: 1 } }
          `}</style>
        </div>
      )}

      {resolved && (
        <>
          <div className={desk === "ladder" ? "flex flex-1 min-h-0 flex-col overflow-hidden" : "hidden"} aria-hidden={desk !== "ladder"}>
            <NiftyLadderPanel chain={resolved} qty={qty} />
          </div>
          <div className={desk === "snake" ? "flex flex-1 min-h-0 flex-col overflow-hidden" : "hidden"} aria-hidden={desk !== "snake"}>
            <NiftySnakePanel chain={resolved} qty={qty} />
          </div>
          <div className={desk === "bothside" ? "flex flex-1 min-h-0 flex-col overflow-hidden" : "hidden"} aria-hidden={desk !== "bothside"}>
            <NiftyBothSidePanel chain={resolved} qty={qty} />
          </div>
          <div className={desk === "snakebothside" ? "flex flex-1 min-h-0 flex-col overflow-hidden" : "hidden"} aria-hidden={desk !== "snakebothside"}>
            <NiftySnakeBothSidePanel chain={resolved} qty={qty} />
          </div>
        </>
      )}

      <div className="sow-footer-scroll sow-glass-footer-bar w-full min-w-0 shrink-0 text-[11px]">
        <div className="flex min-w-max items-center gap-2">
          <span className="text-[10px] text-muted-foreground shrink-0"> </span>
          <div className="flex ml-auto flex-nowrap items-center gap-2 pr-1">
            <div className="sow-glass-exit-group">
              <button
                type="button"
                disabled={exitBusy}
                onClick={() => void exitOpenPositions(25)}
                className={`sow-glass-exit-btn${exitSelected === 25 ? " sow-glass-exit-btn--lit" : ""}`}
              >
                Exit 25%
              </button>
              <button
                type="button"
                disabled={exitBusy}
                onClick={() => void exitOpenPositions(50)}
                className={`sow-glass-exit-btn${exitSelected === 50 ? " sow-glass-exit-btn--lit" : ""}`}
              >
                Exit 50%
              </button>
              <button
                type="button"
                disabled={exitBusy}
                onClick={() => void exitOpenPositions(75)}
                className={`sow-glass-exit-btn${exitSelected === 75 ? " sow-glass-exit-btn--lit" : ""}`}
              >
                Exit 75%
              </button>
              <button
                type="button"
                disabled={exitBusy}
                onClick={() => void exitOpenPositions(100)}
                className={`sow-glass-exit-btn sow-glass-exit-btn--all${exitSelected === 100 ? " sow-glass-exit-btn--lit" : ""}`}
              >
                Exit All
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
