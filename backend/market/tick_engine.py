"""
Thread-safe tick processor: normalize decoded packets, maintain live-by-token dict,
benchmark stats (numpy-backed when installed).
"""

from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Any

from market.instrument_mapper import get_instrument_mapper
from market.ltp_pick import apply_feed_ltp, pick_ltp_for_display, print_ts_from_tick
from market.ema21_engine import get_ema21_engine

_log = logging.getLogger(__name__)

try:
    import numpy as np

    _HAS_NP = True
except Exception:
    _HAS_NP = False


class TickEngine:
    """High-frequency path: ``ingest`` must stay lightweight."""

    __slots__ = ("_lock", "_live", "_buf", "_rx", "_last_mono", "_proc_us", "_redis", "_warn_stale_s")

    def __init__(
        self,
        *,
        buffer_max: int = 100_000,
        redis_publisher: Any | None = None,
        stale_warn_s: float = 5.0,
    ) -> None:
        self._lock = threading.RLock()
        self._live: dict[int, dict[str, Any]] = {}
        self._buf: deque[dict[str, Any]] = deque(maxlen=int(buffer_max))
        self._rx = 0
        self._last_mono = time.perf_counter()
        self._proc_us: deque[float] = deque(maxlen=4096)
        self._redis = redis_publisher
        self._warn_stale_s = float(stale_warn_s)

    def ingest(self, raw: dict[str, Any]) -> None:
        t0 = time.perf_counter()
        try:
            token = int(raw.get("exchangeInstrumentID") or raw.get("token") or 0)
        except Exception:
            return
        if not token:
            return
        seg = raw.get("exchangeSegment")
        seg_i = int(seg) if seg is not None else None

        row = self._normalize_row(raw, seg_i, token)

        elapsed_us = (time.perf_counter() - t0) * 1e6
        now = time.perf_counter()
        stale = now - self._last_mono > self._warn_stale_s
        self._last_mono = now

        with self._lock:
            self._rx += 1
            self._live[token] = row
            self._buf.append({"t": now, "token": token, "row": row})
            self._proc_us.append(elapsed_us)
            rx = self._rx

        if stale and self._warn_stale_s > 0 and rx % 5000 == 0:
            _log.debug("heartbeat: ticks flowing rx=%s", rx)

        if self._redis and rx % 200 == 0:
            try:
                self._redis.publish_tick(token, row)
            except Exception:
                pass

    def _normalize_row(self, raw: dict[str, Any], seg_i: int | None, token: int) -> dict[str, Any]:
        with self._lock:
            prev_row = self._live.get(token) or {}
        if raw.get("_atpOnly"):
            try:
                new_atp = float(raw.get("atp") or raw.get("_atp1501") or 0.0)
            except Exception:
                new_atp = 0.0
            if new_atp <= 0:
                return dict(prev_row) if prev_row else {"token": token, "ltp": 0.0, "atp": 0.0}
            atp_1501 = float(prev_row.get("_atp1501") or 0.0)
            atp_1502 = float(prev_row.get("_atp1502") or 0.0)
            atp_1501 = new_atp
            out = dict(prev_row)
            out.update(
                {
                    "token": token,
                    "atp": new_atp,
                    "_atp1501": atp_1501,
                    "_atp1502": atp_1502,
                    "timestamp": raw.get("timestamp")
                    or prev_row.get("timestamp")
                    or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time())),
                    "ts": float(raw.get("ts") or time.time()),
                }
            )
            if seg_i is not None:
                out["exchangeSegment"] = seg_i
            return out
        m = get_instrument_mapper()
        d = m.enrich_tick(seg_i, token, raw)
        ts_wall = float(d.get("ts") or time.time())
        print_ts = print_ts_from_tick(d, ts_wall)
        try:
            mc = int(d.get("messageCode") or d.get("MessageCode") or 0)
        except Exception:
            mc = 0
        new_atp = float(d.get("atp") or d.get("AverageTradedPrice") or 0.0)
        atp_1501 = float(prev_row.get("_atp1501") or 0.0)
        atp_1502 = float(prev_row.get("_atp1502") or 0.0)
        if float(d.get("_atp1501") or 0.0) > 0:
            atp_1501 = float(d["_atp1501"])
        if float(d.get("_atp1502") or 0.0) > 0:
            atp_1502 = float(d["_atp1502"])
        if mc == 1501 and new_atp > 0:
            atp_1501 = new_atp
        elif mc == 1502 and new_atp > 0:
            atp_1502 = new_atp
        use_atp = atp_1501 if atp_1501 > 0 else atp_1502
        raw_ltp = float(d.get("ltp") or 0.0)
        ltp_1501 = float(prev_row.get("_ltp1501") or 0.0)
        ltp_1502 = float(prev_row.get("_ltp1502") or 0.0)
        ltp_ts_1501 = float(prev_row.get("_ltp1501_ts") or 0.0)
        ltp_ts_1502 = float(prev_row.get("_ltp1502_ts") or 0.0)
        if float(d.get("_ltp1501") or 0.0) > 0:
            ltp_1501, ltp_ts_1501 = apply_feed_ltp(
                ltp_1501,
                ltp_ts_1501,
                float(d["_ltp1501"]),
                float(d.get("_ltp1501_ts") or print_ts),
            )
        if float(d.get("_ltp1502") or 0.0) > 0:
            ltp_1502, ltp_ts_1502 = apply_feed_ltp(
                ltp_1502,
                ltp_ts_1502,
                float(d["_ltp1502"]),
                float(d.get("_ltp1502_ts") or print_ts),
            )
        if mc == 1501 and raw_ltp > 0:
            ltp_1501, ltp_ts_1501 = apply_feed_ltp(ltp_1501, ltp_ts_1501, raw_ltp, print_ts)
        elif mc == 1502 and raw_ltp > 0:
            ltp_1502, ltp_ts_1502 = apply_feed_ltp(ltp_1502, ltp_ts_1502, raw_ltp, print_ts)
        new_ltp = pick_ltp_for_display(ltp_1501, ltp_1502, ltp_ts_1501, ltp_ts_1502, ts_wall)
        new_bid = float(d.get("bid") or d.get("bid_price") or 0.0)
        new_ask = float(d.get("ask") or d.get("ask_price") or 0.0)
        prev_ltp = float(prev_row.get("ltp") or 0.0)
        prev_bid = float(prev_row.get("bid") or 0.0)
        prev_ask = float(prev_row.get("ask") or 0.0)
        if new_ltp <= 0 and prev_ltp > 0:
            new_ltp = prev_ltp
        if new_bid <= 0 and prev_bid > 0:
            new_bid = prev_bid
        if new_ask <= 0 and prev_ask > 0:
            new_ask = prev_ask
        out: dict[str, Any] = {
            "symbol": str(d.get("symbol") or ""),
            "ltp": new_ltp,
            "atp": use_atp,
            "_atp1501": atp_1501,
            "_atp1502": atp_1502,
            "_ltp1501": ltp_1501,
            "_ltp1502": ltp_1502,
            "_ltp1501_ts": ltp_ts_1501,
            "_ltp1502_ts": ltp_ts_1502,
            "bid": new_bid,
            "ask": new_ask,
            "oi": int(d.get("oi") or 0),
            "volume": int(d.get("volume") or 0),
            "timestamp": d.get("timestamp") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts_wall)),
            "exchangeSegment": seg_i,
            "token": token,
            "bid_qty": int(d.get("bid_qty") or 0),
            "ask_qty": int(d.get("ask_qty") or 0),
        }
        try:
            pc = float(d.get("prevClose") or 0.0)
            if pc > 0:
                out["prevClose"] = pc
        except Exception:
            pass
        try:
            ch = float(d.get("percentChange") or float("nan"))
            if ch == ch:
                out["percentChange"] = ch
        except Exception:
            pass
        try:
            op = float(d.get("dayOpen") or 0.0)
            if op > 0:
                out["dayOpen"] = op
        except Exception:
            pass
        try:
            hi = float(d.get("dayHigh") or 0.0)
            lo = float(d.get("dayLow") or 0.0)
            if hi > 0 and lo > 0:
                if hi < lo:
                    hi, lo = lo, hi
                out["dayHigh"] = hi
                out["dayLow"] = lo
        except Exception:
            pass
        ema21 = get_ema21_engine().on_ltp(token, new_ltp, ts_wall)
        if ema21 > 0:
            out["ema21"] = ema21
        return out

    def live_tokens_view(self) -> dict[int, dict[str, Any]]:
        with self._lock:
            return {int(k): dict(v) for k, v in self._live.items()}

    def get_live_snapshot(self, max_tokens: int | None = None) -> dict[str, dict[str, Any]]:
        with self._lock:
            items = list(self._live.items())
        if max_tokens is not None:
            items = items[-int(max_tokens) :]
        return {str(k): dict(v) for k, v in items}

    def get_token_row(self, token: int) -> dict[str, Any] | None:
        with self._lock:
            r = self._live.get(int(token))
            return dict(r) if r else None

    def benchmark_summary(self) -> dict[str, Any]:
        import os

        proc = list(self._proc_us)
        lat_p50_us = lat_p95_us = 0.0
        proc_mean = proc_std = 0.0

        if proc:
            if _HAS_NP:
                arr = np.array(proc, dtype=np.float64)
                proc_mean = float(arr.mean())
                proc_std = float(arr.std(ddof=0))
                lat_p50_us = float(np.percentile(arr, 50))
                lat_p95_us = float(np.percentile(arr, 95))
            else:
                srt = sorted(proc)
                proc_mean = sum(proc) / len(proc)
                ms = sorted([(x - proc_mean) ** 2 for x in proc])
                proc_std = (sum(ms) / len(ms)) ** 0.5
                ix = len(srt) // 2
                lat_p50_us = float(srt[ix])
                lat_p95_us = float(srt[int(len(srt) * 0.95)])

        with self._lock:
            n_live = len(self._live)
            n_buf = len(self._buf)

        return {
            "ticks_processed": self._rx,
            "live_token_count": n_live,
            "buffer_fill": n_buf,
            "buffer_capacity": getattr(self._buf, "maxlen", None),
            "ingest_latency_us_mean": proc_mean,
            "ingest_latency_us_std": proc_std,
            "ingest_latency_us_p50": lat_p50_us,
            "ingest_latency_us_p95": lat_p95_us,
            "pid": os.getpid(),
            "numpy": _HAS_NP,
            "timestamp": time.time(),
        }


_engine: TickEngine | None = None


def get_tick_engine() -> TickEngine:
    global _engine
    if _engine is None:
        rp = None
        try:
            from market.redis_publisher import RedisPublisher as _Rp

            tmp = _Rp()
            rp = tmp if tmp.enabled else None
        except Exception:
            rp = None
        _engine = TickEngine(redis_publisher=rp)
    return _engine
