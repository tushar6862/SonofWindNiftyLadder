"""
CD desk: SENSEX range from the last 4 closed 15-minute spot bars.

Bars open at 09:15 IST. The forming candle is never in the range.
HIGH is the max high of those 4 bars. LOW is the min low.
MID is (HIGH + LOW) / 2. HIGH − LOW under 50 is not a trade.
The fourth bar closes at 10:15, which is the first entry time.
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
    _minute_dt,
    _px2,
    _spot_symbol,
    select_session_date,
)

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
LOOKBACK = 4
TF_MINUTES = 15
MIN_GAP = 50.0
SESSION_OPEN = (9, 15)
_CACHE_TTL_SEC = 10.0
_CACHE: dict[str, Any] = {}
_lock = threading.Lock()


def _session_minutes(bars: list[dict[str, Any]]) -> dict[date, dict[datetime, dict[str, float]]]:
    by_day: dict[date, dict[datetime, dict[str, float]]] = {}
    for bar in bars or []:
        minute = _minute_dt(bar.get("time") or 0)
        if minute is None or not _in_cash_window(minute):
            continue
        high = _as_float(bar.get("high"))
        low = _as_float(bar.get("low"))
        close = _as_float(bar.get("close"))
        opened = _as_float(bar.get("open"))
        if close is None or close <= 0:
            continue
        if high is None or high <= 0:
            high = close
        if low is None or low <= 0:
            low = close
        if opened is None or opened <= 0:
            opened = close
        slot = by_day.setdefault(minute.date(), {})
        slot[minute] = {"open": opened, "high": high, "low": low, "close": close}
    return by_day


def _bucket_open(minute: datetime, tf_minutes: int = TF_MINUTES) -> datetime | None:
    start = minute.replace(hour=9, minute=15, second=0, microsecond=0)
    if minute < start:
        return None
    elapsed = int((minute - start).total_seconds() // 60)
    step = max(1, int(tf_minutes))
    bucket = (elapsed // step) * step
    return start + timedelta(minutes=bucket)


def _closed(bucket: datetime, now: datetime, tf_minutes: int = TF_MINUTES) -> bool:
    return now >= bucket + timedelta(minutes=max(1, int(tf_minutes)))


def score_close(kind: str, sold: float, cover: float, target_pct: float = 10.0) -> float:
    """Day-stop points for one full close. Trail is always 0."""
    if kind == "TRAIL":
        return 0.0
    if kind == "TARGET":
        limit = float(sold) * (1.0 - float(target_pct) / 100.0) + 1.0
        return 1.0 if float(cover) <= limit else 0.0
    if float(cover) > float(sold):
        return -0.5 if kind == "OPPOSITE" else -1.0
    return 0.0


def build_cd_range(
    bars: list[dict[str, Any]],
    now: datetime,
    lookback: int = LOOKBACK,
    tf_minutes: int = TF_MINUTES,
    min_gap: float = MIN_GAP,
) -> dict[str, Any]:
    """Last closed SENSEX spot bars. The forming bar is dropped."""
    lookback = max(1, int(lookback))
    tf_minutes = max(1, int(tf_minutes))
    min_gap = float(min_gap)
    now = now.astimezone(IST)
    days = _session_minutes(bars)
    session = select_session_date(now, set(days))
    symbol = _spot_symbol("SENSEX")
    if session is None:
        return {
            "ok": False,
            "index": "SENSEX",
            "error": "No Sensex cash-session candles from Fyers yet.",
            "source": "fyers",
            "futureSymbol": symbol,
            "tradable": False,
        }
    buckets: dict[datetime, dict[str, float]] = {}
    for minute, row in days.get(session, {}).items():
        bucket = _bucket_open(minute, tf_minutes)
        if bucket is None:
            continue
        cur = buckets.get(bucket)
        if cur is None:
            buckets[bucket] = dict(row)
            continue
        cur["high"] = max(cur["high"], row["high"])
        cur["low"] = min(cur["low"], row["low"])
        cur["close"] = row["close"]
    ordered = sorted(buckets)
    closed = [bucket for bucket in ordered if _closed(bucket, now, tf_minutes)]
    forming = next((bucket for bucket in ordered if not _closed(bucket, now, tf_minutes)), None)
    live = now.date() == session and now.weekday() < 5 and SESSION_OPEN <= (now.hour, now.minute) <= (15, 30)
    used = closed[-lookback:]
    open_min = 9 * 60 + 15 + lookback * tf_minutes
    base: dict[str, Any] = {
        "ok": True,
        "index": "SENSEX",
        "source": "fyers",
        "sessionDate": session.isoformat(),
        "futureSymbol": symbol,
        "lookback": lookback,
        "barMinutes": tf_minutes,
        "minGap": min_gap,
        "closedCount": len(closed),
        "liveSession": live,
        "firstEntry": f"{open_min // 60:02d}:{open_min % 60:02d}",
        "formingMinute": forming.strftime("%H:%M") if forming is not None else None,
        "tradable": False,
        "high": None,
        "low": None,
        "mid": None,
        "gap": None,
        "bars": [
            {
                "minute": bucket.strftime("%H:%M"),
                "high": _px2(buckets[bucket]["high"]),
                "low": _px2(buckets[bucket]["low"]),
                "close": _px2(buckets[bucket]["close"]),
            }
            for bucket in used
        ],
    }
    if len(used) < lookback:
        base["waiting"] = True
        base["error"] = (
            f"Need {lookback} closed {tf_minutes}-minute bars. First entry is {base['firstEntry']} IST."
        )
        return base
    high = max(buckets[bucket]["high"] for bucket in used)
    low = min(buckets[bucket]["low"] for bucket in used)
    gap = high - low
    base["high"] = _px2(high)
    base["low"] = _px2(low)
    base["mid"] = _px2((high + low) / 2.0)
    base["gap"] = _px2(gap)
    base["tradable"] = gap >= min_gap
    if gap < min_gap:
        base["error"] = f"HIGH − LOW is under {min_gap:g}. No trade."
    return base


def _compute(now: datetime, lookback: int = LOOKBACK, tf_minutes: int = TF_MINUTES, min_gap: float = MIN_GAP) -> dict[str, Any]:
    from market.rsi_band import _fetch_fyers_history

    symbol = _spot_symbol("SENSEX")
    now_epoch = int(now.timestamp())
    start_epoch = int((now - timedelta(days=5)).timestamp())
    bars = _fetch_fyers_history(symbol, "1", start_epoch, now_epoch)
    if not bars:
        return {
            "ok": False,
            "index": "SENSEX",
            "error": "Fyers Sensex spot history is unavailable.",
            "source": "fyers",
            "futureSymbol": symbol,
            "tradable": False,
        }
    return build_cd_range(bars, now, lookback, tf_minutes, min_gap)


def get_cd_range(lookback: int = LOOKBACK, tf_minutes: int = TF_MINUTES, min_gap: float = MIN_GAP) -> dict[str, Any]:
    """Cached SENSEX range for the saved timeframe, candle count, and gap."""
    lookback = max(1, int(lookback))
    tf_minutes = max(1, int(tf_minutes))
    min_gap = float(min_gap)
    key = f"{tf_minutes}:{lookback}:{min_gap:g}"
    now = datetime.now(IST)
    with _lock:
        rows = _CACHE.setdefault("rows", {})
        row = rows.get(key) if isinstance(rows, dict) else None
        cached = row.get("payload") if isinstance(row, dict) else None
        age = time.time() - float(row.get("ts") or 0) if isinstance(row, dict) else _CACHE_TTL_SEC
        if isinstance(cached, dict) and age < _CACHE_TTL_SEC:
            return cached
        try:
            payload = _compute(now, lookback, tf_minutes, min_gap)
        except Exception as exc:
            _log.warning("CD range failed: %s", exc)
            if isinstance(cached, dict) and cached.get("ok"):
                return cached
            payload = {
                "ok": False,
                "index": "SENSEX",
                "error": str(exc),
                "source": "fyers",
                "tradable": False,
            }
        if not isinstance(rows, dict):
            rows = {}
            _CACHE["rows"] = rows
        rows[key] = {"ts": time.time(), "payload": payload}
        return payload


def _minute_bar(day: datetime, hour: int, minute: int, high: float, low: float) -> dict[str, Any]:
    stamp = int(day.replace(hour=hour, minute=minute, second=0, microsecond=0).timestamp())
    close = (high + low) / 2.0
    return {"time": stamp, "open": low, "high": high, "low": low, "close": close, "volume": 1}


def _bucket(day: datetime, hour: int, minute: int, high: float, low: float, spike_at: int = 0) -> list[dict[str, Any]]:
    rows = []
    start = day.replace(hour=hour, minute=minute, second=0, microsecond=0)
    for i in range(TF_MINUTES):
        dt = start + timedelta(minutes=i)
        if i == spike_at:
            h, l = high, low
        else:
            mid = (high + low) / 2.0
            h, l = mid, mid
        rows.append(_minute_bar(day, dt.hour, dt.minute, h, l))
    return rows


def _self_check() -> None:
    day = datetime(2026, 10, 26, 9, 15, tzinfo=IST)
    bars: list[dict[str, Any]] = []
    bars += _bucket(day, 9, 15, 80100, 80000)
    bars += _bucket(day, 9, 30, 80200, 79950)
    bars += _bucket(day, 9, 45, 80150, 79900)
    bars += _bucket(day, 10, 0, 80300, 80050, spike_at=14)
    bars += _bucket(day, 10, 15, 90000, 10000)

    early = build_cd_range(bars, day.replace(hour=10, minute=14))
    if early.get("tradable") or early.get("closedCount") != 3:
        raise SystemExit(f"10:14 must wait on 3 closed bars: {early}")
    if early.get("high") is not None:
        raise SystemExit("forming 10:00 bar must not set HIGH before 10:15")

    ready = build_cd_range(bars, day.replace(hour=10, minute=15))
    if not ready.get("tradable") or ready.get("closedCount") != 4:
        raise SystemExit(f"10:15 must be tradable: {ready}")
    if ready.get("high") != 80300 or ready.get("low") != 79900:
        raise SystemExit(f"range drifted: {ready.get('high')} {ready.get('low')}")
    if ready.get("gap") != 400 or ready.get("mid") != 80100:
        raise SystemExit(f"gap/mid drifted: {ready}")
    if ready.get("formingMinute") != "10:15":
        raise SystemExit(f"forming candle leaked or missing: {ready.get('formingMinute')}")
    if any(row["high"] == 90000 for row in ready.get("bars") or []):
        raise SystemExit("forming wick entered the range")

    later = build_cd_range(bars, day.replace(hour=10, minute=20))
    if later.get("high") != 80300 or later.get("low") != 79900:
        raise SystemExit("live wick moved HIGH or LOW")

    tight = []
    tight += _bucket(day, 9, 15, 100, 80)
    tight += _bucket(day, 9, 30, 100, 80)
    tight += _bucket(day, 9, 45, 100, 80)
    tight += _bucket(day, 10, 0, 100, 80)
    under = build_cd_range(tight, day.replace(hour=10, minute=15))
    if under.get("tradable") or under.get("gap") != 20:
        raise SystemExit(f"gap under 50 must not trade: {under}")

    exact = []
    exact += _bucket(day, 9, 15, 150, 100)
    exact += _bucket(day, 9, 30, 150, 100)
    exact += _bucket(day, 9, 45, 150, 100)
    exact += _bucket(day, 10, 0, 150, 100)
    edge = build_cd_range(exact, day.replace(hour=10, minute=15))
    if not edge.get("tradable") or edge.get("gap") != 50:
        raise SystemExit(f"gap of 50 must trade: {edge}")

    if score_close("TARGET", 772.32, 766.10) != 0:
        raise SystemExit("772.32 covered at 766.10 scores 0")
    if score_close("TARGET", 100, 90) != 1 or score_close("TARGET", 100, 91) != 1:
        raise SystemExit("target slack failed")
    if score_close("TARGET", 100, 91.02) != 0:
        raise SystemExit("target past the one-point slack must score 0")
    if score_close("TRAIL", 100, 101) != 0:
        raise SystemExit("a losing trail scores 0")
    if score_close("OPPOSITE", 100, 101) != -0.5:
        raise SystemExit("a losing opposite break scores -0.5")
    if score_close("SL", 100, 112) != -1:
        raise SystemExit("a losing stop scores -1")
    if score_close("SQUARE", 100, 99) != 0:
        raise SystemExit("a winning square does not score +1")
    print("cd range self-check ok")


if __name__ == "__main__":
    _self_check()
