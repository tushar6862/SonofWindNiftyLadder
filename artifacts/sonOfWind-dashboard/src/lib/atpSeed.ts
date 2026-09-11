import { apiFetch } from "@/lib/backend";

/** Broker REST batch size — sequential calls avoid pending pile-up. */
const ATP_CHUNK = 40;
const QUOTE_FETCH_TIMEOUT_MS = 12_000;

const ATP_SEEDED = new Set<string>();
const QUOTE_SEEDED = new Set<string>();

let quoteRefreshBusy = false;
let quoteRefreshQueued: { exchangeSegment: number; exchangeInstrumentID: number }[] | null = null;

function instKey(inst: { exchangeSegment: number; exchangeInstrumentID: number }): string {
  return `${inst.exchangeSegment}:${inst.exchangeInstrumentID}`;
}

function filterNew(
  seen: Set<string>,
  instruments: { exchangeSegment: number; exchangeInstrumentID: number }[],
): { exchangeSegment: number; exchangeInstrumentID: number }[] {
  const out: typeof instruments = [];
  for (const inst of instruments) {
    const k = instKey(inst);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(inst);
  }
  return out;
}

function dispatchAtpMap(atpMap?: Record<string, number> | Record<number, number> | null) {
  if (!atpMap || typeof atpMap !== "object") return;
  const keys = Object.keys(atpMap);
  if (!keys.length) return;
  window.dispatchEvent(new CustomEvent("sonofwind_atp_snapshot", { detail: { map: atpMap } }));
}

function dispatchQuoteMaps(r: { ltpMap?: Record<string, number>; atpMap?: Record<string, number> } | null) {
  if (!r) return;
  if (r.ltpMap && typeof r.ltpMap === "object" && Object.keys(r.ltpMap).length) {
    window.dispatchEvent(new CustomEvent("sonofwind_ltp_snapshot", { detail: { map: r.ltpMap } }));
  }
  dispatchAtpMap(r.atpMap);
}

async function fetchQuoteChunk(
  chunk: { exchangeSegment: number; exchangeInstrumentID: number }[],
  isCancelled?: () => boolean,
): Promise<void> {
  if (isCancelled?.()) return;
  const signal =
    typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? (AbortSignal as typeof AbortSignal & { timeout: (ms: number) => AbortSignal }).timeout(
          QUOTE_FETCH_TIMEOUT_MS,
        )
      : undefined;
  try {
    const r = (await apiFetch("/api/md/quote_snapshot", {
      method: "POST",
      body: JSON.stringify({ xtsMessageCode: 1501, instruments: chunk }),
      signal,
    })) as { ltpMap?: Record<string, number>; atpMap?: Record<string, number> };
    dispatchQuoteMaps(r);
  } catch {
    /* best-effort */
  }
}

async function fetchAtpChunks(
  instruments: { exchangeSegment: number; exchangeInstrumentID: number }[],
  isCancelled?: () => boolean,
): Promise<void> {
  for (let i = 0; i < instruments.length; i += ATP_CHUNK) {
    if (isCancelled?.()) break;
    const chunk = instruments.slice(i, i + ATP_CHUNK);
    try {
      const r = (await apiFetch("/api/md/atp_snapshot", {
        method: "POST",
        body: JSON.stringify({ xtsMessageCode: 1501, instruments: chunk }),
      })) as { atpMap?: Record<string, number> };
      dispatchAtpMap(r.atpMap);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * One-time Mace (ATP) bootstrap via touchline (1501) — matches XTS Snap Quote ATP.
 * Live ATP for options chain comes from ``/api/md/stream`` (server refreshes touchline ATP ~2.5s).
 */
export async function seedAtpFromRest(
  instruments: { exchangeSegment: number; exchangeInstrumentID: number }[],
  isCancelled?: () => boolean,
): Promise<void> {
  const pending = filterNew(ATP_SEEDED, instruments);
  await fetchAtpChunks(pending, isCancelled);
}

/** Re-fetch touchline ATP (not deduped) so Mace keeps moving when the socket omits ATP. */
export async function refreshAtpFromRest(
  instruments: { exchangeSegment: number; exchangeInstrumentID: number }[],
  isCancelled?: () => boolean,
): Promise<void> {
  if (!instruments.length) return;
  await fetchAtpChunks(instruments, isCancelled);
}

async function refreshQuotesFromRestInner(
  instruments: { exchangeSegment: number; exchangeInstrumentID: number }[],
  isCancelled?: () => boolean,
): Promise<void> {
  for (let i = 0; i < instruments.length; i += ATP_CHUNK) {
    if (isCancelled?.()) break;
    await fetchQuoteChunk(instruments.slice(i, i + ATP_CHUNK), isCancelled);
  }
}

/** Re-fetch touchline LTP + Mace — serial global lock prevents pending request pile-up. */
export async function refreshQuotesFromRest(
  instruments: { exchangeSegment: number; exchangeInstrumentID: number }[],
  isCancelled?: () => boolean,
): Promise<void> {
  if (!instruments.length) return;
  if (quoteRefreshBusy) {
    quoteRefreshQueued = instruments;
    return;
  }
  quoteRefreshBusy = true;
  try {
    let batch = instruments;
    do {
      quoteRefreshQueued = null;
      await refreshQuotesFromRestInner(batch, isCancelled);
      batch = quoteRefreshQueued ?? [];
    } while (!isCancelled?.() && quoteRefreshQueued && quoteRefreshQueued.length > 0);
  } finally {
    quoteRefreshBusy = false;
  }
}

/** Rare fallback: full quote (LTP + ATP) — sequential only. */
export async function seedQuotesFromRest(
  instruments: { exchangeSegment: number; exchangeInstrumentID: number }[],
  isCancelled?: () => boolean,
): Promise<void> {
  const pending = filterNew(QUOTE_SEEDED, instruments);
  for (let i = 0; i < pending.length; i += ATP_CHUNK) {
    if (isCancelled?.()) break;
    const chunk = pending.slice(i, i + ATP_CHUNK);
    try {
      const r = (await apiFetch("/api/md/quote_snapshot", {
        method: "POST",
        body: JSON.stringify({ xtsMessageCode: 1502, instruments: chunk }),
      })) as { ltpMap?: Record<string, number>; atpMap?: Record<string, number> };
      dispatchQuoteMaps(r);
    } catch {
      /* best-effort */
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("sonofwind_auth", () => {
    ATP_SEEDED.clear();
    QUOTE_SEEDED.clear();
  });
}
