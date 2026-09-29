"""
Wilder RSI(14) indicator engine for NIFTY spot.
Supports 1, 2, 3, 5, 10, 15, and 30-minute timeframes.
Fetches candles from Fyers (preferred for market data) with fallback to XTS.
Calculates confirmed candle RSI and live/forming candle projected RSI.
Detects CE_SELL (cross below 60) and PE_SELL (cross above 40) chart events.
"""
from __future__ import annotations

import logging
import math
import time
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import requests

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
RSI_PERIOD = 14
CE_CROSS_THRESHOLD = 60.0
PE_CROSS_THRESHOLD = 40.0
CE_ARM_THRESHOLD = 60.5
PE_ARM_THRESHOLD = 39.5
CE_AUTO_EXIT_THRESHOLD = 63.0
PE_AUTO_EXIT_THRESHOLD = 37.0

SUPPORTED_TIMEFRAMES = [1, 2, 3, 5, 10, 15, 30]

# Simple in-memory cache to avoid hammering APIs when polled every 5s
_CACHE: dict[int, dict[str, Any]] = {}  # tf_minutes -> {ts, payload}
_CACHE_TTL_SEC = 3.0


def compute_wilder_rsi_series(closes: list[float], period: int = RSI_PERIOD) -> tuple[list[float | None], float | None, float | None]:
    """
    Computes Wilder RSI(14) series given closing prices.
    Returns:
      - list of RSI values (None for index < period)
      - final smoothed avg_gain (for forming-candle projection)
      - final smoothed avg_loss (for forming-candle projection)
    """
    n = len(closes)
    if n <= period:
        return [None] * n, None, None

    rsi_series: list[float | None] = [None] * n
    changes = [closes[i] - closes[i - 1] for i in range(1, n)]

    # Initial average gain/loss for first 'period' bars
    initial_gains = [max(c, 0.0) for c in changes[:period]]
    initial_losses = [max(-c, 0.0) for c in changes[:period]]

    avg_gain = sum(initial_gains) / period
    avg_loss = sum(initial_losses) / period

    if avg_loss == 0.0:
        rsi_series[period] = 100.0 if avg_gain > 0 else 50.0
    else:
        rs = avg_gain / avg_loss
        rsi_series[period] = 100.0 - (100.0 / (1.0 + rs))

    # Wilder smoothing for subsequent bars
    for i in range(period + 1, n):
        c = changes[i - 1]
        gain = max(c, 0.0)
        loss = max(-c, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period

        if avg_loss == 0.0:
            rsi_val = 100.0 if avg_gain > 0 else 50.0
        else:
            rs = avg_gain / avg_loss
            rsi_val = 100.0 - (100.0 / (1.0 + rs))
        rsi_series[i] = round(rsi_val, 2)

    return rsi_series, avg_gain, avg_loss


def project_forming_rsi(
    last_avg_gain: float | None,
    last_avg_loss: float | None,
    last_confirmed_close: float,
    live_spot: float,
    period: int = RSI_PERIOD,
) -> float | None:
    """
    Projects Wilder RSI for the live/forming candle using live spot price.
    """
    if last_avg_gain is None or last_avg_loss is None or last_confirmed_close <= 0 or live_spot <= 0:
        return None

    change = live_spot - last_confirmed_close
    gain = max(change, 0.0)
    loss = max(-change, 0.0)

    proj_avg_gain = (last_avg_gain * (period - 1) + gain) / period
    proj_avg_loss = (last_avg_loss * (period - 1) + loss) / period

    if proj_avg_loss == 0.0:
        return 100.0 if proj_avg_gain > 0 else 50.0

    rs = proj_avg_gain / proj_avg_loss
    proj_rsi = 100.0 - (100.0 / (1.0 + rs))
    return round(proj_rsi, 2)


def _fetch_fyers_history(symbol: str, resolution: str, from_epoch: int, to_epoch: int) -> list[dict[str, Any]]:
    """
    Fetch historical candles from Fyers API v3.
    Returns list of dict: {time, open, high, low, close, volume}
    """
    from market.fyers_ltp import access_token_header, has_access_token

    if not has_access_token():
        return []

    hdr = access_token_header()
    if not hdr:
        return []

    url = "https://api-t1.fyers.in/data/history"
    params = {
        "symbol": symbol,
        "resolution": str(resolution),
        "date_format": "1",
        "range_from": str(from_epoch),
        "range_to": str(to_epoch),
        "cont_flag": "1",
    }
    try:
        r = requests.get(url, params=params, headers={"Authorization": hdr}, timeout=6)
        if r.status_code != 200:
            _log.warning("Fyers history API returned %s: %s", r.status_code, r.text[:200])
            return []
        data = r.json()
        if not isinstance(data, dict) or data.get("s") != "ok":
            return []
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
        return bars
    except Exception as e:
        _log.warning("Fyers history API exception: %s", e)
        return []


def _fetch_xts_candles(client: Any, tf_minutes: int) -> list[dict[str, Any]]:
    """
    Fallback to XTS for NIFTY spot candles.
    """
    if client is None:
        return []
    try:
        from market.dada_range import fetch_session_1m_bars, aggregate_1m_to_tf

        bars_1m = fetch_session_1m_bars(client, exchange_segment=1, exchange_instrument_id=26000)
        if not bars_1m:
            return []
        agg = aggregate_1m_to_tf(bars_1m, tf_minutes=tf_minutes)
        out: list[dict[str, Any]] = []
        for b in agg:
            dt = datetime.strptime(str(b.minute_key), "%Y%m%d%H%M").replace(tzinfo=IST)
            out.append({
                "time": int(dt.timestamp()),
                "open": b.open,
                "high": b.high,
                "low": b.low,
                "close": b.close,
                "volume": 0.0,
            })
        return out
    except Exception as e:
        _log.warning("XTS candle fetch exception: %s", e)
        return []


def _generate_synthetic_seed_candles(tf_minutes: int, live_spot: float = 24000.0) -> list[dict[str, Any]]:
    """
    Generates realistic intraday candle seeds when market is closed / no broker connected.
    Ensures UI and RSI chart are fully interactive for testing.
    """
    now = datetime.now(IST)
    start = now.replace(hour=9, minute=15, second=0, microsecond=0)
    bars: list[dict[str, Any]] = []
    current_time = start
    base_price = live_spot if live_spot > 0 else 24000.0
    px = base_price - 120.0  # Start slightly lower

    idx = 0
    while current_time < now and len(bars) < 80:
        # Oscillate to produce realistic RSI between 30 and 70
        cycle = math.sin(idx * 0.25) * 45.0 + math.cos(idx * 0.1) * 20.0
        c = base_price + cycle
        o = px
        h = max(o, c) + abs(math.sin(idx)) * 8.0
        l = min(o, c) - abs(math.cos(idx)) * 8.0
        bars.append({
            "time": int(current_time.timestamp()),
            "open": round(o, 2),
            "high": round(h, 2),
            "low": round(l, 2),
            "close": round(c, 2),
            "volume": 1000 + (idx % 10) * 150,
        })
        px = c
        current_time += timedelta(minutes=tf_minutes)
        idx += 1

    return bars


def detect_rsi_crossovers(
    candles: list[dict[str, Any]],
    rsi_series: list[float | None],
) -> list[dict[str, Any]]:
    """
    Detects crossover signals on confirmed (closed) candles.
    - CE_SELL: Downward cross below 60 (rsi[k-1] >= 60 and rsi[k] < 60)
    - PE_SELL: Upward cross above 40 (rsi[k-1] <= 40 and rsi[k] > 40)
    """
    signals: list[dict[str, Any]] = []
    n = len(rsi_series)
    for i in range(1, n):
        prev = rsi_series[i - 1]
        curr = rsi_series[i]
        if prev is None or curr is None:
            continue

        c = candles[i]
        bar_time = c.get("time", 0)
        spot_close = c.get("close", 0.0)

        # CE_SELL: downward cross below 60
        if prev >= CE_CROSS_THRESHOLD and curr < CE_CROSS_THRESHOLD:
            signals.append({
                "time": bar_time,
                "type": "CE_SELL",
                "rsi": curr,
                "prevRsi": prev,
                "spot": spot_close,
                "label": "CE SELL (RSI < 60)",
            })

        # PE_SELL: upward cross above 40
        if prev <= PE_CROSS_THRESHOLD and curr > PE_CROSS_THRESHOLD:
            signals.append({
                "time": bar_time,
                "type": "PE_SELL",
                "rsi": curr,
                "prevRsi": prev,
                "spot": spot_close,
                "label": "PE SELL (RSI > 40)",
            })

    return signals


def get_rsi_analysis(
    timeframe: int = 5,
    live_spot: float | None = None,
    xts_client: Any = None,
) -> dict[str, Any]:
    """
    Main entry point for RSI calculation and analysis.
    Checks cache first, then Fyers history, then XTS, with fallback seed.
    """
    tf = int(timeframe) if int(timeframe) in SUPPORTED_TIMEFRAMES else 5

    now_epoch = int(time.time())
    cached = _CACHE.get(tf)
    if cached and (now_epoch - cached["ts"]) < _CACHE_TTL_SEC:
        payload = dict(cached["payload"])
        # Update live projection with current spot if available
        if live_spot is not None and live_spot > 0:
            last_gain = payload.get("_lastAvgGain")
            last_loss = payload.get("_lastAvgLoss")
            last_close = payload.get("lastConfirmedClose", 0.0)
            proj = project_forming_rsi(last_gain, last_loss, last_close, live_spot)
            if proj is not None:
                payload["projectedRsi"] = proj
                payload["liveRsi"] = proj
                payload["liveSpot"] = live_spot
        return payload

    # Time range: last 3 days to guarantee sufficient bars for 14-period RSI
    from_epoch = now_epoch - (3 * 86400)
    symbol = "NSE:NIFTY50-INDEX"

    source = "fyers"
    candles = _fetch_fyers_history(symbol, str(tf), from_epoch, now_epoch)

    # Fallback to XTS if Fyers returned empty
    if not candles and xts_client is not None:
        source = "xts"
        candles = _fetch_xts_candles(xts_client, tf)

    # If still empty (e.g. after hours / mock / dev), provide synthetic seeds
    if not candles:
        source = "synthetic"
        candles = _generate_synthetic_seed_candles(tf, live_spot or 24200.0)

    # Sort candles ascending by time
    candles.sort(key=lambda x: x["time"])

    closes = [float(c["close"]) for c in candles]
    rsi_series, last_gain, last_loss = compute_wilder_rsi_series(closes, period=RSI_PERIOD)

    # Attach RSI to each candle
    candles_with_rsi: list[dict[str, Any]] = []
    for i, c in enumerate(candles):
        c_copy = dict(c)
        c_copy["rsi"] = rsi_series[i]
        candles_with_rsi.append(c_copy)

    # Detect signals on confirmed bars
    signals = detect_rsi_crossovers(candles, rsi_series)

    # Confirmed RSI is from the last closed candle
    last_confirmed_rsi = None
    for val in reversed(rsi_series):
        if val is not None:
            last_confirmed_rsi = val
            break

    last_confirmed_close = closes[-1] if closes else 0.0

    # Projected forming RSI
    effective_spot = live_spot if live_spot is not None and live_spot > 0 else last_confirmed_close
    projected_rsi = project_forming_rsi(last_gain, last_loss, last_confirmed_close, effective_spot)
    live_rsi = projected_rsi if projected_rsi is not None else last_confirmed_rsi

    payload = {
        "ok": True,
        "timeframe": tf,
        "source": source,
        "candleCount": len(candles_with_rsi),
        "candles": candles_with_rsi[-120:],  # Return up to 120 most recent candles for chart
        "signals": signals[-20:],  # Return recent 20 crossover events
        "confirmedRsi": last_confirmed_rsi,
        "projectedRsi": projected_rsi,
        "liveRsi": live_rsi,
        "liveSpot": effective_spot,
        "lastConfirmedClose": last_confirmed_close,
        # Threshold constants for frontend transparency
        "thresholds": {
            "ceArm": CE_ARM_THRESHOLD,
            "peArm": PE_ARM_THRESHOLD,
            "ceCross": CE_CROSS_THRESHOLD,
            "peCross": PE_CROSS_THRESHOLD,
            "ceAutoExit": CE_AUTO_EXIT_THRESHOLD,
            "peAutoExit": PE_AUTO_EXIT_THRESHOLD,
        },
        "_lastAvgGain": last_gain,
        "_lastAvgLoss": last_loss,
    }

    _CACHE[tf] = {"ts": now_epoch, "payload": payload}
    return payload
