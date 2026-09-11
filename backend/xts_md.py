import json
import os
import re
import threading
import time
from dataclasses import dataclass
from queue import Empty, Full, Queue
from typing import Any, Callable, Iterable

import requests

from market.ltp_pick import apply_feed_ltp, pick_ltp_for_display, print_ts_from_tick
from market.packet_decoder import decode_xts_binary_packet


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
XTS_MD_PUBLISH_FORMAT = _env("XTS_MD_PUBLISH_FORMAT", "JSON")
XTS_MD_BROADCAST_MODE = _env("XTS_MD_BROADCAST_MODE", "Full")
# Brokers often reject one bad token in a batch — cap chunk size via env when needed (e.g. 32).
# Many XTS gateways reject >100 instruments per REST subscribe (see e-quotes-0003 in OEM docs).
XTS_MD_SUBSCRIBE_CHUNK = max(8, min(int(_env("XTS_MD_SUBSCRIBE_CHUNK", "96")), 100))
# Coalesce socket ticks before SSE listeners / pipeline (ms). 0 = every socket tick → SSE (tick-to-tick).
_COALESCE_MS_RAW = float(_env("XTS_MD_COALESCE_MS", "0") or "0")
XTS_MD_COALESCE_SEC = max(0.0, _COALESCE_MS_RAW / 1000.0)
# Server-side touchline ATP refresh → pushed on existing SSE (replaces browser atp_snapshot polling).
XTS_MD_ATP_REFRESH_SEC = max(0.0, float(_env("XTS_MD_ATP_REFRESH_SEC", "1.5") or "0"))
XTS_MD_ATP_CHUNK = max(8, min(int(_env("XTS_MD_ATP_CHUNK", "40")), 100))
# Symphony CandleDataEvent (message 1505) — opt-in; doubles subscription count.
XTS_MD_SUBSCRIBE_1505 = str(_env("XTS_MD_SUBSCRIBE_1505", "0")).strip().lower() not in ("0", "false", "no", "off")
# Reconnect Socket.IO when no binary ticks for this many seconds (ATP refresh does not count).
XTS_MD_SOCKET_STALE_SEC = max(15.0, float(_env("XTS_MD_SOCKET_STALE_SEC", "45") or "45"))


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
    return print_ts_from_tick(tick, time.time())


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

    Track 1501 (touchline) and 1502 (depth) ATP separately; display ATP prefers 1501
    (XTS Snap Quote Mace) but LTP uses the newest last-trade print (tick-to-tick).
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
        if mc == 1501:
            ltp1501, ltp_ts_1501 = apply_feed_ltp(ltp1501, ltp_ts_1501, l, ts)
        elif mc == 1502:
            ltp1502, ltp_ts_1502 = apply_feed_ltp(ltp1502, ltp_ts_1502, l, ts)
        # 1505 candle events must not drive touchline LTP (minute close ≠ live tick).
    out["_ltp1501"] = ltp1501
    out["_ltp1502"] = ltp1502
    out["_ltp1501_ts"] = ltp_ts_1501
    out["_ltp1502_ts"] = ltp_ts_1502
    picked = pick_ltp_for_display(ltp1501, ltp1502, ltp_ts_1501, ltp_ts_1502)
    if picked > 0:
        out["ltp"] = picked
    if atp1501 > 0:
        out["messageCode"] = 1501
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
        return (
            f"{XTS_MD_ROOT}/?token={self._md.token}"
            f"&userID={self._md.user_id}"
            f"&publishFormat={XTS_MD_PUBLISH_FORMAT}"
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


def _touchline_derived_price(block: dict[str, Any]) -> float | None:
    """When LastTradedPrice is 0 (common for indices pre-open), use close / book / mid."""
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
        self._listeners: set[Queue] = set()
        self._listeners_snapshot: tuple[Queue, ...] = ()
        self._pipeline_sink: Callable[[dict[str, Any]], None] | None = None
        self._coalesce_lock = threading.Lock()
        self._coalesce: dict[tuple[int, int], dict[str, Any]] = {}
        self._coalesce_last_flush = time.monotonic()
        self._coalesce_flush_stop: threading.Event | None = None
        self._coalesce_flush_started = False
        self._latest_sse: dict[int, dict[str, Any]] = {}
        self._atp_refresh_stop: threading.Event | None = None
        self._atp_thread_started = False
        self._atp_refresh_lock = threading.Lock()
        self._atp_refresh_offset = 0
        self._ema21_bootstrapped: set[int] = set()
        self._last_socket_rx_mono = time.monotonic()
        self._reconnect_lock = threading.Lock()
        self._watchdog_stop: threading.Event | None = None
        self._watchdog_started = False
        self._ensure_alive_scheduled = False
        self._last_ensure_alive_mono = 0.0
        self._last_soft_reconnect_mono = 0.0

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
        if sid is not None:
            try:
                sid.disconnect()
            except Exception:
                pass
        return pending

    def _touch_socket_rx(self) -> None:
        self._last_socket_rx_mono = time.monotonic()

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
            # Avoid reconnect storms when many /api/md/start calls arrive together.
            if time.monotonic() - self._last_soft_reconnect_mono < 30.0:
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
        while not stop.wait(30.0):
            try:
                self.schedule_ensure_socket_alive()
            except Exception:
                pass

    def _connect(self, api_key: str, api_secret: str, *, reuse_client: bool = False) -> None:
        client = self._client if (reuse_client and self._client is not None) else None
        if client is None:
            client = XtsMarketDataClient(api_key=api_key, api_secret=api_secret, timeout_s=7.0)
        if not client.has_token():
            client.login()
        # Assign only after a token exists so REST never sees a token-less client.
        self._client = client

        import socketio  # lazy import

        self._sid = socketio.Client(logger=False, engineio_logger=False, ssl_verify=False)

        @self._sid.on("xts-binary-packet")
        def _on_packet(data):
            try:
                if isinstance(data, str):
                    return
                if isinstance(data, (list, tuple)):
                    blob = b"".join(bytes(x) for x in data if not isinstance(x, str))
                else:
                    blob = bytes(data)
                self._touch_socket_rx()
                for tick in decode_xts_binary_packet(blob):
                    self._publish(tick)
            except Exception:
                # swallow; keep socket alive
                return

        @self._sid.on("disconnect")
        def _on_disconnect():
            self.schedule_ensure_socket_alive()

        @self._sid.on("1505-json-full")
        def _on_1505_full(data):
            self._ingest_symphony_candle(data)

        @self._sid.on("1505-json-partial")
        def _on_1505_partial(data):
            self._ingest_symphony_candle(data)

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
        if XTS_MD_SUBSCRIBE_1505:
            try:
                self.subscribe(instruments=instruments, xts_message_code=1505)
            except Exception:
                pass

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
            try:
                raw = client.get_quote(
                    instruments=chunk,
                    xts_message_code=1501,
                    publish_format="JSON",
                )
                merged_atp.update(_extract_atp_map_from_quote_response(raw))
            except Exception:
                return

            if not merged_atp:
                return

            seg_by_tid: dict[int, int] = {}
            with self._lock:
                for s, t in self._subs:
                    seg_by_tid[int(t)] = int(s)

            all_tids = set(merged_atp.keys())
            for tid in all_tids:
                ik = int(tid)
                atp = float(merged_atp.get(ik) or 0.0)
                prev = te.get_token_row(ik) or {}
                prev_atp = float(prev.get("atp") or 0.0)
                atp_changed = atp > 0 and abs(prev_atp - atp) >= 1e-4
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

    def _enqueue_listener(self, q: Queue, payload: dict[str, Any]) -> None:
        try:
            q.put_nowait(payload)
        except Full:
            # Drop stale backlog — browser was falling behind (seconds-late LTP).
            try:
                while True:
                    q.get_nowait()
            except Empty:
                pass
            snap = list(self._latest_sse.values())
            for p in snap:
                try:
                    q.put_nowait(p)
                except Full:
                    break
            try:
                q.put_nowait(payload)
            except Exception:
                pass
        except Exception:
            pass

    def add_listener(self) -> Queue:
        q: Queue = Queue(maxsize=12000)
        with self._lock:
            self._listeners.add(q)
            self._refresh_listener_snapshot()
        self._prime_listener_queue(q)
        return q

    def remove_listener(self, q: Queue):
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
                "ltp": row.get("ltp"),
                "ts": float(row.get("ts") or time.time()),
            }
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
        sink = self._pipeline_sink
        if sink:
            try:
                sink(tick)
            except Exception:
                pass

        payload = self._sse_payload(tick)
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
        for q in self._listeners_snapshot:
            self._enqueue_listener(q, payload)

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
        if gap <= 0:
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

