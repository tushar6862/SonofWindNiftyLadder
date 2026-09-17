"""Pick display LTP from touchline (1501) vs depth (1502) feeds."""

from __future__ import annotations

import time
from typing import Any

# Same LastTradedPrice reprint (bid/ask 1501 snapshots) must not look like a new print.
_LTP_EPS = 1e-6
# Reject a *different* LTP only if its exchange time is clearly old (out-of-order replay).
# Spike prints often share the same integer LastTradedTime or a slightly older LTT than wall.
_STALE_SEC = 2.0


def exchange_print_ts(d: dict[str, Any]) -> float:
    """Exchange LastTradedTime only. 0 if the packet has no LTT (book-only)."""
    for key in ("exchange_ts", "LastTradedTime", "lastTradedTime"):
        try:
            v = float(d.get(key) or 0.0)
        except Exception:
            continue
        if v > 1e12:
            v /= 1000.0
        if v > 1e9:
            return v
    return 0.0


def print_ts_from_tick(d: dict[str, Any], wall: float | None = None) -> float:
    """Exchange LastTradedTime when present; else packet wall clock."""
    w = float(wall) if wall and wall > 0 else time.time()
    ex = exchange_print_ts(d)
    return ex if ex > 0 else w


def apply_feed_ltp(
    prev_ltp: float,
    prev_ts: float,
    new_ltp: float,
    new_ts: float,
    *,
    wall_ok: bool = True,
) -> tuple[float, float]:
    """Accept a new last-trade print. Book packets without LTT must not look like prints."""
    wall = time.time()
    if new_ltp <= 0:
        return float(prev_ltp or 0.0), float(prev_ts or 0.0)
    if prev_ltp <= 0:
        return float(new_ltp), float(new_ts or (wall if wall_ok else 0.0))
    if abs(float(new_ltp) - float(prev_ltp)) < _LTP_EPS:
        ts = float(prev_ts or 0.0)
        if new_ts > ts:
            ts = float(new_ts)
        return float(prev_ltp), ts
    if new_ts <= 0 and not wall_ok:
        return float(prev_ltp), float(prev_ts)
    # Drop delayed snapshots whose exchange time is older than the live print.
    if new_ts > 1e9 and prev_ts > 1e9 and (float(prev_ts) - float(new_ts)) > 0.25:
        return float(prev_ltp), float(prev_ts)
    # Never mix wall into stored LTT — that makes the next exchange print look "stale".
    if new_ts > 0:
        return float(new_ltp), float(new_ts)
    if wall_ok:
        return float(new_ltp), wall
    return float(new_ltp), float(prev_ts or 0.0)


def pick_ltp_for_display(
    ltp_1501: float,
    ltp_1502: float,
    ts_1501: float,
    ts_1502: float,
    now: float | None = None,
) -> float:
    """XTS Snap Quote LastTradedPrice is 1501. Depth (1502) is bid/ask only."""
    _ = now, ts_1501, ts_1502
    if ltp_1501 > 0:
        return float(ltp_1501)
    if ltp_1502 > 0:
        return float(ltp_1502)
    return 0.0
