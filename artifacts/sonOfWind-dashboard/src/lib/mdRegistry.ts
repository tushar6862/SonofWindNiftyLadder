import { useEffect, useMemo } from "react";
import { apiFetch } from "@/lib/backend";

export type MdInstrument = { exchangeSegment: number; exchangeInstrumentID: number };

const SUBSCRIBED = new Set<string>();
const PENDING_SUBSCRIBE = new Set<string>();

export const MD_SUBSCRIBE_CHUNK = 64;

let subscribeDrain: Promise<void> = Promise.resolve();

function key(seg: number, id: number): string {
  return `${seg}:${id}`;
}

export function resetMdRegistry(): void {
  SUBSCRIBED.clear();
  PENDING_SUBSCRIBE.clear();
  subscribeDrain = Promise.resolve();
}

if (typeof window !== "undefined") {
  window.addEventListener("sonofwind_auth", resetMdRegistry);
}

function collectNewSubscribe(instruments: MdInstrument[], force = false): MdInstrument[] {
  const out: MdInstrument[] = [];
  for (const inst of instruments) {
    const seg = Number(inst.exchangeSegment);
    const id = Number(inst.exchangeInstrumentID);
    if (!Number.isFinite(seg) || seg <= 0 || !Number.isFinite(id) || id <= 0) continue;
    const k = key(seg, id);
    if (force) {
      SUBSCRIBED.delete(k);
    }
    if (SUBSCRIBED.has(k) || PENDING_SUBSCRIBE.has(k)) continue;
    PENDING_SUBSCRIBE.add(k);
    out.push({ exchangeSegment: seg, exchangeInstrumentID: id });
  }
  return out;
}

async function drainSubscribeQueue(
  batch: MdInstrument[],
  isCancelled?: () => boolean,
): Promise<void> {
  for (let i = 0; i < batch.length; i += MD_SUBSCRIBE_CHUNK) {
    if (isCancelled?.()) {
      for (const inst of batch) {
        PENDING_SUBSCRIBE.delete(key(inst.exchangeSegment, inst.exchangeInstrumentID));
      }
      return;
    }
    const slice = batch.slice(i, i + MD_SUBSCRIBE_CHUNK);
    try {
      await apiFetch("/api/md/subscribe", {
        method: "POST",
        body: JSON.stringify({ xtsMessageCode: 1501, instruments: slice }),
      });
      for (const inst of slice) {
        const k = key(inst.exchangeSegment, inst.exchangeInstrumentID);
        PENDING_SUBSCRIBE.delete(k);
        SUBSCRIBED.add(k);
      }
    } catch (err) {
      for (const inst of slice) {
        PENDING_SUBSCRIBE.delete(key(inst.exchangeSegment, inst.exchangeInstrumentID));
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/unauthorized|401/i.test(msg)) return;
      throw err;
    }
  }
}

/**
 * Subscribe Touchline (1501) once per instrument — serialized queue avoids duplicate
 * in-flight calls. Live LTP/Mace from ``/api/md/stream`` (SSE).
 */
export type SubscribeMdOpts = { force?: boolean };

export async function subscribeMdTouchline(
  instruments: MdInstrument[],
  isCancelled?: () => boolean,
  opts?: SubscribeMdOpts,
): Promise<void> {
  const pending = collectNewSubscribe(instruments, Boolean(opts?.force));
  if (!pending.length) return;

  const run = async () => {
    await drainSubscribeQueue(pending, isCancelled);
  };

  const job = subscribeDrain.then(run, run);
  subscribeDrain = job.catch(() => {});
  await job;
}

/**
 * Deduped Touchline subscribe for legs outside the main chain (e.g. open positions).
 * Chain options are subscribed once from Dashboard — panels rely on ``/api/md/stream``.
 */
export function useSubscribeTouchline(seg: number, ids: number[]): void {
  const instruments = useMemo(() => {
    if (!seg || seg <= 0) return [];
    const uniq = new Set<number>();
    for (const id of ids || []) {
      if (typeof id === "number" && Number.isFinite(id) && id > 0) uniq.add(id);
    }
    return Array.from(uniq).map((exchangeInstrumentID) => ({
      exchangeSegment: seg,
      exchangeInstrumentID,
    }));
  }, [seg, ids]);

  useEffect(() => {
    if (!instruments.length) return;
    let cancelled = false;
    const sub = (force = false) => {
      void subscribeMdTouchline(instruments, () => cancelled, { force });
    };
    sub(false);
    const onResub = () => sub(true);
    window.addEventListener("sonofwind_md_resubscribe", onResub);
    return () => {
      cancelled = true;
      window.removeEventListener("sonofwind_md_resubscribe", onResub);
    };
  }, [instruments]);
}
