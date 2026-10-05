"""
Nifty cash-session VWAP, matched to the TradingView session line on Nifty spot.

Each 1-minute bar uses typical price (high + low + close) / 3. The weight is
that same Fyers Nifty spot candle's volume. A minute with no volume is left
out. Touchline AverageTradedPrice is not used.
"""
from __future__ import annotations

import logging
import math
import re
import threading
import time
from datetime import date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
SPOT_SYMBOL = "NSE:NIFTY50-INDEX"
SESSION_OPEN = (9, 15)
SESSION_LAST = (15, 29)
# 5 Oct 2026, 14:00 IST. Spot-volume hlc3 prints 22511.56, the chart line.
ANCHOR_MINUTE = (9, 52)
ANCHOR_HIGH = 22612.95
ANCHOR_LOW = 22607.15
ANCHOR_CLOSE = 22609.0
ANCHOR_VWAP = 22558.77
ANCHOR_TOLERANCE = 0.15

_CACHE: dict[str, Any] = {}
_CACHE_TTL_SEC = 12.0
_refresh_guard = threading.Lock()
_refreshing = False
_FRONT_CACHE: dict[str, Any] = {}


def typical_price(high: float | None, low: float | None, close: float | None) -> float | None:
    """(high + low + close) / 3. A missing high or low falls back to the close."""
    if close is None or not math.isfinite(close) or close <= 0:
        return None
    high_ok = high is not None and math.isfinite(high) and high > 0
    low_ok = low is not None and math.isfinite(low) and low > 0
    if not high_ok or not low_ok:
        return float(close)
    return (float(high) + float(low) + float(close)) / 3.0


def _px2(value: float) -> float:
    return round(float(value) + 1e-9, 2)


def signal_for(close: float | None, vwap: float | None) -> str:
    """Last closed spot close versus session VWAP. Equal or missing: no trade."""
    if close is None or vwap is None:
        return "NONE"
    if not math.isfinite(close) or not math.isfinite(vwap) or close <= 0 or vwap <= 0:
        return "NONE"
    c = _px2(close)
    v = _px2(vwap)
    if c > v:
        return "SELL_PE"
    if c < v:
        return "SELL_CE"
    return "NONE"


def signal_label(signal: str) -> str:
    if signal == "SELL_PE":
        return "Sell ATM PE"
    if signal == "SELL_CE":
        return "Sell ATM CE"
    return "No trade"


def _minute_dt(epoch: int) -> datetime | None:
    try:
        raw = int(epoch)
    except (TypeError, ValueError):
        return None
    if raw <= 0:
        return None
    # Fyers history stamps are epoch seconds. A millisecond stamp would land
    # centuries ahead and must not enter the session sum.
    if raw > 10_000_000_000:
        return None
    dt = datetime.fromtimestamp(raw, IST).replace(second=0, microsecond=0)
    return dt


def _in_cash_window(dt: datetime) -> bool:
    hm = (dt.hour, dt.minute)
    return SESSION_OPEN <= hm <= SESSION_LAST


def _is_closed(minute: datetime, now: datetime) -> bool:
    return now >= minute + timedelta(minutes=1)


def _as_float(value: Any) -> float | None:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num):
        return None
    return num


def _index_session_bars(bars: list[dict[str, Any]]) -> dict[date, dict[datetime, dict[str, float | None]]]:
    by_day: dict[date, dict[datetime, dict[str, float | None]]] = {}
    for bar in bars or []:
        minute = _minute_dt(bar.get("time") or 0)
        if minute is None or not _in_cash_window(minute):
            continue
        close = _as_float(bar.get("close"))
        if close is None or close <= 0:
            continue
        slot = by_day.setdefault(minute.date(), {})
        slot[minute] = {
            "high": _as_float(bar.get("high")),
            "low": _as_float(bar.get("low")),
            "close": close,
            "volume": _as_float(bar.get("volume")) or 0.0,
        }
    return by_day


def select_session_date(now: datetime, dates: set[date]) -> date | None:
    """Cash session resets at 09:15 IST. A live weekday uses that day only."""
    today = now.date()
    hm = (now.hour, now.minute)
    weekday = today.weekday() < 5
    if weekday and SESSION_OPEN <= hm <= (15, 30):
        return today if today in dates else None
    if weekday and hm > (15, 30) and today in dates:
        return today
    prior = sorted(d for d in dates if d < today)
    if prior:
        return prior[-1]
    if today in dates:
        return today
    return None


