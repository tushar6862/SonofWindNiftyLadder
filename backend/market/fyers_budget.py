"""
Fyers Standard (free) data-API budget.

Prime is off, so Quotes + History share one bucket: 5/sec, 50/min, 5000/day.
This gate stops at 4/sec, 8/min and 1500/day. A fifth call in the same second,
or a 50th in the same minute, never leaves the process. Crossing Fyers' own
per-minute cap more than three times blocks the account for the rest of the day.
The websocket does not spend this bucket, so live LTP stays on the socket.

This gate keeps REST far under those caps. Candles are reused from disk, and
from Redis when REDIS_URL is up, so VWAP and RSI share one 1-minute pull.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
_CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
_USAGE_PATH = _CACHE_DIR / "fyers_usage.json"
_CANDLE_DIR = _CACHE_DIR / "fyers_candles"

# Official Standard data API. Three minute-cap breaches block the rest of the day.
_OFFICIAL_SEC = 5
_OFFICIAL_MIN = 50
_OFFICIAL_DAY = 5000
# Stop one step inside those numbers. Env cannot raise them past the free plan.
_SEC_CAP = min(4, max(1, int(os.environ.get("FYERS_REST_SEC_CAP", "4") or "4")))
_MIN_CAP = min(40, max(1, int(os.environ.get("FYERS_REST_MIN_CAP", "8") or "8")))
_DAY_CAP = min(4500, max(50, int(os.environ.get("FYERS_REST_DAY_CAP", "1500") or "1500")))
_KEEP_DAYS = 40

_lock = threading.Lock()
_block_until = 0.0
_warned = False
_sec_key = ""
_sec_count = 0
_redis: Any = None
_redis_tried = False


def _env(key: str, default: str = "") -> str:
    return str(os.environ.get(key) or default).strip()


def _now() -> datetime:
    return datetime.now(IST)


def _day_key() -> str:
    return _now().strftime("%Y-%m-%d")


def _minute_key() -> str:
    return _now().strftime("%Y-%m-%dT%H:%M")


def _second_key() -> str:
    return _now().strftime("%Y-%m-%dT%H:%M:%S")


def market_open(now: datetime | None = None) -> bool:
    """NSE cash session. Holidays still count as open; one extra pull is cheap."""
    cur = now or _now()
    if cur.weekday() >= 5:
        return False
    mins = cur.hour * 60 + cur.minute
    return (9 * 60 + 15) <= mins <= (15 * 60 + 31)


def history_max_age(resolution: str) -> float:
    """How long a candle pull stays fresh. Closed bars do not need a faster poll."""
    try:
        tf = int(str(resolution or "1").strip() or "1")
    except Exception:
        tf = 1
    tf = max(1, tf)
    return max(50.0, float(tf) * 60.0 - 8.0)


def _blank_usage() -> dict[str, Any]:
    return {
        "day": _day_key(),
        "total": 0,
        "history": 0,
        "quotes": 0,
        "minute": _minute_key(),
        "minuteCount": 0,
    }


def _roll(data: dict[str, Any]) -> dict[str, Any]:
    day = _day_key()
    if str(data.get("day") or "") != day:
        data = _blank_usage()
    minute = _minute_key()
    if str(data.get("minute") or "") != minute:
        data["minute"] = minute
        data["minuteCount"] = 0
    return data


def _read_usage() -> dict[str, Any]:
    try:
        if _USAGE_PATH.is_file():
            raw = json.loads(_USAGE_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return _roll(raw)
    except Exception:
        pass
    return _blank_usage()


def _write_usage(data: dict[str, Any]) -> None:
    try:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        _USAGE_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass
    _mirror_usage(data)


def _redis_client() -> Any:
    global _redis, _redis_tried
    if _redis_tried:
        return _redis
    _redis_tried = True
    url = _env("REDIS_URL")
    if not url:
        return None
    try:
        import redis

        client = redis.from_url(url, decode_responses=True)
        client.ping()
        _redis = client
    except Exception:
        _redis = None
    return _redis


def _prefix() -> str:
    return _env("REDIS_KEY_PREFIX", "sow") or "sow"


def _mirror_usage(data: dict[str, Any]) -> None:
    client = _redis_client()
    if client is None:
        return
    try:
        key = f"{_prefix()}:fyers:usage:{data.get('day')}"
        client.hset(
            key,
            mapping={
                "total": int(data.get("total") or 0),
                "history": int(data.get("history") or 0),
                "quotes": int(data.get("quotes") or 0),
                "minute": str(data.get("minute") or ""),
                "minuteCount": int(data.get("minuteCount") or 0),
                "dayCap": _DAY_CAP,
                "minuteCap": _MIN_CAP,
            },
        )
        client.expire(key, 36 * 3600)
    except Exception:
        pass


def _pin(field: str) -> None:
    with _lock:
        data = _read_usage()
        if field == "day":
            data["total"] = max(int(data.get("total") or 0), _DAY_CAP)
        else:
            data["minute"] = _minute_key()
            data["minuteCount"] = max(int(data.get("minuteCount") or 0), _MIN_CAP)
        _write_usage(data)


def note_rate_limit(status: int, message: str) -> None:
    """Fyers said stop. Hold REST until the window clears."""
    global _block_until
    low = str(message or "").lower()
    limited = int(status) == 429 or "limit" in low or "quota" in low
    if not limited:
        return
    if "day" in low:
        _pin("day")
        _block_until = time.time() + 3600.0
        _log.warning("Fyers daily data cap hit — REST paused, cache and socket stay on")
        return
    _pin("minute")
    _block_until = time.time() + 90.0
    _log.warning("Fyers minute data cap hit — REST paused for 90s")


def try_consume(kind: str) -> bool:
    """Reserve one Quotes or History call. False means serve cache, do not call Fyers."""
    global _warned, _sec_key, _sec_count
    if time.time() < _block_until:
        return False
    kind_key = "quotes" if str(kind) == "quotes" else "history"
    with _lock:
        second = _second_key()
        if second != _sec_key:
            _sec_key = second
            _sec_count = 0
        if _sec_count >= _SEC_CAP:
            return False
        data = _read_usage()
        total = int(data.get("total") or 0)
        minute_count = int(data.get("minuteCount") or 0)
        if total >= _DAY_CAP or minute_count >= _MIN_CAP:
            if not _warned:
                _warned = True
                _log.info(
                    "Fyers free REST held at %s/%s today (%s/min) — serving cache",
                    total,
                    _DAY_CAP,
                    minute_count,
                )
            return False
        _warned = False
        _sec_count += 1
        data["total"] = total + 1
        data["minuteCount"] = minute_count + 1
        data[kind_key] = int(data.get(kind_key) or 0) + 1
        _write_usage(data)
        return True


def snapshot() -> dict[str, Any]:
    with _lock:
        data = _read_usage()
    return {
        "plan": "standard",
        "officialSecCap": _OFFICIAL_SEC,
        "officialMinCap": _OFFICIAL_MIN,
        "officialDayCap": _OFFICIAL_DAY,
        "secCap": _SEC_CAP,
        "dayUsed": int(data.get("total") or 0),
        "dayCap": _DAY_CAP,
        "minuteUsed": int(data.get("minuteCount") or 0),
        "minuteCap": _MIN_CAP,
        "history": int(data.get("history") or 0),
        "quotes": int(data.get("quotes") or 0),
        "redis": _redis_client() is not None,
        "held": time.time() < _block_until or int(data.get("total") or 0) >= _DAY_CAP,
    }


def _candle_name(symbol: str, resolution: str) -> str:
    raw = f"{symbol}_{resolution}"
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in raw)
    return safe[:120] or "candle"


def _clip(bars: list[dict[str, Any]], from_epoch: int, to_epoch: int) -> list[dict[str, Any]]:
    start = int(from_epoch)
    end = int(to_epoch) + 120
    out = [b for b in bars if start <= int(b.get("time") or 0) <= end]
    out.sort(key=lambda b: int(b.get("time") or 0))
    return out


def _read_disk_candles(symbol: str, resolution: str) -> dict[str, Any] | None:
    path = _CANDLE_DIR / f"{_candle_name(symbol, resolution)}.json"
    try:
        if not path.is_file():
            return None
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(raw, dict) or not isinstance(raw.get("bars"), list):
        return None
    return raw


def _read_redis_candles(symbol: str, resolution: str) -> dict[str, Any] | None:
    client = _redis_client()
    if client is None:
        return None
    try:
        raw = client.get(f"{_prefix()}:fyers:candles:{_candle_name(symbol, resolution)}")
    except Exception:
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("bars"), list):
        return None
    return data


def _pick_candle_doc(symbol: str, resolution: str) -> dict[str, Any] | None:
    disk = _read_disk_candles(symbol, resolution)
    red = _read_redis_candles(symbol, resolution)
    if disk is None:
        return red
    if red is None:
        return disk
    if float(red.get("fetchedAt") or 0) >= float(disk.get("fetchedAt") or 0):
        return red
    return disk


def cached_history(symbol: str, resolution: str, from_epoch: int, to_epoch: int) -> list[dict[str, Any]]:
    doc = _pick_candle_doc(symbol, resolution)
    if not doc:
        return []
    bars = [b for b in doc.get("bars") or [] if isinstance(b, dict)]
    return _clip(bars, from_epoch, to_epoch)


def history_is_fresh(symbol: str, resolution: str) -> bool:
    """True when the last pull can be reused and Fyers must not be called."""
    doc = _pick_candle_doc(symbol, resolution)
    if not doc or not doc.get("bars"):
        return False
    if not market_open():
        return True
    age = time.time() - float(doc.get("fetchedAt") or 0.0)
    return age < history_max_age(resolution)


def store_history(symbol: str, resolution: str, bars: list[dict[str, Any]]) -> None:
    if not bars:
        return
    prev = _pick_candle_doc(symbol, resolution) or {}
    merged: dict[int, dict[str, Any]] = {}
    for row in prev.get("bars") or []:
        if isinstance(row, dict) and int(row.get("time") or 0) > 0:
            merged[int(row["time"])] = row
    for row in bars:
        if isinstance(row, dict) and int(row.get("time") or 0) > 0:
            merged[int(row["time"])] = row
    cutoff = int(time.time()) - _KEEP_DAYS * 86400
    kept = [merged[k] for k in sorted(merged) if k >= cutoff]
    doc = {"symbol": symbol, "resolution": str(resolution), "fetchedAt": time.time(), "bars": kept}
    try:
        _CANDLE_DIR.mkdir(parents=True, exist_ok=True)
        path = _CANDLE_DIR / f"{_candle_name(symbol, resolution)}.json"
        path.write_text(json.dumps(doc), encoding="utf-8")
    except Exception:
        pass
    client = _redis_client()
    if client is None:
        return
    try:
        client.setex(
            f"{_prefix()}:fyers:candles:{_candle_name(symbol, resolution)}",
            8 * 3600,
            json.dumps(doc, separators=(",", ":")),
        )
    except Exception:
        pass


def aggregate_1m(bars: list[dict[str, Any]], tf_minutes: int) -> list[dict[str, Any]]:
    """Clock-aligned OHLC. Supported TFs divide the IST offset, so epoch buckets match."""
    tf = max(1, int(tf_minutes))
    ordered = sorted(bars, key=lambda b: int(b.get("time") or 0))
    if tf <= 1:
        return ordered
    span = tf * 60
    buckets: dict[int, dict[str, Any]] = {}
    for bar in ordered:
        try:
            stamp = int(bar.get("time") or 0)
            high = float(bar.get("high") or 0.0)
            low = float(bar.get("low") or 0.0)
            close = float(bar.get("close") or 0.0)
            opened = float(bar.get("open") or 0.0)
            volume = float(bar.get("volume") or 0.0)
        except Exception:
            continue
        if stamp <= 0 or close <= 0:
            continue
        key = stamp - (stamp % span)
        row = buckets.get(key)
        if row is None:
            buckets[key] = {
                "time": key,
                "open": opened if opened > 0 else close,
                "high": high if high > 0 else close,
                "low": low if low > 0 else close,
                "close": close,
                "volume": volume,
            }
            continue
        row["high"] = max(float(row["high"]), high if high > 0 else close)
        row["low"] = min(float(row["low"]), low if low > 0 else close)
        row["close"] = close
        row["volume"] = float(row["volume"]) + volume
    return [buckets[k] for k in sorted(buckets)]
