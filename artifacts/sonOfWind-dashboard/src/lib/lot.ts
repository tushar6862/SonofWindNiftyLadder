import type { IndexName } from "@/pages/Dashboard";

export const LOT_SIZE_BY_INDEX: Record<IndexName, number> = {
  SENSEX: 20,
  NIFTY: 65,
  BANKNIFTY: 30,
} as const;

export function lotSizeForIndex(index: IndexName): number {
  const n = LOT_SIZE_BY_INDEX[index as keyof typeof LOT_SIZE_BY_INDEX];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 65;
}