def accumulate_vwap(
    spot_by_minute: dict[datetime, dict[str, float | None]],
    fut_by_minute: dict[datetime, dict[str, float | None]],
    now: datetime,
) -> dict[str, Any]:
    """
    VWAP = sum(typical price × spot volume) / sum(spot volume).
    A minute with no spot volume is left out. The forming minute is
    reported separately and is not part of the signal VWAP.
    """
    minutes = sorted(set(spot_by_minute) | set(fut_by_minute))
    num = 0.0
    den = 0.0
    closed: list[dict[str, Any]] = []
    forming: dict[str, Any] | None = None

    for minute in minutes:
        spot = spot_by_minute.get(minute)
        if spot is None:
            continue
        typical = typical_price(spot.get("high"), spot.get("low"), spot.get("close"))
        if typical is None:
            continue
        fut_vol = float(spot.get("volume") or 0.0)
        row = {
            "minute": minute.strftime("%H:%M"),
            "epoch": int(minute.timestamp()),
            "high": spot.get("high"),
            "low": spot.get("low"),
            "close": float(spot["close"]),
            "typical": typical,
            "futVolume": fut_vol,
        }
        if not _is_closed(minute, now):
            forming = row
            continue
        if fut_vol > 0:
            num += typical * fut_vol
            den += fut_vol
        vwap = (num / den) if den > 0 else None
        row["vwap"] = _px2(vwap) if vwap is not None else None
        row["inSum"] = fut_vol > 0
        closed.append(row)

    vwap = (num / den) if den > 0 else None
    live_num, live_den = num, den
    if forming is not None and float(forming.get("futVolume") or 0.0) > 0:
        live_num += float(forming["typical"]) * float(forming["futVolume"])
        live_den += float(forming["futVolume"])
    live = (live_num / live_den) if live_den > 0 else vwap
    last = closed[-1] if closed else None
    last_close = float(last["close"]) if last else None
    signal = signal_for(last_close, vwap)
    return {
        "vwap": _px2(vwap) if vwap is not None else None,
        "liveVwap": _px2(live) if live is not None else None,
        "lastClose": _px2(last_close) if last_close is not None else None,
        "lastMinute": last["minute"] if last else None,
        "signal": signal,
        "signalLabel": signal_label(signal),
        "barsUsed": sum(1 for row in closed if row.get("inSum")),
        "formingDropped": forming is not None,
        "formingMinute": forming["minute"] if forming else None,
        "closed": closed,
        "sumTypicalVolume": num,
        "sumVolume": den,
    }


def anchor_check(closed: list[dict[str, Any]]) -> dict[str, Any] | None:
    """VWAP through the reference 09:52 candle, when that print is in the session."""
    hit = None
    for row in closed:
        high = row.get("high")
        low = row.get("low")
        close = row.get("close")
        if row.get("minute") != "09:52":
            continue
        if high is None or low is None or close is None:
            continue
        if (
            abs(float(high) - ANCHOR_HIGH) <= 0.02
            and abs(float(low) - ANCHOR_LOW) <= 0.02
            and abs(float(close) - ANCHOR_CLOSE) <= 0.02
        ):
            hit = row
            break
    if hit is None:
        return None
    vwap = hit.get("vwap")
    near = isinstance(vwap, (int, float)) and abs(float(vwap) - ANCHOR_VWAP) <= ANCHOR_TOLERANCE
    return {
        "minute": "09:52",
        "high": hit.get("high"),
        "low": hit.get("low"),
        "close": hit.get("close"),
        "vwap": vwap,
        "expected": ANCHOR_VWAP,
        "near": near,
    }


def build_vwap_from_candles(
    spot_bars: list[dict[str, Any]],
    fut_bars: list[dict[str, Any]],
    now: datetime,
    future_symbol: str = "",
    future_expiry: str = "",
) -> dict[str, Any]:
    spot_days = _index_session_bars(spot_bars)
    fut_days = _index_session_bars(fut_bars)
    session = select_session_date(now, set(spot_days))
    if session is None:
        return {
            "ok": False,
            "error": "No Nifty cash-session candles from Fyers yet.",
            "source": "fyers",
            "futureSymbol": future_symbol,
        }
    summed = accumulate_vwap(spot_days.get(session, {}), fut_days.get(session, {}), now)
    if summed["vwap"] is None:
        return {
            "ok": False,
            "error": "Nifty spot volume has not printed for this session.",
            "source": "fyers",
            "sessionDate": session.isoformat(),
            "futureSymbol": future_symbol,
            "futureExpiry": future_expiry,
        }
    anchor = anchor_check(summed["closed"])
    at_0952 = next((row for row in summed["closed"] if row.get("minute") == "09:52"), None)
    tail = []
    for row in summed["closed"][-12:]:
        tail.append(
            {
                "minute": row["minute"],
                "close": _px2(float(row["close"])),
                "vwap": row["vwap"],
                "futVolume": row["futVolume"],
            }
        )
    return {
        "ok": True,
        "source": "fyers",
        "sessionDate": session.isoformat(),
        "futureSymbol": future_symbol,
        "futureExpiry": future_expiry,
        "vwap": summed["vwap"],
        "liveVwap": summed["liveVwap"],
        "lastClose": summed["lastClose"],
        "lastMinute": summed["lastMinute"],
        "signal": summed["signal"],
        "signalLabel": summed["signalLabel"],
        "barsUsed": summed["barsUsed"],
        "formingDropped": summed["formingDropped"],
        "formingMinute": summed["formingMinute"],
        "tail": tail,
        "anchor": anchor,
        "at0952": (
            {
                "minute": "09:52",
                "high": at_0952.get("high"),
                "low": at_0952.get("low"),
                "close": _px2(float(at_0952["close"])),
                "vwap": at_0952.get("vwap"),
            }
            if at_0952
            else None
        ),
    }


