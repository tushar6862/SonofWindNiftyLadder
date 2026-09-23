import json
import os
import re
import threading
import time
from collections import deque
from dataclasses import dataclass
from queue import Empty, Full, Queue
from typing import Any, Callable, Iterable

import requests

from market.ltp_pick import apply_feed_ltp, exchange_print_ts, pick_ltp_for_display, print_ts_from_tick
from market.packet_decoder import decode_xts_binary_packet


class SseTickPipe:
    """SSE listener pipe: last-trade lane is always drained before ATP/noise."""

    __slots__ = ("_cond", "_ltp", "_other", "_max", "_size")

    def __init__(self, maxsize: int = 12000):
        self._cond = threading.Condition()
        self._ltp: deque[dict[str, Any]] = deque()
        self._other: deque[dict[str, Any]] = deque()
        self._max = max(64, int(maxsize))
        self._size = 0

    def qsize(self) -> int:
        return int(self._size)

    def put_nowait(self, payload: dict[str, Any], *, priority: bool = False) -> None:
        with self._cond:
            if self._size >= self._max:
                if not priority:
                    raise Full
                # Priority last-trade: drop oldest noise first, then oldest LTP.
                if self._other:
                    self._other.popleft()
                    self._size -= 1
                elif self._ltp:
                    self._ltp.popleft()
                    self._size -= 1
                else:
                    raise Full
            if priority:
                self._ltp.append(payload)
            else:
                self._other.append(payload)
            self._size += 1
            self._cond.notify()

    def get(self, timeout: float | None = None) -> dict[str, Any]:
        with self._cond:
            if timeout is None:
                while self._size <= 0:
                    self._cond.wait()
            else:
                end = time.monotonic() + float(timeout)
                while self._size <= 0:
                    remaining = end - time.monotonic()
                    if remaining <= 0:
                        raise Empty
                    self._cond.wait(remaining)
            if self._ltp:
                self._size -= 1
                return self._ltp.popleft()
            if self._other:
                self._size -= 1
                return self._other.popleft()
            raise Empty

    def get_nowait(self) -> dict[str, Any]:
        with self._cond:
            if self._ltp:
                self._size -= 1
                return self._ltp.popleft()
            if self._other:
                self._size -= 1
                return self._other.popleft()
            raise Empty


def _sse_payload_is_ltp_print(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("_atpOnly") or payload.get("_ema21Only") or payload.get("_snapshot"):
        return False
    if payload.get("_gapFill") or payload.get("_fromRestQuote") or payload.get("_hotLtp"):
        return False
    try:
        if float(payload.get("ltp") or 0.0) <= 0:
            return False
    except Exception:
        return False
    if payload.get("_fyersLtp") is True:
        return True
    try:
        mc = int(payload.get("messageCode") or 0)
    except Exception:
        mc = 0
    return mc != 1502


def _unwrap_md_payload(data: Any) -> Any:
    """Socket JSON is sometimes zlib bytes. Inflate before the partial parser."""
    import zlib

    raw: bytes | None = None
    if isinstance(data, (bytes, bytearray, memoryview)):
        raw = bytes(data)
    if raw is None:
        return data
    if len(raw) >= 2 and raw[0] == 0x78:
        try:
            raw = zlib.decompress(raw)
        except Exception:
            pass
    try:
        return raw.decode("utf-8")
    except Exception:
        return raw


def _bytes_from_packet_str(s: str) -> bytes:
    import base64
    import binascii

    text = str(s or "").strip()
    if not text:
        return b""
    try:
        return base64.b64decode(text, validate=False)
    except (binascii.Error, ValueError):
        pass
    try:
        return text.encode("latin-1", "ignore")
    except Exception:
        return b""


def _env(name: str, default: str = "") -> str:
    v = os.getenv(name)
    return default if v is None else str(v)


def _md_auth_failed(data: Any = None, snippet: str = "", status_code: int | None = None) -> bool:
    """True when the MD gateway rejected the call for a missing/expired session token.

    Investeria/XTS often returns HTTP 400 ``Please Provide token to Authenticate``
    (not ``Invalid Token`` / 401). Treat those as a re-login trigger.
    """
    parts: list[str] = [str(snippet or "")]
    if isinstance(data, dict):
        for k in ("description", "message", "status", "error", "code"):
            v = data.get(k)
            if v:
                parts.append(str(v))
    blob = " ".join(parts).lower()
    needles = (
        "invalid token",
        "please provide token",
        "provide token to authenticate",
        "token to authenticate",
        "authorization not found",
        "token/authorization",
        "token expired",
        "session expired",
        "please login",
        "login required",
        "no token",
        "unauthoriz",
    )
    if any(n in blob for n in needles):
        return True
    try:
        sc = int(status_code) if status_code is not None else 0
    except Exception:
        sc = 0
    return sc in (401, 403) and ("token" in blob or "auth" in blob)


XTS_MD_ROOT = _env("XTS_MD_ROOT", "https://trading.investeria.in").rstrip("/")
XTS_MD_SOURCE = _env("XTS_MD_SOURCE", "WEBAPI")
XTS_MD_SOCKETIO_PATH = _env("XTS_MD_SOCKETIO_PATH", "apibinarymarketdata/socket.io")
# Binary = denser last-trade. JSON kept as failover if Binary yields no LTP.
XTS_MD_PUBLISH_FORMAT = _env("XTS_MD_PUBLISH_FORMAT", "Binary")
# Runtime flip target (Binary <-> JSON) when ltp-pub stays empty after connect.
_ACTIVE_PUBLISH_FORMAT = str(XTS_MD_PUBLISH_FORMAT or "Binary").strip() or "Binary"
# Partial = tick-to-tick 1501/1512-json-partial (Snap Quote LTP). Full = slow snapshots.
XTS_MD_BROADCAST_MODE = _env("XTS_MD_BROADCAST_MODE", "Partial")
# Brokers often reject one bad token in a batch — cap chunk size via env when needed (e.g. 32).
# Many XTS gateways reject >100 instruments per REST subscribe (see e-quotes-0003 in OEM docs).
XTS_MD_SUBSCRIBE_CHUNK = max(8, min(int(_env("XTS_MD_SUBSCRIBE_CHUNK", "96")), 100))
# Coalesce socket ticks before SSE listeners / pipeline (ms). 0 = every socket tick → SSE (tick-to-tick).
_COALESCE_MS_RAW = float(_env("XTS_MD_COALESCE_MS", "0") or "0")
XTS_MD_COALESCE_SEC = max(0.0, _COALESCE_MS_RAW / 1000.0)
# Server-side touchline ATP refresh → pushed on existing SSE (replaces browser atp_snapshot polling).
# 1.5s × 40 legs at 9:15 flooded the SSE queue under CPU load and delayed Snap Quote LTP by 3–4 pts.
XTS_MD_ATP_REFRESH_SEC = max(0.0, float(_env("XTS_MD_ATP_REFRESH_SEC", "4") or "0"))
XTS_MD_ATP_CHUNK = max(8, min(int(_env("XTS_MD_ATP_CHUNK", "24")), 100))
# Skip enqueueing ATP-only SSE when a listener queue already has this many pending events.
XTS_MD_ATP_SSE_MAX_Q = max(32, min(int(_env("XTS_MD_ATP_SSE_MAX_Q", "128")), 2000))
# Symphony CandleDataEvent (message 1505) — opt-in; doubles subscription count.
XTS_MD_SUBSCRIBE_1505 = str(_env("XTS_MD_SUBSCRIBE_1505", "0")).strip().lower() not in ("0", "false", "no", "off")
# 1512 = Snap Quote LTP event (tick-to-tick LastTradedPrice). Default on with 1501.
XTS_MD_SUBSCRIBE_1512 = str(_env("XTS_MD_SUBSCRIBE_1512", "1")).strip().lower() not in ("0", "false", "no", "off")
# Reconnect Socket.IO when no binary ticks for this many seconds (ATP refresh does not count).
XTS_MD_SOCKET_STALE_SEC = max(15.0, float(_env("XTS_MD_SOCKET_STALE_SEC", "45") or "45"))
# LIVE / hunt focus: single-token touchline poll so the painted strike tracks XTS when the socket is quiet.
XTS_MD_HOT_FOCUS_SEC = max(0.05, float(_env("XTS_MD_HOT_FOCUS_SEC", "0.05") or "0.05"))
XTS_MD_HOT_FOCUS_SOCKET_GUARD_SEC = max(0.5, float(_env("XTS_MD_HOT_FOCUS_SOCKET_GUARD_SEC", "2.0") or "2.0"))


def _parse_symphony_candle_partial(raw: str) -> dict[str, Any] | None:
    """Parse 1505-json-partial: ``t:12_1136974,o:...,c:...,bt:...``."""
    if not raw or ":" not in raw:
        return None
    parts: dict[str, str] = {}
    for kv in str(raw).split(","):
        if ":" not in kv:
            continue
        k, v = kv.split(":", 1)
        parts[k.strip().lower()] = v.strip()
    tok = parts.get("t", "")
    if "_" not in tok:
        return None
    seg_s, tid_s = tok.split("_", 1)
    try:
        seg = int(seg_s)
        tid = int(tid_s)
        close = float(parts.get("c") or 0.0)
        bar_time = float(parts.get("bt") or 0.0)
    except Exception:
        return None
    if tid <= 0 or close <= 0 or bar_time <= 0:
        return None
    return {
        "exchangeSegment": seg,
        "exchangeInstrumentID": tid,
        "Close": close,
        "BarTime": bar_time,
        "messageCode": 1505,
    }


def _symphony_candle_fields(data: Any) -> dict[str, Any] | None:
    if isinstance(data, str):
        s = data.strip()
        if s.startswith("{"):
            try:
                data = json.loads(s)
            except Exception:
                return _parse_symphony_candle_partial(s)
        else:
            return _parse_symphony_candle_partial(s)
    if not isinstance(data, dict):
        return None
    tid = int(data.get("ExchangeInstrumentID") or data.get("exchangeInstrumentID") or 0)
    close = float(data.get("Close") or data.get("close") or data.get("c") or 0.0)
    bar_time = float(data.get("BarTime") or data.get("barTime") or data.get("bt") or 0.0)
    if tid <= 0 or close <= 0 or bar_time <= 0:
        return None
    seg = data.get("ExchangeSegment") or data.get("exchangeSegment")
    out: dict[str, Any] = {
        "exchangeInstrumentID": tid,
        "Close": close,
        "BarTime": bar_time,
        "messageCode": 1505,
    }
    if seg is not None:
        out["exchangeSegment"] = int(seg)
    return out


def _plausible_md_px(x: float) -> bool:
    if not (x > 0) or x != x:
        return False
    if 1e9 <= x < 2e10:
        return False
    if x >= 1e12:
        return False
    return True


def _tick_from_xts_partial_str(raw: str, message_code: int) -> dict[str, Any] | None:
    s = str(raw or "").strip().replace("|", ",")
    if not s:
        return None
    if ":" in s and any(k in s.lower() for k in ("ltp:", "lt:", "t:", "p:")):
        parts: dict[str, str] = {}
        for kv in s.split(","):
            if ":" not in kv:
                continue
            k, v = kv.split(":", 1)
            parts[k.strip().lower()] = v.strip()
        tok = parts.get("t") or parts.get("token") or ""
        seg = 0
        tid = 0
        if "_" in tok:
            a, b = tok.split("_", 1)
            try:
                tid = int(b)
            except Exception:
                tid = 0
            if a.isdigit():
                try:
                    seg = int(a)
                except Exception:
                    seg = 0
        else:
            try:
                tid = int(tok)
            except Exception:
                tid = 0
        try:
            ltp = float(
                parts.get("ltp")
                or parts.get("lt")
                or parts.get("lasttradedprice")
                or 0.0
            )
        except Exception:
            ltp = 0.0
        if ltp <= 0 and int(message_code) in (1501, 1512):
            try:
                ltp = float(parts.get("p") or 0.0)
            except Exception:
                ltp = 0.0
        # Never treat bid/ask keys as last trade.
        if parts.get("ap") or parts.get("bp") or parts.get("ask") or parts.get("bid"):
            if "ltp" not in parts and "lt" not in parts and "lasttradedprice" not in parts:
                if int(message_code) == 1502 or ("p" not in parts and ltp <= 0):
                    ltp = 0.0
        try:
            bid = float(parts.get("bp") or parts.get("b") or parts.get("bid") or 0.0)
        except Exception:
            bid = 0.0
        try:
            ask = float(parts.get("ap") or parts.get("a") or parts.get("ask") or 0.0)
        except Exception:
            ask = 0.0
        try:
            atp = float(parts.get("atp") or parts.get("avg") or 0.0)
        except Exception:
            atp = 0.0
        try:
            ltt = float(parts.get("ltt") or parts.get("lasttradedtime") or parts.get("tt") or 0.0)
        except Exception:
            ltt = 0.0
        if tid <= 0:
            return None
        if int(message_code) == 1502:
            ltp = 0.0
        return _dashboard_tick_from_fields(message_code, seg, tid, ltp, bid, ask, atp, ltt)
    cols = [c.strip() for c in s.split(",") if c.strip() != ""]
    if len(cols) >= 2 and int(message_code) in (1501, 1512):
        start = 0
        try:
            if int(float(cols[0])) in (1501, 1512, 1502):
                start = 1
        except Exception:
            start = 0
        n = len(cols) - start
        if n == 2:
            tok = cols[start]
            try:
                ltp_i = float(cols[start + 1])
            except Exception:
                return None
            if "_" in tok:
                seg_i, tid_i = _seg_tid_from_t_token(tok)
            else:
                try:
                    tid_i = int(float(tok))
                except Exception:
                    tid_i = 0
                seg_i = 0
            if tid_i > 0 and _plausible_md_px(ltp_i):
                return _dashboard_tick_from_fields(int(message_code), seg_i, tid_i, ltp_i, 0.0, 0.0, 0.0)
        if n >= 3:
            try:
                seg_i = int(float(cols[start]))
                tid_i = int(float(cols[start + 1]))
                third = float(cols[start + 2])
            except Exception:
                return None
            ltp_off = 2
            ltp_i = third
            if not _plausible_md_px(third) and n >= 4:
                try:
                    ltp_i = float(cols[start + 3])
                    ltp_off = 3
                except Exception:
                    return None
            ltt_i = 0.0
            ltt_off = ltp_off + 6
            if n > ltt_off:
                try:
                    ltt_i = float(cols[start + ltt_off])
                except Exception:
                    ltt_i = 0.0
            atp_i = 0.0
            atp_off = ltp_off + 5
            if n > atp_off:
                try:
                    atp_i = float(cols[start + atp_off])
                except Exception:
                    atp_i = 0.0
            if tid_i > 0 and _plausible_md_px(ltp_i):
                return _dashboard_tick_from_fields(
                    int(message_code), seg_i, tid_i, ltp_i, 0.0, 0.0, atp_i, ltt_i
                )
    return None


def _unix_print_ts(v: float) -> float:
    if v > 1e12:
        v /= 1000.0
    if v > 1e9:
        return float(v)
    return 0.0


def _dashboard_tick_from_fields(
    message_code: int,
    seg: int,
    tid: int,
    ltp: float,
    bid: float,
    ask: float,
    atp: float,
    ltt: float = 0.0,
) -> dict[str, Any]:
    wall = time.time()
    ex_ts = _unix_print_ts(float(ltt or 0.0))
    out: dict[str, Any] = {
        "symbol": "",
        "ltp": float(ltp or 0.0),
        "atp": float(atp or 0.0),
        "bid": float(bid or 0.0),
        "ask": float(ask or 0.0),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(wall)),
        "segment": int(seg or 0),
        "token": int(tid),
        "messageCode": int(message_code),
        "exchangeSegment": int(seg or 0),
        "exchangeInstrumentID": int(tid),
        "ts": wall,
        "exchange_ts": ex_ts,
    }
    if ex_ts > 0:
        out["LastTradedTime"] = ex_ts
    if int(message_code) in (1501, 1512) and ltp > 0:
        out["_ltp1501"] = float(ltp)
        out["_ltp1501_ts"] = ex_ts or wall
    elif int(message_code) == 1502:
        # Depth: bid/ask only. Never copy book px into Snap Quote LTP.
        if float(ltp or 0.0) > 0:
            out["_ltp1502"] = float(ltp)
            out["_ltp1502_ts"] = ex_ts
    return out


def _seg_tid_from_t_token(tok: object) -> tuple[int, int]:
    s = str(tok or "").strip()
    if "_" not in s:
        try:
            return 0, int(s)
        except Exception:
            return 0, 0
    a, b = s.split("_", 1)
    tid = 0
    seg = 0
    try:
        tid = int(b)
    except Exception:
        return 0, 0
    if a.isdigit():
        try:
            seg = int(a)
        except Exception:
            seg = 0
    return seg, tid


