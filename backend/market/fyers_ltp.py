"""
Fyers LTP for LIVE paint + TopBar (Spot / VIX / ATM CE·PE).
Syn. Fut. and ATM straddle are computed in the UI from those LTPs.
XTS remains orders / positions / margin / chain resolve.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable

import requests

_CACHE = Path(__file__).resolve().parent.parent / "cache" / "fyers_tokens.json"
_MASTER_GLOB = "instruments_master_*.txt"
_QUOTES_URL = "https://api-t1.fyers.in/data/quotes"
_AUTH_URL = "https://api-t1.fyers.in/api/v3/validate-authcode"
_POLL_SEC = max(0.05, float(os.environ.get("FYERS_LTP_POLL_SEC", "0.08") or "0.08"))
# Fyers access tokens are day-scoped; treat slightly early so UI prompts re-login.
_TOKEN_SKEW_SEC = 60

FYERS_INDEX_SYMBOL: dict[str, str] = {
    "NIFTY": "NSE:NIFTY50-INDEX",
    "BANKNIFTY": "NSE:NIFTYBANK-INDEX",
    "SENSEX": "BSE:SENSEX-INDEX",
}
FYERS_VIX_SYMBOL = "NSE:INDIAVIX-INDEX"

# Handler: (tid, seg, ltp, ltt, extras)
LtpHandler = Callable[[int, int, float, float, dict[str, float]], None]


def _env(key: str, default: str = "") -> str:
    return str(os.environ.get(key) or default).strip()


def fyers_enabled() -> bool:
    if _env("FYERS_LTP", "1").lower() in ("0", "false", "no", "off"):
        return False
    return bool(_env("FYERS_APP_ID") and _env("FYERS_SECRET_KEY"))


def _app_id() -> str:
    return _env("FYERS_APP_ID")


def _secret() -> str:
    return _env("FYERS_SECRET_KEY")


def _redirect() -> str:
    return _env("FYERS_REDIRECT_URI", "http://localhost:5174/fyers/callback")


def _app_id_hash() -> str:
    raw = f"{_app_id()}:{_secret()}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _load_tokens() -> dict[str, Any]:
    try:
        if _CACHE.is_file():
            return json.loads(_CACHE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _save_tokens(data: dict[str, Any]) -> None:
    try:
        _CACHE.parent.mkdir(parents=True, exist_ok=True)
        _CACHE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


def auth_login_url(state: str = "sonofwind") -> str:
    from urllib.parse import quote

    return (
        "https://api-t1.fyers.in/api/v3/generate-authcode"
        f"?client_id={quote(_app_id())}"
        f"&redirect_uri={quote(_redirect())}"
        f"&response_type=code"
        f"&state={quote(state)}"
    )


def exchange_auth_code(auth_code: str) -> dict[str, Any]:
    code = str(auth_code or "").strip()
    if not code:
        raise ValueError("auth_code required")
    r = requests.post(
        _AUTH_URL,
        json={
            "grant_type": "authorization_code",
            "appIdHash": _app_id_hash(),
            "code": code,
        },
        timeout=20,
    )
    data = r.json() if r.content else {}
    if not isinstance(data, dict) or not data.get("access_token"):
        raise RuntimeError(str((data or {}).get("message") or data or r.text))
    out = {
        "access_token": str(data["access_token"]).strip(),
        "refresh_token": str(data.get("refresh_token") or "").strip(),
        "saved_at": time.time(),
    }
    _save_tokens(out)
    return {"ok": True, "saved_at": out["saved_at"]}


def _jwt_exp(token: str) -> float | None:
    """Read JWT exp claim without verifying signature (local expiry gate only)."""
    try:
        parts = str(token or "").split(".")
        if len(parts) < 2:
            return None
        payload = parts[1]
        pad = "=" * ((4 - len(payload) % 4) % 4)
        raw = base64.urlsafe_b64decode(payload + pad)
        data = json.loads(raw.decode("utf-8"))
        exp = data.get("exp")
        return float(exp) if exp is not None else None
    except Exception:
        return None


def access_token_raw() -> str:
    return str(_load_tokens().get("access_token") or "").strip()


def token_expired(token: str | None = None) -> bool:
    tok = (token if token is not None else access_token_raw()).strip()
    if not tok:
        return True
    exp = _jwt_exp(tok)
    if exp is None:
        # No exp claim — keep previous behaviour (presence = usable).
        return False
    return time.time() >= (exp - _TOKEN_SKEW_SEC)


def has_access_token() -> bool:
    tok = access_token_raw()
    if not tok:
        return False
    return not token_expired(tok)


def access_token_header() -> str:
    tok = access_token_raw()
    if not tok or token_expired(tok):
        return ""
    return f"{_app_id()}:{tok}"


def _master_paths() -> list[Path]:
    cache = Path(__file__).resolve().parent.parent / "cache"
    if not cache.is_dir():
        return []
    return sorted(cache.glob(_MASTER_GLOB), key=lambda p: p.stat().st_mtime, reverse=True)


def fyers_symbol_for_iid(exchange_instrument_id: int) -> str | None:
    """Map XTS option token → NSE:NIFTY26…CE using instruments master."""
    tid = int(exchange_instrument_id or 0)
    if tid <= 0:
        return None
    needle = f"|{tid}|"
    for path in _master_paths()[:6]:
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for line in text.splitlines():
            if needle not in line:
                continue
            parts = line.split("|")
            if len(parts) < 5:
                continue
            for c in (parts[4].strip() if len(parts) > 4 else "", parts[-1].strip() if parts else ""):
                c = c.strip().upper().replace(" ", "")
                if c.startswith("NIFTY") and (c.endswith("CE") or c.endswith("PE")) and any(ch.isdigit() for ch in c):
                    return f"NSE:{c}"
            try:
                name = parts[3].strip().upper()
                exp = parts[16].strip() if len(parts) > 16 else ""
                strike = parts[17].strip() if len(parts) > 17 else ""
                ot_raw = parts[18].strip().upper() if len(parts) > 18 else ""
            except Exception:
                continue
            if name != "NIFTY":
                continue
            ot = "CE" if ot_raw in ("3", "CE", "C", "CALL") else "PE" if ot_raw in ("4", "PE", "P", "PUT") else ""
            if not ot:
                continue
            m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", exp)
            if not m:
                continue
            yy = m.group(1)[2:]
            mon = int(m.group(2))
            dd = m.group(3)
            try:
                strike_i = int(float(strike))
            except Exception:
                continue
            return f"NSE:NIFTY{yy}{mon}{dd}{strike_i}{ot}"
    return None


def _px(v: Any) -> float:
    try:
        n = float(v or 0.0)
    except Exception:
        return 0.0
    return n if n > 0 else 0.0


def _quote_extras(v: dict[str, Any]) -> dict[str, float]:
    out: dict[str, float] = {}
    mapping = {
        "prevClose": ("prev_close_price", "prev_close", "previous_close"),
        "dayOpen": ("open_price", "open"),
        "dayHigh": ("high_price", "high"),
        "dayLow": ("low_price", "low"),
        "percentChange": ("chp", "percent_change"),
    }
    for key, names in mapping.items():
        for n in names:
            px = _px(v.get(n)) if key != "percentChange" else None
            if key == "percentChange":
                try:
                    chp = float(v.get(n))
                    if abs(chp) > 1e-12:
                        out[key] = chp
                        break
                except Exception:
                    continue
            elif px > 0:
                out[key] = px
                break
    return out


class FyersLtpFeed:
    """Fyers quotes/WS → SSE LTP for LIVE + TopBar tokens."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ws = None
        self._want_live: dict[str, tuple[int, int]] = {}
        self._want_topbar: dict[str, tuple[int, int]] = {}
        self._want: dict[str, tuple[int, int]] = {}
        self._on_ltp: LtpHandler | None = None
        self._started = False
        self._poll_stop: threading.Event | None = None
        self._last_err = ""
        self._rx = 0
        self._mode = ""

    def set_ltp_handler(self, fn: LtpHandler | None) -> None:
        self._on_ltp = fn

    def status(self) -> dict[str, Any]:
        tok = access_token_raw()
        expired = bool(tok) and token_expired(tok)
        authed = bool(tok) and not expired
        if expired and self._started:
            # Stop feeding stale quotes under an expired session.
            try:
                self._stop_feeds()
            except Exception:
                pass
            if not self._last_err:
                self._last_err = "Fyers access token expired — reconnect Fyers"
        return {
            "enabled": fyers_enabled(),
            "authed": authed,
            "expired": expired,
            "connected": bool(self._started) and authed,
            "mode": self._mode if authed else "",
            "symbols": sorted(self._want.keys()) if authed else [],
            "rx": int(self._rx),
            "lastError": self._last_err
            or ("Fyers access token expired — reconnect Fyers" if expired else ""),
            "appId": (_app_id()[:6] + "…") if _app_id() else "",
        }

    def _rebuild_want(self) -> tuple[set[str], set[str]]:
        with self._lock:
            prev = set(self._want.keys())
            merged = {**self._want_topbar, **self._want_live}
            self._want = merged
            nxt = set(merged.keys())
        return nxt - prev, prev - nxt

    def set_hot_instruments(self, instruments: list[dict[str, Any]]) -> dict[str, Any]:
        """LIVE / hunt option tokens (does not clear TopBar Spot/VIX/ATM)."""
        if not fyers_enabled():
            return {"ok": False, "error": "fyers disabled"}
        next_want: dict[str, tuple[int, int]] = {}
        missing: list[int] = []
        for inst in instruments or []:
            try:
                tid = int(inst.get("exchangeInstrumentID") or 0)
                seg = int(inst.get("exchangeSegment") or 0)
            except Exception:
                continue
            if tid <= 0:
                continue
            sym = fyers_symbol_for_iid(tid)
            if not sym:
                missing.append(tid)
                continue
            next_want[sym] = (tid, seg if seg > 0 else 2)
        with self._lock:
            self._want_live = next_want
        added, removed = self._rebuild_want()
        if has_access_token():
            self.ensure_socket()
            self._apply_subscriptions(added, removed)
        return {
            "ok": True,
            "symbols": sorted(self._want.keys()),
            "missing": missing,
            "authed": has_access_token(),
            "mode": self._mode,
        }

    def set_topbar_instruments(
        self,
        *,
        index_key: str,
        spot: dict[str, Any] | None,
        vix: dict[str, Any] | None,
        options: list[dict[str, Any]] | None,
    ) -> dict[str, Any]:
        """Pin Spot + VIX + ATM CE/PE so TopBar Syn Fut / ATM use Fyers LTPs."""
        if not fyers_enabled():
            return {"ok": False, "error": "fyers disabled"}
        next_want: dict[str, tuple[int, int]] = {}
        idx = str(index_key or "NIFTY").strip().upper()
        spot_sym = FYERS_INDEX_SYMBOL.get(idx, FYERS_INDEX_SYMBOL["NIFTY"])
        missing: list[int] = []

        if isinstance(spot, dict):
            try:
                tid = int(spot.get("exchangeInstrumentID") or 0)
                seg = int(spot.get("exchangeSegment") or 0)
            except Exception:
                tid, seg = 0, 0
            if tid > 0:
                next_want[spot_sym] = (tid, seg if seg > 0 else 1)

        if isinstance(vix, dict):
            try:
                tid = int(vix.get("exchangeInstrumentID") or 0)
                seg = int(vix.get("exchangeSegment") or 0)
            except Exception:
                tid, seg = 0, 0
            if tid > 0:
                next_want[FYERS_VIX_SYMBOL] = (tid, seg if seg > 0 else 1)

        for inst in options or []:
            try:
                tid = int(inst.get("exchangeInstrumentID") or 0)
                seg = int(inst.get("exchangeSegment") or 0)
            except Exception:
                continue
            if tid <= 0:
                continue
            sym = fyers_symbol_for_iid(tid)
            if not sym:
                missing.append(tid)
                continue
            next_want[sym] = (tid, seg if seg > 0 else 2)

        with self._lock:
            self._want_topbar = next_want
        added, removed = self._rebuild_want()
        if has_access_token():
            self.ensure_socket()
            self._apply_subscriptions(added, removed)
        return {
            "ok": True,
            "symbols": sorted(self._want.keys()),
            "topbar": sorted(next_want.keys()),
            "missing": missing,
            "authed": has_access_token(),
            "mode": self._mode,
        }

    def ensure_socket(self) -> None:
        if not fyers_enabled() or not has_access_token():
            return
        with self._lock:
            if self._started:
                return
            self._started = True
        if self._try_start_ws():
            return
        self._start_poll_loop()

    def on_auth_success(self) -> None:
        self._stop_feeds()
        self.ensure_socket()
        with self._lock:
            syms = list(self._want.keys())
        if syms:
            self._apply_subscriptions(set(syms), set())

    def _stop_feeds(self) -> None:
        stop = self._poll_stop
        if stop is not None:
            stop.set()
        self._poll_stop = None
        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                ws.close_connection()
            except Exception:
                pass
        with self._lock:
            self._started = False
            self._mode = ""

    def _apply_subscriptions(self, added: set[str], removed: set[str]) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            if removed:
                ws.unsubscribe(symbols=list(removed), data_type="SymbolUpdate")
        except Exception:
            pass
        try:
            if added:
                ws.subscribe(symbols=list(added), data_type="SymbolUpdate")
            elif self._want:
                ws.subscribe(symbols=list(self._want.keys()), data_type="SymbolUpdate")
        except Exception as e:
            self._last_err = str(e)

    def _try_start_ws(self) -> bool:
        try:
            from fyers_apiv3.FyersWebsocket import data_ws
        except Exception as e:
            self._last_err = f"fyers ws import: {e}"
            return False
        token = access_token_header()
        if not token:
            return False
        feed = self

        def onmessage(msg: Any) -> None:
            try:
                feed._on_ws_message(msg)
            except Exception as ex:
                feed._last_err = str(ex)

        def onerror(msg: Any) -> None:
            feed._last_err = str(msg)

        def onclose(_msg: Any) -> None:
            with feed._lock:
                feed._started = False
                feed._ws = None
                feed._mode = ""
            try:
                feed._start_poll_loop()
            except Exception:
                pass

        def onopen() -> None:
            with feed._lock:
                syms = list(feed._want.keys())
            if syms and feed._ws is not None:
                try:
                    feed._ws.subscribe(symbols=syms, data_type="SymbolUpdate")
                except Exception as ex:
                    feed._last_err = str(ex)

        try:
            ws = data_ws.FyersDataSocket(
                access_token=token,
                log_path="",
                litemode=False,
                write_to_file=False,
                reconnect=True,
                on_connect=onopen,
                on_close=onclose,
                on_error=onerror,
                on_message=onmessage,
            )
            self._ws = ws
            self._mode = "ws"
            with self._lock:
                self._started = True
            threading.Thread(target=ws.connect, name="fyers-ltp-ws", daemon=True).start()
            return True
        except Exception as e:
            self._last_err = str(e)
            self._ws = None
            return False

    def _start_poll_loop(self) -> None:
        if self._poll_stop is not None and not self._poll_stop.is_set():
            return
        stop = threading.Event()
        self._poll_stop = stop
        self._mode = "quotes"
        with self._lock:
            self._started = True

        def loop() -> None:
            while not stop.wait(_POLL_SEC):
                try:
                    self._poll_quotes_once()
                except Exception as e:
                    self._last_err = str(e)

        threading.Thread(target=loop, name="fyers-ltp-poll", daemon=True).start()

    def _resolve_pair(self, sym: str) -> tuple[int, int] | None:
        with self._lock:
            want = dict(self._want)
        pair = want.get(sym)
        if pair is not None:
            return pair
        bare = sym.replace("NSE:", "").replace("BSE:", "")
        for k, p in want.items():
            if k.replace("NSE:", "").replace("BSE:", "") == bare:
                return p
        return None

    def _poll_quotes_once(self) -> None:
        with self._lock:
            want = dict(self._want)
        if not want:
            return
        hdr = access_token_header()
        if not hdr:
            return
        r = requests.get(
            _QUOTES_URL,
            params={"symbols": ",".join(want.keys())},
            headers={"Authorization": hdr},
            timeout=4,
        )
        data = r.json() if r.content else {}
        if not isinstance(data, dict):
            return
        if str(data.get("s") or "").lower() not in ("ok", "") and data.get("code") not in (200, None, 0):
            msg = str(data.get("message") or data)
            self._last_err = msg
            # Token died mid-session — force UI back to Connect Fyers.
            code = data.get("code")
            low = msg.lower()
            if code in (401, 403, -16, -17) or "token" in low or "auth" in low or "login" in low:
                try:
                    self._stop_feeds()
                except Exception:
                    pass
            return
        rows = data.get("d") or data.get("data") or []
        if not isinstance(rows, list):
            return
        for row in rows:
            if not isinstance(row, dict):
                continue
            v = row.get("v") if isinstance(row.get("v"), dict) else row
            if not isinstance(v, dict):
                continue
            sym = str(row.get("n") or v.get("symbol") or v.get("n") or "").strip().upper()
            if not sym:
                continue
            if ":" not in sym:
                if "SENSEX" in sym:
                    sym = f"BSE:{sym}"
                else:
                    sym = f"NSE:{sym}"
            ltp = _px(v.get("lp") or v.get("ltp"))
            if ltp <= 0:
                continue
            pair = self._resolve_pair(sym)
            if pair is None:
                continue
            tid, seg = pair
            self._emit(tid, seg, ltp, _px(v.get("tt")), _quote_extras(v))

    def _on_ws_message(self, msg: Any) -> None:
        if not isinstance(msg, dict):
            return
        sym = str(msg.get("symbol") or msg.get("n") or "").strip().upper()
        if not sym:
            return
        if ":" not in sym:
            sym = f"NSE:{sym}"
        ltp = _px(msg.get("ltp") or msg.get("lp"))
        if ltp <= 0:
            return
        try:
            ltt = float(msg.get("last_traded_time") or msg.get("ltt") or 0.0)
        except Exception:
            ltt = 0.0
        pair = self._resolve_pair(sym)
        if pair is None:
            return
        tid, seg = pair
        extras = _quote_extras(msg)
        self._emit(tid, seg, ltp, ltt, extras)

    def _emit(self, tid: int, seg: int, ltp: float, ltt: float, extras: dict[str, float] | None = None) -> None:
        self._rx += 1
        fn = self._on_ltp
        if fn:
            fn(int(tid), int(seg), float(ltp), float(ltt), dict(extras or {}))


_FEED: FyersLtpFeed | None = None
_FEED_LOCK = threading.Lock()


def get_fyers_ltp_feed() -> FyersLtpFeed:
    global _FEED
    with _FEED_LOCK:
        if _FEED is None:
            _FEED = FyersLtpFeed()
        return _FEED
