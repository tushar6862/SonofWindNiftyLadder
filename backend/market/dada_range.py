"""
DADA strategy: first 15-minute (09:15–09:30 IST) spot HIGH / LOW.

Uses Symphony 1-minute OHLC, rescaled to live spot LTP when needed.
"""

from __future__ import annotations

import json
import logging
import re
import statistics
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")


@dataclass(frozen=True)
class OhlcBar:
    minute_key: int
    open: float
    high: float
    low: float
    close: float


def _session_start_ist(now: datetime | None = None) -> datetime:
    now = (now or datetime.now(IST)).astimezone(IST)
    return now.replace(hour=9, minute=15, second=0, microsecond=0)


def _opening_end_ist(now: datetime | None = None) -> datetime:
    now = (now or datetime.now(IST)).astimezone(IST)
    return now.replace(hour=9, minute=30, second=0, microsecond=0)


def _format_xts_time(dt: datetime) -> str:
    return dt.astimezone(IST).strftime("%b %d %Y %H%M%S")


def _minute_key_to_dt(minute_key: int) -> datetime | None:
    s = str(int(minute_key))
    if len(s) != 12:
        return None
    try:
        return datetime(
            int(s[0:4]),
            int(s[4:6]),
            int(s[6:8]),
            int(s[8:10]),
            int(s[10:12]),
            tzinfo=IST,
        )
    except Exception:
        return None


def _ohlc_epoch_to_minute_key(ts: float) -> int:
    """XTS OHLC BarTime is IST wall-clock stored as UTC epoch (vendor quirk)."""
    dt = datetime.utcfromtimestamp(float(ts))
    return int(dt.strftime("%Y%m%d%H%M"))


def _parse_pipe_ohlc_line(line: str) -> OhlcBar | None:
    line = line.strip().strip(",")
    if not line:
        return None
    parts = [p.strip() for p in line.split("|")]
    if len(parts) < 5:
        return None
    try:
        ts_raw = parts[0].split()[0]
        ts = float(ts_raw)
        o = float(parts[1].replace(",", ""))
        h = float(parts[2].replace(",", ""))
        lo = float(parts[3].replace(",", ""))
        c = float(parts[4].replace(",", ""))
    except Exception:
        return None
    if not (h > 0 and lo > 0 and c > 0):
        return None
    if h < lo:
        h, lo = lo, h
    return OhlcBar(_ohlc_epoch_to_minute_key(ts), o, h, lo, c)


def _parse_pipe_ohlc_blob(text: str) -> list[OhlcBar]:
    out: list[OhlcBar] = []
    for segment in re.split(r"[,]+", text):
        bar = _parse_pipe_ohlc_line(segment)
        if bar is not None:
            out.append(bar)
    return out


def _candle_from_dict(obj: dict[str, Any]) -> OhlcBar | None:
    def f(*keys: str) -> float | None:
        for k in keys:
            if k in obj and obj[k] is not None:
                try:
                    return float(obj[k])
                except Exception:
                    continue
        return None

    h = f("High", "high", "h")
    lo = f("Low", "low", "l")
    c = f("Close", "close", "c")
    o = f("Open", "open", "o") or c
    if h is None or lo is None or c is None or not (h > 0 and lo > 0 and c > 0):
        return None
    if h < lo:
        h, lo = lo, h
    ts: float | None = None
    for k, v in obj.items():
        kn = str(k).lower()
        if "timestamp" in kn or "bartime" in kn or kn in ("t", "time"):
            if isinstance(v, (int, float)):
                ts = float(v)
                break
            if isinstance(v, str):
                m = re.search(r"(\d{9,11})", v)
                if m:
                    ts = float(m.group(1))
                    break
    if ts is None:
        return None
    return OhlcBar(_ohlc_epoch_to_minute_key(ts), float(o or c), float(h), float(lo), float(c))