def _tick_from_xts_json_leaf(leaf: dict[str, Any], message_code: int) -> dict[str, Any] | None:
    tok = leaf.get("t") or leaf.get("T")
    seg, tid = _seg_tid_from_t_token(tok) if tok else (0, 0)
    if tid <= 0:
        tid = first_exchange_instrument_id(leaf) or 0
    if tid <= 0:
        return None
    if seg <= 0:
        try:
            seg = int(leaf.get("ExchangeSegment") or leaf.get("exchangeSegment") or leaf.get("segment") or 0)
        except Exception:
            seg = 0
    ltp = float(
        _positive_float(leaf.get("ltp") or leaf.get("LTP") or leaf.get("LastTradedPrice") or leaf.get("lastTradedPrice"))
        or _touchline_last_traded_price(leaf)
        or 0.0
    )
    # Partial shorthand ``p:`` is last trade on 1501/1512 — never Bid/Ask.
    if ltp <= 0 and int(message_code) in (1501, 1512):
        ltp = float(_positive_float(leaf.get("p") or leaf.get("P")) or 0.0)
    tl = leaf.get("Touchline") or leaf.get("touchline") or leaf.get("TouchLine") or leaf.get("touchLine")
    if not isinstance(tl, dict):
        tl = {}
    bid = 0.0
    ask = 0.0
    bi = tl.get("BidInfo") if isinstance(tl.get("BidInfo"), dict) else leaf.get("BidInfo")
    ai = tl.get("AskInfo") if isinstance(tl.get("AskInfo"), dict) else leaf.get("AskInfo")
    if isinstance(bi, dict):
        bid = float(_positive_float(bi.get("Price") or bi.get("price")) or 0.0)
    if isinstance(ai, dict):
        ask = float(_positive_float(ai.get("Price") or ai.get("price")) or 0.0)
    if bid <= 0:
        bid = float(_positive_float(leaf.get("BidPrice") or leaf.get("bid") or tl.get("BidPrice")) or 0.0)
    if ask <= 0:
        ask = float(_positive_float(leaf.get("AskPrice") or leaf.get("ask") or tl.get("AskPrice")) or 0.0)
    atp = float(
        _positive_float(tl.get("AverageTradedPrice") or leaf.get("AverageTradedPrice") or leaf.get("atp")) or 0.0
    )
    ltt = float(
        _positive_float(
            leaf.get("LastTradedTime")
            or leaf.get("lastTradedTime")
            or tl.get("LastTradedTime")
            or tl.get("lastTradedTime")
            or leaf.get("ltt")
        )
        or 0.0
    )
    if ltp <= 0 and bid <= 0 and ask <= 0 and atp <= 0:
        return None
    if int(message_code) == 1502:
        ltp = 0.0
    return _dashboard_tick_from_fields(message_code, seg, int(tid), ltp, bid, ask, atp, ltt)


