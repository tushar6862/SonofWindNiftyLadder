"""Shared Fyers candle history. VWAP and CD read 1-minute bars through this."""
from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import requests

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")

_HIST_FAIL_UNTIL = 0.0
_HIST_FAIL_LOG_AT = 0.0


def _fyers_history_date(epoch: int) -> str:
    """date_format 1 requires YYYY-MM-DD in IST, not epoch seconds."""
    return datetime.fromtimestamp(int(epoch), IST).strftime("%Y-%m-%d")


def _fetch_fyers_history(symbol: str, resolution: str, from_epoch: int, to_epoch: int) -> list[dict[str, Any]]:
    """
    Fyers history, served from the shared disk/Redis candle cache when it is fresh.
    A network pull is one Standard-plan data call and is skipped once the free budget is held.
    """
    global _HIST_FAIL_UNTIL, _HIST_FAIL_LOG_AT
    from market.fyers_budget import cached_history, history_is_fresh, note_rate_limit, store_history, try_consume
    from market.fyers_ltp import access_token_header, has_access_token

    cached = cached_history(symbol, resolution, from_epoch, to_epoch)
    if history_is_fresh(symbol, resolution):
        return cached
    if not has_access_token() or time.time() < _HIST_FAIL_UNTIL:
        return cached
    hdr = access_token_header()
    if not hdr or not try_consume("history"):
        return cached

    url = "https://api-t1.fyers.in/data/history"
    params = {
        "symbol": symbol,
        "resolution": str(resolution),
        "date_format": "1",
        "range_from": _fyers_history_date(from_epoch),
        "range_to": _fyers_history_date(to_epoch),
        "cont_flag": "1",
    }
    try:
        r = requests.get(url, params=params, headers={"Authorization": hdr}, timeout=12)
        if r.status_code != 200:
            note_rate_limit(r.status_code, r.text[:300])
            # 429 means the data API is exhausted — back off long enough for the limit to clear.
            _HIST_FAIL_UNTIL = time.time() + (180.0 if r.status_code == 429 else 20.0)
            if time.time() - _HIST_FAIL_LOG_AT > 30.0:
                _HIST_FAIL_LOG_AT = time.time()
                _log.warning("Fyers history API returned %s — backing off", r.status_code)
            return cached
        data = r.json() if r.content else {}
        if not isinstance(data, dict) or data.get("s") != "ok":
            note_rate_limit(int(data.get("code") or 0) if isinstance(data, dict) else 0, str(data))
            _HIST_FAIL_UNTIL = time.time() + 20.0
            return cached
        _HIST_FAIL_UNTIL = 0.0
        raw_candles = data.get("candles") or []
        bars: list[dict[str, Any]] = []
        for c in raw_candles:
            if isinstance(c, (list, tuple)) and len(c) >= 5:
                bars.append({
                    "time": int(c[0]),
                    "open": float(c[1]),
                    "high": float(c[2]),
                    "low": float(c[3]),
                    "close": float(c[4]),
                    "volume": float(c[5]) if len(c) > 5 else 0.0,
                })
        if bars:
            store_history(symbol, resolution, bars)
            return cached_history(symbol, resolution, from_epoch, to_epoch)
        return cached
    except Exception as e:
        _HIST_FAIL_UNTIL = time.time() + 20.0
        if time.time() - _HIST_FAIL_LOG_AT > 30.0:
            _HIST_FAIL_LOG_AT = time.time()
            _log.warning("Fyers history API exception: %s", e)
        return cached
