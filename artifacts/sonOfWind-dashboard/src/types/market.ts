export type ChainInstrumentRow = { ce: number; pe: number };

/** Successful /api/chain/resolve payload (subset used by UI). */
export interface ChainResolved {
  index: string;
  atmStrike: number;
  spotLtp: number;
  step: number;
  optionSegment: number;
  optionSeries?: string;
  optionSymbol?: string;
  expiryApi?: string;
  instrumentMap: Record<string, ChainInstrumentRow>;
  /** Strikes resolved each side of ATM (±chainWings steps); see chainWingsCap. */
  chainWings?: number;
  /** Server clamp from XTS_CHAIN_WINGS_MAX — requested wings cannot exceed this. */
  chainWingsCap?: number;
  spotSegment: number;
  spotToken: number;
  /** Previous session close from broker quote @ resolve (fills TopBar until stream sends Touchline.Close). */
  spotPrevClose?: number | null;
  /** Gateway % vs prev close @ resolve — prefer live (LTP − ref) / ref in UI. */
  spotChangePct?: number | null;
  /** Session open when prev close unavailable in JSON. */
  spotDayOpen?: number | null;
  /** Exchange day high/low from broker quote @ resolve (TopBar prefers stream Touchline thereafter). */
  spotDayHigh?: number | null;
  spotDayLow?: number | null;
  vixInstrumentId: number;
  vixSegment?: number;
  /** India VIX previous close / open from REST @ chain resolve when stream omits Touchline. */
  vixPrevClose?: number | null;
  vixDayOpen?: number | null;
  spotQuoteMessageCode?: number | null;
  spotQuoteNote?: string | null;
  warnings?: Array<{ strike?: number; error?: string }>;
}

export type ChainResolveResponse = ({ ok: true } & ChainResolved) | { ok: false; error?: string };

export interface ExpiryRow {
  label: string;
  api: string;
}

export type ChainExpiriesResponse =
  | ({ ok: true } & {
      expiries: ExpiryRow[];
      strikeFilterApplied?: boolean;
      strikeFilterEmpty?: boolean;
      expiryFetchNotes?: string[];
    })
  | { ok: false; error?: string };