def _ticks_from_xts_json_event(data: Any, message_code: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def walk(x: Any) -> None:
        if x is None:
            return
        if isinstance(x, (bytes, bytearray, memoryview)):
            try:
                x = bytes(x).decode("utf-8", "replace")
            except Exception:
                return
        if isinstance(x, str):
            s = x.strip()
            if not s:
                return
            if s[0] in "{[":
                try:
                    walk(json.loads(s))
                    return
                except Exception:
                    pass
            tick = _tick_from_xts_partial_str(s, message_code)
            if tick:
                out.append(tick)
            return
        if isinstance(x, list):
            for y in x:
                walk(y)
            return
        if isinstance(x, dict):
            if x.get("t") is not None and (
                x.get("ltp") is not None
                or x.get("LTP") is not None
                or x.get("LastTradedPrice") is not None
                or x.get("p") is not None
                or x.get("P") is not None
            ):
                tick = _tick_from_xts_json_leaf(x, message_code)
                if tick:
                    out.append(tick)
                return
            leaves = list(_iter_quote_leaf_dicts(x))
            if leaves:
                for leaf in leaves:
                    if isinstance(leaf, dict):
                        tick = _tick_from_xts_json_leaf(leaf, message_code)
                        if tick:
                            out.append(tick)
                if out:
                    return
            tick = _tick_from_xts_json_leaf(x, message_code)
            if tick:
                out.append(tick)
                return
            for v in x.values():
                if isinstance(v, (str, list, dict)):
                    walk(v)

    walk(data)
    return out


def _md_tick_message_code(tick: dict[str, Any]) -> int:
    try:
        return int(tick.get("messageCode") or tick.get("MessageCode") or 0)
    except Exception:
        return 0


def _md_tick_atp(tick: dict[str, Any]) -> float:
    try:
        return float(tick.get("atp") or tick.get("AverageTradedPrice") or 0.0)
    except Exception:
        return 0.0


def _md_tick_ltp(tick: dict[str, Any]) -> float:
    try:
        return float(tick.get("ltp") or tick.get("LastTradedPrice") or 0.0)
    except Exception:
        return 0.0


def _md_tick_ts(tick: dict[str, Any]) -> float:
    return exchange_print_ts(tick)


def _merge_preserve_price_fields(prev: dict[str, Any], out: dict[str, Any]) -> dict[str, Any]:
    """Depth-only packets can carry ltp=0 — never wipe a live touchline price."""
    for key in ("ltp", "bid", "ask"):
        try:
            new_v = float(out.get(key) or 0.0)
            prev_v = float(prev.get(key) or 0.0)
        except Exception:
            continue
        if new_v <= 0 and prev_v > 0:
            out[key] = prev_v
    return out


def _coalesce_merge_ticks(prev: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    """
    Merge coalesced socket ticks for the same instrument.

    Track 1501 (touchline) and 1502 (depth) ATP separately; display ATP and LTP both
    prefer 1501 (XTS Snap Quote Mace / LastTradedPrice). Depth is bid/ask only.
    """
    out = _merge_preserve_price_fields(prev, {**prev, **new})
    atp1501 = float(prev.get("_atp1501") or 0.0)
    atp1502 = float(prev.get("_atp1502") or 0.0)
    for t in (prev, new):
        mc = _md_tick_message_code(t)
        a = _md_tick_atp(t)
        if a <= 0:
            continue
        if mc == 1501:
            atp1501 = a
        elif mc == 1502:
            atp1502 = a
    out["_atp1501"] = atp1501
    out["_atp1502"] = atp1502
    out["atp"] = atp1501 if atp1501 > 0 else atp1502
    ltp1501 = float(prev.get("_ltp1501") or 0.0)
    ltp1502 = float(prev.get("_ltp1502") or 0.0)
    ltp_ts_1501 = float(prev.get("_ltp1501_ts") or 0.0)
    ltp_ts_1502 = float(prev.get("_ltp1502_ts") or 0.0)
    for t in (prev, new):
        mc = _md_tick_message_code(t)
        l = _md_tick_ltp(t)
        if l <= 0:
            continue
        ts = _md_tick_ts(t)
        if mc in (1501, 1512):
            ltp1501, ltp_ts_1501 = apply_feed_ltp(ltp1501, ltp_ts_1501, l, ts or time.time(), wall_ok=True)
        elif mc == 1502:
            ltp1502, ltp_ts_1502 = apply_feed_ltp(ltp1502, ltp_ts_1502, l, ts, wall_ok=False)
        # 1505 candle events must not drive touchline LTP (minute close ≠ live tick).
    out["_ltp1501"] = ltp1501
    out["_ltp1502"] = ltp1502
    out["_ltp1501_ts"] = ltp_ts_1501
    out["_ltp1502_ts"] = ltp_ts_1502
    picked = pick_ltp_for_display(ltp1501, ltp1502, ltp_ts_1501, ltp_ts_1502)
    if picked > 0:
        out["ltp"] = picked
    return out


def _quote_to_float(v: Any) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        f = float(v)
        return f if f == f else None
    if isinstance(v, str):
        s = v.strip().replace(",", "")
        if not s:
            return None
        try:
            f = float(s)
            return f if f == f else None
        except Exception:
            return None
    return None


def _extract_atp_map_from_quote_response(obj: object) -> dict[int, float]:
    """instrumentId -> AverageTradedPrice from XTS /instruments/quotes JSON."""
    out: dict[int, float] = {}

    def to_int(v: Any) -> int | None:
        try:
            if v is None:
                return None
            return int(str(v).strip())
        except Exception:
            return None

    def visit(x: object) -> None:
        if isinstance(x, str):
            s = x.strip()
            if s.startswith("{") or s.startswith("["):
                try:
                    visit(json.loads(s))
                except Exception:
                    pass
            return
        if isinstance(x, dict):
            iid = to_int(
                x.get("exchangeInstrumentID")
                or x.get("ExchangeInstrumentID")
                or x.get("instrumentId")
                or x.get("InstrumentId")
            )
            if iid:
                tl = x.get("Touchline") or x.get("touchline") or x.get("TouchLine") or x.get("touchLine")
                atp: float | None = None
                if isinstance(tl, dict):
                    atp = _quote_to_float(
                        tl.get("AverageTradedPrice")
                        or tl.get("averageTradedPrice")
                        or tl.get("ATP")
                        or tl.get("atp")
                    )
                if atp is None or atp <= 0:
                    atp = _quote_to_float(
                        x.get("AverageTradedPrice")
                        or x.get("averageTradedPrice")
                        or x.get("ATP")
                        or x.get("atp")
                    )
                if atp is not None and atp > 0:
                    out[int(iid)] = float(atp)
            if "result" in x:
                visit(x.get("result"))
            if "listQuotes" in x:
                visit(x.get("listQuotes"))
            if "ListQuotes" in x:
                visit(x.get("ListQuotes"))
            for v in x.values():
                if isinstance(v, (dict, list, str)):
                    visit(v)
        elif isinstance(x, list):
            for it in x:
                visit(it)

    visit(obj)
    return out


def _extract_ltp_map_from_quote_response(obj: object) -> dict[int, float]:
    """instrumentId -> LastTradedPrice from XTS /instruments/quotes JSON."""
    out: dict[int, float] = {}

    def to_int(v: Any) -> int | None:
        try:
            if v is None:
                return None
            return int(str(v).strip())
        except Exception:
            return None

    def visit(x: object) -> None:
        if isinstance(x, str):
            s = x.strip()
            if s.startswith("{") or s.startswith("["):
                try:
                    visit(json.loads(s))
                except Exception:
                    pass
            return
        if isinstance(x, dict):
            iid = to_int(
                x.get("exchangeInstrumentID")
                or x.get("ExchangeInstrumentID")
                or x.get("instrumentId")
                or x.get("InstrumentId")
            )
            if iid:
                tl = x.get("Touchline") or x.get("touchline") or x.get("TouchLine") or x.get("touchLine")
                ltp: float | None = None
                if isinstance(tl, dict):
                    ltp = _quote_to_float(
                        tl.get("LastTradedPrice")
                        or tl.get("lastTradedPrice")
                        or tl.get("LTP")
                        or tl.get("ltp")
                        or tl.get("LastPrice")
                        or tl.get("lastPrice")
                    )
                if ltp is None or ltp <= 0:
                    ltp = _quote_to_float(
                        x.get("LastTradedPrice")
                        or x.get("lastTradedPrice")
                        or x.get("LTP")
                        or x.get("ltp")
                    )
                if ltp is not None and ltp > 0:
                    out[int(iid)] = float(ltp)
            if "result" in x:
                visit(x.get("result"))
            if "listQuotes" in x:
                visit(x.get("listQuotes"))
            if "ListQuotes" in x:
                visit(x.get("ListQuotes"))
            for v in x.values():
                if isinstance(v, (dict, list, str)):
                    visit(v)
        elif isinstance(x, list):
            for it in x:
                visit(it)

    visit(obj)
    return out


def _md_subscription_response_ok(resp: Any) -> bool:
    """
    Subscription REST responses vary by host (parity with XTS_OPTIONS_DASHBOARD `_md_subscription_response_ok`).
    """
    if not isinstance(resp, dict):
        return False
    t = str(resp.get("type") or resp.get("Type") or "").lower()
    if t == "success":
        return True
    if t == "error":
        return False
    res = resp.get("result")
    if isinstance(res, dict):
        errs = res.get("errors") or res.get("Errors")
        if errs:
            return False
        if (
            res.get("quotesList") is not None
            or res.get("listQuotes") is not None
            or res.get("Remaining_Subscription_Count") is not None
            or res.get("mdp") is not None
        ):
            return True
    return bool(res)


@dataclass
class XtsMarketDataSession:
    token: str
    user_id: str
    created_at: float


class XtsMarketDataClient:
    def __init__(self, api_key: str, api_secret: str, timeout_s: float = 7.0):
        self.api_key = api_key
        self.api_secret = api_secret
        self.timeout_s = timeout_s
        self.session = requests.Session()
        self._md: XtsMarketDataSession | None = None
        self._quote_lock = threading.Lock()
        self._login_lock = threading.Lock()

    def has_token(self) -> bool:
        return bool(self._md and str(self._md.token or "").strip())

    def ensure_session(self) -> None:
        """Login once if this client has no MD token yet."""
        if self.has_token():
            return
        with self._login_lock:
            if not self.has_token():
                self._login_unlocked()

    def _headers(self) -> dict[str, str]:
        """
        Default headers for this vendor gateway.
        Note: Some XTS deployments expect raw token, others expect `Bearer <token>`.
        We keep a default (raw token) and use `_auth_header_variants()` for retries.
        """
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._md and self._md.token:
            h["Authorization"] = self._md.token
        return h

    def _auth_header_variants(self) -> list[dict[str, str]]:
        base = {"Content-Type": "application/json"}
        tok = (self._md.token if self._md else "") or ""
        if not tok:
            return [dict(base)]
        # Optimized: most Symphony/XTS gateways expect raw token in Authorization.
        # Keeping only the known-good variant cuts REST retries significantly.
        return [{**base, "Authorization": tok}]

    def _request_get_json_with_variants(
        self,
        url: str,
        *,
        params_candidates: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """
        Some vendor gateways are picky about:
        - Authorization header style (raw token vs Bearer)
        - query param casing (exchangeSegment vs ExchangeSegment)
        - float vs int formatting in query params
        Try a small Cartesian product and return first successful JSON.
        """
        self.ensure_session()
        last_exc: Exception | None = None
        # Retry once after re-login if gateway reports missing/expired token.
        for attempt in range(2):
            invalid_token_hit = False
            for hdr in self._auth_header_variants():
                for params in params_candidates:
                    try:
                        r = self.session.get(url, params=params, headers=hdr, timeout=self.timeout_s)
                        snippet = (r.text or "").replace("\r", "").strip()[:900]

                        data: Any = None
                        try:
                            data = r.json()
                        except Exception:
                            data = None

                        if _md_auth_failed(data, snippet, r.status_code):
                            invalid_token_hit = True
                            last_exc = RuntimeError(f"http {r.status_code}: {snippet[:200] or 'auth token missing'}")
                            continue

                        if isinstance(data, dict) and str(data.get("type") or data.get("Type") or "").lower() == "error":
                            desc = str(
                                data.get("description")
                                or data.get("message")
                                or data.get("status")
                                or snippet
                            )[:400]
                            last_exc = RuntimeError(f"http {r.status_code}: {desc}")
                            continue

                        if not r.ok:
                            last_exc = RuntimeError(f"http {r.status_code}: {snippet[:400] or r.reason}")
                            continue

                        if data is None:
                            last_exc = RuntimeError(f"non_json status={r.status_code} snippet={snippet[:240]}")
                            continue

                        return data if isinstance(data, dict) else {"type": "success", "result": data}
                    except Exception as e:
                        last_exc = e
                        continue

            if invalid_token_hit and attempt == 0:
                try:
                    self.login()
                    continue
                except Exception as e:
                    last_exc = e
            break

        raise last_exc or RuntimeError("get_failed")

    def login(self) -> XtsMarketDataSession:
        with self._login_lock:
            return self._login_unlocked()

    def _login_unlocked(self) -> XtsMarketDataSession:
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/auth/login"
        payload = {"appKey": self.api_key, "secretKey": self.api_secret, "source": XTS_MD_SOURCE}
        r = self.session.post(url, json=payload, timeout=self.timeout_s)
        r.raise_for_status()
        data = r.json()
        if data.get("type") != "success":
            raise RuntimeError(data.get("description") or "XTS marketdata_login failed")
        res = data.get("result") or {}
        md = XtsMarketDataSession(
            token=str(res.get("token") or ""),
            user_id=str(res.get("userID") or ""),
            created_at=time.time(),
        )
        if not md.token or not md.user_id:
            raise RuntimeError("XTS marketdata_login missing token/userID")
        self._md = md
        return md

    def subscribe(self, instruments: list[dict[str, Any]], xts_message_code: int) -> dict[str, Any]:
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/instruments/subscription"

        normed: list[dict[str, int]] = []
        for inst in instruments:
            seg_k = inst.get("exchangeSegment", inst.get("ExchangeSegment"))
            tid_k = inst.get("exchangeInstrumentID", inst.get("ExchangeInstrumentID"))
            if seg_k is None or tid_k is None:
                continue
            seg_i = int(seg_k)
            tid_i = int(tid_k)
            if tid_i <= 0:
                continue
            normed.append({"exchangeSegment": seg_i, "exchangeInstrumentID": tid_i})

        if not normed:
            return {"type": "skipped", "description": "subscription: no instruments with valid IDs"}

        self.ensure_session()

        pascal_inst = [{"ExchangeSegment": x["exchangeSegment"], "ExchangeInstrumentID": x["exchangeInstrumentID"]} for x in normed]
        str_inst = [{"exchangeSegment": x["exchangeSegment"], "exchangeInstrumentID": str(x["exchangeInstrumentID"])} for x in normed]
        str_pascal = [{"ExchangeSegment": x["exchangeSegment"], "ExchangeInstrumentID": str(x["exchangeInstrumentID"])} for x in normed]
        code = int(xts_message_code)
        payload_candidates: list[dict[str, Any]] = [
            {"instruments": normed, "xtsMessageCode": code},
            {"source": XTS_MD_SOURCE, "instruments": normed, "xtsMessageCode": code},
            {"instruments": pascal_inst, "xtsMessageCode": code},
            {"source": XTS_MD_SOURCE, "instruments": pascal_inst, "xtsMessageCode": code},
            {"instruments": str_inst, "xtsMessageCode": code},
            {"source": XTS_MD_SOURCE, "instruments": str_inst, "xtsMessageCode": code},
            {"instruments": str_pascal, "xtsMessageCode": code},
            {"source": XTS_MD_SOURCE, "instruments": str_pascal, "xtsMessageCode": code},
            # Some gateways validate Instruments key casing (rare but observed).
            {"Instruments": normed, "xtsMessageCode": code},
            {"source": XTS_MD_SOURCE, "Instruments": normed, "xtsMessageCode": code},
            {"Instruments": pascal_inst, "xtsMessageCode": code},
            {"source": XTS_MD_SOURCE, "Instruments": pascal_inst, "xtsMessageCode": code},
            {"Instruments": str_inst, "xtsMessageCode": code},
            {"source": XTS_MD_SOURCE, "Instruments": str_inst, "xtsMessageCode": code},
            {"Instruments": str_pascal, "xtsMessageCode": code},
            {"source": XTS_MD_SOURCE, "Instruments": str_pascal, "xtsMessageCode": code},
        ]

        last_exc: Exception | None = None
        for attempt in range(2):
            invalid_token_hit = False
            for hdr in self._auth_header_variants():
                for payload in payload_candidates:
                    try:
                        r = self.session.post(url, data=json.dumps(payload), headers=hdr, timeout=self.timeout_s)
                        snippet = (r.text or "").replace("\r", "").strip()[:880]
                        try:
                            data = r.json()
                        except Exception:
                            last_exc = RuntimeError(f"subscription HTTP {r.status_code}: non-JSON: {snippet or r.reason}")
                            continue

                        if _md_auth_failed(data, snippet, r.status_code):
                            invalid_token_hit = True
                            last_exc = RuntimeError(f"subscription HTTP {r.status_code}: {snippet[:200] or 'auth token missing'}")
                            continue

                        if isinstance(data, dict) and _md_subscription_response_ok(data):
                            return data

                        if isinstance(data, dict) and str(data.get("type") or data.get("Type") or "").lower() == "error":
                            # Preserve validation details (often nested under result.errors[])
                            msg = str(data.get("description") or data.get("message") or data.get("error") or "")[:320]
                            if not msg or msg.lower() == "bad request":
                                try:
                                    msg = (json.dumps(data, default=str)[:920]) if isinstance(data, dict) else (snippet[:920])
                                except Exception:
                                    msg = snippet[:920]
                            elif snippet and snippet not in msg:
                                msg = f"{msg} — {snippet[:520]}"
                            last_exc = RuntimeError(f"subscription: {msg}")
                            continue

                        if r.ok:
                            return data if isinstance(data, dict) else {"type": "success", "result": data}

                        desc = ""
                        if isinstance(data, dict):
                            desc = str(data.get("description") or data.get("message") or "").strip()
                        last_exc = RuntimeError(
                            f"subscription HTTP {r.status_code}: {(desc or r.reason)[:400]} — {snippet[:480]}"
                        )
                    except Exception as e:
                        last_exc = e
                        continue

            if invalid_token_hit and attempt == 0:
                try:
                    self.login()
                    continue
                except Exception as e:
                    last_exc = e
            break

        raise last_exc or RuntimeError("subscription failed")

    def socket_url(self) -> str:
        if not self._md:
            raise RuntimeError("marketdata session not initialized")
        fmt = str(_ACTIVE_PUBLISH_FORMAT or XTS_MD_PUBLISH_FORMAT or "Binary").strip() or "Binary"
        return (
            f"{XTS_MD_ROOT}/?token={self._md.token}"
            f"&userID={self._md.user_id}"
            f"&publishFormat={fmt}"
            f"&broadcastMode={XTS_MD_BROADCAST_MODE}"
        )

    def get_expiry_date(self, exchange_segment: int, series: str, symbol: str) -> dict[str, Any]:
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/instruments/instrument/expiryDate"
        seg = int(exchange_segment)
        ser = str(series).strip()
        sym = str(symbol).strip()
        params_candidates = [
            {"exchangeSegment": seg, "series": ser, "symbol": sym},
            {"ExchangeSegment": seg, "series": ser, "symbol": sym},
            {"ExchangeSegment": seg, "Series": ser, "Symbol": sym},
            {"exchangeSegment": seg, "Series": ser, "Symbol": sym},
        ]
        return self._request_get_json_with_variants(url, params_candidates=params_candidates)

    def get_option_symbol(
        self,
        exchange_segment: int,
        series: str,
        symbol: str,
        expiry_date: str,
        option_type: str,
        strike_price: float,
    ) -> dict[str, Any]:
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/instruments/instrument/optionsymbol"
        seg = int(exchange_segment)
        ser = str(series).strip()
        sym = str(symbol).strip()
        exp = str(expiry_date).strip()
        opt = str(option_type).strip()
        # Strike is commonly validated as an integer by some gateways.
        try:
            strike_i = int(round(float(strike_price)))
        except Exception:
            strike_i = None
        strike_f = float(strike_price)

        base1 = {"exchangeSegment": seg, "series": ser, "symbol": sym, "expiryDate": exp, "optionType": opt}
        base2 = {"ExchangeSegment": seg, "series": ser, "symbol": sym, "expiryDate": exp, "optionType": opt}
        base3 = {"ExchangeSegment": seg, "Series": ser, "Symbol": sym, "ExpiryDate": exp, "OptionType": opt}

        params_candidates: list[dict[str, Any]] = []
        for base in (base1, base2, base3):
            params_candidates.append({**base, "strikePrice": strike_f})
            params_candidates.append({**base, "StrikePrice": strike_f})
            if strike_i is not None:
                params_candidates.append({**base, "strikePrice": strike_i})
                params_candidates.append({**base, "StrikePrice": strike_i})
                params_candidates.append({**base, "strikePrice": str(strike_i)})
                params_candidates.append({**base, "StrikePrice": str(strike_i)})
        return self._request_get_json_with_variants(url, params_candidates=params_candidates)

    def get_quote(self, instruments: list[dict[str, Any]], xts_message_code: int, publish_format: str = "JSON") -> dict[str, Any]:
        with self._quote_lock:
            return self._get_quote_unlocked(instruments, xts_message_code, publish_format)

    def _get_quote_unlocked(
        self, instruments: list[dict[str, Any]], xts_message_code: int, publish_format: str = "JSON"
    ) -> dict[str, Any]:
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/instruments/quotes"
        code = int(xts_message_code)

        # Normalize instruments: gateways can be picky about int vs str + key casing.
        normed: list[dict[str, Any]] = []
        for inst in instruments or []:
            seg = inst.get("exchangeSegment", inst.get("ExchangeSegment"))
            tid = inst.get("exchangeInstrumentID", inst.get("ExchangeInstrumentID"))
            if seg is None or tid is None:
                continue
            try:
                seg_i = int(seg)
                tid_i = int(tid)
            except Exception:
                continue
            if tid_i <= 0:
                continue
            normed.append({"exchangeSegment": seg_i, "exchangeInstrumentID": tid_i})

        # Build payload candidates (parity with `subscribe()` robustness).
        pascal_inst = [{"ExchangeSegment": x["exchangeSegment"], "ExchangeInstrumentID": x["exchangeInstrumentID"]} for x in normed]
        str_inst = [{"exchangeSegment": x["exchangeSegment"], "exchangeInstrumentID": str(x["exchangeInstrumentID"])} for x in normed]
        str_pascal = [{"ExchangeSegment": x["exchangeSegment"], "ExchangeInstrumentID": str(x["exchangeInstrumentID"])} for x in normed]
        payload_candidates: list[dict[str, Any]] = [
            {"instruments": normed, "xtsMessageCode": code, "publishFormat": publish_format},
            {"source": XTS_MD_SOURCE, "instruments": normed, "xtsMessageCode": code, "publishFormat": publish_format},
            {"instruments": pascal_inst, "xtsMessageCode": code, "publishFormat": publish_format},
            {"source": XTS_MD_SOURCE, "instruments": pascal_inst, "xtsMessageCode": code, "publishFormat": publish_format},
            {"instruments": str_inst, "xtsMessageCode": code, "publishFormat": publish_format},
            {"source": XTS_MD_SOURCE, "instruments": str_inst, "xtsMessageCode": code, "publishFormat": publish_format},
            {"instruments": str_pascal, "xtsMessageCode": code, "publishFormat": publish_format},
            {"source": XTS_MD_SOURCE, "instruments": str_pascal, "xtsMessageCode": code, "publishFormat": publish_format},
        ]

        self.ensure_session()
        last_exc: Exception | None = None
        for attempt in range(2):
            invalid_token_hit = False
            for hdr in self._auth_header_variants():
                for payload in payload_candidates:
                    try:
                        r = self.session.post(url, data=json.dumps(payload), headers=hdr, timeout=self.timeout_s)
                        snippet = (r.text or "").replace("\r", "").strip()[:900]

                        # Try to parse JSON regardless of status — vendor often sends meaningful body on 400.
                        data: Any = None
                        try:
                            data = r.json()
                        except Exception:
                            data = None

                        if _md_auth_failed(data, snippet, r.status_code):
                            invalid_token_hit = True
                            last_exc = RuntimeError(f"http {r.status_code}: {snippet[:200] or 'auth token missing'}")
                            continue

                        if isinstance(data, dict) and str(data.get("type") or data.get("Type") or "").lower() == "error":
                            desc = str(
                                data.get("description")
                                or data.get("message")
                                or data.get("status")
                                or snippet
                            )[:400]
                            last_exc = RuntimeError(f"http {r.status_code}: {desc}")
                            continue

                        if not r.ok:
                            last_exc = RuntimeError(f"http {r.status_code}: {snippet[:400] or r.reason}")
                            continue

                        if data is None:
                            last_exc = RuntimeError(f"non_json status={r.status_code} snippet={snippet[:240]}")
                            continue

                        return data if isinstance(data, dict) else {"type": "success", "result": data}
                    except Exception as e:
                        last_exc = e
                        continue

            if invalid_token_hit and attempt == 0:
                try:
                    self.login()
                    continue
                except Exception as e:
                    last_exc = e
            break

        raise last_exc or RuntimeError("quotes_failed")

    def get_ohlc(
        self,
        *,
        exchange_segment: int,
        exchange_instrument_id: int,
        start_time: str,
        end_time: str,
        compression_value: int | str = 60,
    ) -> dict[str, Any]:
        """
        Symphony intraday OHLC (1-min = compressionValue 60).
        GET /apibinarymarketdata/instruments/ohlc
        Docs: https://developers.symphonyfintech.in/doc/apimarketdata/#OHLC
        Response: result.dataReponse = ``ts|o|h|l|c|v|oi,ts|o|...``
        """
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/instruments/ohlc"
        seg = int(exchange_segment)
        iid = int(exchange_instrument_id)
        comp = str(compression_value)
        params_candidates: list[dict[str, Any]] = [
            {
                "exchangeSegment": seg,
                "exchangeInstrumentID": iid,
                "startTime": start_time,
                "endTime": end_time,
                "compressionValue": comp,
            },
            {
                "exchangeSegment": seg,
                "exchangeInstrumentID": iid,
                "startTime": start_time,
                "endTime": end_time,
                "compressionValue": int(comp) if comp.isdigit() else comp,
            },
            {
                "source": XTS_MD_SOURCE,
                "exchangeSegment": seg,
                "exchangeInstrumentID": iid,
                "startTime": start_time,
                "endTime": end_time,
                "compressionValue": comp,
            },
            {
                "ExchangeSegment": seg,
                "ExchangeInstrumentID": iid,
                "StartTime": start_time,
                "EndTime": end_time,
                "CompressionValue": comp,
            },
        ]
        return self._request_get_json_with_variants(url, params_candidates=params_candidates)

    def search_by_instrument_id(self, instruments: list[dict[str, Any]]) -> dict[str, Any]:
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/search/instrumentsbyid"

        normalized: list[dict[str, Any]] = []
        for x in instruments:
            seg = x.get("exchangeSegment", x.get("ExchangeSegment"))
            tid = x.get("exchangeInstrumentID", x.get("ExchangeInstrumentID"))
            if seg is not None and tid is not None:
                normalized.append({"exchangeSegment": int(seg), "exchangeInstrumentID": int(tid)})

        # Connect.py parity: `search_by_instrumentid` sends {"source", "instruments"} with raw Authorization.
        payload_variants: list[dict[str, Any]] = [
            {"source": XTS_MD_SOURCE, "instruments": normalized},
            {"instruments": normalized},
            {
                "source": XTS_MD_SOURCE,
                "instruments": [
                    {"ExchangeSegment": int(z["exchangeSegment"]), "ExchangeInstrumentID": int(z["exchangeInstrumentID"])}
                    for z in normalized
                ],
            },
            {
                "instruments": [
                    {"ExchangeSegment": int(z["exchangeSegment"]), "ExchangeInstrumentID": int(z["exchangeInstrumentID"])}
                    for z in normalized
                ]
            },
        ]

        self.ensure_session()
        last_err: Exception | None = None
        for attempt in range(2):
            invalid_token_hit = False
            for hdr in self._auth_header_variants():
                for payload in payload_variants:
                    try:
                        r = self.session.post(url, data=json.dumps(payload), headers=hdr, timeout=self.timeout_s)
                        snippet = (r.text or "").replace("\r", "").strip()[:900]
                        data: Any = None
                        try:
                            data = r.json()
                        except Exception:
                            data = None

                        if _md_auth_failed(data, snippet, r.status_code):
                            invalid_token_hit = True
                            last_err = RuntimeError(f"search_by_instrument_id HTTP {r.status_code}: {snippet[:200] or 'auth token missing'}")
                            continue

                        r.raise_for_status()
                        if data is None:
                            data = r.json()
                        if isinstance(data, list) and data:
                            data = next((x for x in data if isinstance(x, dict)), data[0])
                        if isinstance(data, dict) and data.get("type") == "error":
                            raise RuntimeError(str(data.get("description") or data))
                        return data if isinstance(data, dict) else {"result": data}
                    except Exception as e:
                        last_err = e
                        continue

            if invalid_token_hit and attempt == 0:
                try:
                    self.login()
                    continue
                except Exception as e:
                    last_err = e
            break

        raise last_err or RuntimeError("search_by_instrument_id_failed")

    def get_index_list(self, exchange_segment: int) -> dict[str, Any]:
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/instruments/indexlist"
        seg = int(exchange_segment)
        params_candidates = [{"exchangeSegment": seg}, {"ExchangeSegment": seg}, {"exchangeSegment": str(seg)}, {"ExchangeSegment": str(seg)}]
        return self._request_get_json_with_variants(url, params_candidates=params_candidates)

    def search_by_string(self, search_string: str) -> dict[str, Any]:
        """Symphony SDK route: GET /search/instruments …"""
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/search/instruments"
        q = str(search_string).strip()
        params_candidates = [{"searchString": q}, {"SearchString": q}, {"searchstring": q}]
        return self._request_get_json_with_variants(url, params_candidates=params_candidates)

    def instruments_master(self, exchange_segment_list: list[str]) -> dict[str, Any]:
        """
        POST /instruments/master
        Returns the raw dataset (often pipe-separated lines). Caller should persist/cache once per day.
        Doc: https://developers.symphonyfintech.in/doc/apimarketdata/#instruments-master
        """
        url = f"{XTS_MD_ROOT}/apibinarymarketdata/instruments/master"
        segs = [str(x).strip() for x in (exchange_segment_list or []) if str(x).strip()]
        if not segs:
            raise ValueError("exchange_segment_list is required")

        payload_candidates: list[dict[str, Any]] = [
            {"exchangeSegmentList": segs},
            {"ExchangeSegmentList": segs},
            {"exchangeSegmentList": [s.upper() for s in segs]},
            {"ExchangeSegmentList": [s.upper() for s in segs]},
        ]

        self.ensure_session()
        last_exc: Exception | None = None
        for attempt in range(2):
            invalid_token_hit = False
            for hdr in self._auth_header_variants():
                for payload in payload_candidates:
                    try:
                        r = self.session.post(url, json=payload, headers=hdr, timeout=self.timeout_s)
                        text = (r.text or "").replace("\r", "")

                        # If server returns JSON, prefer it.
                        data: Any = None
                        try:
                            data = r.json()
                        except Exception:
                            data = None

                        if _md_auth_failed(data, text, r.status_code):
                            invalid_token_hit = True
                            last_exc = RuntimeError(f"http {r.status_code}: {text.strip()[:200] or 'auth token missing'}")
                            continue

                        if isinstance(data, dict) and str(data.get("type") or data.get("Type") or "").lower() == "error":
                            desc = str(data.get("description") or data.get("message") or data.get("status") or text)[:400]
                            last_exc = RuntimeError(f"http {r.status_code}: {desc}")
                            continue

                        if not r.ok:
                            last_exc = RuntimeError(f"http {r.status_code}: {(text.strip()[:400] or r.reason)}")
                            continue

                        if data is not None:
                            return data if isinstance(data, dict) else {"type": "success", "result": data}

                        # Non-JSON success: return raw text as result.
                        return {"type": "success", "result": text}
                    except Exception as e:
                        last_exc = e
                        continue

            if invalid_token_hit and attempt == 0:
                try:
                    self.login()
                    continue
                except Exception as e:
                    last_exc = e
            break

        raise last_exc or RuntimeError("instruments_master_failed")


def flatten_json_strings(obj: Any) -> list[str]:
    out: list[str] = []
    if isinstance(obj, str):
        out.append(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            out.extend(flatten_json_strings(v))
    elif isinstance(obj, list):
        for v in obj:
            out.extend(flatten_json_strings(v))
    return out


def pick_expiry_for_label(expiry_label: str, candidates: list[str]) -> str | None:
    """
    Matches UI expiry like \"7 May\" / \"07 May\" / \"07May2026\" to one of broker strings from API list.
    """
    if not candidates:
        return None
    raw = str(expiry_label or "").strip()
    if not raw:
        return candidates[0]

    # If UI already sends ISO (recommended), match by exact date first.
    iso_m = re.match(r"^\s*(\d{4})-(\d{2})-(\d{2})", raw)
    if iso_m:
        y, mo, d = int(iso_m.group(1)), int(iso_m.group(2)), int(iso_m.group(3))
        iso_full = f"{y:04d}-{mo:02d}-{d:02d}T00:00:00"
        for c in candidates:
            if str(c).strip() == iso_full:
                return c
        patt = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
        for c in candidates:
            mc = patt.search(str(c))
            if mc and int(mc.group(1)) == y and int(mc.group(2)) == mo and int(mc.group(3)) == d:
                return c
        return candidates[0]

    # Compact UI token: 18Jun2026 / 18JUN2026
    compact = re.sub(r"[\s\-_/]", "", raw).upper()
    cm = re.match(r"^(\d{1,2})([A-Z]{3})(\d{4})$", compact)
    if cm:
        day_i = int(cm.group(1))
        mon3 = cm.group(2).upper()
        year_i = int(cm.group(3))
        months = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6, "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
        month_num = months.get(mon3)
        if month_num:
            iso_full = f"{int(year_i):04d}-{int(month_num):02d}-{int(day_i):02d}T00:00:00"
            for c in candidates:
                if str(c).strip() == iso_full:
                    return c
            patt = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
            for c in candidates:
                mc = patt.search(str(c))
                if mc and int(mc.group(1)) == year_i and int(mc.group(2)) == month_num and int(mc.group(3)) == day_i:
                    return c

    # Accept: "7 May", "07 May", "07May2026", "07 May 2026"
    m = re.match(r"^\s*(\d{1,2})\s*([a-z]{3,9})\s*(\d{4})?\s*$", raw, re.I)
    if not m:
        return candidates[0]
    day_i = int(m.group(1))
    day_s = str(day_i)  # 7
    month_prefix = m.group(2).lower()[:3]  # may
    year_i: int | None = None
    try:
        if m.group(3):
            year_i = int(m.group(3))
    except Exception:
        year_i = None
    months = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}

    month_num = months.get(month_prefix)
    if month_num and year_i:
        # Best: exact ISO token match (many vendors use midnight ISO strings)
        iso_full = f"{int(year_i):04d}-{int(month_num):02d}-{int(day_i):02d}T00:00:00"
        for c in candidates:
            if str(c).strip() == iso_full:
                return c
        # Prefer strict date matching when year is present (works with ISO "YYYY-MM-DDT..")
        patt = re.compile(r"(\d{4})-(\d{2})-(\d{2})")
        for c in candidates:
            mc = patt.search(str(c))
            if mc and int(mc.group(1)) == int(year_i) and int(mc.group(2)) == int(month_num) and int(mc.group(3)) == int(day_i):
                return c
    for c in candidates:
        lc = c.lower()
        ok_day = day_s in lc or f"{int(day_s):02d}" in lc
        ok_mon = month_prefix in lc if not month_num else any(
            lc.find(x) >= 0
            for x in (month_prefix, str(month_num), f"{month_num:02d}")
        )
        if ok_day and ok_mon:
            return c

    # fallback: substring match on month prefix
    for c in candidates:
        lc = c.lower()
        if month_prefix in lc and day_s in lc.replace(" ", ""):
            return c
    return candidates[0]


def first_exchange_instrument_id(obj: Any) -> int | None:
    keys = ("exchangeInstrumentID", "ExchangeInstrumentID", "instrumentID", "InstrumentID", "instrumentId", "InstrumentId")
    if obj is None:
        return None
    if isinstance(obj, dict):
        for k in keys:
            if k not in obj:
                continue
            v = obj[k]
            if isinstance(v, bool):
                continue
            if isinstance(v, int):
                return int(v)
            try:
                s = str(v).strip()
                if s.isdigit():
                    return int(s)
                return int(float(s))
            except Exception:
                continue
        for v in obj.values():
            x = first_exchange_instrument_id(v)
            if x is not None:
                return x
    if isinstance(obj, list):
        for v in obj:
            x = first_exchange_instrument_id(v)
            if x is not None:
                return x
    return None


def _positive_float(v: object) -> float | None:
    """Parse a plausible market price (>0) from JSON scalars/strings."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        x = float(v)
        return x if x > 0 else None
    if isinstance(v, str):
        try:
            x = float(v.replace(",", "").strip())
            return x if x > 0 else None
        except Exception:
            return None
    return None


def quote_first_ltp(obj: Any) -> float | None:
    """Pull LTP-like price from REST quote / search payloads (nested Touchline tolerated)."""

    def _dig_from_dict(item: dict[str, Any]) -> float | None:
        keyed = (
            "LastTradedPrice",
            "LastTradePrice",
            "lastTradePrice",
            "last_traded_price",
            "ClosePrice",
            "closeprice",
            "ltp",
            "LTP",
            "CMP",
            "LastPrice",
            "lastPrice",
            "TradingPrice",
        )
        # Common nesting: Touchline / touchline / quote / quotes
        for k in keyed:
            if k in item:
                n = _positive_float(item[k])
                if n is not None:
                    return n
        tl = (
            item.get("Touchline")
            or item.get("touchLine")
            or item.get("touchline")
            or item.get("TouchLine")
            or item.get("Quote")
            or item.get("quote")
        )
        if isinstance(tl, dict):
            return quote_first_ltp(tl)

        ql = item.get("Quotes") or item.get("quotes")
        if isinstance(ql, dict):
            for v in ql.values():
                x = quote_first_ltp(v)
                if x is not None:
                    return x

        qs = item.get("InstrumentQuoteList") or item.get("instruments") or item.get("instrumentsList")
        if isinstance(qs, list) and qs:
            return quote_first_ltp(qs[0])

        return None

    if obj is None:
        return None
    if isinstance(obj, dict):
        x = _dig_from_dict(obj)
        if x is not None:
            return x
        if obj.get("type") == "success":
            inner = quote_first_ltp(obj.get("result"))
            if inner:
                return inner
        for v in obj.values():
            found = quote_first_ltp(v)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = quote_first_ltp(v)
            if found is not None:
                return found

    loose = loose_ltp_walk(obj)
    return loose


def loose_ltp_walk(obj: Any, depth: int = 0) -> float | None:
    """Last resort: any dict key implying LTP paired with numeric value."""
    if depth > 12 or obj is None:
        return None
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = str(k).lower().replace("_", "").replace(" ", "")
            if (
                any(s in kl for s in ("lasttrade", "ltp", "closeprice", "lastprice"))
                and not kl.endswith("percentage")
                and not kl.endswith("change")
            ):
                n = loose_ltp_walk(v, depth + 1) if isinstance(v, (dict, list)) else _positive_float(v)
                if n is not None and n > 0:
                    return n
        for v in obj.values():
            x = loose_ltp_walk(v, depth + 1)
            if x is not None:
                return x
    elif isinstance(obj, list):
        for it in obj:
            x = loose_ltp_walk(it, depth + 1)
            if x is not None:
                return x
    return None


def _expand_json_strings(obj: Any, depth: int = 0) -> Any:
    """XTS sometimes returns quote dicts as JSON-encoded strings (see Symphony docs)."""
    if depth > 8 or obj is None:
        return obj
    if isinstance(obj, str):
        s = obj.strip()
        if len(s) >= 2 and s[0] in "{[":
            try:
                return _expand_json_strings(json.loads(s), depth + 1)
            except Exception:
                return obj
        return obj
    if isinstance(obj, dict):
        return {k: _expand_json_strings(v, depth + 1) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_expand_json_strings(v, depth + 1) for v in obj]
    return obj


def _touchline_last_traded_price(block: dict[str, Any]) -> float | None:
    """XTS Snap Quote LTP field only — never Close/Open/High/mid."""
    if not isinstance(block, dict):
        return None
    keys = (
        "LastTradedPrice",
        "lastTradedPrice",
        "LastTradePrice",
        "lastTradePrice",
        "LTP",
        "ltp",
    )

    def pick(d: dict[str, Any]) -> float | None:
        for k in keys:
            n = _positive_float(d.get(k))
            if n is not None:
                return n
        return None

    n = pick(block)
    if n is not None:
        return n
    tl = block.get("Touchline") or block.get("touchline") or block.get("TouchLine") or block.get("touchLine")
    if isinstance(tl, dict):
        return pick(tl)
    return None


def _touchline_derived_price(block: dict[str, Any]) -> float | None:
    """Index/pre-open fallback when LastTradedPrice is 0. Not used for option hunt LTP."""
    if not isinstance(block, dict):
        return None

    def from_touchline(tl: dict[str, Any]) -> float | None:
        for k in ("LastTradedPrice", "Close", "Open", "High", "Low", "AverageTradedPrice"):
            n = _positive_float(tl.get(k))
            if n is not None:
                return n
        bid = tl.get("BidInfo") if isinstance(tl.get("BidInfo"), dict) else {}
        ask = tl.get("AskInfo") if isinstance(tl.get("AskInfo"), dict) else {}
        bp = _positive_float(bid.get("Price"))
        ap = _positive_float(ask.get("Price"))
        if bp is not None and ap is not None:
            return (bp + ap) / 2.0
        if ap is not None:
            return ap
        if bp is not None:
            return bp
        return None

    for k in ("LastTradedPrice", "Close", "Open", "High", "Low"):
        n = _positive_float(block.get(k))
        if n is not None:
            return n

    tl = block.get("Touchline") or block.get("touchline") or block.get("TouchLine")
    if isinstance(tl, dict):
        n = from_touchline(tl)
        if n is not None:
            return n

    for side in ("Bids", "Asks"):
        row = block.get(side)
        if isinstance(row, dict):
            n = _positive_float(row.get("Price"))
            if n is not None:
                return n

    return None


def _iter_quote_leaf_dicts(obj: Any) -> Iterable[dict[str, Any]]:
    obj = _expand_json_strings(obj)
    if isinstance(obj, dict):
        lq = obj.get("listQuotes")
        if isinstance(lq, list):
            for it in lq:
                if isinstance(it, dict):
                    yield it
        elif isinstance(lq, dict):
            yield lq
        inner = obj.get("result")
        if inner is not None and inner is not obj:
            yield from _iter_quote_leaf_dicts(inner)
        for v in obj.values():
            if isinstance(v, (dict, list)) and v is not inner and v is not lq:
                if isinstance(v, dict) and (
                    v.get("Touchline") or v.get("LastTradedPrice") is not None or v.get("MessageCode")
                ):
                    yield v
                elif isinstance(v, (dict, list)):
                    yield from _iter_quote_leaf_dicts(v)
    elif isinstance(obj, list):
        for it in obj:
            yield from _iter_quote_leaf_dicts(it)


def _ltp_from_subscription_or_quote_response(resp: Any) -> float | None:
    """
    Many XTS hosts return the first snapshot in subscription REST `result.listQuotes`
    (each entry may be a JSON string). XTS_OPTIONS_DASHBOARD relies on this before get_quote.
    """
    if not isinstance(resp, dict):
        return None
    res = resp.get("result")
    if isinstance(res, dict):
        lq = res.get("listQuotes") or res.get("listquotes") or res.get("ListQuotes")
        if isinstance(lq, list) and lq:
            first = lq[0]
            if isinstance(first, str):
                try:
                    first = json.loads(first)
                except Exception:
                    return quote_best_from_response(first)
            p = quote_best_from_response(first)
            if p is not None and p > 0:
                return float(p)
    return quote_best_from_response(resp)


def quote_best_from_response(obj: Any) -> float | None:
    """Stronger than quote_first_ltp: handles stringified JSON + index LTP=0 fallbacks."""
    if obj is None:
        return None
    expanded = _expand_json_strings(obj)
    if isinstance(expanded, list):
        for el in expanded:
            n = quote_best_from_response(el)
            if n is not None and n > 0:
                return float(n)
    if isinstance(expanded, dict):
        res_any = expanded.get("result")
        if isinstance(res_any, list):
            for el in res_any:
                n = quote_best_from_response(el)
                if n is not None and n > 0:
                    return float(n)
    if isinstance(expanded, dict) and expanded.get("type") == "success":
        leafs = list(_iter_quote_leaf_dicts(expanded.get("result")))
        if not leafs:
            leafs = list(_iter_quote_leaf_dicts(expanded))
    else:
        leafs = list(_iter_quote_leaf_dicts(expanded))

    for leaf in leafs:
        p = _touchline_derived_price(leaf)
        if p is not None and p > 0:
            return float(p)

    # Flat stringified touchline blob (no listQuotes nesting)
    if isinstance(expanded, dict):
        p = _touchline_derived_price(expanded)
        if p is not None and p > 0:
            return float(p)

    legacy = quote_first_ltp(expanded)
    if legacy is not None and legacy > 0:
        return float(legacy)
    loose = loose_ltp_walk(expanded)
    return float(loose) if loose is not None and loose > 0 else None


_PREVIOUS_CLOSE_KEYS: tuple[str, ...] = (
    "PreviousClose",
    "previousClose",
    "PreviousDayClose",
    "previousdayclose",
    "PrevClose",
    "prevClose",
    "YesterdayClose",
    "yesterdayClose",
    # Symphony / XTS Touchline: "Close" = previous session close (see packet_decoder).
    "Close",
    "close",
)
_PREVIOUS_CLOSE_LOOSE_KEYS: tuple[str, ...] = (
    "ClosePrice",
    "closeprice",
    "ClosingPrice",
    "closingprice",
)
_NET_PCT_KEYS: tuple[str, ...] = (
    "PercentChange",
    "percentChange",
    "PercentageChange",
    "percentageChange",
    "NetChangePercent",
    "ChangePercent",
    "changepercent",
)
_NET_CHANGE_ABS_KEYS: tuple[str, ...] = (
    "NetChange",
    "netChange",
    "Change",
    "change",
    "NetPriceChange",
    "netPriceChange",
    "PriceChange",
    "priceChange",
    "AbsoluteChange",
    "absoluteChange",
)


def _net_change_abs_from_touchlike(d: dict[str, Any]) -> float | None:
    if not isinstance(d, dict):
        return None
    for pk in _NET_CHANGE_ABS_KEYS:
        v = d.get(pk)
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)) and v == v and abs(float(v)) > 1e-6:
            return float(v)
        if isinstance(v, str):
            try:
                x = float(v.replace(",", "").strip())
                if x == x and abs(x) > 1e-6:
                    return float(x)
            except Exception:
                continue
    return None


def _ltp_from_touchlike(d: dict[str, Any]) -> float | None:
    if not isinstance(d, dict):
        return None
    return _positive_float(
        d.get("LastTradedPrice")
        or d.get("lastTradedPrice")
        or d.get("LTP")
        or d.get("ltp")
        or d.get("LastTraded")
    )


def _prev_close_distinct_from_ltp(prev: float, ltp: float | None) -> bool:
    if ltp is None or ltp <= 0:
        return prev > 0
    return abs(float(prev) - float(ltp)) >= max(0.01, float(ltp) * 1e-5)


def _prev_close_from_touchlike(d: dict[str, Any], ltp_hint: float | None = None) -> float | None:
    """Previous session close only — reject bogus prev == LTP and zero net/% placeholders."""
    if not isinstance(d, dict):
        return None
    ltp = _ltp_from_touchlike(d)
    if (ltp is None or ltp <= 0) and ltp_hint is not None and float(ltp_hint) > 0:
        ltp = float(ltp_hint)
    for pk in _PREVIOUS_CLOSE_KEYS:
        n = _positive_float(d.get(pk))
        if n is not None and _prev_close_distinct_from_ltp(float(n), ltp):
            return float(n)
    for pk in _PREVIOUS_CLOSE_LOOSE_KEYS:
        n = _positive_float(d.get(pk))
        if n is not None and _prev_close_distinct_from_ltp(float(n), ltp):
            return float(n)
    net = _net_change_abs_from_touchlike(d)
    if ltp is not None and net is not None:
        pc = float(ltp) - float(net)
        if pc > 0 and _prev_close_distinct_from_ltp(pc, ltp):
            return pc
    pct = _net_pct_from_touchlike(d)
    if ltp is not None and pct is not None and abs(float(pct)) > 1e-6:
        denom = 1.0 + float(pct) / 100.0
        if abs(denom) > 1e-12:
            pc = float(ltp) / denom
            if pc > 0 and _prev_close_distinct_from_ltp(pc, ltp):
                return pc
    return None


def _net_pct_from_touchlike(d: dict[str, Any]) -> float | None:
    if not isinstance(d, dict):
        return None
    for pk in _NET_PCT_KEYS:
        v = d.get(pk)
        if isinstance(v, bool):
            continue
        if isinstance(v, (int, float)) and v == v:
            return float(v)
        if isinstance(v, str):
            try:
                x = float(v.replace(",", "").strip())
                if x == x:
                    return float(x)
            except Exception:
                continue
    return None


_DAY_OPEN_KEYS: tuple[str, ...] = ("Open", "open", "OpeningPrice", "openingprice", "DayOpen", "dayopen")


def _day_open_from_touchlike(d: dict[str, Any]) -> float | None:
    if not isinstance(d, dict):
        return None
    for pk in _DAY_OPEN_KEYS:
        n = _positive_float(d.get(pk))
        if n is not None:
            return float(n)
    return None


def _exchange_day_high_low(d: dict[str, Any]) -> tuple[float | None, float | None]:
    """Day/session high · low from a Touchline-like quote dict (broker keys vary)."""
    if not isinstance(d, dict):
        return None, None
    dh = (
        _positive_float(d.get("High"))
        or _positive_float(d.get("DayHigh"))
        or _positive_float(d.get("dayHigh"))
        or _positive_float(d.get("SessionHigh"))
    )
    dl = (
        _positive_float(d.get("Low"))
        or _positive_float(d.get("DayLow"))
        or _positive_float(d.get("dayLow"))
        or _positive_float(d.get("SessionLow"))
    )
    if dh is None or dl is None:
        return None, None
    if dh < dl:
        dh, dl = dl, dh
    return float(dh), float(dl)


def _anchor_fields_scan_dicts(dicts: list[dict[str, Any]]) -> tuple[float | None, float | None, float | None, float | None, float | None]:
    prev_t: float | None = None
    pct_t: float | None = None
    dop_t: float | None = None
    dh_t: float | None = None
    dl_t: float | None = None
    for d in dicts:
        if prev_t is None:
            prev_t = _prev_close_from_touchlike(d)
        if pct_t is None:
            pct_t = _net_pct_from_touchlike(d)
        if dop_t is None:
            dop_t = _day_open_from_touchlike(d)
        if dh_t is None or dl_t is None:
            hi, lo = _exchange_day_high_low(d)
            if hi is not None and lo is not None:
                dh_t, dl_t = hi, lo
    return prev_t, pct_t, dop_t, dh_t, dl_t


def quote_spot_anchor_fields_from_response(
    obj: Any,
) -> tuple[float | None, float | None, float | None, float | None, float | None]:
    """
    Touchline fields from REST quote JSON: prev close, %, session open, day high, day low.

    Keeps sockets honest when the dashboard only receives partial ticks (legacy 1502).
    """
    none5: tuple[float | None, float | None, float | None, float | None, float | None] = (None, None, None, None, None)
    if obj is None:
        return none5
    expanded = _expand_json_strings(obj)
    if isinstance(expanded, list):
        open_fb = none5
        hl_fb = none5
        for el in expanded:
            pc, pt, op, dh, dl = quote_spot_anchor_fields_from_response(el)
            if pc is not None:
                return pc, pt, op, dh, dl
            if open_fb[2] is None and op is not None:
                open_fb = (pc, pt, op, dh, dl)
            if hl_fb[3] is None and dh is not None and dl is not None:
                hl_fb = (pc, pt, op, dh, dl)
        if open_fb != none5:
            _, pt, dop, qh, ql = open_fb
            dh2, dl2 = hl_fb[3], hl_fb[4]
            if (qh is None or ql is None) and dh2 is not None and dl2 is not None:
                qh, ql = dh2, dl2
            return None, pt, dop, qh, ql
        if hl_fb != none5:
            return hl_fb[0], hl_fb[1], hl_fb[2], hl_fb[3], hl_fb[4]
        return none5
    if isinstance(expanded, dict) and expanded.get("type") == "success":
        leafs = list(_iter_quote_leaf_dicts(expanded.get("result")))
        if not leafs:
            leafs = list(_iter_quote_leaf_dicts(expanded))
    else:
        leafs = list(_iter_quote_leaf_dicts(expanded))

    open_only: tuple[float | None, float | None, float | None, float | None, float | None] | None = None
    hl_only: tuple[float | None, float | None, float | None, float | None, float | None] | None = None
    for leaf in leafs:
        if not isinstance(leaf, dict):
            continue
        dicts: list[dict[str, Any]] = [leaf]
        for k in ("Touchline", "touchline", "TouchLine", "Quote", "quote"):
            v = leaf.get(k)
            if isinstance(v, dict):
                dicts.append(v)
        prev, pct, dop, dh, dl = _anchor_fields_scan_dicts(dicts)
        if prev is not None:
            return prev, pct, dop, dh, dl
        if open_only is None and dop is not None:
            open_only = (None, pct, dop, dh, dl)
        if hl_only is None and dh is not None and dl is not None:
            hl_only = (None, pct, dop, dh, dl)
    if open_only is not None:
        _, pt, dop, qh, ql = open_only
        if (qh is None or ql is None) and hl_only is not None:
            qh2, ql2 = hl_only[3], hl_only[4]
            if qh2 is not None and ql2 is not None:
                qh, ql = qh2, ql2
        return None, pt, dop, qh, ql
    if hl_only is not None:
        return hl_only
    return none5


def _parse_index_list_entries(data: dict[str, Any], segment: int) -> list[tuple[int, str, int]]:
    """
    Parses indexlist strings like 'NIFTY 50_26000' → (segment, name, instrument_id).
    """
    out: list[tuple[int, str, int]] = []
    res = data.get("result") if isinstance(data.get("result"), dict) else None
    if not res:
        return out
    raw_list = res.get("indexList") or res.get("indexlist")
    if not isinstance(raw_list, list):
        return out
    for line in raw_list:
        if not isinstance(line, str) or "_" not in line:
            continue
        name_part, tid = line.rsplit("_", 1)
        tid_s = tid.strip()
        if not tid_s.isdigit():
            continue
        out.append((int(segment), name_part.strip(), int(tid_s)))
    return out


# Common UI/index key → exact instrument names that appear in /instruments/indexlist (case-insensitive).
# These are taken from a verified Investeria response (segment=1):
#     NIFTY 50_26000, NIFTY BANK_26001, INDIA VIX_26002, …
INDEX_NAME_ALIASES: dict[str, tuple[str, ...]] = {
    "NIFTY": ("NIFTY 50",),
    "NIFTY50": ("NIFTY 50",),
    "BANKNIFTY": ("NIFTY BANK", "BANK NIFTY"),
    "NIFTYBANK": ("NIFTY BANK", "BANK NIFTY"),
    "VIX": ("INDIA VIX",),
    "INDIAVIX": ("INDIA VIX",),
    "SENSEX": ("SENSEX", "BSE SENSEX", "S&P BSE SENSEX"),
}


def _index_name_match_score(target_norm: str, candidate_norm: str) -> int:
    """0=exact, 1=token-set match, 2=substring, 99=no match. Smaller is better."""
    if not target_norm or not candidate_norm:
        return 99
    if target_norm == candidate_norm:
        return 0
    if set(target_norm.split()) == set(candidate_norm.split()):
        return 1
    if f" {target_norm} " in f" {candidate_norm} ":
        return 2
    if target_norm.replace(" ", "") == candidate_norm.replace(" ", ""):
        return 1
    return 99


def discover_index_probes(cli: XtsMarketDataClient, name_hint: str, segments: Iterable[int]) -> list[tuple[int, int]]:
    """
    Uses GET /instruments/indexlist to find exchangeInstrumentID + segment for an index.
    Prefers exact name match (e.g. ``NIFTY 50`` over ``NIFTY 50 EQL WGT``); falls back to
    a substring match if no exact / token‑set match is available.
    """
    hint = (name_hint or "").strip().upper()
    if not hint:
        return []
    targets = list(INDEX_NAME_ALIASES.get(hint, ())) or [hint]
    target_norms = [re.sub(r"\s+", " ", t.strip().upper()) for t in targets]

    scored: list[tuple[int, tuple[int, int]]] = []
    seen: set[tuple[int, int]] = set()
    fallback: list[tuple[int, int]] = []

    for seg in segments:
        try:
            data = cli.get_index_list(int(seg))
        except Exception:
            continue
        if not isinstance(data, dict):
            continue
        for s, nm, tid in _parse_index_list_entries(data, int(seg)):
            cand_norm = re.sub(r"\s+", " ", str(nm).strip().upper())
            best = 99
            for t in target_norms:
                sc = _index_name_match_score(t, cand_norm)
                if sc < best:
                    best = sc
            key = (int(s), int(tid))
            if key in seen:
                continue
            if best <= 1:  # exact / token-set
                scored.append((best, key))
                seen.add(key)
            elif best == 2:  # substring
                if key not in seen:
                    fallback.append(key)
                    seen.add(key)

    scored.sort(key=lambda x: x[0])
    out: list[tuple[int, int]] = [k for _, k in scored]
    out.extend(fallback)
    return out


def resolve_spot_token_by_name(
    cli: XtsMarketDataClient, name_hint: str, segments: Iterable[int]
) -> tuple[int, int] | None:
    """Returns first (segment, instrumentID) whose name exactly matches an alias, else None."""
    found = discover_index_probes(cli, name_hint, segments)
    return found[0] if found else None


def spot_probes_from_string_search(cli: XtsMarketDataClient, query: str) -> list[tuple[int, int]]:
    """Uses GET /search/instruments — picks rows that look like cash/spot indices."""
    q = (query or "").strip()
    if not q:
        return []
    seen: set[tuple[int, int]] = set()
    out: list[tuple[int, int]] = []
    try:
        raw = cli.search_by_string(q)
        raw = _expand_json_strings(raw)
    except Exception:
        return []

    def visit(o: Any):
        if isinstance(o, dict):
            seg = o.get("exchangeSegment", o.get("ExchangeSegment"))
            tid = first_exchange_instrument_id(o)
            if seg is not None and tid is not None:
                key = (int(seg), int(tid))
                if key not in seen:
                    seen.add(key)
                    out.append(key)
            for v in o.values():
                visit(v)
        elif isinstance(o, list):
            for it in o:
                visit(it)

    visit(raw.get("result") if isinstance(raw, dict) else raw)
    visit(raw)
    # Prefer cash / index segments; drop obvious derivative rows that also match the text search.
    allow_seg = {1, 2, 11, 12}
    return [p for p in out if p[0] in allow_seg]


def fetch_index_spot_ltp(
    cli: XtsMarketDataClient,
    segment_token_pairs: list[tuple[int, int]],
    message_codes: tuple[int, ...] = (1504, 1502, 1501, 1512),
    *,
    discover_name_hint: str | None = None,
    discover_segments: tuple[int, ...] = (1, 11, 12, 2),
    string_queries: tuple[str, ...] = (),
) -> tuple[
    float | None,
    int | None,
    int | None,
    int | None,
    str | None,
    float | None,
    float | None,
    float | None,
    float | None,
    float | None,
]:
    """
    Try (segment, token) × quote message codes (with robust quote parsing).

    Optionally extends probes via indexlist + `/search/instruments` when Sensex/other index
    token differs between vendors.
    Returns ltp tuple + diagnostics + anchor fields from the winning quote when present:
    previous_close, percent_change, session open, exchange day high, exchange day low.
    """
    merged: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    discovered: list[tuple[int, int]] = []
    indexlist_note = ""

    # Step 1: prefer probes resolved by **exact name match** in /instruments/indexlist.
    if discover_name_hint:
        nh = discover_name_hint.strip().upper()
        try:
            discovered = discover_index_probes(cli, nh, discover_segments)
            if discovered:
                indexlist_note = (
                    f"indexlist_resolved={discovered[0][0]}:{discovered[0][1]}"
                    + (f" (alt={','.join(f'{s}:{t}' for s, t in discovered[1:5])})" if len(discovered) > 1 else "")
                )
            else:
                indexlist_note = "indexlist_no_match"
        except Exception as e:
            indexlist_note = f"indexlist_failed: {e!s}"
        for p in discovered:
            if p not in seen:
                merged.append(p)
                seen.add(p)

    # Step 2: explicit probes the caller supplied (defaults from spec).
    for pair in segment_token_pairs:
        if pair not in seen:
            merged.append(pair)
            seen.add(pair)

    # Step 3: string-search fallback for vendor-specific names.
    if discover_name_hint:
        nh = discover_name_hint.strip().upper()
        queries = string_queries if string_queries else ((nh,) if nh else ())
        extra_q = ("BSE SENSEX", "S&P BSE SENSEX") if nh == "SENSEX" else ()
        for q in tuple(dict.fromkeys((*queries, *extra_q))):
            if not str(q).strip():
                continue
            for p in spot_probes_from_string_search(cli, str(q)):
                if p not in seen:
                    merged.append(p)
                    seen.add(p)

    if len(merged) > 48:
        merged = merged[:48]

    notes: list[str] = []
    if indexlist_note:
        notes.append(indexlist_note)
    for seg, tid in merged:
        inst = [{"exchangeSegment": int(seg), "exchangeInstrumentID": int(tid)}]
        for code in message_codes:
            try:
                raw = cli.get_quote(inst, int(code))
                ltp = quote_best_from_response(raw)
                if ltp is not None and ltp > 0:
                    pcp, pctp, dopn, day_hi, day_lo = quote_spot_anchor_fields_from_response(raw)
                    return (
                        float(ltp),
                        int(seg),
                        int(tid),
                        int(code),
                        indexlist_note or None,
                        pcp,
                        pctp,
                        dopn,
                        day_hi,
                        day_lo,
                    )
                notes.append(f"quotes seg={seg} id={tid} code={code}: no_positive_ltp")
            except Exception as e:
                notes.append(f"quotes seg={seg} id={tid} code={code}: {e!s}")

    diag = "; ".join(notes[:36])
    diag = diag[:1800] if len(diag) > 1800 else diag

    for seg, tid in merged[:32]:
        try:
            s = cli.search_by_instrument_id([{"exchangeSegment": int(seg), "exchangeInstrumentID": int(tid)}])
            ltp = quote_best_from_response(s)
            if ltp is not None and ltp > 0:
                pcp, pctp, dopn, day_hi, day_lo = quote_spot_anchor_fields_from_response(s)
                return (
                    float(ltp),
                    int(seg),
                    int(tid),
                    None,
                    f"resolved_via_search; quotes_tried={diag[:520]}",
                    pcp,
                    pctp,
                    dopn,
                    day_hi,
                    day_lo,
                )
        except Exception as e:
            diag = (diag + f" | search seg={seg} id={tid}: {e!s}")[:1800]

    if len(merged) > len(segment_token_pairs):
        suffix = [f"{s}:{t}" for s, t in merged[len(segment_token_pairs) :][:10]]
        diag = (diag + "; extra_probes=" + ",".join(suffix))[:2000]

    return None, None, None, None, diag or "unknown_quote_failure", None, None, None, None, None


def normalize_spot_probes(spec: dict[str, object]) -> list[tuple[int, int]]:
    primary = [(int(spec["spot_segment"]), int(spec["spot_token"]))]
    extra = spec.get("spot_probe")
    if isinstance(extra, list):
        out: list[tuple[int, int]] = []
        for item in extra:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                out.append((int(item[0]), int(item[1])))
            elif isinstance(item, dict):
                s_k = item.get("s") or item.get("segment") or item.get("exchangeSegment")
                i_k = item.get("id") or item.get("instrumentId") or item.get("exchangeInstrumentID")
                if s_k is not None and i_k is not None:
                    out.append((int(s_k), int(i_k)))
        # de-dupe
        merged = []
        seen: set[tuple[int, int]] = set()
        for pair in primary + out:
            if pair not in seen:
                merged.append(pair)
                seen.add(pair)
        return merged
    return primary


def _socketio_text_from_bytes(raw: bytes) -> str | None:
    """Socket.IO text packet carried as bytes, or None for an XTS binary blob.

    A real packet starts with ASCII ``0``–``6``. XTS binary starts with a gzip
    flag ``0x00`` or ``0x01``, which ``int(b'\\x01')`` cannot parse.
    """
    if not raw:
        return None
    first = raw[0]
    if 48 <= first <= 54:  # '0' .. '6'
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if first > 6:
        return None
    body = raw[1:]
    if not body or body[0] in (0, 1):
        return None
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if text[0] in "0123456789/[{":
        # Packet type was a raw byte 0–6, not the ASCII digit.
        return chr(48 + first) + text
    return None


def _socket_transport_dropped(exc: BaseException) -> bool:
    """True for a dead websocket. These must not escape the Engine.IO write thread."""
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return True
    return "WebSocket" in type(exc).__name__


def _install_xts_socketio_order_fix() -> None:
    """Keep XTS binary frames on the ``xts-binary-packet`` handler.

    python-socketio 4.6 runs each Engine.IO message on its own thread, so the
    binary attachment often arrives before the placeholder is stored and is
    decoded as a text packet (``ValueError: invalid literal ... b'\\\\x01'``).
    Messages are applied on the websocket read thread, in order. The user
    handler still runs on a side thread so a tick cannot stall the next read.
    """
    import engineio.client as eio_client
    import engineio.packet as eio_packet
    import socketio.client as sio_client
    import socketio.packet as sio_packet

    if getattr(sio_client.Client, "_sonofwind_bin_fix", False):
        return

    orig_recv = eio_client.Client._receive_packet
    orig_write_loop = eio_client.Client._write_loop

    def _receive_packet(self, pkt):
        if pkt.packet_type == eio_packet.MESSAGE:
            handler = self.handlers.get("message")
            if handler is not None:
                try:
                    handler(pkt.data)
                except Exception:
                    self.logger.exception("message handler error")
            return
        return orig_recv(self, pkt)

    def _run_event(client, namespace, pkt_id, data) -> None:
        try:
            client._handle_event(namespace, pkt_id, data)
        except Exception:
            client.logger.exception("xts socketio event error")

    def _take_socketio_events(client, data):
        events: list[tuple[Any, Any, Any]] = []

        def _consider(pkt) -> None:
            if pkt.packet_type == sio_packet.CONNECT:
                client._handle_connect(pkt.namespace)
            elif pkt.packet_type == sio_packet.DISCONNECT:
                client._handle_disconnect(pkt.namespace)
            elif pkt.packet_type == sio_packet.EVENT:
                events.append((pkt.namespace, pkt.id, pkt.data))
            elif pkt.packet_type == sio_packet.ACK:
                client._handle_ack(pkt.namespace, pkt.id, pkt.data)
            elif pkt.packet_type in (sio_packet.BINARY_EVENT, sio_packet.BINARY_ACK):
                client._binary_packet = pkt
            elif pkt.packet_type == sio_packet.ERROR:
                client._handle_error(pkt.namespace, pkt.data)
            else:
                raise ValueError("Unknown packet type.")

        if isinstance(data, (bytes, bytearray)) and not client._binary_packet:
            raw = bytes(data)
            text = _socketio_text_from_bytes(raw)
            if text is None:
                events.append((None, None, ["xts-binary-packet", raw]))
                return events
            data = text

        if client._binary_packet:
            pkt = client._binary_packet
            try:
                ready = pkt.add_attachment(data)
            except ValueError:
                client._binary_packet = None
                if isinstance(data, (bytes, bytearray)):
                    events.append((None, None, ["xts-binary-packet", bytes(data)]))
                return events
            if ready:
                client._binary_packet = None
                if pkt.packet_type == sio_packet.BINARY_EVENT:
                    events.append((pkt.namespace, pkt.id, pkt.data))
                else:
                    client._handle_ack(pkt.namespace, pkt.id, pkt.data)
            return events

        _consider(sio_packet.Packet(encoded_packet=data))
        return events

    def _handle_eio_message(self, data):
        try:
            events = _take_socketio_events(self, data)
        except ValueError:
            if isinstance(data, (bytes, bytearray)):
                events = [(None, None, ["xts-binary-packet", bytes(data)])]
            else:
                raise
        for namespace, pkt_id, payload in events:
            threading.Thread(
                target=_run_event,
                args=(self, namespace, pkt_id, payload),
                name="md-sio",
            ).start()

    def _write_loop(self):
        # engineio only catches WebSocketConnectionClosedException. Windows raises
        # ConnectionAbortedError (WinError 10053) from ssl.send, which escapes the
        # thread and dumps a traceback. Close the socket so the read loop emits
        # disconnect, then let MarketDataStreamer reconnect.
        try:
            return orig_write_loop(self)
        except Exception as exc:
            if not _socket_transport_dropped(exc):
                raise
            ws = getattr(self, "ws", None)
            if ws is not None:
                try:
                    ws.close()
                except Exception:
                    pass
            cb = getattr(self, "_sonofwind_on_dead", None)
            if cb is not None:
                try:
                    cb()
                except Exception:
                    pass

    eio_client.Client._receive_packet = _receive_packet
    eio_client.Client._write_loop = _write_loop
    sio_client.Client._handle_eio_message = _handle_eio_message
    sio_client.Client._sonofwind_bin_fix = True


class MarketDataStreamer:
    """
    Singleton-ish helper:
    - logs into XTS marketdata
    - connects Socket.IO
    - subscribes instruments
    - publishes decoded LTP ticks into per-subscriber queues
    """

    def __init__(self):
        self._lock = threading.RLock()
        # Serialize start()/connect — parallel Flask requests used to race _connect and hang.
        self._start_mutex = threading.Lock()
        self._started = False
        self._api_key = ""
        self._api_secret = ""
        self._client: XtsMarketDataClient | None = None
        self._sid = None
        self._subs: set[tuple[int, int]] = set()  # (seg, id)
        self._sub_tokens: set[int] = set()  # instrument id — match ticks even if packet segment differs
        self._listeners: set[SseTickPipe] = set()
        self._listeners_snapshot: tuple[SseTickPipe, ...] = ()
        self._pipeline_sink: Callable[[dict[str, Any]], None] | None = None
        self._coalesce_lock = threading.Lock()
        self._coalesce: dict[tuple[int, int], dict[str, Any]] = {}
        self._coalesce_last_flush = time.monotonic()
        self._coalesce_flush_stop: threading.Event | None = None
        self._coalesce_flush_started = False
        self._sink_q: Queue = Queue(maxsize=20000)
        self._sink_started = False
        self._latest_sse: dict[int, dict[str, Any]] = {}
        self._atp_refresh_stop: threading.Event | None = None
        self._atp_thread_started = False
        self._atp_refresh_lock = threading.Lock()
        self._atp_refresh_offset = 0
        self._ema21_bootstrapped: set[int] = set()
        self._last_socket_rx_mono = time.monotonic()
        self._reconnect_lock = threading.Lock()
        self._reconnect_inflight = False
        self._expect_socket_drop = False
        self._watchdog_stop: threading.Event | None = None
        self._watchdog_started = False
        self._ensure_alive_scheduled = False
        self._last_ensure_alive_mono = 0.0
        self._last_soft_reconnect_mono = 0.0
        self._rx_counts: dict[str, int] = {}
        self._connect_mono = time.monotonic()
        self._format_flipped = False
        self._partial_paint_mono: dict[int, float] = {}
        self._json_full_q: Queue = Queue(maxsize=64)
        self._json_full_started = False
        self._hot_lock = threading.Lock()
        self._hot_tokens: dict[int, int] = {}  # tid -> exchangeSegment
        self._hot_last_ltp: dict[int, float] = {}
        self._hot_focus_stop: threading.Event | None = None
        self._hot_focus_started = False

    def _refresh_listener_snapshot(self) -> None:
        self._listeners_snapshot = tuple(self._listeners)

    def _shutdown_locked(self) -> list[dict[str, int]]:
        """Disconnect socket + MD session. Returns instruments to re-subscribe after restart."""
        pending = [
            {"exchangeSegment": int(seg), "exchangeInstrumentID": int(tid)}
            for seg, tid in sorted(self._subs)
            if int(seg) > 0 and int(tid) > 0
        ]
        sid = self._sid
        self._sid = None
        self._client = None
        self._started = False
        self._api_key = ""
        self._api_secret = ""
        self._subs.clear()
        self._sub_tokens.clear()
        with self._coalesce_lock:
            self._coalesce.clear()
            self._coalesce_last_flush = time.monotonic()
        self._latest_sse.clear()
        cstop = self._coalesce_flush_stop
        if cstop is not None:
            cstop.set()
        self._coalesce_flush_started = False
        self._coalesce_flush_stop = None
        stop = self._atp_refresh_stop
        if stop is not None:
            stop.set()
        self._atp_thread_started = False
        self._atp_refresh_stop = None
        wstop = self._watchdog_stop
        if wstop is not None:
            wstop.set()
        self._watchdog_started = False
        self._watchdog_stop = None
        hstop = self._hot_focus_stop
        if hstop is not None:
            hstop.set()
        self._hot_focus_started = False
        self._hot_focus_stop = None
        with self._hot_lock:
            self._hot_tokens.clear()
            self._hot_last_ltp.clear()
        if sid is not None:
            try:
                sid.disconnect()
            except Exception:
                pass
        return pending

    def _touch_socket_rx(self) -> None:
        self._last_socket_rx_mono = time.monotonic()

    def _bump_rx(self, kind: str) -> None:
        self._rx_counts[kind] = int(self._rx_counts.get(kind) or 0) + 1

    def set_hot_focus(self, instruments: list[dict[str, Any]]) -> dict[str, Any]:
        """Pin LIVE tokens for touchline seed until socket last-trade arrives (then socket-only)."""
        next_map: dict[int, int] = {}
        for inst in instruments or []:
            try:
                seg = int(inst.get("exchangeSegment") or inst.get("ExchangeSegment") or 0)
                tid = int(inst.get("exchangeInstrumentID") or inst.get("ExchangeInstrumentID") or 0)
            except Exception:
                continue
            if tid <= 0:
                continue
            if seg <= 0:
                with self._lock:
                    for s, t in self._subs:
                        if int(t) == tid and int(s) > 0:
                            seg = int(s)
                            break
            if seg <= 0:
                continue
            next_map[tid] = seg
        with self._hot_lock:
            self._hot_tokens = next_map
        self._ensure_hot_focus_thread()
        if next_map:
            threading.Thread(target=self._refresh_hot_focus_once, name="md-hot-focus-once", daemon=True).start()
        fyers_out: dict[str, Any] = {}
        try:
            from market.fyers_ltp import fyers_enabled, get_fyers_ltp_feed

            if fyers_enabled():
                feed = get_fyers_ltp_feed()
                feed.set_ltp_handler(self.publish_fyers_ltp)
                fyers_out = feed.set_hot_instruments(
                    [{"exchangeSegment": seg, "exchangeInstrumentID": tid} for tid, seg in next_map.items()]
                )
        except Exception as e:
            fyers_out = {"ok": False, "error": str(e)}
        return {
            "ok": True,
            "count": len(next_map),
            "tokens": sorted(next_map.keys()),
            "fyers": fyers_out,
        }

    def publish_fyers_ltp(
        self,
        tid: int,
        seg: int,
        ltp: float,
        ltt: float = 0.0,
        extras: dict[str, float] | None = None,
    ) -> None:
        """Paint LIVE / TopBar from Fyers (priority last-trade path)."""
        try:
            tid_i = int(tid)
            ltp_f = float(ltp)
        except Exception:
            return
        if tid_i <= 0 or ltp_f <= 0:
            return
        tick: dict[str, Any] = {
            "exchangeInstrumentID": tid_i,
            "exchangeSegment": int(seg) if int(seg or 0) > 0 else 2,
            "messageCode": 1501,
            "ltp": ltp_f,
            "_ltp1501": ltp_f,
            "_fyersLtp": True,
        }
        try:
            if float(ltt or 0.0) > 1e9:
                tick["exchange_ts"] = float(ltt)
                tick["LastTradedTime"] = float(ltt)
        except Exception:
            pass
        if isinstance(extras, dict):
            for k in ("prevClose", "dayOpen", "dayHigh", "dayLow", "percentChange"):
                try:
                    v = float(extras.get(k) or 0.0)
                except Exception:
                    continue
                if k == "percentChange":
                    if abs(v) > 1e-12:
                        tick[k] = v
                elif v > 0:
                    tick[k] = v
        self._deliver_tick(tick)

    def _ensure_hot_focus_thread(self) -> None:
        with self._lock:
            if self._hot_focus_started:
                return
            self._hot_focus_stop = threading.Event()
            self._hot_focus_started = True
            stop = self._hot_focus_stop
        threading.Thread(
            target=self._hot_focus_loop,
            args=(stop,),
            name="md-hot-focus",
            daemon=True,
        ).start()

    def _hot_focus_loop(self, stop: threading.Event) -> None:
        while not stop.wait(XTS_MD_HOT_FOCUS_SEC):
            try:
                self._refresh_hot_focus_once()
            except Exception:
                pass

    def _refresh_hot_focus_once(self) -> None:
        """Seed LIVE LTP from touchline only while socket has been quiet (~250ms)."""
        with self._hot_lock:
            hot = dict(self._hot_tokens)
        if not hot:
            return
        client = self._client
        if not client:
            return
        instruments = [
            {"exchangeSegment": int(seg), "exchangeInstrumentID": int(tid)}
            for tid, seg in hot.items()
            if int(tid) > 0 and int(seg) > 0
        ]
        if not instruments:
            return
        try:
            raw = client.get_quote(
                instruments=instruments,
                xts_message_code=1501,
                publish_format="JSON",
            )
        except Exception:
            return
        ltp_map = _extract_ltp_map_from_quote_response(raw)
        atp_map = _extract_atp_map_from_quote_response(raw)
        now = time.monotonic()
        guard = max(0.5, float(XTS_MD_HOT_FOCUS_SOCKET_GUARD_SEC))
        for tid, seg in hot.items():
            ik = int(tid)
            ltp = float(ltp_map.get(ik) or 0.0)
            if ltp <= 0:
                continue
            last_partial = float(self._partial_paint_mono.get(ik) or 0.0)
            # Socket Snap Quote owns LIVE while prints are flowing — REST must not stick a high print.
            if last_partial > 0 and (now - last_partial) < guard:
                continue
            prev_hot = float(self._hot_last_ltp.get(ik) or 0.0)
            if prev_hot > 0 and abs(prev_hot - ltp) < 1e-6:
                continue
            self._hot_last_ltp[ik] = ltp
            tick: dict[str, Any] = {
                "exchangeInstrumentID": ik,
                "exchangeSegment": int(seg),
                "messageCode": 1501,
                "ltp": ltp,
                "_ltp1501": ltp,
                "_gapFill": True,
                "_fromRestQuote": True,
                "_hotLtp": True,
            }
            atp = float(atp_map.get(ik) or 0.0)
            if atp > 0:
                tick["atp"] = atp
                tick["_atp1501"] = atp
            self._deliver_tick(tick)

    def feed_rx_counts(self) -> dict[str, int]:
        return dict(self._rx_counts)

    def _publish_ema21_only(self, tid: int, ema21: float, seg: int | None = None) -> None:
        """Push EMA update without touching live LTP / Mace."""
        if ema21 <= 0 or tid <= 0:
            return
        payload: dict[str, Any] = {
            "exchangeInstrumentID": int(tid),
            "ema21": float(ema21),
            "_ema21Only": True,
        }
        if seg is not None and int(seg) > 0:
            payload["exchangeSegment"] = int(seg)
        try:
            prev = self._latest_sse.get(int(tid)) or {}
            self._latest_sse[int(tid)] = {**prev, **payload}
        except Exception:
            pass
        for q in self._listeners_snapshot:
            self._enqueue_listener(q, payload)

    def _subscribed_instruments_locked(self) -> list[dict[str, int]]:
        return [
            {"exchangeSegment": int(s), "exchangeInstrumentID": int(t)}
            for s, t in sorted(self._subs)
            if int(s) > 0 and int(t) > 0
        ]

    def _mark_socket_dead(self, eio: Any = None) -> None:
        """XTS websocket aborted. Reconnect without waiting for the stale timeout.

        Ignore drops from a client we already replaced, so a late write-loop
        error cannot tear down the new socket.
        """
        with self._lock:
            if self._expect_socket_drop or not self._started:
                return
            current = getattr(self._sid, "eio", None) if self._sid is not None else None
            if eio is not None and current is not None and eio is not current:
                return
            self._last_socket_rx_mono = 0.0
        self._bump_rx("socket-abort")
        self._request_auto_reconnect()

    def _request_auto_reconnect(self) -> None:
        with self._lock:
            if self._expect_socket_drop or not self._started or self._reconnect_inflight:
                return
            self._reconnect_inflight = True
        threading.Thread(
            target=self._auto_reconnect_worker,
            name="md-auto-reconnect",
            daemon=True,
        ).start()

    def _auto_reconnect_worker(self) -> None:
        delay = 0.4
        try:
            for _attempt in range(10):
                time.sleep(delay)
                if not self._reconnect_lock.acquire(blocking=False):
                    delay = min(max(delay * 1.5, 0.8), 8.0)
                    continue
                try:
                    with self._lock:
                        if not self._started:
                            return
                        key = self._api_key
                        secret = self._api_secret
                        instruments = self._subscribed_instruments_locked()
                        sid = self._sid
                        connected = bool(sid is not None and getattr(sid, "connected", False))
                        rx_age = time.monotonic() - float(self._last_socket_rx_mono or 0.0)
                    if not key or not secret:
                        return
                    # connected can stay True for a moment after WinError 10053.
                    # A fresh tick means the socket recovered; otherwise reconnect.
                    if connected and rx_age < 2.0:
                        return
                    self._soft_reconnect_socket(key, secret, instruments, reuse_client=True)
                    with self._lock:
                        sid = self._sid
                        connected = bool(sid is not None and getattr(sid, "connected", False))
                    if connected:
                        self._bump_rx("auto-reconnect")
                        return
                finally:
                    self._reconnect_lock.release()
                delay = min(max(delay * 2.0, 1.0), 15.0)
        finally:
            with self._lock:
                self._reconnect_inflight = False

    def _soft_reconnect_socket(
        self,
        api_key: str,
        api_secret: str,
        instruments: list[dict[str, int]],
        *,
        reuse_client: bool = True,
    ) -> None:
        """Revive Socket.IO without clearing subscriptions or SSE listeners.

        Reuse the existing MD session by default — a fresh login invalidates the
        REST token and causes ``Please Provide token to Authenticate`` on quotes/OHLC.
        """
        self._expect_socket_drop = True
        self._last_soft_reconnect_mono = time.monotonic()
        try:
            with self._lock:
                sid = self._sid
                self._sid = None
            if sid is not None:
                try:
                    sid.disconnect()
                except Exception:
                    pass
            try:
                self._connect(api_key, api_secret, reuse_client=reuse_client)
                if instruments:
                    self._resubscribe_after_restart(instruments)
                self._ensure_coalesce_flush_thread()
                self._ensure_atp_refresh_thread()
                self._ensure_watchdog_thread()
            except Exception:
                if reuse_client:
                    try:
                        self._connect(api_key, api_secret, reuse_client=False)
                        if instruments:
                            self._resubscribe_after_restart(instruments)
                        self._ensure_coalesce_flush_thread()
                        self._ensure_atp_refresh_thread()
                        self._ensure_watchdog_thread()
                    except Exception:
                        pass
        finally:
            self._expect_socket_drop = False

    def schedule_ensure_socket_alive(self) -> None:
        """Non-blocking debounced socket health check (safe from Flask request threads)."""
        with self._lock:
            if self._ensure_alive_scheduled:
                return
            self._ensure_alive_scheduled = True

        def worker() -> None:
            try:
                now = time.monotonic()
                if now - self._last_ensure_alive_mono < 8.0:
                    return
                self._last_ensure_alive_mono = now
                self.ensure_socket_alive()
            finally:
                with self._lock:
                    self._ensure_alive_scheduled = False

        threading.Thread(target=worker, daemon=True, name="md-ensure-alive").start()

    def ensure_socket_alive(self) -> None:
        """Reconnect + resubscribe when Socket.IO drops or binary ticks go silent."""
        if not self._reconnect_lock.acquire(blocking=False):
            return
        try:
            with self._lock:
                if not self._started:
                    return
                key = self._api_key
                secret = self._api_secret
                instruments = [
                    {"exchangeSegment": int(s), "exchangeInstrumentID": int(t)}
                    for s, t in sorted(self._subs)
                    if int(s) > 0 and int(t) > 0
                ]
                sid = self._sid
                connected = bool(sid is not None and getattr(sid, "connected", False))
                stale = bool(
                    instruments
                    and (time.monotonic() - self._last_socket_rx_mono) > XTS_MD_SOCKET_STALE_SEC
                )
            if connected and not stale:
                return
            # Down sockets retry quickly. A live-but-quiet socket waits longer so
            # overlapping /api/md/start calls do not reconnect in a storm.
            quiet_for = 30.0 if connected else 3.0
            if time.monotonic() - self._last_soft_reconnect_mono < quiet_for:
                return
            if key and secret:
                self._last_soft_reconnect_mono = time.monotonic()
                self._soft_reconnect_socket(key, secret, instruments, reuse_client=True)
        finally:
            self._reconnect_lock.release()

    def _ensure_watchdog_thread(self) -> None:
        with self._lock:
            if self._watchdog_started:
                return
            self._watchdog_stop = threading.Event()
            self._watchdog_started = True
            stop = self._watchdog_stop
        threading.Thread(
            target=self._watchdog_loop,
            args=(stop,),
            name="md-socket-watchdog",
            daemon=True,
        ).start()

    def _watchdog_loop(self, stop: threading.Event) -> None:
        while not stop.wait(5.0):
            try:
                self._maybe_flip_publish_format()
            except Exception:
                pass
            try:
                self.schedule_ensure_socket_alive()
            except Exception:
                pass

    def _maybe_flip_publish_format(self) -> None:
        """If Binary/JSON yields packets but zero LTP for ~4s, flip format once and soft-reconnect."""
        global _ACTIVE_PUBLISH_FORMAT
        if self._format_flipped:
            return
        if time.monotonic() - float(self._connect_mono or 0.0) < 4.0:
            return
        with self._lock:
            if not self._started or not self._api_key or not self._api_secret:
                return
            key = self._api_key
            secret = self._api_secret
            instruments = [
                {"exchangeSegment": int(s), "exchangeInstrumentID": int(t)}
                for s, t in sorted(self._subs)
                if int(s) > 0 and int(t) > 0
            ]
        if not instruments:
            return
        counts = self.feed_rx_counts()
        if int(counts.get("ltp-pub") or 0) > 0:
            return
        # Need some socket traffic so we know the pipe is alive but LTP-empty.
        traffic = (
            int(counts.get("binary") or 0)
            + int(counts.get("1501-partial") or 0)
            + int(counts.get("1512-partial") or 0)
            + int(counts.get("binary-empty") or 0)
        )
        if traffic <= 0:
            return
        cur = str(_ACTIVE_PUBLISH_FORMAT or "Binary").strip() or "Binary"
        nxt = "JSON" if cur.lower() == "binary" else "Binary"
        if not self._reconnect_lock.acquire(timeout=20):
            return
        _ACTIVE_PUBLISH_FORMAT = nxt
        self._format_flipped = True
        self._bump_rx("format-flip:" + nxt)
        self._rx_counts["ltp-pub"] = 0
        self._connect_mono = time.monotonic()
        try:
            self._soft_reconnect_socket(key, secret, instruments, reuse_client=True)
        except Exception:
            pass
        finally:
            self._reconnect_lock.release()

    def _connect(self, api_key: str, api_secret: str, *, reuse_client: bool = False) -> None:
        client = self._client if (reuse_client and self._client is not None) else None
        if client is None:
            client = XtsMarketDataClient(api_key=api_key, api_secret=api_secret, timeout_s=7.0)
        if not client.has_token():
            client.login()
        # Assign only after a token exists so REST never sees a token-less client.
        self._client = client
        self._connect_mono = time.monotonic()

        import socketio  # lazy import

        _install_xts_socketio_order_fix()
        # App owns reconnect + resubscribe. Library reconnect would come back with no instruments.
        self._sid = socketio.Client(
            reconnection=False,
            logger=False,
            engineio_logger=False,
            ssl_verify=False,
        )
        eio = getattr(self._sid, "eio", None)
        if eio is not None:
            eio._sonofwind_on_dead = lambda bound=eio: self._mark_socket_dead(bound)

        @self._sid.on("xts-binary-packet")
        def _on_packet(data):
            try:
                self._touch_socket_rx()
                self._bump_rx("binary")
                self._publish_binary_packet(data)
            except Exception:
                return

        @self._sid.on("disconnect")
        def _on_disconnect(bound=eio):
            self._mark_socket_dead(bound)

        @self._sid.on("1501-json-full")
        def _on_1501_full(data):
            # Parse off the socket thread so a chain snapshot cannot hold the next print.
            self._touch_socket_rx()
            self._bump_rx("1501-full")
            self._queue_full_md(1501, data)

        @self._sid.on("1501-json-partial")
        def _on_1501_partial(data):
            self._bump_rx("1501-partial")
            self._ingest_json_md(1501, data)

        @self._sid.on("1502-json-full")
        def _on_1502_full(_data):
            self._touch_socket_rx()

        @self._sid.on("1502-json-partial")
        def _on_1502_partial(_data):
            # Depth packets must not delay the Snap Quote print.
            self._touch_socket_rx()

        @self._sid.on("1512-json-full")
        def _on_1512_full(data):
            self._touch_socket_rx()
            self._bump_rx("1512-full")
            self._queue_full_md(1512, data)

        @self._sid.on("1512-json-partial")
        def _on_1512_partial(data):
            self._bump_rx("1512-partial")
            self._ingest_json_md(1512, data)

        @self._sid.on("*")
        def _on_unhandled(event, *args):
            # Brokers rename events. Named handlers already ran; this only catches the rest.
            name = str(event or "").lower()
            if name in (
                "xts-binary-packet",
                "1501-json-full",
                "1501-json-partial",
                "1502-json-full",
                "1502-json-partial",
                "1512-json-full",
                "1512-json-partial",
                "1505-json-full",
                "1505-json-partial",
                "disconnect",
                "connect",
            ):
                return
            self._touch_socket_rx()
            self._bump_rx("other:" + name[:40])
            data = args[0] if args else None
            if "1512" in name:
                if "full" in name:
                    self._queue_full_md(1512, data)
                else:
                    self._ingest_json_md(1512, data)
            elif "1501" in name:
                if "full" in name:
                    self._queue_full_md(1501, data)
                else:
                    self._ingest_json_md(1501, data)

        @self._sid.on("1505-json-full")
        def _on_1505_full(data):
            self._ingest_symphony_candle(data)

        @self._sid.on("1505-json-partial")
        def _on_1505_partial(data):
            self._ingest_symphony_candle(data)

        # No catch-all on named events: it parsed every packet twice. Unknown names are handled above.

        url = self._client.socket_url()
        self._sid.connect(url, transports=["websocket"], socketio_path=XTS_MD_SOCKETIO_PATH)
        self._touch_socket_rx()

    def _resubscribe_after_restart(self, instruments: list[dict[str, int]]) -> None:
        if not instruments:
            return
        dual = str(_env("XTS_MD_SUBSCRIBE_1502", "1")).strip().lower() not in ("0", "false", "no", "off")
        try:
            self.subscribe(instruments=instruments, xts_message_code=1501)
        except Exception:
            pass
        if dual:
            try:
                self.subscribe(instruments=instruments, xts_message_code=1502)
            except Exception:
                pass
        if XTS_MD_SUBSCRIBE_1512:
            try:
                self.subscribe(instruments=instruments, xts_message_code=1512)
            except Exception:
                pass
        if XTS_MD_SUBSCRIBE_1505:
            try:
                self.subscribe(instruments=instruments, xts_message_code=1505)
            except Exception:
                pass

    def _publish_binary_packet(self, data: Any) -> None:
        """xts-binary-packet is bytes, a Buffer list, or a string. Publish every decoded last-trade."""

        def _emit(blob: bytes) -> None:
            if not blob:
                self._bump_rx("binary-empty")
                return
            n = 0
            for tick in decode_xts_binary_packet(blob):
                if float(tick.get("ltp") or 0.0) > 0:
                    n += 1
                    self._bump_rx("ltp-pub")
                self._publish(tick)
            if n:
                self._bump_rx("binary-ltp")
            else:
                self._bump_rx("binary-empty")

        if isinstance(data, str):
            s = data.strip()
            if not s:
                return
            low = s.lower()
            if s[0] in "{[" or "ltp:" in low or low.startswith("t:") or "lasttradedprice" in low:
                self._ingest_json_md(1501, s)
                return
            blob = _bytes_from_packet_str(s)
            if blob:
                _emit(blob)
                return
            try:
                _emit(s.encode("latin-1", "ignore"))
            except Exception:
                pass
            return
        if isinstance(data, dict) and str(data.get("type") or "") == "Buffer" and isinstance(data.get("data"), list):
            try:
                _emit(bytes(int(x) & 0xFF for x in data["data"]))
            except Exception:
                pass
            return
        if isinstance(data, (list, tuple)):
            if data and isinstance(data[0], str):
                for item in data:
                    if isinstance(item, str):
                        self._publish_binary_packet(item)
                return
            try:
                _emit(b"".join(bytes(x) for x in data if not isinstance(x, str)))
            except Exception:
                pass
            return
        try:
            _emit(bytes(data))
        except Exception:
            pass

    def _ensure_json_full_thread(self) -> None:
        if self._json_full_started:
            return
        self._json_full_started = True
        threading.Thread(
            target=self._json_full_loop,
            name="md-json-full",
            daemon=True,
        ).start()

    def _queue_full_md(self, message_code: int, data: Any) -> None:
        self._ensure_json_full_thread()
        item = (int(message_code), data)
        try:
            self._json_full_q.put_nowait(item)
        except Full:
            try:
                self._json_full_q.get_nowait()
            except Empty:
                pass
            try:
                self._json_full_q.put_nowait(item)
            except Exception:
                pass

    def _json_full_loop(self) -> None:
        while True:
            try:
                code, data = self._json_full_q.get()
            except Exception:
                continue
            try:
                self._ingest_json_md(int(code), data, full_snap=True)
            except Exception:
                pass

    def _ingest_json_md(self, message_code: int, data: Any, *, snapshot: bool = False, full_snap: bool = False) -> None:
        """XTS JSON socket. Partial and 1512/1501 full both carry Snap Quote last trade."""
        try:
            self._touch_socket_rx()
            data = _unwrap_md_payload(data)
            ticks = _ticks_from_xts_json_event(data, int(message_code))
            if not ticks:
                self._bump_rx("json-empty")
            for tick in ticks:
                if snapshot:
                    tick = {**tick, "_snapshot": True}
                    tick.pop("ltp", None)
                    tick.pop("_ltp1501", None)
                elif full_snap:
                    tick = {**tick, "_fullSnap": True}
                if float(tick.get("ltp") or 0.0) > 0 and not tick.get("_snapshot"):
                    self._bump_rx("ltp-pub")
                self._publish(tick)
        except Exception:
            self._bump_rx("json-err")
            return

    def _ingest_symphony_candle(self, data: Any) -> None:
        """Symphony CandleDataEvent (1505) — update EMA only; never overwrite live LTP/Mace."""
        fields = _symphony_candle_fields(data)
        if not fields:
            return
        tid = int(fields["exchangeInstrumentID"])
        if tid not in self._sub_tokens and (int(fields.get("exchangeSegment") or 0), tid) not in self._subs:
            return
        from market.ema21_engine import get_ema21_engine

        close = float(fields["Close"])
        bar_time = float(fields["BarTime"])
        ema21 = get_ema21_engine().on_symphony_candle(tid, bar_time, close)
        seg = int(fields["exchangeSegment"]) if fields.get("exchangeSegment") is not None else None
        self._publish_ema21_only(tid, ema21, seg)

    def set_pipeline_sink(self, fn: Callable[[dict[str, Any]], None] | None) -> None:
        """Optional: forward each subscribed tick dict (after segment filter)."""
        self._pipeline_sink = fn

    def start(self, api_key: str, api_secret: str):
        """
        Start (or restart) the shared MD socket for these credentials.

        The streamer is process-global: if a different user logs in, we must
        reconnect with that user's md_key/md_secret or ticks stay on the
        first account (stale / missing live updates).
        """
        key = str(api_key or "").strip()
        secret = str(api_secret or "").strip()
        if not key or not secret:
            raise ValueError("md credentials required")

        with self._start_mutex:
            pending: list[dict[str, int]] = []
            with self._lock:
                if (
                    self._started
                    and self._api_key == key
                    and self._api_secret == secret
                    and self._client is not None
                ):
                    self._ensure_watchdog_thread()
                    self.schedule_ensure_socket_alive()
                    return
                if self._started:
                    pending = self._shutdown_locked()
                self._api_key = key
                self._api_secret = secret
                self._started = True

            try:
                self._connect(key, secret)
            except Exception:
                with self._lock:
                    self._shutdown_locked()
                raise

            if pending:
                self._resubscribe_after_restart(pending)

            self._ensure_coalesce_flush_thread()
            self._ensure_atp_refresh_thread()
            self._ensure_watchdog_thread()

    def _ensure_coalesce_flush_thread(self) -> None:
        gap = XTS_MD_COALESCE_SEC
        if gap <= 0:
            return
        with self._lock:
            if self._coalesce_flush_started:
                return
            self._coalesce_flush_stop = threading.Event()
            self._coalesce_flush_started = True
            stop = self._coalesce_flush_stop
        threading.Thread(
            target=self._coalesce_flush_loop,
            args=(stop, gap),
            name="md-coalesce-flush",
            daemon=True,
        ).start()

    def _coalesce_flush_loop(self, stop: threading.Event, gap: float) -> None:
        while not stop.wait(max(0.005, gap)):
            try:
                with self._coalesce_lock:
                    pending = bool(self._coalesce)
                if pending:
                    self._flush_coalesced()
            except Exception:
                pass

    def _ensure_atp_refresh_thread(self) -> None:
        if XTS_MD_ATP_REFRESH_SEC <= 0:
            return
        with self._lock:
            if self._atp_thread_started:
                return
            self._atp_refresh_stop = threading.Event()
            self._atp_thread_started = True
            stop = self._atp_refresh_stop
        threading.Thread(
            target=self._atp_refresh_loop,
            args=(stop,),
            name="md-atp-refresh",
            daemon=True,
        ).start()

    def _atp_refresh_loop(self, stop: threading.Event) -> None:
        self._refresh_atp_once()
        while not stop.wait(XTS_MD_ATP_REFRESH_SEC):
            try:
                self._refresh_atp_once()
            except Exception:
                pass

    def _schedule_atp_refresh(self) -> None:
        if XTS_MD_ATP_REFRESH_SEC <= 0:
            return
        threading.Thread(target=self._refresh_atp_once, name="md-atp-refresh-once", daemon=True).start()

    def _refresh_atp_once(self) -> None:
        """REST touchline poll — keeps LTP + Mace moving when socket is quiet or disconnected."""
        if not self._atp_refresh_lock.acquire(blocking=False):
            return
        try:
            client = self._client
            if not client:
                return
            with self._lock:
                if not self._subs:
                    return
                instruments = [
                    {"exchangeSegment": int(s), "exchangeInstrumentID": int(t)}
                    for s, t in sorted(self._subs)
                    if int(s) > 0 and int(t) > 0
                ]
            try:
                from market.tick_engine import get_tick_engine

                te = get_tick_engine()
            except Exception:
                return

            merged_atp: dict[int, float] = {}
            chunk_sz = int(XTS_MD_ATP_CHUNK)
            n = len(instruments)
            if n <= 0:
                return
            # One chunk per cycle — avoids hammering broker + Flask when 150+ legs subscribed.
            start = int(self._atp_refresh_offset) % n
            self._atp_refresh_offset = (start + chunk_sz) % max(n, 1)
            chunk = [instruments[(start + i) % n] for i in range(min(chunk_sz, n))]
            merged_ltp: dict[int, float] = {}
            try:
                raw = client.get_quote(
                    instruments=chunk,
                    xts_message_code=1501,
                    publish_format="JSON",
                )
                merged_atp.update(_extract_atp_map_from_quote_response(raw))
                merged_ltp.update(_extract_ltp_map_from_quote_response(raw))
            except Exception:
                return

            if not merged_atp and not merged_ltp:
                return

            seg_by_tid: dict[int, int] = {}
            with self._lock:
                for s, t in self._subs:
                    seg_by_tid[int(t)] = int(s)

            all_tids = set(merged_atp.keys()) | set(merged_ltp.keys())
            for tid in all_tids:
                ik = int(tid)
                atp = float(merged_atp.get(ik) or 0.0)
                ltp = float(merged_ltp.get(ik) or 0.0)
                prev = te.get_token_row(ik) or {}
                prev_atp = float(prev.get("atp") or 0.0)
                prev_ltp = float(prev.get("ltp") or 0.0)
                atp_changed = atp > 0 and abs(prev_atp - atp) >= 1e-4
                # Bulk refresh is Mace only. LIVE hot-token poll owns REST LTP gap-fill —
                # bulk LTP used to stamp as a socket print and freeze LIVE 0.5–4 pts behind XTS.
                _ = ltp, prev_ltp
                if not atp_changed:
                    continue
                row = prev
                seg = row.get("exchangeSegment") or row.get("segment") or seg_by_tid.get(ik)
                tick = {
                    "exchangeInstrumentID": ik,
                    "messageCode": 1501,
                    "atp": atp,
                    "_atp1501": atp,
                    "_atpOnly": True,
                }
                if seg is not None:
                    tick["exchangeSegment"] = int(seg)
                self._deliver_tick(tick)
        finally:
            self._atp_refresh_lock.release()

    def subscribe(self, instruments: list[dict[str, Any]], xts_message_code: int = 1501):
        """REST subscribe homogeneously per exchange segment — many gateways 400 mixed-segment batches."""
        if not self._client:
            raise RuntimeError("streamer not started")

        normed: list[dict[str, int]] = []
        for inst in instruments:
            seg_k = inst.get("exchangeSegment", inst.get("ExchangeSegment"))
            tid_k = inst.get("exchangeInstrumentID", inst.get("ExchangeInstrumentID"))
            if seg_k is None or tid_k is None:
                continue
            seg_i = int(seg_k)
            tid_i = int(tid_k)
            if tid_i <= 0:
                continue
            normed.append({"exchangeSegment": seg_i, "exchangeInstrumentID": tid_i})

        if not normed:
            return {"type": "skipped", "description": "streamer subscribe: no valid instruments"}

        from collections import defaultdict

        by_seg: dict[int, list[dict[str, int]]] = defaultdict(list)
        for row in normed:
            by_seg[row["exchangeSegment"]].append(row)

        chunk_sz = int(XTS_MD_SUBSCRIBE_CHUNK)
        results: list[dict[str, Any]] = []
        warnings: list[str] = []
        code = int(xts_message_code)

        for seg in sorted(by_seg.keys()):
            rows = by_seg[seg]
            for i in range(0, len(rows), chunk_sz):
                chunk = rows[i : i + chunk_sz]
                try:
                    res = self._client.subscribe(instruments=chunk, xts_message_code=code)
                except Exception as e:
                    warnings.append(f"segment {seg} ids {[c['exchangeInstrumentID'] for c in chunk][:8]}…: {e!s}"[:920])
                    continue
                results.append({"exchangeSegment": seg, "instruments": len(chunk), "response": res})
                for row in chunk:
                    tid_i = int(row["exchangeInstrumentID"])
                    self._subs.add((seg, tid_i))
                    self._sub_tokens.add(tid_i)

        if int(xts_message_code) == 1501 and XTS_MD_SUBSCRIBE_1512:
            for seg in sorted(by_seg.keys()):
                rows = by_seg[seg]
                for i in range(0, len(rows), chunk_sz):
                    chunk = rows[i : i + chunk_sz]
                    try:
                        self._client.subscribe(instruments=chunk, xts_message_code=1512)
                    except Exception:
                        pass

        if int(xts_message_code) == 1501 and XTS_MD_SUBSCRIBE_1505:
            for seg in sorted(by_seg.keys()):
                rows = by_seg[seg]
                for i in range(0, len(rows), chunk_sz):
                    chunk = rows[i : i + chunk_sz]
                    try:
                        self._client.subscribe(instruments=chunk, xts_message_code=1505)
                    except Exception:
                        pass

        if not results:
            raise RuntimeError("; ".join(warnings) if warnings else "subscription failed for all chunks")

        out: dict[str, Any] = {"chunkResults": results, "chunks": len(results)}
        if warnings:
            out["chunkWarnings"] = warnings
        if int(xts_message_code) == 1501:
            self._ensure_atp_refresh_thread()
            self._schedule_atp_refresh()
            self._schedule_ema21_bootstrap(normed)
        return out

    def _bootstrap_ema21_one(self, row: dict[str, int], *, force: bool = False) -> bool:
        if not self._client:
            return False
        from market.ema21_engine import fetch_and_bootstrap_ema21, get_ema21_engine
        from market.instrument_mapper import get_instrument_mapper
        from market.tick_engine import get_tick_engine

        seg = int(row["exchangeSegment"])
        tid = int(row["exchangeInstrumentID"])
        if force:
            get_ema21_engine().reset_token(tid)
            self._ema21_bootstrapped.discard(tid)
        live = get_tick_engine().get_token_row(tid) or {}
        ltp = float(live.get("ltp") or 0.0)
        meta = get_instrument_mapper().describe(seg, tid)
        opt_side = str(row.get("optType") or row.get("opt_side") or meta.get("kind") or "")
        strike_hint = float(row.get("strike") or meta.get("strike") or 0.0)
        expiry_hint = str(row.get("expiry") or meta.get("expiry") or "")
        ema, n_candles = fetch_and_bootstrap_ema21(
            self._client,
            exchange_segment=seg,
            exchange_instrument_id=tid,
            live_ltp=ltp,
            opt_side=opt_side,
            strike_hint=strike_hint,
            expiry_hint=expiry_hint,
        )
        if ema <= 0 or n_candles <= 0:
            return False
        self._publish_ema21_only(tid, ema, seg)
        return True

    def _schedule_ema21_bootstrap(self, instruments: list[dict[str, int]]) -> None:
        pending = [
            row
            for row in instruments
            if int(row.get("exchangeInstrumentID") or 0) > 0
            and int(row["exchangeInstrumentID"]) not in self._ema21_bootstrapped
        ]
        if not pending:
            return

        def worker() -> None:
            for row in pending:
                tid = int(row["exchangeInstrumentID"])
                if tid in self._ema21_bootstrapped:
                    continue
                try:
                    if self._bootstrap_ema21_one(row):
                        self._ema21_bootstrapped.add(tid)
                except Exception:
                    pass
                time.sleep(1.05)

        threading.Thread(target=worker, daemon=True, name="ema21-bootstrap").start()

    def bootstrap_ema21_now(self, instruments: list[dict[str, int]], *, force: bool = False) -> dict[str, Any]:
        """Priority bootstrap for visible table legs (one instrument at a time)."""
        ok: list[int] = []
        fail: list[int] = []
        for row in instruments:
            tid = int(row.get("exchangeInstrumentID") or 0)
            if tid <= 0:
                continue
            if not force and tid in self._ema21_bootstrapped:
                ok.append(tid)
                continue
            try:
                if self._bootstrap_ema21_one(row, force=force):
                    self._ema21_bootstrapped.add(tid)
                    ok.append(tid)
                else:
                    fail.append(tid)
            except Exception:
                fail.append(tid)
            time.sleep(0.35)
        return {"ok": ok, "fail": fail}

    def bootstrap_ema21_now_async(
        self,
        instruments: list[dict[str, int]],
        *,
        force: bool = False,
    ) -> None:
        """Background OHLC bootstrap — never block Flask workers."""

        def worker() -> None:
            try:
                self.bootstrap_ema21_now(instruments, force=force)
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="ema21-bootstrap-now").start()

    def bootstrap_ema21_for_subscribed(self) -> None:
        with self._lock:
            rows = [
                {"exchangeSegment": int(seg), "exchangeInstrumentID": int(tid)}
                for seg, tid in sorted(self._subs)
                if int(seg) > 0 and int(tid) > 0
            ]
        if rows:
            self._schedule_ema21_bootstrap(rows)

    def rest_client(self) -> XtsMarketDataClient:
        if not self._client:
            raise RuntimeError("streamer not started")
        return self._client

    def _prime_listener_queue(self, q: Queue) -> None:
        """Push latest TickEngine rows for subscribed tokens so new SSE clients are not stuck on REST seed."""
        if not self._sub_tokens:
            return
        try:
            from market.tick_engine import get_tick_engine

            te = get_tick_engine()
        except Exception:
            return
        for tid in list(self._sub_tokens):
            row = te.get_token_row(int(tid))
            if not row:
                continue
            ltp = float(row.get("ltp") or 0.0)
            if ltp <= 0:
                continue
            seg = row.get("exchangeSegment")
            if seg is None:
                seg = row.get("segment")
            tick: dict[str, Any] = {
                "exchangeInstrumentID": int(tid),
                "ltp": ltp,
            }
            if seg is not None:
                tick["exchangeSegment"] = seg
            atp = float(row.get("atp") or 0.0)
            if atp > 0:
                tick["atp"] = atp
            for k in ("bid", "ask", "prevClose", "percentChange", "dayOpen", "dayHigh", "dayLow", "ema21"):
                v = row.get(k)
                if v is not None:
                    tick[k] = v
            self._enqueue_listener(q, self._sse_payload(tick))

    def _paint_payload(self, tick: dict[str, Any]) -> dict[str, Any]:
        """Lock-free last-trade payload. Do not read TickEngine — that wait was the 9:15 paint lag."""
        try:
            tid = int(tick.get("exchangeInstrumentID") or tick.get("token") or 0)
        except Exception:
            tid = 0
        if tid <= 0:
            return tick
        try:
            mc_i = int(tick.get("messageCode") or tick.get("MessageCode") or 0)
        except Exception:
            mc_i = 0
        out: dict[str, Any] = {"exchangeInstrumentID": tid}
        seg = tick.get("exchangeSegment", tick.get("segment"))
        if seg is not None:
            out["exchangeSegment"] = seg
        if mc_i:
            out["messageCode"] = mc_i
        if tick.get("_atpOnly"):
            out["_atpOnly"] = True
        # Snapshot / ATP-only must not rewind a Snap Quote last-trade print.
        # Gap-fill REST may carry ltp (flagged) so LIVE is not blank when socket is quiet.
        paint_ltp = not tick.get("_snapshot") and not tick.get("_atpOnly")
        if paint_ltp and tick.get("_fullSnap") and tid > 0:
            last_partial = float(self._partial_paint_mono.get(tid) or 0.0)
            if last_partial > 0 and (time.monotonic() - last_partial) < 1.5:
                paint_ltp = False
        if tick.get("_gapFill") or tick.get("_fromRestQuote"):
            out["_gapFill"] = True
        if tick.get("_hotLtp"):
            out["_hotLtp"] = True
        if tick.get("_fyersLtp"):
            out["_fyersLtp"] = True
        try:
            ltp = float(tick.get("ltp") or 0.0)
        except Exception:
            ltp = 0.0
        if paint_ltp and mc_i in (1501, 1512) and ltp > 0:
            out["ltp"] = ltp
        elif paint_ltp and mc_i != 1502 and ltp > 0:
            out["ltp"] = ltp
        try:
            ex_ts = float(tick.get("exchange_ts") or tick.get("LastTradedTime") or 0.0)
            if ex_ts > 1e9:
                out["exchange_ts"] = ex_ts
                out["LastTradedTime"] = ex_ts
        except Exception:
            pass
        for k in (
            "bid",
            "ask",
            "atp",
            "prevClose",
            "percentChange",
            "dayOpen",
            "dayHigh",
            "dayLow",
            "ema21",
            "oi",
            "volume",
        ):
            v = tick.get(k)
            if v is None:
                continue
            try:
                fv = float(v)
            except Exception:
                continue
            if fv != fv:
                continue
            if k == "percentChange" or fv > 0:
                out[k] = fv
        return out

    def _push_sse(self, payload: dict[str, Any]) -> None:
        try:
            tid = int(payload.get("exchangeInstrumentID") or 0)
            if tid > 0:
                if payload.get("_atpOnly") or payload.get("_ema21Only"):
                    prev = self._latest_sse.get(tid) or {}
                    self._latest_sse[tid] = {**prev, **payload}
                else:
                    self._latest_sse[tid] = payload
        except Exception:
            pass
        atp_only = bool(payload.get("_atpOnly") or payload.get("_ema21Only"))
        for q in self._listeners_snapshot:
            if atp_only:
                try:
                    if q.qsize() >= XTS_MD_ATP_SSE_MAX_Q:
                        # Keep last-trade path clear during a 9:15 burst / 100% CPU.
                        continue
                except Exception:
                    pass
            self._enqueue_listener(q, payload)

    def _ensure_sink_thread(self) -> None:
        if self._sink_started:
            return
        self._sink_started = True
        threading.Thread(target=self._sink_loop, name="md-tick-sink", daemon=True).start()

    def _sink_loop(self) -> None:
        """TickEngine normalize stays off the socket thread so the next print can paint immediately."""
        while True:
            try:
                tick = self._sink_q.get()
            except Exception:
                continue
            if tick is None:
                return
            sink = self._pipeline_sink
            if not sink:
                continue
            try:
                sink(tick)
            except Exception:
                pass

    def _enqueue_listener(self, q: SseTickPipe, payload: dict[str, Any]) -> None:
        """Last-trade goes on the priority lane so LIVE paints before ATP noise."""
        priority = _sse_payload_is_ltp_print(payload)
        try:
            q.put_nowait(payload, priority=priority)
            return
        except Full:
            pass
        except Exception:
            return
        if not priority:
            return
        try:
            q.put_nowait(payload, priority=True)
        except Exception:
            pass

    def add_listener(self) -> SseTickPipe:
        q = SseTickPipe(maxsize=12000)
        with self._lock:
            self._listeners.add(q)
            self._refresh_listener_snapshot()
        self._prime_listener_queue(q)
        return q

    def remove_listener(self, q: SseTickPipe):
        with self._lock:
            self._listeners.discard(q)
            self._refresh_listener_snapshot()

    def _sse_payload(self, tick: dict[str, Any]) -> dict[str, Any]:
        """Compact JSON for SSE after TickEngine normalize (smaller + faster browser parse)."""
        try:
            from market.tick_engine import get_tick_engine

            token = int(tick.get("exchangeInstrumentID") or tick.get("token") or 0)
            if not token:
                return tick
            if tick.get("_atpOnly"):
                atp_v = float(tick.get("atp") or tick.get("_atp1501") or 0.0)
                if atp_v <= 0:
                    row = get_tick_engine().get_token_row(token)
                    if row:
                        atp_v = float(row.get("atp") or 0.0)
                if atp_v <= 0:
                    return tick
                out: dict[str, Any] = {
                    "exchangeInstrumentID": token,
                    "atp": atp_v,
                    "_atpOnly": True,
                }
                seg = tick.get("exchangeSegment")
                if seg is not None:
                    out["exchangeSegment"] = seg
                return out
            row = get_tick_engine().get_token_row(token)
            if not row:
                return tick
            atp_v = float(row.get("atp") or 0.0)
            if atp_v <= 0:
                try:
                    atp_v = float(
                        tick.get("atp")
                        or tick.get("AverageTradedPrice")
                        or tick.get("averageTradedPrice")
                        or 0.0
                    )
                except Exception:
                    atp_v = 0.0
            out: dict[str, Any] = {
                "exchangeInstrumentID": token,
            }
            mc = tick.get("messageCode") or row.get("messageCode")
            mc_i = int(mc or 0)
            if mc_i:
                out["messageCode"] = mc_i
            try:
                tick_ltp = float(tick.get("ltp") or 0.0)
            except Exception:
                tick_ltp = 0.0
            try:
                row_ltp = float(row.get("ltp") or 0.0)
            except Exception:
                row_ltp = 0.0
            try:
                ltp_1501 = float(row.get("_ltp1501") or 0.0)
            except Exception:
                ltp_1501 = 0.0
            # Snap Quote last trade = 1501 / 1512. 1502 book often reprints bid as ltp.
            if mc_i in (1501, 1512) and tick_ltp > 0:
                out["ltp"] = tick_ltp
            elif ltp_1501 > 0:
                out["ltp"] = ltp_1501
            elif mc_i != 1502 and tick_ltp > 0:
                out["ltp"] = tick_ltp
            elif mc_i != 1502 and row_ltp > 0:
                out["ltp"] = row_ltp
            if tick.get("_fromRestQuote"):
                out["_fromRestQuote"] = True
            if atp_v > 0:
                out["atp"] = atp_v
            seg = tick.get("exchangeSegment")
            if seg is not None:
                out["exchangeSegment"] = seg
            for k in (
                "bid",
                "ask",
                "prevClose",
                "percentChange",
                "dayOpen",
                "dayHigh",
                "dayLow",
                "oi",
                "volume",
                "ema21",
            ):
                v = row.get(k)
                if v is not None:
                    out[k] = v
            return out
        except Exception:
            return tick

    def _deliver_tick(self, tick: dict[str, Any]) -> None:
        # Paint first. TickEngine used to run on the socket thread and held the next 1501 print.
        payload = self._paint_payload(tick)
        # Stamp freshness only when last-trade LTP actually changes.
        # Re-stamping same LTP blocked hot-focus / next print for hundreds of ms.
        # Fyers LIVE LTP stamps the same way so XTS REST cannot rewind it.
        if (
            not tick.get("_fullSnap")
            and not tick.get("_atpOnly")
            and not tick.get("_snapshot")
            and not tick.get("_gapFill")
            and not tick.get("_fromRestQuote")
            and not tick.get("_hotLtp")
        ) or tick.get("_fyersLtp"):
            try:
                new_ltp = float(payload.get("ltp") or 0.0)
                tid = int(payload.get("exchangeInstrumentID") or 0)
                if tid > 0 and new_ltp > 0:
                    prev = float(self._hot_last_ltp.get(tid) or 0.0)
                    if prev <= 0 or abs(prev - new_ltp) >= 1e-6:
                        self._partial_paint_mono[tid] = time.monotonic()
                        self._hot_last_ltp[tid] = new_ltp
            except Exception:
                pass
        self._push_sse(payload)
        self._ensure_sink_thread()
        try:
            self._sink_q.put_nowait(tick)
        except Full:
            try:
                self._sink_q.get_nowait()
            except Empty:
                pass
            try:
                self._sink_q.put_nowait(tick)
            except Exception:
                pass
        except Exception:
            pass

    def _flush_coalesced(self) -> None:
        with self._coalesce_lock:
            batch = self._coalesce
            self._coalesce = {}
            self._coalesce_last_flush = time.monotonic()
        for t in batch.values():
            self._deliver_tick(t)

    def _publish(self, tick: dict[str, Any]):
        seg = int(tick.get("exchangeSegment") or tick.get("segment") or 0)
        iid = int(tick.get("exchangeInstrumentID") or tick.get("token") or 0)
        if iid <= 0:
            return
        if iid not in self._sub_tokens and (seg, iid) not in self._subs:
            return
        if seg <= 0 and iid in self._sub_tokens:
            for s, t in self._subs:
                if t == iid and s > 0:
                    seg = s
                    tick = {**tick, "exchangeSegment": seg}
                    break

        gap = XTS_MD_COALESCE_SEC
        # Snap Quote last-trade must never wait on coalesce — 9:15 burst was skipping 3–4 prints.
        try:
            mc = int(tick.get("messageCode") or tick.get("MessageCode") or 0)
        except Exception:
            mc = 0
        try:
            ltp_now = float(tick.get("ltp") or 0.0)
        except Exception:
            ltp_now = 0.0
        if (
            gap <= 0
            or tick.get("_atpOnly")
            or (mc in (1501, 1512) and ltp_now > 0 and not tick.get("_snapshot"))
        ):
            self._deliver_tick(tick)
            return

        key = (seg, iid)
        flush = False
        with self._coalesce_lock:
            prev = self._coalesce.get(key)
            self._coalesce[key] = _coalesce_merge_ticks(prev, tick) if prev else tick
            now = time.monotonic()
            if now - self._coalesce_last_flush >= gap:
                flush = True
        if flush:
            self._flush_coalesced()