def _master_text() -> str:
    from market.fyers_ltp import _master_paths

    paths = _master_paths()
    if not paths:
        return ""
    try:
        return paths[0].read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


def front_month_nifty_future(as_of: date, master_text: str | None = None) -> dict[str, str] | None:
    """Nearest NIFTY FUTIDX whose expiry is today or later. Not NIFTYNXT / FPI."""
    text = master_text if master_text is not None else _master_text()
    best: tuple[date, str] | None = None
    for line in text.splitlines():
        parts = line.split("|")
        if len(parts) < 17:
            continue
        if parts[5].strip().upper() != "FUTIDX":
            continue
        if parts[3].strip().upper() != "NIFTY":
            continue
        match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", parts[16].strip())
        if not match:
            continue
        expiry = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
        if expiry < as_of:
            continue
        symbol = parts[4].strip().upper()
        if not symbol.startswith("NIFTY") or not symbol.endswith("FUT"):
            continue
        if best is None or expiry < best[0]:
            best = (expiry, symbol)
    if best is None:
        return None
    expiry, symbol = best
    return {
        "symbol": f"NSE:{symbol}",
        "expiry": expiry.isoformat(),
        "tradingSymbol": symbol,
    }


def _resolve_front(as_of: date) -> dict[str, str] | None:
    key = as_of.isoformat()
    cached = _FRONT_CACHE.get(key)
    if isinstance(cached, dict) and cached.get("symbol"):
        return cached
    found = front_month_nifty_future(as_of)
    if found:
        _FRONT_CACHE.clear()
        _FRONT_CACHE[key] = found
    return found


def _compute(now: datetime) -> dict[str, Any]:
    from market.rsi_band import _fetch_fyers_history

    now_epoch = int(now.timestamp())
    start_epoch = int((now - timedelta(days=6)).timestamp())
    spot = _fetch_fyers_history(SPOT_SYMBOL, "1", start_epoch, now_epoch)
    if not spot:
        return {
            "ok": False,
            "error": "Fyers Nifty spot history is unavailable.",
            "source": "fyers",
            "futureSymbol": SPOT_SYMBOL,
        }
    return build_vwap_from_candles(spot, [], now, future_symbol=SPOT_SYMBOL)


def _schedule_refresh() -> None:
    global _refreshing
    with _refresh_guard:
        if _refreshing:
            return
        _refreshing = True

    def run() -> None:
        global _refreshing
        try:
            payload = _compute(datetime.now(IST))
            if payload.get("ok"):
                _CACHE["ts"] = time.time()
                _CACHE["payload"] = payload
            elif _CACHE.get("payload"):
                _log.info("Nifty VWAP refresh kept the last Fyers session: %s", payload.get("error"))
        finally:
            with _refresh_guard:
                _refreshing = False

    threading.Thread(target=run, name="nifty-vwap", daemon=True).start()


def get_nifty_vwap() -> dict[str, Any]:
    """Cached session VWAP. History refresh stays off the request after the first fill."""
    cached = _CACHE.get("payload")
    age = time.time() - float(_CACHE.get("ts") or 0)
    if isinstance(cached, dict) and cached.get("ok"):
        if age >= _CACHE_TTL_SEC:
            _schedule_refresh()
        return cached
    payload = _compute(datetime.now(IST))
    if payload.get("ok"):
        _CACHE["ts"] = time.time()
        _CACHE["payload"] = payload
        return payload
    if isinstance(cached, dict):
        stale = dict(cached)
        stale["stale"] = True
        return stale
    return payload


