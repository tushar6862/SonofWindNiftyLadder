/** Size and short-MTM helpers still used by the VWAP desk. */

export const SIZE_MULTS = [1, 2, 3] as const;
export type SizeMult = (typeof SIZE_MULTS)[number];
export type FlipSide = "CE" | "PE";

export function isSizeMult(value: number): value is SizeMult {
  return value === 1 || value === 2 || value === 3;
}

export function orderQuantity(qty: number, size: SizeMult): number {
  return qty * size;
}

/** Short MTM. Profit when premium falls. */
export function shortMtm(fill: number, live: number, qty: number): number {
  return (fill - live) * qty;
}
