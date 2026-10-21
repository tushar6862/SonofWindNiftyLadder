"""
1-minute Fast level: the open of the 09:20 IST cash candle.

The selected index (Nifty, Bank Nifty, or Sensex) supplies its own spot
candles. The trade level is that candle's open. High, low, and close are
printed with it and are not part of the cross.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from market.nifty_vwap import (
    _as_float,
    _in_cash_window,
    _is_closed,
    _label,
    _minute_dt,
    _px2,
    _spot_symbol,
    normalize_index,
    select_session_date,
    signal_for,
    signal_label,
)

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
OPEN_MINUTE = (9, 20)
_MISS_TTL_SEC = 20.0

_CACHE: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _session_bars(bars: list[dict[str, Any]]) -> dict[date, dict[datetime, dict[str, float | None]]]:
    by_day: dict[date, dict[datetime, dict[str, float | None]]] = {}
    for bar in bars or []:
        minute = _minute_dt(bar.get("time") or 0)
        if minute is None or not _in_cash_window(minute):
            continue
        opened = _as_float(bar.get("open"))
        close = _as_float(bar.get("close"))
        if opened is None or opened <= 0:
            continue
        slot = by_day.setdefault(minute.date(), {})
        slot[minute] = {
            "open": opened,
            "high": _as_float(bar.get("high")),
            "low": _as_float(bar.get("low")),
            "close": close if close is not None and close > 0 else opened,
        }
    return by_day


def _px_or_none(value: float | None) -> float | None:
    if value is None:
        return None
    return _px2(float(value))


def build_open920(
    bars: list[dict[str, Any]],
    now: datetime,
    symbol: str = "",
    label: str = "Nifty",
    index_key: str = "NIFTY",
) -> dict[str, Any]:
    days = _session_bars(bars)
    session = select_session_date(now, set(days))
    if session is None:
        return {
            "ok": False,
            "index": index_key,
            "error": f"No {label} cash-session candles from Fyers yet.",
            "source": "fyers",
            "futureSymbol": symbol,
        }
    day = days.get(session, {})
    hit_minute = None
    hit = None
    for minute, row in day.items():
        if (minute.hour, minute.minute) == OPEN_MINUTE:
            hit_minute = minute
            hit = row
            break
    if hit is None or hit_minute is None:
        waiting = session == now.date() and (now.hour, now.minute) < (9, 21)
        return {
            "ok": False,
            "index": index_key,
            "waiting": waiting,
            "error": (
                f"{label} 9:20 open has not printed yet."
                if waiting
                else f"{label} 9:20 candle is missing for {session.isoformat()}."
            ),
            "source": "fyers",
            "sessionDate": session.isoformat(),
            "futureSymbol": symbol,
        }
    closed = [minute for minute in day if _is_closed(minute, now)]
    last = max(closed) if closed else None
    last_row = day[last] if last is not None else hit
    last_close = float(last_row["close"])
    level = float(hit["open"])
    signal = signal_for(last_close, level)
    return {
        "ok": True,
        "index": index_key,
        "source": "fyers",
        "sessionDate": session.isoformat(),
        "futureSymbol": symbol,
        "open920": _px2(level),
        "high920": _px_or_none(hit.get("high")),
        "low920": _px_or_none(hit.get("low")),
        "close920": _px_or_none(hit.get("close")),
        "minute": "09:20",
        "lastClose": _px2(last_close),
        "lastMinute": last.strftime("%H:%M") if last is not None else hit_minute.strftime("%H:%M"),
        "signal": signal,
        "signalLabel": signal_label(signal),
    }


def _compute(now: datetime, index_key: str = "NIFTY") -> dict[str, Any]:
    from market.rsi_band import _fetch_fyers_history

    key = normalize_index(index_key)
    symbol = _spot_symbol(key)
    label = _label(key)
    now_epoch = int(now.timestamp())
    start_epoch = int((now - timedelta(days=5)).timestamp())
    bars = _fetch_fyers_history(symbol, "1", start_epoch, now_epoch)
    if not bars:
        return {
            "ok": False,
            "index": key,
            "error": f"Fyers {label} spot history is unavailable.",
            "source": "fyers",
            "futureSymbol": symbol,
        }
    return build_open920(bars, now, symbol=symbol, label=label, index_key=key)


def get_index_open920(index_key: str = "NIFTY") -> dict[str, Any]:
    """Cached 09:20 open for the top-bar index. Today's open is fetched once."""
    key = normalize_index(index_key)
    now = datetime.now(IST)
    today = now.date().isoformat()
    with _lock:
        bucket = _CACHE.get(key) or {}
        cached = bucket.get("payload")
        age = time.time() - float(bucket.get("ts") or 0)
        if (
            isinstance(cached, dict)
            and cached.get("ok")
            and cached.get("sessionDate") == today
            and isinstance(cached.get("open920"), (int, float))
        ):
            return cached
        if isinstance(cached, dict) and not cached.get("ok") and age < _MISS_TTL_SEC:
            return cached
        payload = _compute(now, key)
        if payload.get("ok"):
            _CACHE[key] = {"ts": time.time(), "payload": payload}
            return payload
        if isinstance(cached, dict) and cached.get("ok") and cached.get("sessionDate") == today:
            _log.info("%s 9:20 refresh kept the last open: %s", _label(key), payload.get("error"))
            return cached
        _CACHE[key] = {"ts": time.time(), "payload": payload}
        return payload


def _self_check() -> None:
    day = datetime(2026, 10, 21, 9, 25, tzinfo=IST)

    def bar(minute: int, open_px: float, high: float, low: float, close: float) -> dict[str, Any]:
        stamp = int(day.replace(hour=9, minute=minute, second=0, microsecond=0).timestamp())
        return {"time": stamp, "open": open_px, "high": high, "low": low, "close": close, "volume": 10}

    bars = [
        bar(15, 25000.0, 25010.0, 24990.0, 25005.0),
        bar(20, 25020.5, 25040.0, 25018.0, 25030.0),
        bar(21, 25030.0, 25032.0, 25010.0, 25012.0),
    ]
    out = build_open920(bars, day, symbol="NSE:NIFTY50-INDEX", label="Nifty", index_key="NIFTY")
    if out.get("open920") != 25020.5:
        raise SystemExit(f"9:20 open {out.get('open920')} != 25020.5")
    if out.get("high920") != 25040.0 or out.get("low920") != 25018.0 or out.get("close920") != 25030.0:
        raise SystemExit(f"9:20 OHLC drifted: {out}")
    if out.get("signal") != "SELL_CE":
        raise SystemExit(f"close below the open must sell CE, got {out.get('signal')}")

    above = list(bars)
    above[-1] = dict(above[-1], close=25050.0)
    out_above = build_open920(above, day, index_key="NIFTY")
    if out_above.get("signal") != "SELL_PE":
        raise SystemExit(f"close above the open must sell PE, got {out_above.get('signal')}")

    early = build_open920(bars[:1], day.replace(minute=18), index_key="SENSEX", label="Sensex")
    if early.get("ok") or not early.get("waiting"):
        raise SystemExit(f"before 9:21 must wait: {early}")

    flat = [bar(20, 100.0, 101.0, 99.0, 100.0)]
    out_flat = build_open920(flat, day.replace(minute=22))
    if out_flat.get("signal") != "NONE":
        raise SystemExit("a close equal to the 9:20 open must be no trade")
    if _spot_symbol("SENSEX") != "BSE:SENSEX-INDEX":
        raise SystemExit("Sensex spot symbol drifted")
    print("open920 self-check ok")


if __name__ == "__main__":
    _self_check()
