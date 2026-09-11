import type { ChainResolved } from "@/types/market";

/** Bootstrap header spot / VIX from ``/api/chain/resolve`` — no ``quote_snapshot``. */
export function seedChainSpotFromResolve(chain: ChainResolved): void {
  const ltp: Record<string, number> = {};
  if (chain.spotToken > 0 && typeof chain.spotLtp === "number" && chain.spotLtp > 0) {
    ltp[String(chain.spotToken)] = chain.spotLtp;
  }
  if (Object.keys(ltp).length) {
    window.dispatchEvent(new CustomEvent("sonofwind_ltp_snapshot", { detail: { map: ltp } }));
  }

  type DayRef = {
    prevClose?: number;
    percentChange?: number;
    dayOpen?: number;
    dayHigh?: number;
    dayLow?: number;
  };
  const spotDay: Record<string, DayRef> = {};

  if (chain.spotToken > 0) {
    const ref: DayRef = {};
    if (typeof chain.spotPrevClose === "number" && chain.spotPrevClose > 0) ref.prevClose = chain.spotPrevClose;
    if (typeof chain.spotChangePct === "number" && Number.isFinite(chain.spotChangePct)) {
      ref.percentChange = chain.spotChangePct;
    }
    if (typeof chain.spotDayOpen === "number" && chain.spotDayOpen > 0) ref.dayOpen = chain.spotDayOpen;
    if (typeof chain.spotDayHigh === "number" && chain.spotDayHigh > 0) ref.dayHigh = chain.spotDayHigh;
    if (typeof chain.spotDayLow === "number" && chain.spotDayLow > 0) ref.dayLow = chain.spotDayLow;
    if (Object.keys(ref).length) spotDay[String(chain.spotToken)] = ref;
  }

  const vixId = chain.vixInstrumentId;
  if (typeof vixId === "number" && vixId > 0) {
    const ref: DayRef = {};
    if (typeof chain.vixPrevClose === "number" && chain.vixPrevClose > 0) ref.prevClose = chain.vixPrevClose;
    if (typeof chain.vixDayOpen === "number" && chain.vixDayOpen > 0) ref.dayOpen = chain.vixDayOpen;
    if (Object.keys(ref).length) spotDay[String(vixId)] = ref;
  }

  if (Object.keys(spotDay).length) {
    window.dispatchEvent(new CustomEvent("sonofwind_spot_day_ref_snapshot", { detail: { map: spotDay } }));
  }
}