def _self_check() -> None:
    """Formula checks that do not need the network."""
    day = datetime(2026, 10, 5, 9, 53, tzinfo=IST)
    spot = []
    # Heavy spot volume sits on the lower bar, so VWAP is below the plain
    # average of the two typical prices. hlc3 of the first bar is 106.67.
    specs = ((15, 130.0, 90.0, 100.0, 90.0), (16, 210.0, 190.0, 200.0, 10.0))
    for minute, high, low, close, vol in specs:
        stamp = int(day.replace(hour=9, minute=minute).timestamp())
        spot.append({"time": stamp, "open": close, "high": high, "low": low, "close": close, "volume": vol})
    out = build_vwap_from_candles(spot, [], day.replace(minute=17), future_symbol=SPOT_SYMBOL)
    first_typical = (130.0 + 90.0 + 100.0) / 3.0
    expected = _px2((first_typical * 90.0 + 200.0 * 10.0) / 100.0)
    if out.get("vwap") != expected:
        raise SystemExit(f"weighted vwap {out.get('vwap')} != {expected}")
    if out.get("signal") != "SELL_PE":
        raise SystemExit(f"expected SELL_PE, got {out.get('signal')}")

    missing = list(spot)
    missing[0] = dict(missing[0])
    missing[0]["high"] = None
    out_missing = build_vwap_from_candles(missing, [], day.replace(minute=17))
    expected_missing = _px2((100.0 * 90.0 + 200.0 * 10.0) / 100.0)
    if out_missing.get("vwap") != expected_missing:
        raise SystemExit(f"missing-high vwap {out_missing.get('vwap')} != {expected_missing}")

    spot_zero = [dict(spot[0], volume=0), spot[1]]
    out_zero = build_vwap_from_candles(spot_zero, [], day.replace(minute=17))
    if out_zero.get("vwap") != _px2(200.0):
        raise SystemExit(f"zero-volume minute leaked into VWAP: {out_zero.get('vwap')}")

    forming_now = day.replace(minute=16, second=30)
    out_forming = build_vwap_from_candles(spot, [], forming_now)
    if out_forming.get("lastMinute") != "09:15" or out_forming.get("formingDropped") is not True:
        raise SystemExit(f"forming minute was not dropped: {out_forming.get('lastMinute')}")
    if out_forming.get("liveVwap") == out_forming.get("vwap"):
        raise SystemExit("forming spot volume should move the live VWAP")

    flat_stamp = int(day.replace(hour=9, minute=15).timestamp())
    flat_spot = [{"time": flat_stamp, "high": 100.0, "low": 100.0, "close": 100.0, "volume": 5}]
    out_flat = build_vwap_from_candles(flat_spot, [], day.replace(minute=16))
    if out_flat.get("signal") != "NONE":
        raise SystemExit("a close equal to VWAP must be no trade")

    master = (
        "NSEFO|1|1|NIFTYFPI|NIFTYFPI26OCTFUT|FUTIDX|x|1|1|1|1|1|1|1|1|Spot|2026-10-27T14:30:00|\n"
        "NSEFO|2|1|NIFTY|NIFTY26NOVFUT|FUTIDX|x|1|1|1|1|1|1|1|1|Spot|2026-11-24T14:30:00|\n"
        "NSEFO|3|1|NIFTY|NIFTY26OCTFUT|FUTIDX|x|1|1|1|1|1|1|1|1|Spot|2026-10-27T14:30:00|\n"
        "NSEFO|4|1|NIFTY|NIFTY26SEPFUT|FUTIDX|x|1|1|1|1|1|1|1|1|Spot|2026-09-29T14:30:00|\n"
    )
    front = front_month_nifty_future(date(2026, 10, 5), master)
    if not front or front["symbol"] != "NSE:NIFTY26OCTFUT":
        raise SystemExit(f"front month picked {front}")
    print("nifty vwap self-check ok")


if __name__ == "__main__":
    _self_check()
    payload = get_nifty_vwap()
    print(
        {
            "ok": payload.get("ok"),
            "error": payload.get("error"),
            "sessionDate": payload.get("sessionDate"),
            "futureSymbol": payload.get("futureSymbol"),
            "vwap": payload.get("vwap"),
            "liveVwap": payload.get("liveVwap"),
            "lastClose": payload.get("lastClose"),
            "lastMinute": payload.get("lastMinute"),
            "signal": payload.get("signal"),
            "barsUsed": payload.get("barsUsed"),
            "anchor": payload.get("anchor"),
            "at0952": payload.get("at0952"),
            "tail": payload.get("tail"),
        }
    )