def parse_ohlc_full(raw: Any) -> list[OhlcBar]:
    bars: list[OhlcBar] = []
    seen: set[int] = set()

    def add(bar: OhlcBar | None) -> None:
        if bar is None or bar.minute_key <= 0:
            return
        if bar.minute_key in seen:
            return
        seen.add(bar.minute_key)
        bars.append(bar)

    def visit(obj: Any, depth: int = 0) -> None:
        if depth > 16 or obj is None:
            return
        if isinstance(obj, str):
            s = obj.strip()
            if not s:
                return
            if s[0] in "{[":
                try:
                    visit(json.loads(s), depth + 1)
                except Exception:
                    pass
                return
            if "|" in s and ("," in s or re.search(r"\d\|\d", s)):
                for bar in _parse_pipe_ohlc_blob(s):
                    add(bar)
                return
            for line in re.split(r"[\r\n]+", s):
                add(_parse_pipe_ohlc_line(line))
            return
        if isinstance(obj, dict):
            dr = obj.get("dataReponse") or obj.get("dataResponse") or obj.get("DataResponse")
            if isinstance(dr, str) and "|" in dr:
                for bar in _parse_pipe_ohlc_blob(dr):
                    add(bar)
            if any(k in obj for k in ("High", "high", "h", "Close", "close", "c")):
                add(_candle_from_dict(obj))
                return
            for k in ("dataReponse", "dataResponse", "DataResponse", "result", "Result", "listCandles", "candles"):
                if k in obj and not (
                    k in ("dataReponse", "dataResponse", "DataResponse") and isinstance(obj.get(k), str)
                ):
                    visit(obj[k], depth + 1)
            for v in obj.values():
                if isinstance(v, (dict, list, str)):
                    visit(v, depth + 1)
            return
        if isinstance(obj, list):
            for item in obj:
                visit(item, depth + 1)

    visit(raw)
    bars.sort(key=lambda b: b.minute_key)
    return bars


def _rescale_bars_to_ltp(bars: list[OhlcBar], live_ltp: float) -> list[OhlcBar]:
    if not bars or not (live_ltp > 0):
        return bars
    recent = [b.close for b in bars[-24:] if b.close > 0]
    if not recent:
        return bars
    med = float(statistics.median(recent))
    if med <= 0:
        return bars
    ratio = med / float(live_ltp)
    if 0.985 <= ratio <= 1.015:
        return bars
    factor = float(live_ltp) / med
    if not (0.02 <= factor <= 50.0):
        return bars
    _log.info(
        "dada ohlc rescale med=%.2f ltp=%.2f factor=%.6f bars=%s",
        med,
        live_ltp,
        factor,
        len(bars),
    )
    return [
        OhlcBar(
            b.minute_key,
            float(b.open) * factor,
            float(b.high) * factor,
            float(b.low) * factor,
            float(b.close) * factor,
        )
        for b in bars
    ]


def fetch_opening_1m_bars(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
) -> list[OhlcBar]:
    """Fetch 1-minute OHLC covering 09:15–09:30 IST (or until now if still marking)."""
    now = datetime.now(IST)
    start = _session_start_ist(now)
    end = _opening_end_ist(now)
    if now < start:
        return []

    fetch_end = min(now, end + timedelta(minutes=1))
    merged: dict[int, OhlcBar] = {}
    try:
        raw = client.get_ohlc(
            exchange_segment=int(exchange_segment),
            exchange_instrument_id=int(exchange_instrument_id),
            start_time=_format_xts_time(start),
            end_time=_format_xts_time(fetch_end),
            compression_value=60,
        )
        if isinstance(raw, dict) and str(raw.get("type", "")).lower() == "error":
            _log.warning(
                "dada ohlc error iid=%s: %s",
                exchange_instrument_id,
                raw.get("description") or raw.get("message"),
            )
        else:
            for bar in parse_ohlc_full(raw):
                dt = _minute_key_to_dt(bar.minute_key)
                if dt is None:
                    continue
                # Include bars whose open is in [09:15, 09:29] (covers through 09:30 close)
                if start <= dt < end:
                    merged[bar.minute_key] = bar
    except Exception as e:
        _log.warning("dada ohlc fail iid=%s: %s", exchange_instrument_id, e)

    return sorted(merged.values(), key=lambda b: b.minute_key)


def _dt_to_minute_key(dt: datetime) -> int:
    return int(dt.astimezone(IST).strftime("%Y%m%d%H%M"))


