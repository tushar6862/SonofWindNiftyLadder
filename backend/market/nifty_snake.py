"""NIFTY Snake hedge lookup. Independent of Nifty Ladder."""

from __future__ import annotations

import re
from pathlib import Path

_MONTHS = {
    "JAN": 1,
    "FEB": 2,
    "MAR": 3,
    "APR": 4,
    "MAY": 5,
    "JUN": 6,
    "JUL": 7,
    "AUG": 8,
    "SEP": 9,
    "OCT": 10,
    "NOV": 11,
    "DEC": 12,
}


def expiry_dates(token: str) -> set[str]:
    text = (token or "").strip()
    out: set[str] = set()
    if not text:
        return out
    iso = re.search(r"(20\d{2})-(\d{2})-(\d{2})", text)
    if iso:
        out.add(f"{iso.group(1)}-{iso.group(2)}-{iso.group(3)}")
    named = re.search(r"(\d{1,2})\s*([A-Za-z]{3,9})\s*(20\d{2})", text)
    if named:
        mon = _MONTHS.get(named.group(2).upper()[:3])
        if mon:
            out.add(f"{named.group(3)}-{mon:02d}-{int(named.group(1)):02d}")
    return out


def _cache_files() -> list[Path]:
    cache = Path(__file__).resolve().parent.parent / "cache"
    if not cache.is_dir():
        return []
    files = list(cache.glob("instruments_master_*NSEFO*.txt"))
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return files[:3]


def list_hedge_candidates(
    *,
    expiry: str,
    option_type: str,
    spot: float,
    step: float = 50.0,
    min_points: float = 100.0,
    max_points: float = 3200.0,
) -> list[dict[str, int | float]]:
    """Far-OTM same-side NIFTY strikes for a ~3–4 Rs long hedge.

    CE is above spot, PE is below spot. Quotes are the caller's job.
    """
    side = str(option_type or "").strip().upper()
    if side not in ("CE", "PE"):
        raise ValueError("optionType must be CE or PE")
    if not (spot > 0):
        raise ValueError("spot required")
    dates = expiry_dates(expiry)
    if not dates:
        raise ValueError("Could not parse expiry")
    want_ot = "3" if side == "CE" else "4"
    step_n = step if step > 0 else 50.0
    out: list[dict[str, int | float]] = []
    seen: set[int] = set()

    for path in _cache_files():
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in raw.splitlines():
            if "|NIFTY|" not in line or "|OPTIDX|" not in line:
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 19:
                continue
            if parts[0].upper() not in ("NSEFO", "2"):
                continue
            if parts[2] not in ("2", "OPTIONS", "OPTION"):
                continue
            if parts[3].upper() != "NIFTY":
                continue
            if parts[18].upper() not in (want_ot, side):
                continue
            exp = parts[16].split("T", 1)[0]
            if exp not in dates:
                continue
            try:
                strike = int(round(float(parts[17])))
                iid = int(parts[1])
            except ValueError:
                continue
            if iid <= 0 or strike <= 0 or iid in seen:
                continue
            dist = (strike - spot) if side == "CE" else (spot - strike)
            if dist < min_points or dist > max_points:
                continue
            if abs(strike / step_n - round(strike / step_n)) > 0.01:
                continue
            seen.add(iid)
            out.append({"strike": strike, "exchangeInstrumentID": iid, "distance": round(dist, 2)})
        if len(out) >= 40:
            break

    out.sort(key=lambda row: float(row["distance"]))
    return out[:60]
