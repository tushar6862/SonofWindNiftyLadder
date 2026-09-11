"""
NIFTY Ladder — 09:15 IST open-drive hint from the first 1-minute NIFTY bar.
Bias only (UP→PE, DOWN→CE, FLAT→none). Not an auto-entry.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from market.dada_range import (
    IST,
    _dt_to_minute_key,
    _rescale_bars_to_ltp,
    _session_start_ist,
    fetch_opening_1m_bars,
)


def build_open_drive_payload(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    live_ltp: float = 0.0,
) -> dict[str, Any]:
    now = datetime.now(IST)
    session = _session_start_ist(now)
    key_0915 = _dt_to_minute_key(session)
    closed = now >= session + timedelta(minutes=1)

    bars = fetch_opening_1m_bars(
        client,
        exchange_segment=int(exchange_segment),
        exchange_instrument_id=int(exchange_instrument_id),
    )
    if live_ltp and float(live_ltp) > 0 and bars:
        bars = _rescale_bars_to_ltp(bars, float(live_ltp))

    bar = next((b for b in bars if int(b.minute_key) == int(key_0915)), None)
    if bar is None and bars:
        bar = bars[0]

    open_px = round(float(bar.open), 2) if bar else None
    close_px = round(float(bar.close), 2) if bar else None
    high_px = round(float(bar.high), 2) if bar else None
    low_px = round(float(bar.low), 2) if bar else None

    bias = None
    suggest = None
    if closed and open_px is not None and close_px is not None:
        if close_px > open_px:
            bias = "UP"
            suggest = "PE"
        elif close_px < open_px:
            bias = "DOWN"
            suggest = "CE"
        else:
            bias = "FLAT"

    return {
        "ok": True,
        "ready": bool(closed and bar is not None),
        "closed": closed,
        "minuteKey": int(bar.minute_key) if bar else key_0915,
        "label": "09:15",
        "open": open_px,
        "high": high_px,
        "low": low_px,
        "close": close_px,
        "bias": bias,
        "suggest": suggest,
        "barsUsed": len(bars),
    }