def fetch_session_1m_bars(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
) -> list[OhlcBar]:
    """Fetch today's session 1-minute OHLC from 09:15 IST until now."""
    now = datetime.now(IST)
    day_start = _session_start_ist(now)
    if now < day_start:
        return []

    merged: dict[int, OhlcBar] = {}
    cursor = day_start
    while cursor < now:
        chunk_end = min(cursor + timedelta(hours=1), now)
        try:
            raw = client.get_ohlc(
                exchange_segment=int(exchange_segment),
                exchange_instrument_id=int(exchange_instrument_id),
                start_time=_format_xts_time(cursor),
                end_time=_format_xts_time(chunk_end),
                compression_value=60,
            )
            if isinstance(raw, dict) and str(raw.get("type", "")).lower() == "error":
                _log.warning(
                    "dada session ohlc error iid=%s: %s",
                    exchange_instrument_id,
                    raw.get("description") or raw.get("message"),
                )
            else:
                for bar in parse_ohlc_full(raw):
                    dt = _minute_key_to_dt(bar.minute_key)
                    if dt is None:
                        continue
                    if day_start <= dt <= now:
                        merged[bar.minute_key] = bar
        except Exception as e:
            _log.warning("dada session ohlc fail iid=%s: %s", exchange_instrument_id, e)
        cursor = chunk_end + timedelta(seconds=1)

    return sorted(merged.values(), key=lambda b: b.minute_key)


