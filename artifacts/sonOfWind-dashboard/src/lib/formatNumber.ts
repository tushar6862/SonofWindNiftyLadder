const LOCALE = "en-IN";

type FmtOpts = {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
};

function fmtLocale(value: number, opts?: FmtOpts): string {
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: opts?.minimumFractionDigits ?? 0,
    maximumFractionDigits: opts?.maximumFractionDigits ?? 2,
  });
}

/** Generic number with thousand separators (en-IN). */
export function fmtNum(value: number | null | undefined, opts?: FmtOpts): string {
  if (value == null) return "—";
  // Defensive: sometimes upstream data can accidentally be an array (e.g. [930.2, 0, 0...]),
  // which would render as "930.20,0.00,0.00" via Array.toLocaleString. Pick first valid number.
  const normalize = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v.replace(/,/g, "").trim());
      return Number.isFinite(n) ? n : null;
    }
    if (Array.isArray(v)) {
      for (const it of v) {
        const n = normalize(it);
        if (n != null) return n;
      }
      return null;
    }
    return null;
  };
  const n = normalize(value as unknown);
  if (n == null) return "—";
  return fmtLocale(n, opts);
}

/** LTP, Mace, ATP, avg price — 2 decimals + separators. */
export function fmtPrice(value: number | null | undefined): string {
  return fmtNum(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Qty — integer with separators. */
export function fmtQty(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Math.round(Number(value)).toLocaleString(LOCALE);
}

/** PnL / MTM — signed, 2 decimals + separators. */
export function fmtPnl(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  const body = fmtLocale(Math.abs(n), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return body;
}

export const fmtMtm = fmtPnl;

/** Percentage suffix. */
export function fmtPct(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return `${fmtLocale(Number(value), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}%`;
}

/** Margin chips: Lakh / Cr with separators on the numeric part. */
export function fmtInrShort(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e7) {
    const scaled = abs / 1e7;
    const d = abs >= 1e8 ? 1 : 2;
    return `${sign}${fmtLocale(scaled, { minimumFractionDigits: d, maximumFractionDigits: d })} Cr`;
  }
  if (abs >= 1e5) {
    const scaled = abs / 1e5;
    const d = abs >= 1e6 ? 1 : 2;
    return `${sign}${fmtLocale(scaled, { minimumFractionDigits: d, maximumFractionDigits: d })} Lakh`;
  }
  return `${sign}${Math.round(abs).toLocaleString(LOCALE)}`;
}
