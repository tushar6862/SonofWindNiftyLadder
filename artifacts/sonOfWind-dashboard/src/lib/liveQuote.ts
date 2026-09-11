import { peekLiveTick } from "@/context/LiveLtpContext";
import { touchPxFromTick } from "@/lib/touchPx";

export { touchPxFromTick } from "@/lib/touchPx";

export function peekTouchPx(
  iid: number | null | undefined,
  fallbackMap?: Record<number, number>,
): number | null {
  if (iid == null || !Number.isFinite(iid) || iid <= 0) return null;
  const fb =
    fallbackMap && typeof fallbackMap[iid] === "number" && fallbackMap[iid]! > 0
      ? fallbackMap[iid]!
      : null;
  return touchPxFromTick(peekLiveTick(iid), fb);
}

/** Read LTP / ATP (Mace) from in-memory maps fed by ``/api/md/stream``. */
export function readLiveQuote(
  iid: number,
  ltps: Record<number, number>,
  atps: Record<number, number>,
): { ltp: number | null; atp: number | null } {
  const l = peekTouchPx(iid, ltps);
  const a = atps[iid];
  const ltp = typeof l === "number" && Number.isFinite(l) && l > 0 ? l : null;
  const atp = typeof a === "number" && Number.isFinite(a) && a > 0 ? a : null;
  return { ltp, atp };
}