def _tf_bucket_open(dt: datetime, tf_minutes: int = 5) -> datetime | None:
    """Session-aligned bucket open from 09:15 IST."""
    dt = dt.astimezone(IST).replace(second=0, microsecond=0)
    start = _session_start_ist(dt)
    end = start.replace(hour=15, minute=30, second=0, microsecond=0)
    if dt < start or dt >= end:
        return None
    elapsed = int((dt - start).total_seconds() // 60)
    bucket = (elapsed // int(tf_minutes)) * int(tf_minutes)
    return start + timedelta(minutes=bucket)


def aggregate_1m_to_tf(bars_1m: list[OhlcBar], tf_minutes: int = 3) -> list[OhlcBar]:
    """Aggregate 1m OHLC into session-aligned TF bars from 09:15 IST."""
    tf = max(1, int(tf_minutes))
    buckets: dict[int, OhlcBar] = {}
    for b in bars_1m:
        dt = _minute_key_to_dt(b.minute_key)
        if dt is None:
            continue
        open_dt = _tf_bucket_open(dt, tf)
        if open_dt is None:
            continue
        key = _dt_to_minute_key(open_dt)
        cur = buckets.get(key)
        if cur is None:
            buckets[key] = OhlcBar(key, b.open, b.high, b.low, b.close)
        else:
            buckets[key] = OhlcBar(
                key,
                cur.open,
                max(cur.high, b.high),
                min(cur.low, b.low),
                b.close,
            )
    return sorted(buckets.values(), key=lambda x: x.minute_key)


def aggregate_1m_to_5m(bars_1m: list[OhlcBar]) -> list[OhlcBar]:
    return aggregate_1m_to_tf(bars_1m, 5)


def closed_tf_bars(bars: list[OhlcBar], tf_minutes: int = 3, now: datetime | None = None) -> list[OhlcBar]:
    """Keep only fully closed TF candles (open + tf_minutes <= now)."""
    tf = max(1, int(tf_minutes))
    now = (now or datetime.now(IST)).astimezone(IST)
    out: list[OhlcBar] = []
    for b in bars:
        start = _minute_key_to_dt(b.minute_key)
        if start is None:
            continue
        end = start + timedelta(minutes=tf)
        if end <= now:
            out.append(b)
    return out


def closed_5m_bars(bars: list[OhlcBar], now: datetime | None = None) -> list[OhlcBar]:
    return closed_tf_bars(bars, 5, now)


def build_dada_sl1m_payload(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    live_ltp: float = 0.0,
    after_minute_key: int = 0,
) -> dict[str, Any]:
    """Closed 1m spot bars for ORB primary SL."""
    bars_1m = fetch_session_1m_bars(
        client,
        exchange_segment=exchange_segment,
        exchange_instrument_id=exchange_instrument_id,
    )
    if live_ltp and float(live_ltp) > 0 and bars_1m:
        bars_1m = _rescale_bars_to_ltp(bars_1m, float(live_ltp))
    closed = closed_tf_bars(bars_1m, 1)
    after_k = int(after_minute_key or 0)
    if after_k > 0:
        closed = [b for b in closed if b.minute_key > after_k]

    return {
        "ok": True,
        "tfMinutes": 1,
        "oneMinuteCount": len(bars_1m),
        "closedCount": len(closed),
        "afterMinuteKey": after_k or None,
        "bars": [
            {
                "t": b.minute_key,
                "label": (
                    f"{str(b.minute_key)[8:10]}:{str(b.minute_key)[10:12]}"
                    if len(str(b.minute_key)) == 12
                    else str(b.minute_key)
                ),
                "o": round(b.open, 2),
                "h": round(b.high, 2),
                "l": round(b.low, 2),
                "c": round(b.close, 2),
            }
            for b in closed
        ],
    }


def build_dada_sl3m_payload(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    live_ltp: float = 0.0,
    after_minute_key: int = 0,
) -> dict[str, Any]:
    """Alias — DADA primary SL is 1m ORB close (kept for older callers)."""
    return build_dada_sl1m_payload(
        client,
        exchange_segment=exchange_segment,
        exchange_instrument_id=exchange_instrument_id,
        live_ltp=live_ltp,
        after_minute_key=after_minute_key,
    )


def build_dada_sl5m_payload(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    live_ltp: float = 0.0,
    after_minute_key: int = 0,
) -> dict[str, Any]:
    """Alias — DADA primary SL is 1m ORB close (kept for older callers)."""
    return build_dada_sl1m_payload(
        client,
        exchange_segment=exchange_segment,
        exchange_instrument_id=exchange_instrument_id,
        live_ltp=live_ltp,
        after_minute_key=after_minute_key,
    )


def build_dada_range_payload(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    live_ltp: float = 0.0,
) -> dict[str, Any]:
    now = datetime.now(IST)
    start = _session_start_ist(now)
    end = _opening_end_ist(now)

    if now < start:
        return {
            "ok": True,
            "ready": False,
            "frozen": False,
            "window": "09:15-09:30",
            "status": "PRE_OPEN",
            "barsUsed": 0,
            "high": None,
            "low": None,
            "range": None,
        }

    bars = fetch_opening_1m_bars(
        client,
        exchange_segment=exchange_segment,
        exchange_instrument_id=exchange_instrument_id,
    )
    rescaled = False
    if live_ltp and float(live_ltp) > 0 and bars:
        before = bars[-1].close if bars else 0.0
        bars = _rescale_bars_to_ltp(bars, float(live_ltp))
        after = bars[-1].close if bars else 0.0
        rescaled = abs(after - before) > 0.5

    high = max((float(b.high) for b in bars), default=0.0) if bars else 0.0
    low = min((float(b.low) for b in bars), default=0.0) if bars else 0.0
    if live_ltp and float(live_ltp) > 0 and now < end:
        # While still in the marking window, fold live spot into H/L
        high = max(high, float(live_ltp)) if high > 0 else float(live_ltp)
        low = min(low, float(live_ltp)) if low > 0 else float(live_ltp)

    frozen = now >= end
    valid = high > 0 and low > 0 and high >= low
    rng = {"high": round(high, 2), "low": round(low, 2), "gap": round(high - low, 2)} if valid else None

    return {
        "ok": True,
        "ready": bool(valid and (frozen or len(bars) > 0)),
        "frozen": frozen,
        "window": "09:15-09:30",
        "status": "FROZEN" if frozen else "MARKING",
        "barsUsed": len(bars),
        "rescaled": rescaled,
        "liveLtp": float(live_ltp) if live_ltp else None,
        "high": rng["high"] if rng else None,
        "low": rng["low"] if rng else None,
        "range": rng,
        "bars": [
            {
                "t": b.minute_key,
                "label": (
                    f"{str(b.minute_key)[8:10]}:{str(b.minute_key)[10:12]}"
                    if len(str(b.minute_key)) == 12
                    else str(b.minute_key)
                ),
                "o": round(b.open, 2),
                "h": round(b.high, 2),
                "l": round(b.low, 2),
                "c": round(b.close, 2),
            }
            for b in bars
        ],
    }
