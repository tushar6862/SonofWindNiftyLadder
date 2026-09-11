"""Pick display LTP from touchline (1501) vs depth (1502) feeds."""

from __future__ import annotations

import time
from typing import Any

# Same LastTradedPrice reprint (bid/ask 1501 snapshots) must not look like a new print.
_LTP_EPS = 1e-6
# Reject a *different* LTP only if its exchange time is clearly old (out-of-order replay).
# Spike prints often share the same integer LastTradedTime or a slightly older LTT than wall.
_STALE_SEC = 2.0


def print_ts_from_tick(d: dict[str, Any], wall: float | None = None) -> float:
    """Exchange LastTradedTime when present; else packet wall clock."""
    w = float(wall) if wall and wall > 0 else time.time()
    for key in ("exchange_ts", "LastTradedTime", "lastTradedTime"):
        try:
            v = float(d.get(key) or 0.0)
        except Exception:
            continue
        if v > 1e12:
            v /= 1000.0
        if v > 1e9:
            return v
    return w


def apply_feed_ltp(
    prev_ltp: float,
    prev_ts: float,
    new_ltp: float,
    new_ts: float,
) -> tuple[float, float]:
    """Accept a new last-trade print. Reprints keep the old ts. Spikes must not freeze."""
    wall = time.time()
    if new_ltp <= 0:
        return float(prev_ltp or 0.0), float(prev_ts or 0.0)
    if prev_ltp <= 0:
        return float(new_ltp), float(new_ts or wall)
    if abs(float(new_ltp) - float(prev_ltp)) < _LTP_EPS:
        return float(prev_ltp), float(prev_ts or 0.0)
    if new_ts > 0 and prev_ts > 0 and (float(prev_ts) - float(new_ts)) > _STALE_SEC:
        return float(prev_ltp), float(prev_ts)
    return float(new_ltp), max(float(new_ts or 0.0), float(prev_ts or 0.0), wall)


def pick_ltp_for_display(
    ltp_1501: float,
    ltp_1502: float,
    ts_1501: float,
    ts_1502: float,
    now: float | None = None,
) -> float:
    """Newest print wins. 1501 (Snap Quote) on a tie. Depth 1502 covers spikes when touchline lags."""
    _ = now
    have1 = ltp_1501 > 0
    have2 = ltp_1502 > 0
    if have1 and not have2:
        return float(ltp_1501)
    if have2 and not have1:
        return float(ltp_1502)
    if not have1 and not have2:
        return 0.0
    if abs(float(ltp_1501) - float(ltp_1502)) < _LTP_EPS:
        return float(ltp_1501)
    if float(ts_1502) > float(ts_1501):
        return float(ltp_1502)
    return float(ltp_1501)
