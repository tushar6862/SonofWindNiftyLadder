import { apiFetch } from "@/lib/backend";

type HotInst = { exchangeSegment: number; exchangeInstrumentID: number };

const bySource = new Map<string, HotInst[]>();
let timer: number | null = null;
let lastKey = "";

let topbarTimer: number | null = null;
let topbarKey = "";

function flush(): void {
  timer = null;
  const merged = new Map<number, HotInst>();
  for (const list of bySource.values()) {
    for (const inst of list) {
      if (inst.exchangeInstrumentID > 0 && inst.exchangeSegment > 0) {
        merged.set(inst.exchangeInstrumentID, inst);
      }
    }
  }
  const instruments = Array.from(merged.values());
  const key = instruments
    .map((i) => `${i.exchangeSegment}:${i.exchangeInstrumentID}`)
    .sort()
    .join("|");
  if (key === lastKey) return;
  lastKey = key;
  void apiFetch("/api/md/hot_focus", {
    method: "POST",
    body: JSON.stringify({ instruments }),
  }).catch(() => {
    /* best-effort */
  });
}

/** Pin LIVE/hunt tokens so the backend polls touchline ~200ms for those strikes only. */
export function setHotFocus(source: "ladder" | "snake", instruments: HotInst[]): void {
  bySource.set(
    source,
    instruments.filter((i) => i.exchangeInstrumentID > 0 && i.exchangeSegment > 0),
  );
  if (timer != null) return;
  timer = window.setTimeout(flush, 40);
}

/** Pin Spot + VIX + ATM CE/PE so TopBar paints from Fyers. */
export function setFyersTopbarFocus(args: {
  index: string;
  spot?: HotInst | null;
  vix?: HotInst | null;
  options?: HotInst[];
}): void {
  const spot =
    args.spot && args.spot.exchangeInstrumentID > 0 && args.spot.exchangeSegment > 0 ? args.spot : null;
  const vix = args.vix && args.vix.exchangeInstrumentID > 0 && args.vix.exchangeSegment > 0 ? args.vix : null;
  const options = (args.options || []).filter((i) => i.exchangeInstrumentID > 0 && i.exchangeSegment > 0);
  const key = [
    args.index,
    spot ? `${spot.exchangeSegment}:${spot.exchangeInstrumentID}` : "",
    vix ? `${vix.exchangeSegment}:${vix.exchangeInstrumentID}` : "",
    ...options.map((o) => `${o.exchangeSegment}:${o.exchangeInstrumentID}`).sort(),
  ].join("|");
  if (key === topbarKey) return;
  topbarKey = key;
  if (topbarTimer != null) window.clearTimeout(topbarTimer);
  topbarTimer = window.setTimeout(() => {
    topbarTimer = null;
    void apiFetch("/api/fyers/topbar_focus", {
      method: "POST",
      body: JSON.stringify({
        index: args.index,
        spot,
        vix,
        options,
      }),
    }).catch(() => {
      /* best-effort */
    });
  }, 50);
}
