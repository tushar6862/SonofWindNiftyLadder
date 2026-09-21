import math
import os
import queue
import re
import secrets
import threading
from typing import Any
import json
import time
import uuid
from pathlib import Path
from datetime import date, datetime, timedelta

from flask import Flask, has_request_context, jsonify, make_response, request, session
from flask_cors import CORS
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from werkzeug.security import check_password_hash

from xts_client import XtsInteractiveClient, _xts_empty_data_error, _xts_unmapped_client_error
from xts_md import (
    MarketDataStreamer,
    fetch_index_spot_ltp,
    first_exchange_instrument_id,
    flatten_json_strings,
    normalize_spot_probes,
    pick_expiry_for_label,
    quote_spot_anchor_fields_from_response,
)

from market.option_chain_manager import get_option_chain_manager

def _load_backend_dotenv() -> None:
    """Load backend/.env into os.environ (does not override existing vars)."""
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if not s or s.startswith("#") or "=" not in s:
                continue
            key, _, val = s.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            # Fyers keys always come from this file so a new App ID wins over a stale shell env.
            if key and (key.startswith("FYERS_") or key not in os.environ):
                os.environ[key] = val
    except Exception:
        pass


_load_backend_dotenv()


def _env(name: str, default: str = "") -> str:
    v = os.getenv(name)
    return default if v is None else str(v)


ALLOWED_ORIGINS = [
    # Localhost dev (any Vite port)
    r"^http://(localhost|127\.0\.0\.1):\d+$",
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    # LAN dev (when opening Vite via Network URL)
    r"^http://192\.168\.\d{1,3}\.\d{1,3}:\d+$",
    r"^http://10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$",
    r"^http://100\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$",
    # Production frontend (Vercel)
    "https://son-of-wind-opt-flow-son-of-wind-dashboard-871lwhf2s.vercel.app",
    r"^https://.*\.vercel\.app$",
    # Production / preview frontend (Render)
    "https://trading.investeria.in",
    r"^https://.*\.onrender\.com$",
]


app = Flask(__name__)
# Empty string in env (FLASK_SECRET_KEY=) must not disable sessions — login uses session + signed cookies.
_sk = str(_env("FLASK_SECRET_KEY", "")).strip()
app.secret_key = _sk if _sk else secrets.token_hex(32)
app.permanent_session_lifetime = timedelta(days=7)

# Stateless auth token (survives process restarts). Requires stable FLASK_SECRET_KEY in production.
_AUTH_SALT = "sonofwind-auth-v1"
_AUTH_TOKEN_MAX_AGE_S = int(_env("AUTH_TOKEN_MAX_AGE_S", str(7 * 24 * 60 * 60)))  # default 7 days
_AUTH = URLSafeTimedSerializer(app.secret_key, salt=_AUTH_SALT)

CORS(
    app,
    supports_credentials=True,
    resources={r"/api/*": {"origins": ALLOWED_ORIGINS}},
)

# ── In-memory margin + XTS sessions ───────────────────────────────────────────
# IMPORTANT: cache per-user; otherwise last-fetched user's values leak to others.
_MARGIN_BY_USER: dict[str, dict[str, float]] = {}  # username -> {available, used, free}
_LAST_MARGIN_FETCH_TS_BY_USER: dict[str, float] = {}  # username -> ts
_BUSY_MARGIN_BY_USER: dict[str, bool] = {}  # username -> busy flag
_XTS_IX: dict[str, XtsInteractiveClient] = {}  # username -> client
# Back-compat cache for older tokens + optional in-memory cache for new ones.
_TOKENS: dict[str, str] = {}  # token -> username
_MD_STREAMER = MarketDataStreamer()


def _tokens_file_path() -> Path:
    cache_dir = Path(__file__).with_name("cache")
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir / "auth_tokens.json"


def _load_tokens_from_disk() -> None:
    try:
        p = _tokens_file_path()
        if not p.exists() or not p.is_file():
            return
        raw = json.loads(p.read_text(encoding="utf-8") or "{}")
        if isinstance(raw, dict):
            for tok, user in raw.items():
                t = str(tok or "").strip()
                u = str(user or "").strip().upper()
                if t and u:
                    _TOKENS[t] = u
    except Exception:
        return


def _save_tokens_to_disk() -> None:
    try:
        p = _tokens_file_path()
        p.write_text(json.dumps(_TOKENS, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        return


_load_tokens_from_disk()

# INDIA VIX (verified from /instruments/indexlist segment=1): exchangeInstrumentID = 26002.
# Old default 26017 was actually "NIFTY MIDCAP 100".
VIX_INSTRUMENT_ID = int(_env("XTS_VIX_INSTRUMENT_ID", "26002"))
VIX_SEGMENT_ID = int(_env("XTS_VIX_SEGMENT", "1"))

# XTS exchange → numeric segment id (Investeria binary market data convention).
# Mirrors XTS_OPTIONS_DASHBOARD/xts_integration.py SEG_MAP.
EXCHANGE_SEGMENTS: dict[str, int] = {
    "NSECM": 1,
    "NSEFO": 2,
    "NSECD": 3,
    "MCXFO": 51,
    "BSECM": 11,
    "BSEFO": 12,
}


def _seg_id(value: object, default: int) -> int:
    """Accept either an int (1) or an exchange name (\"NSECM\") and return the numeric segment id."""
    if value is None:
        return int(default)
    s = str(value).strip()
    if not s:
        return int(default)
    if s.isdigit():
        return int(s)
    upper = s.upper()
    if upper in EXCHANGE_SEGMENTS:
        return int(EXCHANGE_SEGMENTS[upper])
    try:
        return int(s)
    except ValueError:
        return int(default)


def _index_md_spec(
    *,
    key: str,
    default_spot_exchange: str,
    default_spot_token: int,
    default_option_exchange: str,
    default_series: str,
    default_symbol: str,
    default_step: int,
    spot_probe: list[tuple[int, int]] | None = None,
) -> dict[str, object]:
    """
    Build a per-index marketdata spec, fully overridable via env. Per-index env keys:
        XTS_<KEY>_SPOT_EXCHANGE / XTS_<KEY>_SPOT_SEGMENT  (e.g. NSECM or 1)
        XTS_<KEY>_SPOT_TOKEN
        XTS_<KEY>_OPTION_EXCHANGE / XTS_<KEY>_OPTION_SEGMENT
        XTS_<KEY>_OPTION_SERIES
        XTS_<KEY>_OPTION_SYMBOL
        XTS_<KEY>_STEP
    """
    k = key.upper()
    spot_seg_env = _env(f"XTS_{k}_SPOT_EXCHANGE") or _env(f"XTS_{k}_SPOT_SEGMENT")
    opt_seg_env = _env(f"XTS_{k}_OPTION_EXCHANGE") or _env(f"XTS_{k}_OPTION_SEGMENT")

    spot_segment = _seg_id(spot_seg_env, EXCHANGE_SEGMENTS[default_spot_exchange])
    option_segment = _seg_id(opt_seg_env, EXCHANGE_SEGMENTS[default_option_exchange])
    spot_token = int(_env(f"XTS_{k}_SPOT_TOKEN", str(default_spot_token)) or default_spot_token)
    series = str(_env(f"XTS_{k}_OPTION_SERIES", default_series) or default_series)
    symbol = str(_env(f"XTS_{k}_OPTION_SYMBOL", default_symbol) or default_symbol)
    step = int(_env(f"XTS_{k}_STEP", str(default_step)) or default_step)
    # Spot discovery (indexlist + string search) is useful for vendor-specific tokens,
    # but it adds extra REST calls. Default OFF for SENSEX when a spot token is configured.
    spot_discovery_env = _env(f"XTS_{k}_SPOT_DISCOVERY")
    if spot_discovery_env is None:
        spot_discovery = (k != "SENSEX")
    else:
        spot_discovery = str(spot_discovery_env).strip().lower() not in ("0", "false", "no", "off")

    spec: dict[str, object] = {
        "spot_segment": spot_segment,
        "spot_token": spot_token,
        "option_segment": option_segment,
        "series": series,
        "symbol": symbol,
        "step": step,
        "spot_discovery": bool(spot_discovery),
    }
    if spot_probe:
        spec["spot_probe"] = list(spot_probe)
    return spec


# Marketdata specs: spot tickers + derivatives segment for chain resolution (XTS numbering).
# Default mapping (override with env):
#     NIFTY      → NSE (NSECM=1)  | options NSEFO=2
#     BANKNIFTY  → NSE (NSECM=1)  | options NSEFO=2
#     SENSEX     → BSE (BSECM=11) | options BSEFO=12
INDEX_MD_SPECS: dict[str, dict[str, object]] = {
    "NIFTY": _index_md_spec(
        key="NIFTY",
        default_spot_exchange="NSECM",
        default_spot_token=26000,
        default_option_exchange="NSEFO",
        default_series="OPTIDX",
        default_symbol="NIFTY",
        default_step=50,
    ),
    "BANKNIFTY": _index_md_spec(
        key="BANKNIFTY",
        default_spot_exchange="NSECM",
        default_spot_token=26001,
        default_option_exchange="NSEFO",
        default_series="OPTIDX",
        default_symbol="BANKNIFTY",
        default_step=100,
    ),
    "SENSEX": _index_md_spec(
        key="SENSEX",
        default_spot_exchange="BSECM",
        default_spot_token=26065,
        default_option_exchange="BSEFO",
        default_series="OPTIDX",
        default_symbol="SENSEX",
        default_step=100,
        spot_probe=[(EXCHANGE_SEGMENTS["BSECM"], 26065), (EXCHANGE_SEGMENTS["NSECM"], 26065)],
    ),
}


def _ensure_market_streamer(username: str) -> None:
    users = _load_users()
    rec = users.get(username)
    if not isinstance(rec, dict) or not rec.get("md_key") or not rec.get("md_secret"):
        raise RuntimeError("Marketdata credentials missing for this user")
    _MD_STREAMER.start(api_key=str(rec["md_key"]), api_secret=str(rec["md_secret"]))


@app.get("/api/md/index_specs")
def md_index_specs():
    """
    Returns configured spot instruments for index tickers.
    Used by the frontend ticker bar to subscribe to NIFTY/BANKNIFTY/SENSEX without running chain resolve.
    """
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    try:
        _ensure_market_streamer(username)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    out: dict[str, object] = {}
    for k, spec in INDEX_MD_SPECS.items():
        try:
            out[str(k)] = {
                "spotSegment": int(spec.get("spot_segment") or 0),
                "spotToken": int(spec.get("spot_token") or 0),
            }
        except Exception:
            continue
    return jsonify({"ok": True, "indices": out})


def _load_users() -> dict[str, object]:
    """
    Multi-user store:
    - Reads from backend/users.json by default
    - Override path via USERS_FILE env
    - If file missing/invalid, falls back to env (APP_USERNAME/APP_PASSWORD)
    """
    users_file = _env("USERS_FILE", str(Path(__file__).with_name("users.json")))
    p = Path(users_file)

    if p.exists() and p.is_file():
        try:
            raw = json.loads(p.read_text(encoding="utf-8") or "{}")
            if isinstance(raw, dict):
                out: dict[str, object] = {}
                for k, v in raw.items():
                    u = str(k or "").strip().upper()
                    if not u:
                        continue
                    out[u] = v
                if out:
                    return out
        except Exception:
            pass

    demo_user = _env("APP_USERNAME", "SR04").strip().upper()
    demo_pass = _env("APP_PASSWORD", "1234").strip()
    return {demo_user: {"password": demo_pass}} if demo_user and demo_pass else {}


def _verify_password(user_record: object, password: str) -> bool:
    if not password:
        return False

    try:
        # Simple format: {"SR04": "1234"}
        if isinstance(user_record, str):
            if len(user_record) != len(password):
                return False
            return secrets.compare_digest(user_record, password)

        # Rich format: {"SR04": {"password": "..."} } or {"password_hash": "..."}
        if isinstance(user_record, dict):
            if "password_hash" in user_record and isinstance(user_record.get("password_hash"), str):
                return bool(check_password_hash(user_record["password_hash"], password))
            if "password" in user_record and isinstance(user_record.get("password"), str):
                plain = user_record["password"]
                if len(plain) != len(password):
                    return False
                return secrets.compare_digest(plain, password)
    except Exception:
        return False

    return False


def _current_user() -> str | None:
    # EventSource cannot send Authorization; allow ?token=
    qs = request.args.get("token", type=str)
    if qs and qs.strip():
        qst = qs.strip()
        if qst in _TOKENS:
            return str(_TOKENS[qst])
        # Accept stateless tokens in querystring too.
        try:
            data = _AUTH.loads(qst, max_age=_AUTH_TOKEN_MAX_AGE_S)
            if isinstance(data, dict) and data.get("u"):
                return str(data["u"])
        except (SignatureExpired, BadSignature):
            pass

    # Prefer Bearer token (works across refresh without cookies)
    auth = (request.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1].strip()
        u = _TOKENS.get(token)
        if u:
            return str(u)
        # Stateless token fallback (survives restarts)
        try:
            data = _AUTH.loads(token, max_age=_AUTH_TOKEN_MAX_AGE_S)
            if isinstance(data, dict) and data.get("u"):
                return str(data["u"])
        except (SignatureExpired, BadSignature):
            pass

    u = session.get("username")
    if not u:
        return None
    return str(u)


@app.get("/api/auth/me")
def auth_me():
    u = _current_user()
    return jsonify({"loggedIn": bool(u), "username": u})


@app.post("/api/auth/login")
def auth_login():
    try:
        data = request.get_json(silent=True) or {}
        username = str(data.get("username") or "").strip().upper()
        password = str(data.get("password") or "").strip()

        if not username or not password:
            return jsonify({"ok": False, "error": "Username and password required"}), 400

        users = _load_users()
        rec = users.get(username)
        if not _verify_password(rec, password):
            return jsonify({"ok": False, "error": "Invalid username or password"}), 401

        # Issue token for frontend persistence (avoid cookie SameSite issues).
        # Use stateless signed token so it stays valid across Render restarts (requires stable FLASK_SECRET_KEY).
        token = str(_AUTH.dumps({"u": username}))
        _TOKENS[token] = username  # optional cache
        _save_tokens_to_disk()  # back-compat: harmless if FS is ephemeral/read-only

        session.permanent = True
        session["username"] = username
        # Save client_id mapping for dealer accounts (SRxxPRO)
        if isinstance(rec, dict) and rec.get("user_id"):
            session["client_id"] = str(rec.get("user_id"))

        # Do NOT do broker login here (it makes login slow). Margin API will lazily login.
        return jsonify({"ok": True, "username": username, "token": token})
    except Exception as e:
        app.logger.exception("auth_login")
        return jsonify({"ok": False, "error": "Login server error", "detail": str(e)}), 500


@app.post("/api/auth/logout")
def auth_logout():
    u = _current_user() or session.get("username")
    if u:
        _XTS_IX.pop(str(u), None)

    # Revoke token if provided
    auth = (request.headers.get("Authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1].strip()
        _TOKENS.pop(token, None)
        _save_tokens_to_disk()
    session.clear()
    return jsonify({"ok": True})


@app.get("/api/health")
def health():
    return jsonify({"ok": True})


@app.post("/api/md/start")
def md_start():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        _MD_STREAMER.schedule_ensure_socket_alive()
        try:
            _MD_STREAMER.bootstrap_ema21_for_subscribed()
        except Exception:
            pass
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/md/hot_focus")
def md_hot_focus():
    """Pin LIVE/hunt instrument(s) for ~200ms touchline LTP — keeps painted strike near XTS Snap Quote."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    instruments = data.get("instruments") or []
    if not isinstance(instruments, list):
        return jsonify({"ok": False, "error": "instruments[] required"}), 400
    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        out = _MD_STREAMER.set_hot_focus(instruments)
        return jsonify({"ok": True, **out})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/fyers/status")
def fyers_status():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    try:
        from market.fyers_ltp import auth_login_url, get_fyers_ltp_feed, fyers_enabled

        feed = get_fyers_ltp_feed()
        st = feed.status()
        return jsonify(
            {
                "ok": True,
                **st,
                "loginUrl": auth_login_url() if fyers_enabled() and not st.get("authed") else None,
            }
        )
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/api/fyers/login_url")
def fyers_login_url():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    try:
        from market.fyers_ltp import auth_login_url, fyers_enabled

        if not fyers_enabled():
            return jsonify({"ok": False, "error": "Fyers not configured"}), 400
        return jsonify({"ok": True, "url": auth_login_url()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/fyers/callback")
def fyers_callback():
    """Exchange Fyers auth_code for access_token (daily login)."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    code = str(data.get("auth_code") or data.get("code") or "").strip()
    if not code:
        return jsonify({"ok": False, "error": "auth_code required"}), 400
    try:
        from market.fyers_ltp import exchange_auth_code, get_fyers_ltp_feed

        exchange_auth_code(code)
        feed = get_fyers_ltp_feed()
        feed.set_ltp_handler(_MD_STREAMER.publish_fyers_ltp)
        feed.on_auth_success()
        return jsonify({"ok": True, "authed": True, "message": "Fyers LTP connected"})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/fyers/topbar_focus")
def fyers_topbar_focus():
    """Pin Spot + VIX + ATM CE/PE so TopBar metrics paint from Fyers."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    try:
        from market.fyers_ltp import fyers_enabled, get_fyers_ltp_feed

        if not fyers_enabled():
            return jsonify({"ok": False, "error": "Fyers not configured"}), 400
        feed = get_fyers_ltp_feed()
        feed.set_ltp_handler(_MD_STREAMER.publish_fyers_ltp)
        out = feed.set_topbar_instruments(
            index_key=str(data.get("index") or "NIFTY"),
            spot=data.get("spot") if isinstance(data.get("spot"), dict) else None,
            vix=data.get("vix") if isinstance(data.get("vix"), dict) else None,
            options=data.get("options") if isinstance(data.get("options"), list) else [],
        )
        return jsonify({"ok": True, **out})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/md/dada/range")
def md_dada_range():
    """DADA strategy: first 15-min (09:15–09:30 IST) spot HIGH / LOW."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    seg = data.get("exchangeSegment", data.get("ExchangeSegment"))
    tid = data.get("exchangeInstrumentID", data.get("ExchangeInstrumentID"))
    live_ltp = data.get("liveLtp", data.get("ltp", 0))
    if seg is None or tid is None:
        return jsonify({"ok": False, "error": "exchangeSegment + exchangeInstrumentID required"}), 400
    try:
        seg_i = int(seg)
        tid_i = int(tid)
        live_f = float(live_ltp or 0)
    except Exception:
        return jsonify({"ok": False, "error": "invalid segment/instrument/ltp"}), 400
    if not (seg_i > 0 and tid_i > 0):
        return jsonify({"ok": False, "error": "invalid segment/instrument"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        cli = _MD_STREAMER.rest_client()
        if cli is None:
            return jsonify({"ok": False, "error": "Market data client not ready"}), 503
        from market.dada_range import build_dada_range_payload

        payload = build_dada_range_payload(
            cli,
            exchange_segment=seg_i,
            exchange_instrument_id=tid_i,
            live_ltp=live_f,
        )
        return jsonify(payload)
    except Exception as e:
        app.logger.exception("md_dada_range failed")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/md/dada/sl1m")
def md_dada_sl1m():
    """DADA / ORB primary SL: closed 1m spot bars."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    seg = data.get("exchangeSegment", data.get("ExchangeSegment"))
    tid = data.get("exchangeInstrumentID", data.get("ExchangeInstrumentID"))
    live_ltp = data.get("liveLtp", data.get("ltp", 0))
    after_key = data.get("afterMinuteKey", data.get("after_minute_key", 0))
    if seg is None or tid is None:
        return jsonify({"ok": False, "error": "exchangeSegment + exchangeInstrumentID required"}), 400
    try:
        seg_i = int(seg)
        tid_i = int(tid)
        live_f = float(live_ltp or 0)
        after_i = int(after_key or 0)
    except Exception:
        return jsonify({"ok": False, "error": "invalid segment/instrument/ltp/after"}), 400
    if not (seg_i > 0 and tid_i > 0):
        return jsonify({"ok": False, "error": "invalid segment/instrument"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        cli = _MD_STREAMER.rest_client()
        if cli is None:
            return jsonify({"ok": False, "error": "Market data client not ready"}), 503
        from market.dada_range import build_dada_sl1m_payload

        payload = build_dada_sl1m_payload(
            cli,
            exchange_segment=seg_i,
            exchange_instrument_id=tid_i,
            live_ltp=live_f,
            after_minute_key=after_i,
        )
        return jsonify(payload)
    except Exception as e:
        app.logger.exception("md_dada_sl1m failed")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/md/dada/sl3m")
def md_dada_sl3m():
    """Backward-compatible alias → 1m ORB SL bars."""
    return md_dada_sl1m()


@app.post("/api/md/dada/sl5m")
def md_dada_sl5m():
    """Backward-compatible alias → 1m ORB SL bars."""
    return md_dada_sl1m()


@app.post("/api/md/nifty_ladder/open_drive")
def md_nifty_ladder_open_drive():
    """NIFTY Ladder: 09:15 IST 1-minute open-drive hint (UP→PE / DOWN→CE / FLAT)."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    seg = data.get("exchangeSegment", data.get("ExchangeSegment"))
    tid = data.get("exchangeInstrumentID", data.get("ExchangeInstrumentID"))
    live_ltp = data.get("liveLtp", data.get("ltp", 0))
    if seg is None or tid is None:
        return jsonify({"ok": False, "error": "exchangeSegment + exchangeInstrumentID required"}), 400
    try:
        seg_i = int(seg)
        tid_i = int(tid)
        live_f = float(live_ltp or 0)
    except Exception:
        return jsonify({"ok": False, "error": "invalid segment/instrument/ltp"}), 400
    if not (seg_i > 0 and tid_i > 0):
        return jsonify({"ok": False, "error": "invalid segment/instrument"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        cli = _MD_STREAMER.rest_client()
        if cli is None:
            return jsonify({"ok": False, "error": "Market data client not ready"}), 503
        from market.nifty_ladder import build_open_drive_payload

        payload = build_open_drive_payload(
            cli,
            exchange_segment=seg_i,
            exchange_instrument_id=tid_i,
            live_ltp=live_f,
        )
        return jsonify(payload)
    except Exception as e:
        app.logger.exception("md_nifty_ladder_open_drive failed")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/api/md/nifty_snake/hedge_candidates")
def md_nifty_snake_hedge_candidates():
    """NIFTY Snake: far-OTM same-side strikes for a ~3–4 Rs long hedge."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    expiry = str(data.get("expiry") or data.get("expiryApi") or "").strip()
    option_type = str(data.get("optionType") or data.get("side") or "").strip().upper()
    try:
        spot = float(data.get("spot") or data.get("spotLtp") or 0)
        step = float(data.get("step") or 50)
    except Exception:
        return jsonify({"ok": False, "error": "invalid spot/step"}), 400
    try:
        from market.nifty_snake import list_hedge_candidates

        rows = list_hedge_candidates(expiry=expiry, option_type=option_type, spot=spot, step=step)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("md_nifty_snake_hedge_candidates failed")
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "candidates": rows, "count": len(rows)})


@app.post("/api/md/nifty_bothside/hedge_candidates")
def md_nifty_bothside_hedge_candidates():
    """NIFTY Ladder Both Side: far-OTM same-side strikes for a ~3–4 Rs long hedge."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    expiry = str(data.get("expiry") or data.get("expiryApi") or "").strip()
    option_type = str(data.get("optionType") or data.get("side") or "").strip().upper()
    try:
        spot = float(data.get("spot") or data.get("spotLtp") or 0)
        step = float(data.get("step") or 50)
    except Exception:
        return jsonify({"ok": False, "error": "invalid spot/step"}), 400
    try:
        from market.nifty_bothside import list_hedge_candidates

        rows = list_hedge_candidates(expiry=expiry, option_type=option_type, spot=spot, step=step)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("md_nifty_bothside_hedge_candidates failed")
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "candidates": rows, "count": len(rows)})


@app.post("/api/md/nifty_snake_bothside/hedge_candidates")
def md_nifty_snake_bothside_hedge_candidates():
    """NIFTY Snake Both Side: far-OTM same-side strikes for a ~3–4 Rs long hedge."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    data = request.get_json(silent=True) or {}
    expiry = str(data.get("expiry") or data.get("expiryApi") or "").strip()
    option_type = str(data.get("optionType") or data.get("side") or "").strip().upper()
    try:
        spot = float(data.get("spot") or data.get("spotLtp") or 0)
        step = float(data.get("step") or 50)
    except Exception:
        return jsonify({"ok": False, "error": "invalid spot/step"}), 400
    try:
        from market.nifty_snake_bothside import list_hedge_candidates

        rows = list_hedge_candidates(expiry=expiry, option_type=option_type, spot=spot, step=step)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        app.logger.exception("md_nifty_snake_bothside_hedge_candidates failed")
        return jsonify({"ok": False, "error": str(e)}), 500
    return jsonify({"ok": True, "candidates": rows, "count": len(rows)})


@app.post("/api/md/ema21/bootstrap")
def md_ema21_bootstrap():
    """Priority OHLC seed for Ramsetu table legs — 1-min candle 5 EMA (Angel parity)."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    instruments = data.get("instruments") or []
    if not isinstance(instruments, list) or not instruments:
        return jsonify({"ok": False, "error": "instruments[] required"}), 400

    normed: list[dict[str, Any]] = []
    for inst in instruments:
        seg = inst.get("exchangeSegment", inst.get("ExchangeSegment"))
        tid = inst.get("exchangeInstrumentID", inst.get("ExchangeInstrumentID"))
        if seg is None or tid is None:
            continue
        seg_i = int(seg)
        tid_i = int(tid)
        if seg_i > 0 and tid_i > 0:
            row: dict[str, Any] = {"exchangeSegment": seg_i, "exchangeInstrumentID": tid_i}
            for k in ("strike", "optType", "opt_side", "expiry"):
                if inst.get(k) is not None:
                    row[k] = inst.get(k)
            normed.append(row)

    if not normed:
        return jsonify({"ok": False, "error": "no valid instruments"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        from market.ema21_engine import get_ema21_engine

        tids = [int(r["exchangeInstrumentID"]) for r in normed]
        ema_map = {
            str(tid): float(get_ema21_engine().get(tid))
            for tid in tids
            if float(get_ema21_engine().get(tid)) > 0
        }
        _MD_STREAMER.bootstrap_ema21_now_async(normed, force=bool(data.get("force", False)))
        return jsonify(
            {
                "ok": True,
                "queued": True,
                "bootstrapped": list(ema_map.keys()),
                "failed": [],
                "ema21Map": ema_map,
            }
        )
    except Exception as e:
        app.logger.exception("md_ema21_bootstrap failed")
        return jsonify({"ok": False, "error": str(e)}), 500


def _truthy_qs(name: str) -> bool:
    v = (request.args.get(name, type=str) or "").strip().lower()
    return v in ("1", "true", "yes", "y", "on")


def _csv_qs(name: str) -> list[str]:
    raw = (request.args.get(name, type=str) or "").strip()
    if not raw:
        return []
    return [x.strip() for x in raw.split(",") if x.strip()]


def _normalize_expiry_label(label: str) -> str:
    """
    Normalize user-provided expiry label.
    - Keep "7 May" style intact (used by UI dropdowns)
    - For compact tokens like 07May2026 / 07may2026 -> 07MAY2026
    """
    s = str(label or "").strip()
    if not s:
        return ""
    # Compact token: ddMonYYYY (no spaces)
    compact = re.sub(r"[\s\-_/]", "", s)
    m = re.match(r"^(\d{1,2})([A-Za-z]{3})(\d{4})$", compact)
    if m:
        return f"{int(m.group(1)):02d}{m.group(2).upper()}{m.group(3)}"
    return s


def _parse_master_option_row(parts: list[str]) -> dict[str, str] | None:
    """
    Parse one Instruments Master row (pipe-separated) for Options instruments.
    Uses documented header order from Symphony API docs.
    """
    if len(parts) < 20:
        return None
    inst_type = parts[2].strip()
    if inst_type not in ("2", "OPTIONS", "OPTION"):
        return None
    try:
        return {
            "exchangeSegment": parts[0].strip().upper(),
            "exchangeInstrumentID": parts[1].strip(),
            "series": parts[5].strip().upper(),
            "name": parts[3].strip().upper(),
            "underlyingIndexName": parts[15].strip().upper(),
            "contractExpiration": parts[16].strip(),  # ISO-like string
            "strikePrice": parts[17].strip(),
            "optionType": parts[18].strip().upper(),  # often 3/4
            "displayName": (parts[19].strip() if len(parts) > 19 else ""),
            "description": (parts[4].strip() if len(parts) > 4 else ""),
        }
    except Exception:
        return None


def _master_cache_paths_for_day(day: str) -> list[Path]:
    cache_dir = Path(__file__).with_name("cache")
    if not cache_dir.exists():
        return []
    return sorted(cache_dir.glob(f"instruments_master_{day}_*.txt"), key=lambda p: p.stat().st_mtime, reverse=True)


def _ensure_master_cache_today(cli: Any, *, segments: list[str]) -> None:
    """
    Best-effort: ensure Instruments Master cache file exists for today.
    Avoids repeated slow optionSymbol calls for SENSEX.
    """
    day = datetime.now().strftime("%Y%m%d")
    safe_seg = "-".join(re.sub(r"[^A-Z0-9]+", "", str(s).strip().upper()) for s in segments)[:80] or "SEG"
    # Cache is per-day + per segment set; ensure *this* segment set exists (e.g., BSEFO for SENSEX).
    cache_dir = Path(__file__).with_name("cache")
    if cache_dir.exists():
        existing = list(cache_dir.glob(f"instruments_master_{day}_{safe_seg}.txt"))
        if existing:
            return
    try:
        resp = cli.instruments_master(segments)
        result = resp.get("result") if isinstance(resp, dict) else resp
        if isinstance(result, list):
            raw_text = "\n".join(str(x) for x in result)
        elif isinstance(result, dict):
            raw_text = json.dumps(result, ensure_ascii=False)
        else:
            raw_text = str(result or "")
        if not raw_text.strip():
            return
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path = cache_dir / f"instruments_master_{day}_{safe_seg}.txt"
        cache_path.write_text(raw_text, encoding="utf-8")
    except Exception:
        return


def _try_resolve_chain_from_master(
    *,
    index_key: str,
    expiry_attempts: list[str],
    atm_strike: int,
    step: float,
    wings: int,
) -> dict[str, dict[str, int]] | None:
    """
    Try to build strike->(ce,pe) mapping from cached Instruments Master.
    This avoids slow broker calls for optionSymbol per strike.
    """
    day = datetime.now().strftime("%Y%m%d")
    candidates = _master_cache_paths_for_day(day)
    if not candidates:
        return None

    # Expiry match: accept any attempt token; normalize to date-only if possible.
    attempt_set = set(str(x).strip() for x in expiry_attempts if str(x).strip())
    attempt_dates = set()
    for a in list(attempt_set):
        m = re.match(r"^(\d{4}-\d{2}-\d{2})", a)
        if m:
            attempt_dates.add(m.group(1))
        m2 = re.match(r"^(\d{2})([A-Z]{3})(\d{4})$", re.sub(r"[\s\-_/]", "", a).upper())
        if m2:
            # convert 07MAY2026 -> 2026-05-07
            dd, mon3, yyyy = int(m2.group(1)), m2.group(2).upper(), int(m2.group(3))
            months = {"JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6, "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12}
            mm = months.get(mon3)
            if mm:
                attempt_dates.add(f"{yyyy:04d}-{mm:02d}-{dd:02d}")

    # Master dumps vary: some return segment names (NSEFO/BSEFO) while others return numeric ids (2/12).
    bsefo = str(EXCHANGE_SEGMENTS["BSEFO"])
    nsefo = str(EXCHANGE_SEGMENTS["NSEFO"])
    seg_whitelist = {"BSEFO", "NSEFO", bsefo, nsefo}
    series_whitelist = {"OPTIDX", "IO", "O"}

    # Build strike set we care about.
    strike_targets = {int(atm_strike + int(off * step)) for off in range(-wings, wings + 1)}
    out: dict[str, dict[str, int]] = {}

    def _opt_side(row: dict[str, str]) -> str | None:
        ot = row.get("optionType", "").strip().upper()
        disp = (row.get("displayName") or row.get("description") or "").upper()
        if ot in ("3", "CE", "CALL"):
            return "ce"
        if ot in ("4", "PE", "PUT"):
            return "pe"
        if " CE " in f" {disp} " or disp.endswith(" CE") or disp.endswith("CE"):
            return "ce"
        if " PE " in f" {disp} " or disp.endswith(" PE") or disp.endswith("PE"):
            return "pe"
        return None

    # Read the newest cache first (latest segments set).
    for path in candidates[:3]:
        try:
            raw = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for line in raw.splitlines():
            if "|" not in line:
                continue
            parts = [p.strip() for p in line.split("|")]
            row = _parse_master_option_row(parts)
            if not row:
                continue
            if row["exchangeSegment"] not in seg_whitelist:
                continue
            if row["series"] and row["series"] not in series_whitelist:
                continue
            under1 = str(row.get("underlyingIndexName") or "").upper()
            row_name = str(row.get("name") or "").strip().upper()
            under_c = re.sub(r"[^A-Z]+", "", (under1 + " " + row_name))
            key = str(index_key or "").upper()
            if key == "SENSEX":
                if "SENSEX" not in under_c:
                    continue
            elif key == "BANKNIFTY":
                # Master underlying may be "Nifty Bank"; symbol name must be BANKNIFTY only.
                if row_name != "BANKNIFTY":
                    continue
            elif key == "NIFTY":
                # "NIFTY" substring also matches FINNIFTY / NIFTYNXT50 / MIDCPNIFTY — use exact name.
                if row_name != "NIFTY":
                    continue
            else:
                if key and key not in under_c:
                    continue
            exp = row.get("contractExpiration") or ""
            exp_date = exp.split("T", 1)[0] if exp else ""
            if attempt_set and (exp not in attempt_set) and (exp_date not in attempt_dates):
                continue
            try:
                strike_i = int(round(float(row.get("strikePrice") or "0")))
            except Exception:
                continue
            if strike_i not in strike_targets:
                continue
            side = _opt_side(row)
            if not side:
                continue
            iid_s = row.get("exchangeInstrumentID") or ""
            if not iid_s.isdigit():
                continue
            bucket = out.setdefault(str(strike_i), {})
            bucket[side] = int(iid_s)

        # If we already have most strikes, stop early.
        if out and sum(1 for v in out.values() if "ce" in v and "pe" in v) >= max(5, int(len(strike_targets) * 0.6)):
            break

    # Keep only complete pairs.
    paired = {k: v for k, v in out.items() if "ce" in v and "pe" in v}
    return paired or None


@app.get("/api/instruments/master")
def instruments_master():
    """
    Fetch + cache the Symphony/XTS Instruments Master once per day.
    Doc: https://developers.symphonyfintech.in/doc/apimarketdata/#instruments-master
    """
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    # Default includes NSE segments; add BSEFO when explicitly requested for Sensex options mapping.
    segments = _csv_qs("segments") or ["NSECM", "NSEFO", "NSECD"]
    segments = [str(s).strip().upper() for s in segments if str(s).strip()]
    if not segments:
        return jsonify({"ok": False, "error": "segments query param required"}), 400

    refresh = _truthy_qs("refresh")
    as_lines = _truthy_qs("lines")

    # Cache file is per-day + per segment set.
    day = datetime.now().strftime("%Y%m%d")
    safe_seg = "-".join(re.sub(r"[^A-Z0-9]+", "", s) for s in segments)[:80] or "SEG"
    cache_dir = Path(__file__).with_name("cache")
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"instruments_master_{day}_{safe_seg}.txt"

    if cache_path.exists() and cache_path.is_file() and not refresh:
        raw_text = cache_path.read_text(encoding="utf-8", errors="replace")
        payload: dict[str, object] = {
            "ok": True,
            "cached": True,
            "segments": segments,
            "day": day,
        }
        if as_lines:
            payload["lines"] = [ln for ln in raw_text.split("\n") if ln.strip()]
        else:
            payload["raw"] = raw_text
        return jsonify(payload)

    try:
        _ensure_market_streamer(username)
        cli = _MD_STREAMER.rest_client()
        resp = cli.instruments_master(segments)
        result = resp.get("result") if isinstance(resp, dict) else resp

        if isinstance(result, list):
            raw_text = "\n".join(str(x) for x in result)
        elif isinstance(result, dict):
            raw_text = json.dumps(result, ensure_ascii=False)
        else:
            raw_text = str(result or "")

        cache_path.write_text(raw_text, encoding="utf-8")

        payload2: dict[str, object] = {
            "ok": True,
            "cached": False,
            "segments": segments,
            "day": day,
        }
        if as_lines:
            payload2["lines"] = [ln for ln in raw_text.split("\n") if ln.strip()]
        else:
            payload2["raw"] = raw_text
        return jsonify(payload2)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


def _spot_plausible_for_index(idx: str, px: float) -> bool:
    """Reject garbage parsed from malformed quote JSON (e.g. stray small numbers)."""
    bounds = {
        "SENSEX": (38_000.0, 160_000.0),
        "NIFTY": (15_000.0, 35_000.0),
        "BANKNIFTY": (40_000.0, 70_000.0),
    }
    lo, hi = bounds.get(idx, (1e-9, 1e15))
    return lo <= float(px) <= hi


def _synthetic_expiry_token(label: str) -> str | None:
    """UI label like '7 May' / '18Jun2026' -> '07MAY2026' (current year when year omitted)."""
    sk = _expiry_token_sort_key(label)
    if sk:
        y, mon, d = sk
        return f"{int(d):02d}{_MONTH_LABELS[mon - 1].upper()}{int(y)}"
    m = re.match(r"^\s*(\d{1,2})\s+([a-z]{3,9})\s*$", (label or "").strip(), re.I)
    if not m:
        return None
    day = int(m.group(1))
    mon_full = m.group(2).upper()
    yr = datetime.now().year
    return f"{day:02d}{mon_full}{yr}"


def _expiry_token_variants(token: str) -> list[str]:
    """Alternate spellings brokers use for expiryDate query param."""
    t = str(token or "").strip()
    if not t:
        return []
    out: list[str] = [t]

    # ISO forms returned by expiryDate often include time; optionsymbol sometimes expects date-only.
    iso_dt = re.match(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})", t)
    iso_d = re.match(r"^(\d{4}-\d{2}-\d{2})$", t)
    if iso_dt:
        date_only = iso_dt.group(1)
        out.extend([date_only, f"{date_only}T00:00:00"])
        try:
            y, mo, da = int(date_only[0:4]), int(date_only[5:7]), int(date_only[8:10])
            mon_lbl = _MONTH_LABELS[mo - 1].upper()
            out.extend([f"{da:02d}{mon_lbl}{y}", f"{da}{mon_lbl}{y}"])
        except Exception:
            pass
    elif iso_d:
        date_only = iso_d.group(1)
        out.append(f"{date_only}T00:00:00")
        try:
            y, mo, da = int(date_only[0:4]), int(date_only[5:7]), int(date_only[8:10])
            mon_lbl = _MONTH_LABELS[mo - 1].upper()
            out.extend([f"{da:02d}{mon_lbl}{y}", f"{da}{mon_lbl}{y}"])
        except Exception:
            pass
    compact = re.sub(r"[\s\-_/]", "", t)
    if compact != t:
        out.append(compact)
    cu = compact.upper()
    out.append(cu)
    out.append(compact.capitalize())

    m = re.match(r"^(\d{1,2})([A-Za-z]{3})(\d{2}|\d{4})$", compact)
    if m:
        d, mon_upper, yr = int(m.group(1)), m.group(2).upper(), m.group(3)
        y4 = yr if len(yr) == 4 else (f"20{yr}")
        titled = mon_upper[:1] + mon_upper[1:].lower()
        out.extend(
            [
                f"{d:02d}{mon_upper}{y4}",
                f"{d}{mon_upper}{y4}",
                f"{d:02d}{titled}{y4}",
                f"{d:02d}-{mon_upper}-{y4}",
                f"{d:02d}-{titled}-{y4}",
                f"{d:02d}{mon_upper}{y4[2:]}",
            ]
        )
        try:
            yi = int(y4)
            for delta in (-1, 1):
                ya = str(yi + delta)
                out.extend([f"{d:02d}{mon_upper}{ya}", f"{d:02d}{titled}{ya}"])
        except ValueError:
            pass

    seen: set[str] = set()
    uniq: list[str] = []
    for z in out:
        z = str(z).strip()
        if z and z not in seen:
            seen.add(z)
            uniq.append(z)
    return uniq


def _broker_expiries_for_ui_label(expiry_label: str, broker_expiries: list[str]) -> list[str]:
    """All broker strings that look like the UI day+month (e.g. 7 May / 18Jun2026)."""
    if not broker_expiries:
        return []
    sk_label = _expiry_token_sort_key(expiry_label)
    if sk_label:
        hits: list[str] = []
        for c in broker_expiries:
            if _expiry_token_sort_key(c) == sk_label:
                hits.append(str(c).strip())
        if hits:
            return list(dict.fromkeys(hits))
    m = re.match(r"^\s*(\d{1,2})\s+([a-z]{3,9})\s*$", (expiry_label or "").strip(), re.I)
    if not m:
        return []
    day_s = str(int(m.group(1)))
    month_prefix = m.group(2).lower()[:3]
    months = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
    month_num = months.get(month_prefix)
    hits: list[str] = []
    for c in broker_expiries:
        lc = c.lower().replace(" ", "")
        ok_day = day_s in lc or f"{int(day_s):02d}" in lc
        ok_mon = month_prefix in lc
        if month_num and not ok_mon:
            ok_mon = any(x in lc for x in (f"{month_num}", f"{month_num:02d}"))
        if ok_day and ok_mon:
            hits.append(c)
    return list(dict.fromkeys(hits))


def _build_expiry_attempt_order(
    *,
    expiry_label: str,
    expiry_primary: str,
    synth: str | None,
    broker_expiries: list[str],
) -> list[str]:
    # If we already have an exact ISO token from the broker list, don't explode into variants.
    # This avoids wasting the resolve budget on many failing expiry permutations.
    exp0 = str(expiry_primary or "").strip()
    if exp0 and exp0 in set(str(x).strip() for x in broker_expiries):
        # Broker expiryDate list tokens often differ from optionSymbol accepted spellings
        # (ISO with session time vs date-only vs 18JUN2026). Try all safe variants first.
        short: list[str] = [exp0]
        m = re.match(r"^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})", exp0)
        if m:
            d0 = m.group(1)
            t0 = m.group(2)
            short.append(d0)
            if t0 != "00:00:00":
                short.append(f"{d0}T00:00:00")
        for v in _expiry_token_variants(exp0):
            short.append(v)
        if expiry_label.strip():
            for v in _expiry_token_variants(expiry_label):
                short.append(v)
        seen: set[str] = set()
        uniq: list[str] = []
        for x in short:
            s = str(x).strip()
            if s and s not in seen:
                seen.add(s)
                uniq.append(s)
                if len(uniq) >= 28:
                    break
        return uniq

    buckets: list[list[str]] = []
    buckets.append(_broker_expiries_for_ui_label(expiry_label, broker_expiries))
    if expiry_primary.strip():
        buckets.append(_expiry_token_variants(expiry_primary))
    if synth:
        buckets.append(_expiry_token_variants(synth))
    buckets.append(list(broker_expiries[:40]))

    out: list[str] = []
    seen: set[str] = set()
    for b in buckets:
        for x in b:
            s = str(x).strip()
            if s and s not in seen:
                seen.add(s)
                out.append(s)
                if len(out) >= 56:
                    return out
    return out


def _csv_env_tokens(name: str) -> list[str]:
    return [x.strip() for x in _env(name, "").split(",") if x.strip()]


def _gather_broker_expiries(cli: Any, index_key: str) -> tuple[list[str], list[str]]:
    """Return (unique broker expiry strings, fetch notes) for the index."""
    if index_key not in INDEX_MD_SPECS:
        return [], ["invalid index"]
    spec = INDEX_MD_SPECS[index_key]
    opt_seg = int(spec["option_segment"])
    series = str(spec["series"])
    symbol = str(spec["symbol"])
    expiry_fetch_notes: list[str] = []
    broker_expiries: list[str] = []
    seen_bx: set[str] = set()

    if index_key == "SENSEX":
        for seg, ser, sym in _sensex_md_probe_triples(opt_seg, series, symbol):
            try:
                ed = cli.get_expiry_date(int(seg), ser, sym)
                part = flatten_json_strings(ed.get("result") if isinstance(ed, dict) else ed)
                if not part:
                    part = flatten_json_strings(ed)
                for raw in part:
                    s = str(raw).strip()
                    if s and s not in seen_bx:
                        seen_bx.add(s)
                        broker_expiries.append(s)
            except Exception as e:
                expiry_fetch_notes.append(f"expiry(seg={seg},ser={ser},sym={sym}): {e!s}")
    else:
        try:
            ed = cli.get_expiry_date(int(opt_seg), series, symbol)
            part = flatten_json_strings(ed.get("result") if isinstance(ed, dict) else ed)
            if not part:
                part = flatten_json_strings(ed)
            for raw in part:
                s = str(raw).strip()
                if s and s not in seen_bx:
                    seen_bx.add(s)
                    broker_expiries.append(s)
        except Exception as e:
            expiry_fetch_notes.append(f"expiry(seg={opt_seg}): {e!s}")

    return broker_expiries, expiry_fetch_notes


_MONTH_ORDER = {
    "JAN": 1,
    "FEB": 2,
    "MAR": 3,
    "APR": 4,
    "MAY": 5,
    "JUN": 6,
    "JUL": 7,
    "AUG": 8,
    "SEP": 9,
    "OCT": 10,
    "NOV": 11,
    "DEC": 12,
}
_MONTH_LABELS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _expiry_token_sort_key(raw: str) -> tuple[int, int, int] | None:
    s = str(raw).strip()
    if not s:
        return None

    # Common broker formats we see:
    # - 07MAY2026 / 07MAY26 / 7MAY2026
    # - 2026-05-07T00:00:00 / 2026-05-07
    # - 20260507
    iso = re.match(r"^\s*(\d{4})-(\d{2})-(\d{2})", s)
    if iso:
        y, mon, d = int(iso.group(1)), int(iso.group(2)), int(iso.group(3))
        return (y, mon, d)

    digits = re.sub(r"[^\d]", "", s)
    if len(digits) >= 8 and digits[:8].isdigit() and (s.strip().isdigit() or "-" not in s and "T" not in s):
        # YYYYMMDD
        y, mon, d = int(digits[0:4]), int(digits[4:6]), int(digits[6:8])
        if 2000 <= y <= 2100 and 1 <= mon <= 12 and 1 <= d <= 31:
            return (y, mon, d)

    c = re.sub(r"[\s\-_/]", "", s).upper()
    m = re.match(r"^(\d{1,2})([A-Z]{3})(\d{4}|\d{2})$", c)
    if not m:
        return None
    d = int(m.group(1))
    mon = _MONTH_ORDER.get(m.group(2))
    if not mon:
        return None
    y = int(m.group(3))
    if y < 100:
        y += 2000
    return (y, mon, d)


def _expiry_token_to_ui_label(raw: str) -> str:
    sk = _expiry_token_sort_key(raw)
    if sk:
        y, mon, d = sk
        # UI format requested: 07May2026
        return f"{int(d):02d}{_MONTH_LABELS[mon - 1]}{int(y)}"
    return str(raw).strip()


def _expiries_to_sorted_rows(broker_tokens: list[str]) -> list[dict[str, str]]:
    """Deduplicate by calendar day label; sort ascending; preserve broker token per row."""
    best: dict[str, tuple[tuple[int, int, int], str]] = {}
    for raw in broker_tokens:
        lbl = _expiry_token_to_ui_label(raw)
        sk = _expiry_token_sort_key(raw) or (9999, 12, 31)
        if lbl not in best or sk < best[lbl][0]:
            best[lbl] = (sk, str(raw).strip())

    ordered = sorted(best.items(), key=lambda kv: kv[1][0])
    # Only current expiry + next 2 (based on today)
    today = datetime.now().date()
    today_key = (today.year, today.month, today.day)
    start = 0
    for i, (_lbl, (sk, _tok)) in enumerate(ordered):
        if sk >= today_key:
            start = i
            break
    ordered = ordered[start : start + 3]
    return [{"label": lbl, "api": pair[1]} for lbl, pair in ordered]


def _sensex_md_probe_triples(opt_seg: int, series: str, symbol: str) -> list[tuple[int, str, str]]:
    """
    BSE Sensex FO often needs segment 12 with the same symbol as NSE; series can be OPTIDX or IO.
    Extra values from env: XTS_SENSEX_SERIES_PROBE, XTS_SENSEX_SYMBOL_PROBE, XTS_SENSEX_EXTRA_SEGMENTS
    """
    ser_extra = _csv_env_tokens("XTS_SENSEX_SERIES_PROBE")
    sym_extra = _csv_env_tokens("XTS_SENSEX_SYMBOL_PROBE")
    seg_extra: list[int] = []
    for x in _csv_env_tokens("XTS_SENSEX_EXTRA_SEGMENTS"):
        try:
            seg_extra.append(int(x))
        except ValueError:
            continue
    series_list = list(dict.fromkeys([series, *ser_extra, "OPTIDX", "IO", "O"]))
    symbol_list = list(dict.fromkeys([symbol, *sym_extra, "SENSEX"]))
    # BSE Sensex weekly options normally trade under BFO (segment 12); try before NSE FO (2).
    bsefo = EXCHANGE_SEGMENTS["BSEFO"]
    nsefo = EXCHANGE_SEGMENTS["NSEFO"]
    seg_list = list(dict.fromkeys([int(opt_seg), bsefo, nsefo, *seg_extra]))
    out: list[tuple[int, str, str]] = []
    for seg in seg_list:
        for ser in series_list[:10]:
            for sym in symbol_list[:8]:
                t = (int(seg), str(ser), str(sym))
                if t not in out:
                    out.append(t)
                if len(out) >= 64:
                    return out
    return out


def _extract_seg_series_symbol_tuples(obj: object) -> list[tuple[int, str, str]]:
    """Best-effort extract (exchangeSegment, series, symbol) tuples from a broker search response."""
    out: list[tuple[int, str, str]] = []

    def _walk(x: object) -> None:
        if isinstance(x, dict):
            seg = x.get("exchangeSegment", x.get("ExchangeSegment", x.get("segment", x.get("Segment"))))
            ser = x.get("series", x.get("Series"))
            sym = x.get("symbol", x.get("Symbol"))
            try:
                if seg is not None and ser is not None and sym is not None:
                    t = (int(seg), str(ser).strip(), str(sym).strip())
                    if t[1] and t[2] and t not in out:
                        out.append(t)
            except Exception:
                pass
            for v in x.values():
                _walk(v)
        elif isinstance(x, list):
            for v in x:
                _walk(v)

    _walk(obj)
    return out


def _extract_option_contract_candidates(obj: object) -> list[dict[str, object]]:
    """
    Extract option-like rows from broker search payload.
    We look for fields: exchangeSegment/ExchangeSegment, exchangeInstrumentID/ExchangeInstrumentID,
    series, symbol, expiryDate/ExpiryDate, optionType/OptionType, strikePrice/StrikePrice.
    """
    rows: list[dict[str, object]] = []

    def _walk(x: object) -> None:
        if isinstance(x, dict):
            kmap = {
                "exchangeSegment": x.get("exchangeSegment", x.get("ExchangeSegment")),
                "exchangeInstrumentID": x.get("exchangeInstrumentID", x.get("ExchangeInstrumentID")),
                "series": x.get("series", x.get("Series")),
                "symbol": x.get("symbol", x.get("Symbol")),
                "expiryDate": x.get("expiryDate", x.get("ExpiryDate")),
                "optionType": x.get("optionType", x.get("OptionType")),
                "strikePrice": x.get("strikePrice", x.get("StrikePrice")),
            }
            has_any = any(v is not None for v in kmap.values())
            if has_any:
                rows.append(kmap)
            for v in x.values():
                _walk(v)
        elif isinstance(x, list):
            for v in x:
                _walk(v)

    _walk(obj)
    return rows


def _discover_option_params_from_search(
    cli: Any, *, symbol_hint: str, atm_strike: int, expiry_attempts: list[str]
) -> tuple[int, str, str, str, int | None, int | None] | None:
    """
    Try to discover (segment, series, symbol, expiryDate token, atmCE, atmPE) from broker search.
    Returns None when not found.
    """
    q_variants = [
        f"{symbol_hint} {atm_strike}",
        f"{symbol_hint} {atm_strike} CE",
        f"{symbol_hint} {atm_strike} PE",
        f"{symbol_hint} {atm_strike} CALL",
        f"{symbol_hint} {atm_strike} PUT",
        f"{symbol_hint} OPT {atm_strike}",
    ]

    today = datetime.now().date()
    today_key = (today.year, today.month, today.day)

    def _to_int(v: object) -> int | None:
        if v is None or isinstance(v, bool):
            return None
        try:
            return int(v)  # type: ignore[arg-type]
        except Exception:
            try:
                s = str(v).strip()
                if not s:
                    return None
                if s.isdigit():
                    return int(s)
                return int(float(s))
            except Exception:
                return None

    def _to_float(v: object) -> float | None:
        if v is None or isinstance(v, bool):
            return None
        try:
            return float(v)  # type: ignore[arg-type]
        except Exception:
            try:
                s = str(v).strip()
                if not s:
                    return None
                return float(s)
            except Exception:
                return None

    # Gather all candidates from search responses.
    candidates: list[dict[str, object]] = []
    for q in q_variants:
        try:
            sr = cli.search_by_string(q)
            candidates.extend(_extract_option_contract_candidates(sr))
        except Exception:
            continue

    if not candidates:
        return None

    # Normalize and filter to option-like rows with basic fields.
    norm: list[dict[str, object]] = []
    for r in candidates:
        seg = _to_int(r.get("exchangeSegment"))
        series = str(r.get("series") or "").strip()
        sym = str(r.get("symbol") or "").strip()
        exp = str(r.get("expiryDate") or "").strip()
        opt = str(r.get("optionType") or "").strip().upper()
        sp = _to_float(r.get("strikePrice"))
        iid = _to_int(r.get("exchangeInstrumentID"))
        if seg is None or not series or not sym or not exp:
            continue
        if opt and opt not in ("CE", "PE", "CALL", "PUT"):
            continue
        if sp is None:
            continue
        # discard stale expiries if parseable
        sk = _expiry_token_sort_key(exp)
        if sk and sk < today_key:
            continue
        norm.append(
            {
                "seg": seg,
                "series": series,
                "symbol": sym,
                "expiry": exp,
                "opt": ("CE" if opt in ("CE", "CALL") else "PE" if opt in ("PE", "PUT") else ""),
                "strike": float(sp),
                "iid": iid,
            }
        )

    if not norm:
        return None

    # Prefer contracts matching our desired expiry attempts (any variant), and closest strike.
    attempt_set = set(str(x).strip() for x in expiry_attempts if str(x).strip())

    def _score(r: dict[str, object]) -> tuple[int, float]:
        exp = str(r.get("expiry") or "")
        strike = float(r.get("strike") or 0.0)
        hit = 0 if exp in attempt_set else 1
        return (hit, abs(strike - float(atm_strike)))

    norm.sort(key=_score)

    # Find a CE+PE pair with same seg/series/symbol/expiry and strike ~ atm.
    # Use a small band around ATM strike to tolerate rounding differences.
    band = max(5.0, float(abs(atm_strike)) * 0.0005)
    by_key: dict[tuple[int, str, str, str, int], dict[str, dict[str, object]]] = {}
    for r in norm[:600]:
        seg = int(r["seg"])
        series = str(r["series"])
        sym = str(r["symbol"])
        exp = str(r["expiry"])
        strike_i = int(round(float(r["strike"])))
        if abs(float(strike_i) - float(atm_strike)) > band:
            continue
        key = (seg, series, sym, exp, strike_i)
        bucket = by_key.setdefault(key, {})
        opt = str(r.get("opt") or "")
        if opt in ("CE", "PE"):
            bucket[opt] = r

    for (seg, series, sym, exp, strike_i), bucket in by_key.items():
        if "CE" in bucket and "PE" in bucket:
            ce_iid = bucket["CE"].get("iid")
            pe_iid = bucket["PE"].get("iid")
            return int(seg), str(series), str(sym), str(exp), _to_int(ce_iid), _to_int(pe_iid)

    return None


def _guess_atm_strike_from_option_search(
    cli: Any, *, symbol_hint: str, expiry_attempts: list[str], step: int
) -> int | None:
    """
    When spot quote is unavailable (permissions/market closed), approximate ATM strike
    by looking at option contracts returned by broker search.
    """
    q_variants = [
        f"{symbol_hint} CE",
        f"{symbol_hint} PE",
        f"{symbol_hint} OPT",
        f"{symbol_hint} OPTIDX",
        f"{symbol_hint}",
    ]
    candidates: list[dict[str, object]] = []
    for q in q_variants:
        try:
            sr = cli.search_by_string(q)
            candidates.extend(_extract_option_contract_candidates(sr))
        except Exception:
            continue
    if not candidates:
        return None

    attempt_set = set(str(x).strip() for x in expiry_attempts if str(x).strip())
    strikes: list[int] = []
    for r in candidates:
        exp = str(r.get("expiryDate") or "").strip()
        if exp and attempt_set and exp not in attempt_set:
            # keep only near-term expiry results when possible
            continue
        sp = r.get("strikePrice")
        try:
            s_f = float(sp)  # type: ignore[arg-type]
            if s_f > 0:
                strikes.append(int(round(s_f)))
        except Exception:
            continue

    if not strikes:
        return None

    # Snap to step and choose the most common strike; fallback to median.
    snapped = [int(round(x / float(step)) * step) for x in strikes]
    freq: dict[int, int] = {}
    for x in snapped:
        freq[x] = freq.get(x, 0) + 1
    best = max(freq.items(), key=lambda kv: (kv[1], -abs(kv[0] - (sum(snapped) / max(1, len(snapped))))))[0]
    return int(best)


@app.post("/api/chain/expiries")
def chain_expiries():
    """Broker expiries for an index; optional strike filter when chain fields are known."""
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    index_key = str(data.get("index") or "").strip().upper()

    if index_key not in INDEX_MD_SPECS:
        return jsonify({"ok": False, "error": "Invalid index"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    cli = _MD_STREAMER.rest_client()
    broker_expiries, notes = _gather_broker_expiries(cli, index_key)

    strike_raw = data.get("strike")
    opt_seg_raw = data.get("optionSegment")
    series_eff = data.get("optionSeries")
    symbol_eff = data.get("optionSymbol")

    filtered = list(broker_expiries)
    strike_applied = False
    if strike_raw is not None and opt_seg_raw is not None and series_eff and symbol_eff:
        try:
            sk = float(strike_raw)
            seg = int(opt_seg_raw)
            ser = str(series_eff).strip()
            sym = str(symbol_eff).strip()
            strike_applied = True
            ok_tokens: list[str] = []
            for exp_tok in broker_expiries:
                try:
                    cre = cli.get_option_symbol(seg, ser, sym, str(exp_tok), "CE", sk)
                    pre = cli.get_option_symbol(seg, ser, sym, str(exp_tok), "PE", sk)
                    if isinstance(cre, dict) and cre.get("type") == "error":
                        continue
                    if isinstance(pre, dict) and pre.get("type") == "error":
                        continue
                    if first_exchange_instrument_id(cre) is not None and first_exchange_instrument_id(pre) is not None:
                        ok_tokens.append(str(exp_tok).strip())
                except Exception:
                    continue
            filtered = ok_tokens
        except (TypeError, ValueError):
            strike_applied = False

    rows = _expiries_to_sorted_rows(filtered)
    return jsonify(
        {
            "ok": True,
            "expiries": rows,
            "expiryFetchNotes": notes[:12],
            "strikeFilterApplied": bool(strike_applied and rows),
            "strikeFilterEmpty": bool(strike_applied and not rows),
        }
    )




@app.post("/api/chain/resolve")
def chain_resolve():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    index_key = str(data.get("index") or "").strip().upper()
    expiry_label = _normalize_expiry_label(str(data.get("expiry") or data.get("expiryLabel") or ""))
    # This endpoint can become very slow (each strike triggers 2 REST calls). Keep it bounded.
    # Default 60 supports deep OTM (e.g. hedge ATM+40) without extra env; lower via XTS_CHAIN_WINGS_MAX if needed.
    wings_max = int(_env("XTS_CHAIN_WINGS_MAX", "60") or "60")
    wings = max(1, min(int(data.get("wings") or wings_max), wings_max))
    started = time.time()
    budget_s = float(_env("XTS_CHAIN_RESOLVE_BUDGET_S", "30") or "30")
    budget_s = max(6.0, min(budget_s, 60.0))

    def _budget_exceeded() -> bool:
        return (time.time() - started) > budget_s

    if index_key not in INDEX_MD_SPECS:
        return jsonify({"ok": False, "error": "Invalid index"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    spec = INDEX_MD_SPECS[index_key]
    spot_seg = int(spec["spot_segment"])
    spot_token = int(spec["spot_token"])
    opt_seg = int(spec["option_segment"])
    series = str(spec["series"])
    symbol = str(spec["symbol"])
    step = float(spec["step"])

    cli = _MD_STREAMER.rest_client()
    # Tighten REST timeout during chain resolve so UI doesn't hang.
    prev_timeout = getattr(cli, "timeout_s", 7.0)
    try:
        cli.timeout_s = min(float(prev_timeout or 7.0), float(_env("XTS_CHAIN_RESOLVE_HTTP_TIMEOUT_S", "6") or "6"))
    except Exception:
        prev_timeout = getattr(cli, "timeout_s", prev_timeout)

    broker_expiries, expiry_fetch_notes = _gather_broker_expiries(cli, index_key)

    expiry_primary: str | None = None
    if expiry_label and broker_expiries:
        expiry_primary = pick_expiry_for_label(expiry_label, broker_expiries)
    elif broker_expiries:
        expiry_primary = broker_expiries[0]

    synth = _synthetic_expiry_token(expiry_label) if expiry_label else None
    if not expiry_primary:
        expiry_primary = synth

    if not expiry_primary:
        return jsonify(
            {
                "ok": False,
                "error": "Could not resolve expiry token",
                "details": "; ".join(expiry_fetch_notes)[:800],
                "brokerExpiriesSample": broker_expiries[:30],
                "series": series,
                "symbol": symbol,
            }
        ), 502

    # Build expiry token attempts early (used by spot fallback + Sensex discovery).
    expiry_attempts = _build_expiry_attempt_order(
        expiry_label=expiry_label,
        expiry_primary=expiry_primary,
        synth=synth,
        broker_expiries=broker_expiries,
    )

    # Ensure Instruments Master cache exists (best-effort). Fast path when optionSymbol REST is slow/rejected.
    if index_key == "SENSEX":
        _ensure_master_cache_today(cli, segments=["BSEFO", "NSEFO"])
    elif index_key in ("NIFTY", "BANKNIFTY"):
        _ensure_master_cache_today(cli, segments=["NSEFO", "NSECM"])

    probes = normalize_spot_probes(spec)
    discover_hint = index_key if bool(spec.get("spot_discovery", True)) else None

    (
        spot_ltp,
        spot_used_seg,
        spot_used_tid,
        spot_quote_code,
        spot_diag,
        spot_prev_close,
        spot_change_pct,
        spot_day_open,
        spot_day_high,
        spot_day_low,
    ) = fetch_index_spot_ltp(
        cli,
        probes,
        discover_name_hint=discover_hint,
    )

    # Sensex spot token is vendor-dependent; some accounts cannot quote indices via REST.
    # If spot quote fails, approximate ATM from option search so chain can still load.
    if (spot_ltp is None or spot_ltp <= 0) and index_key == "SENSEX":
        guessed = _guess_atm_strike_from_option_search(cli, symbol_hint="SENSEX", expiry_attempts=expiry_attempts, step=int(step))
        if guessed is not None and guessed > 0:
            spot_ltp = float(guessed)
            spot_used_seg = None
            spot_used_tid = None
            spot_quote_code = None
            spot_quote_note = (spot_diag or "") + "; spot_fallback=option_search"
            spot_diag = spot_quote_note

    spot_seg_effective = int(spot_used_seg or spot_seg)
    spot_token_effective = int(spot_used_tid) if spot_used_tid is not None else int(spot_token)
    spot_quote_note = spot_diag
    if spot_used_tid is not None and int(spot_used_tid) != int(spot_token):
        tag = f"broker_token_resolved={spot_used_tid} (config was {spot_token})"
        spot_quote_note = f"{spot_diag}; {tag}" if spot_diag else tag

    if spot_ltp is None or spot_ltp <= 0:
        return jsonify(
            {
                "ok": False,
                "error": "Could not load spot quote (check token / segment / market session / md_key permission)",
                "details": spot_diag,
                "expiryApi": expiry_primary,
                "probesTried": [{"segment": int(s), "instrumentId": int(i)} for s, i in probes],
            }
        ), 502

    if not _spot_plausible_for_index(index_key, float(spot_ltp)):
        return jsonify(
            {
                "ok": False,
                "error": (
                    "Spot quote parsed to an unrealistic value — likely a malformed feed field. "
                    "Retry outside discovery search noise or verify MD permissions."
                ),
                "details": spot_diag,
                "spotLtpAttempt": float(spot_ltp),
            }
        ), 502

    atm_strike = int(round(float(spot_ltp) / step) * step)

    spot_prev_close_o: float | None = float(spot_prev_close) if (spot_prev_close is not None and float(spot_prev_close) > 0) else None
    spot_pct_o: float | None = None
    if spot_change_pct is not None and isinstance(spot_change_pct, (int, float)):
        try:
            spf = float(spot_change_pct)
            spot_pct_o = spf if spf == spf else None
        except Exception:
            spot_pct_o = None
    spot_day_open_o: float | None = float(spot_day_open) if (spot_day_open is not None and float(spot_day_open) > 0) else None
    spot_day_high_o: float | None = (
        float(spot_day_high) if (spot_day_high is not None and float(spot_day_high) > 0) else None
    )
    spot_day_low_o: float | None = (
        float(spot_day_low) if (spot_day_low is not None and float(spot_day_low) > 0) else None
    )
    if (
        spot_day_high_o is not None
        and spot_day_low_o is not None
        and spot_day_high_o + 1e-9 < spot_day_low_o
    ):
        spot_day_high_o, spot_day_low_o = spot_day_low_o, spot_day_high_o

    # India VIX: sockets often omit Close/Open → TopBar Δ/% stays blank unless we hydrate from REST.
    vix_prev_close_o: float | None = None
    vix_day_open_o: float | None = None
    try:
        _vinst = [{"exchangeSegment": int(VIX_SEGMENT_ID), "exchangeInstrumentID": int(VIX_INSTRUMENT_ID)}]
        for _vc in (1504, 1502, 1501, 1512):
            if _budget_exceeded():
                break
            try:
                _vr = cli.get_quote(_vinst, int(_vc))
                _vpc, _vpct, _vop, _vh, _vl = quote_spot_anchor_fields_from_response(_vr)
                if vix_prev_close_o is None and _vpc is not None and float(_vpc) > 0:
                    vix_prev_close_o = float(_vpc)
                if vix_day_open_o is None and _vop is not None and float(_vop) > 0:
                    vix_day_open_o = float(_vop)
                if vix_prev_close_o is not None and vix_day_open_o is not None:
                    break
            except Exception:
                continue
    except Exception:
        pass

    # Retry master fast-path now that ATM strike is known (works for NSE indices too).
    try:
        master_map2 = _try_resolve_chain_from_master(
            index_key=index_key,
            expiry_attempts=expiry_attempts,
            atm_strike=atm_strike,
            step=step,
            wings=wings,
        )
        if master_map2:
            try:
                cli.timeout_s = prev_timeout
            except Exception:
                pass
            # Use configured segment/symbol for NSE indices; for SENSEX prefer BSEFO.
            if index_key == "SENSEX":
                opt_seg_master = EXCHANGE_SEGMENTS["BSEFO"]
                series_master = "OPTIDX"
                symbol_master = "SENSEX"
            else:
                opt_seg_master = int(opt_seg)
                series_master = series
                symbol_master = symbol
            payload_ok = {
                "ok": True,
                "index": index_key,
                "atmStrike": atm_strike,
                "spotLtp": spot_ltp,
                "step": step,
                "optionSegment": opt_seg_master,
                "optionSeries": series_master,
                "optionSymbol": symbol_master,
                "expiryUi": expiry_label,
                "expiryApi": str(expiry_primary),
                "instrumentMap": master_map2,
                "spotSegment": spot_seg_effective,
                "spotToken": spot_token_effective,
                "spotQuoteMessageCode": spot_quote_code,
                "spotQuoteNote": spot_quote_note,
                "spotPrevClose": spot_prev_close_o,
                "spotChangePct": spot_pct_o,
                "spotDayOpen": spot_day_open_o,
                "spotDayHigh": spot_day_high_o,
                "spotDayLow": spot_day_low_o,
                "vixInstrumentId": VIX_INSTRUMENT_ID,
                "vixSegment": VIX_SEGMENT_ID,
                "vixPrevClose": vix_prev_close_o,
                "vixDayOpen": vix_day_open_o,
                "warnings": [{"notice": "resolved_via_instruments_master_cache", "cacheDay": datetime.now().strftime("%Y%m%d")}],
            }
            try:
                from market.dashboard_connector import notify_chain_resolved

                notify_chain_resolved(payload_ok, username)
            except Exception:
                pass
            return jsonify(payload_ok)
    except Exception:
        pass

    opt_seg_eff = int(opt_seg)
    series_eff = series
    symbol_eff = symbol
    expiry_api = str(expiry_primary)
    ace: int | None = None
    ape: int | None = None

    atm_strike_f = float(int(atm_strike))

    def _try_atm_combo(seg_try: int, ser_try: str, sym_try: str, exp_try: str) -> tuple[int | None, int | None]:
        for opt_ce, opt_pe in (("CE", "PE"), ("CALL", "PUT"), ("3", "4")):
            try:
                cre = cli.get_option_symbol(int(seg_try), ser_try, sym_try, exp_try, opt_ce, atm_strike_f)
                pre = cli.get_option_symbol(int(seg_try), ser_try, sym_try, exp_try, opt_pe, atm_strike_f)
                if isinstance(cre, dict) and cre.get("type") == "error":
                    continue
                if isinstance(pre, dict) and pre.get("type") == "error":
                    continue
                c_id = first_exchange_instrument_id(cre)
                p_id = first_exchange_instrument_id(pre)
                if c_id is not None and p_id is not None:
                    return c_id, p_id
            except Exception:
                continue
        return None, None

    resolved = False
    if index_key == "SENSEX":
        md_probes = _sensex_md_probe_triples(opt_seg, series, symbol)
        discovered_used: list[tuple[int, str, str]] = []
        discovery_notes: list[str] = []

        def _run_probe_list(probes: list[tuple[int, str, str]]) -> bool:
            nonlocal opt_seg_eff, series_eff, symbol_eff, expiry_api, ace, ape
            for seg_try, ser_try, sym_try in probes:
                for exp_try in expiry_attempts:
                    if _budget_exceeded():
                        return False
                    c_id, p_id = _try_atm_combo(seg_try, ser_try, sym_try, exp_try)
                    if c_id is not None and p_id is not None:
                        opt_seg_eff = int(seg_try)
                        series_eff = str(ser_try)
                        symbol_eff = str(sym_try)
                        expiry_api = str(exp_try)
                        ace, ape = int(c_id), int(p_id)
                        return True
            return False

        resolved = _run_probe_list(md_probes)

        # Strong fallback: discover option params via search results at ATM strike.
        if not resolved:
            try:
                if _budget_exceeded():
                    raise TimeoutError("resolve budget exceeded before discovery")
                found = _discover_option_params_from_search(
                    cli,
                    symbol_hint="SENSEX",
                    atm_strike=atm_strike,
                    expiry_attempts=expiry_attempts,
                )
                if found:
                    seg_d, ser_d, sym_d, exp_d, ce_d, pe_d = found
                    opt_seg_eff = int(seg_d)
                    series_eff = str(ser_d)
                    symbol_eff = str(sym_d)
                    expiry_api = str(exp_d)
                    if ce_d is not None and pe_d is not None:
                        ace, ape = int(ce_d), int(pe_d)
                        resolved = True
                    else:
                        c_id, p_id = _try_atm_combo(seg_d, ser_d, sym_d, exp_d)
                        if c_id is not None and p_id is not None:
                            ace, ape = int(c_id), int(p_id)
                            resolved = True
            except Exception:
                pass

        # Fallback: broker search to discover correct segment/series/symbol for Sensex options.
        if not resolved:
            try:
                if _budget_exceeded():
                    raise TimeoutError("resolve budget exceeded before search fallback")
                q_variants = [
                    "SENSEX",
                    "SENSEX OPT",
                    "SENSEX OPTIDX",
                    "SENSEX CE",
                    "SENSEX PE",
                    "BSE SENSEX",
                ]
                combined: list[tuple[int, str, str]] = []
                for q in q_variants:
                    try:
                        sr = cli.search_by_string(q)
                        pts = _extract_seg_series_symbol_tuples(sr)
                        if pts:
                            combined.extend(pts)
                            discovery_notes.append(f"search({q}): {len(pts)} tuples")
                    except Exception as e:
                        discovery_notes.append(f"search({q}) failed: {e!s}")
                # Dedupe
                seen_t: set[tuple[int, str, str]] = set()
                combined_uniq: list[tuple[int, str, str]] = []
                for t3 in combined:
                    if t3 not in seen_t:
                        seen_t.add(t3)
                        combined_uniq.append(t3)

                # Keep plausible option-like series first.
                combined_uniq = sorted(
                    combined_uniq,
                    key=lambda t: (
                        0 if "OPT" in t[1].upper() else 1,
                        0 if t[0] in (12, 2) else 1,
                        len(t[1]) + len(t[2]),
                    ),
                )[:120]
                discovered_used = combined_uniq
                if combined_uniq:
                    resolved = _run_probe_list(combined_uniq + md_probes)
            except Exception:
                pass
    else:
        opt_seg_candidates = [int(opt_seg)]
        for seg_try in opt_seg_candidates:
            for exp_try in expiry_attempts:
                if _budget_exceeded():
                    break
                c_id, p_id = _try_atm_combo(seg_try, series, symbol, exp_try)
                if c_id is not None and p_id is not None:
                    opt_seg_eff = int(seg_try)
                    series_eff = series
                    symbol_eff = symbol
                    expiry_api = str(exp_try)
                    ace, ape = int(c_id), int(p_id)
                    resolved = True
                    break
            if resolved:
                break
        # Fallback for NSE indices: discover option params via search results at ATM strike.
        if not resolved and index_key in ("NIFTY", "BANKNIFTY"):
            try:
                if _budget_exceeded():
                    raise TimeoutError("resolve budget exceeded before discovery")
                found = _discover_option_params_from_search(
                    cli,
                    symbol_hint=index_key,
                    atm_strike=atm_strike,
                    expiry_attempts=expiry_attempts,
                )
                if not found and symbol:
                    found = _discover_option_params_from_search(
                        cli,
                        symbol_hint=str(symbol),
                        atm_strike=atm_strike,
                        expiry_attempts=expiry_attempts,
                    )
                if found:
                    seg_d, ser_d, sym_d, exp_d, ce_d, pe_d = found
                    opt_seg_eff = int(seg_d)
                    series_eff = str(ser_d)
                    symbol_eff = str(sym_d)
                    expiry_api = str(exp_d)
                    if ce_d is not None and pe_d is not None:
                        ace, ape = int(ce_d), int(pe_d)
                        resolved = True
                    else:
                        c_id, p_id = _try_atm_combo(seg_d, ser_d, sym_d, exp_d)
                        if c_id is not None and p_id is not None:
                            ace, ape = int(c_id), int(p_id)
                            resolved = True
            except Exception:
                pass

    if _budget_exceeded() and not resolved:
        try:
            cli.timeout_s = prev_timeout
        except Exception:
            pass
        return jsonify(
            {
                "ok": False,
                "error": "Chain resolve timed out (broker API slow). Try lower wings or refresh login.",
                "index": index_key,
                "expiryUi": expiry_label,
                "expiryAttemptsSample": expiry_attempts[:12],
                "brokerExpiriesSample": broker_expiries[:20],
                "budgetSeconds": budget_s,
            }
        ), 504

    if not resolved:
        hint = ""
        if index_key == "SENSEX":
            hint = (
                " Check series/symbol env (XTS_SENSEX_OPTION_SERIES / XTS_SENSEX_OPTION_SYMBOL); "
                "BSE Sensex often uses FO segment 12. Compare brokerExpiriesSample with expiryAttemptsSample."
            )
        return jsonify(
            {
                "ok": False,
                "error": "Could not resolve ATM CE/PE symbol for any expiry string / FO segment combination." + hint,
                "expiryUi": expiry_label,
                "atmStrikeProbe": atm_strike,
                "optionSegmentsTried": (
                    list(dict.fromkeys([int(opt_seg), EXCHANGE_SEGMENTS["BSEFO"], EXCHANGE_SEGMENTS["NSEFO"]]))
                    if index_key == "SENSEX"
                    else [int(opt_seg)]
                ),
                "seriesSymbolProbeHint": (
                    "Set XTS_SENSEX_SERIES_PROBE=IO,O and/or XTS_SENSEX_EXTRA_SEGMENTS=12 if defaults fail."
                    if index_key == "SENSEX"
                    else ""
                ),
                "expiryPrimaryGuess": expiry_primary,
                "expiryAttemptsSample": expiry_attempts[:18],
                "brokerExpiriesSample": broker_expiries[:30],
                "series": series,
                "symbol": symbol,
                "sensexMdProbesSample": (
                    [{"segment": a, "series": b, "symbol": c} for a, b, c in _sensex_md_probe_triples(opt_seg, series, symbol)[:8]]
                    if index_key == "SENSEX"
                    else []
                ),
                "sensexDiscoveredSample": (
                    [{"segment": a, "series": b, "symbol": c} for a, b, c in (discovered_used[:12] if 'discovered_used' in locals() else [])]
                    if index_key == "SENSEX"
                    else []
                ),
                "sensexDiscoveryNotes": (discovery_notes[:12] if 'discovery_notes' in locals() else []),
                "expiryFetchNotes": expiry_fetch_notes[:6],
            }
        ), 502

    instrument_map: dict[str, dict[str, int]] = {}
    resolve_errors: list[dict[str, object]] = []

    for off in range(-wings, wings + 1):
        if _budget_exceeded():
            resolve_errors.append({"error": "budget_exceeded", "partialWings": wings, "budgetSeconds": budget_s})
            break
        strike = atm_strike + int(off * step)
        try:
            sk = float(int(strike))
            ce_resp = cli.get_option_symbol(opt_seg_eff, series_eff, symbol_eff, str(expiry_api), "CE", sk)
            pe_resp = cli.get_option_symbol(opt_seg_eff, series_eff, symbol_eff, str(expiry_api), "PE", sk)
            ce_id = first_exchange_instrument_id(ce_resp)
            pe_id = first_exchange_instrument_id(pe_resp)
            if ce_id is not None and pe_id is not None:
                instrument_map[str(strike)] = {"ce": int(ce_id), "pe": int(pe_id)}
            else:
                resolve_errors.append({"strike": strike, "error": "Missing instrument IDs in broker response"})
        except Exception as e:
            resolve_errors.append({"strike": strike, "error": str(e)})

    try:
        cli.timeout_s = prev_timeout
    except Exception:
        pass

    payload_ok = {
        "ok": True,
        "index": index_key,
        "atmStrike": atm_strike,
        "spotLtp": spot_ltp,
        "step": step,
        "optionSegment": opt_seg_eff,
        "optionSeries": series_eff,
        "optionSymbol": symbol_eff,
        "expiryUi": expiry_label,
        "expiryApi": expiry_api,
        "instrumentMap": instrument_map,
        "chainWings": wings,
        "chainWingsCap": wings_max,
        "spotSegment": spot_seg_effective,
        "spotToken": spot_token_effective,
        "spotQuoteMessageCode": spot_quote_code,
        "spotQuoteNote": spot_quote_note,
        "spotPrevClose": spot_prev_close_o,
        "spotChangePct": spot_pct_o,
        "spotDayOpen": spot_day_open_o,
        "spotDayHigh": spot_day_high_o,
        "spotDayLow": spot_day_low_o,
        "vixInstrumentId": VIX_INSTRUMENT_ID,
        "vixSegment": VIX_SEGMENT_ID,
        "vixPrevClose": vix_prev_close_o,
        "vixDayOpen": vix_day_open_o,
        "warnings": resolve_errors[:20] if resolve_errors else [],
    }

    try:
        from market.dashboard_connector import notify_chain_resolved

        notify_chain_resolved(payload_ok, username)
    except Exception:
        pass

    return jsonify(payload_ok)


@app.get("/api/market/live")
def api_market_live():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    lim = max(50, min(int(request.args.get("limit") or 800), 10_000))
    from market.tick_engine import get_tick_engine

    return jsonify({"ok": True, "ticks": get_tick_engine().get_live_snapshot(lim)})


@app.get("/api/market/chain")
def api_market_chain():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    idx = request.args.get("index", type=str)

    from market.dashboard_connector import get_chain_snapshot_dict

    return jsonify(get_chain_snapshot_dict(idx, username))


@app.get("/api/market/benchmark")
def api_market_benchmark():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401
    from market.tick_engine import get_tick_engine

    return jsonify({"ok": True, **get_tick_engine().benchmark_summary()})


@app.post("/api/md/subscribe")
def md_subscribe():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    instruments = data.get("instruments") or []
    xts_message_code = int(data.get("xtsMessageCode") or 1501)
    if not isinstance(instruments, list) or not instruments:
        return jsonify({"ok": False, "error": "instruments[] required"}), 400
    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        primary = _MD_STREAMER.subscribe(instruments=instruments, xts_message_code=xts_message_code)
        out: dict[str, object] = {str(xts_message_code): primary}

        # XTS_OPTIONS_DASHBOARD parity: many brokers expect 1502 (quote) + 1501 (touchline/binary) subscriptions
        # for the socket to stream ticks reliably; secondary failure is non-fatal.
        dual = str(_env("XTS_MD_SUBSCRIBE_1502", "1")).strip().lower() not in ("0", "false", "no", "off")
        if dual and xts_message_code == 1501:
            try:
                out["1502"] = _MD_STREAMER.subscribe(instruments=instruments, xts_message_code=1502)
            except Exception as e2:
                out["1502_notice"] = str(e2)
            try:
                out["1512"] = _MD_STREAMER.subscribe(instruments=instruments, xts_message_code=1512)
            except Exception as e3:
                out["1512_notice"] = str(e3)

        return jsonify({"ok": True, "result": out})
    except Exception as e:
        # Do not hard-fail UI on vendor subscribe quirks; return 200 with error payload.
        return jsonify({"ok": False, "error": str(e)}), 200


def _expand_json_strings_shallow(obj: object, depth: int = 0) -> object:
    """XTS quotes may embed JSON dicts as strings; expand best-effort."""
    if depth > 6 or obj is None:
        return obj
    if isinstance(obj, str):
        s = obj.strip()
        if len(s) >= 2 and s[0] in "{[":
            try:
                return _expand_json_strings_shallow(json.loads(s), depth + 1)
            except Exception:
                return obj
        return obj
    if isinstance(obj, dict):
        return {k: _expand_json_strings_shallow(v, depth + 1) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_expand_json_strings_shallow(v, depth + 1) for v in obj]
    return obj


def _extract_atp_map_from_quote_response(obj: object) -> dict[int, float]:
    """
    Extract instrumentId -> AverageTradedPrice from quote response.
    Handles common nesting: result.listQuotes[], sometimes entries are JSON strings.
    """
    out: dict[int, float] = {}

    def to_int(v: object) -> int | None:
        if isinstance(v, bool) or v is None:
            return None
        if isinstance(v, int):
            return int(v)
        try:
            s = str(v).strip()
            if not s:
                return None
            if s.isdigit():
                return int(s)
            return int(float(s))
        except Exception:
            return None

    def to_float(v: object) -> float | None:
        if isinstance(v, bool) or v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                x = float(v.replace(",", "").strip())
                return float(x)
            except Exception:
                return None
        return None

    def visit(x: object) -> None:
        x = _expand_json_strings_shallow(x)
        if isinstance(x, dict):
            # If this node looks like a quote leaf, extract ATP.
            iid = to_int(x.get("exchangeInstrumentID") or x.get("ExchangeInstrumentID") or x.get("instrumentId") or x.get("InstrumentId"))
            tl = x.get("Touchline") or x.get("touchline") or x.get("TouchLine") or x.get("touchLine")
            if iid:
                atp: float | None = None
                if isinstance(tl, dict):
                    atp = to_float(
                        tl.get("AverageTradedPrice")
                        or tl.get("averageTradedPrice")
                        or tl.get("ATP")
                        or tl.get("atp")
                        or tl.get("VWAP")
                        or tl.get("vwap")
                    )
                # XTS often returns listQuotes entries as JSON strings where LTP/ATP sit on the
                # root object (MessageCode 1501 shape) — not nested under Touchline. See Symphony
                # Marketdata "Quote" examples (flat AverageTradedPrice).
                if atp is None or atp <= 0:
                    atp = to_float(
                        x.get("AverageTradedPrice")
                        or x.get("averageTradedPrice")
                        or x.get("AvgTradedPrice")
                        or x.get("avgTradedPrice")
                        or x.get("ATP")
                        or x.get("atp")
                    )
                if atp is not None and atp > 0:
                    out[int(iid)] = float(atp)

            # Dive into known wrappers
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


def _overlay_touchline_atp_map(cli: Any, instruments: list[dict[str, Any]], atp_map: dict[int, float]) -> None:
    """Merge 1501 touchline ATP over existing map (Snap Quote parity). Best-effort."""
    if not instruments:
        return
    try:
        raw = cli.get_quote(instruments=instruments, xts_message_code=1501, publish_format="JSON")
        for k, v in _extract_atp_map_from_quote_response(raw).items():
            ik = int(k)
            if float(v) > 0:
                atp_map[ik] = float(v)
    except Exception:
        pass


def _prime_tick_engine_atp1501(atp_map: dict[int, float]) -> None:
    """Push REST touchline ATP into TickEngine so SSE Mace matches Snap Quote and can refresh live."""
    if not atp_map:
        return
    try:
        from market.tick_engine import get_tick_engine

        te = get_tick_engine()
        for tid, atp in atp_map.items():
            if float(atp) <= 0:
                continue
            ik = int(tid)
            row = te.get_token_row(ik) or {}
            seg = row.get("exchangeSegment")
            payload: dict[str, Any] = {
                "exchangeInstrumentID": ik,
                "messageCode": 1501,
                "atp": float(atp),
                "_atp1501": float(atp),
                "ltp": float(row.get("ltp") or 0.0),
            }
            if seg is not None:
                payload["exchangeSegment"] = seg
            te.ingest(payload)
    except Exception:
        pass


def _extract_ltp_map_from_quote_response(obj: object) -> dict[int, float]:
    """
    Extract instrumentId -> LastTradedPrice from quote response.
    Handles common nesting: result.listQuotes[], sometimes entries are JSON strings.
    """
    out: dict[int, float] = {}

    def to_int(v: object) -> int | None:
        if isinstance(v, bool) or v is None:
            return None
        if isinstance(v, int):
            return int(v)
        try:
            s = str(v).strip()
            if not s:
                return None
            if s.isdigit():
                return int(s)
            return int(float(s))
        except Exception:
            return None

    def to_float(v: object) -> float | None:
        if isinstance(v, bool) or v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                x = float(v.replace(",", "").strip())
                return float(x)
            except Exception:
                return None
        return None

    def visit(x: object) -> None:
        x = _expand_json_strings_shallow(x)
        if isinstance(x, dict):
            iid = to_int(
                x.get("exchangeInstrumentID")
                or x.get("ExchangeInstrumentID")
                or x.get("exchangeInstrumentId")
                or x.get("ExchangeInstrumentId")
                or x.get("instrumentId")
                or x.get("InstrumentId")
            )
            tl = x.get("Touchline") or x.get("touchline") or x.get("TouchLine") or x.get("touchLine")
            if iid:
                ltp: float | None = None
                if isinstance(tl, dict):
                    ltp = to_float(
                        tl.get("LastTradedPrice")
                        or tl.get("lastTradedPrice")
                        or tl.get("LTP")
                        or tl.get("ltp")
                        or tl.get("LastPrice")
                        or tl.get("lastPrice")
                    )
                if ltp is None or ltp <= 0:
                    ltp = to_float(
                        x.get("LastTradedPrice")
                        or x.get("lastTradedPrice")
                        or x.get("LTP")
                        or x.get("ltp")
                        or x.get("LastPrice")
                        or x.get("lastPrice")
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


def _flip_quote_pair_maps_from_response(raw: object) -> tuple[dict[int, float], dict[int, float]]:
    """
    LTP + ATP maps from /instruments/quotes JSON. Uses xts_md quote leaf iteration (same family as
    fetch_index_spot_ltp) and merges legacy _extract_* maps — some brokers return shapes the
    recursive visit() misses, which left Flip bootstrap with empty ltpMap/atpMap.
    """
    from xts_md import _iter_quote_leaf_dicts, _positive_float, _touchline_last_traded_price

    ltp_map: dict[int, float] = {}
    atp_map: dict[int, float] = {}

    def to_iid(leaf: dict[str, object]) -> int | None:
        def parse_iid(v: object) -> int | None:
            if v is None or isinstance(v, bool):
                return None
            try:
                s = str(v).strip()
                if not s:
                    return None
                i = int(s) if s.isdigit() else int(float(s))
                return i if i > 0 else None
            except Exception:
                return None

        def pick_from_dict(d: dict[str, object] | None) -> int | None:
            if not isinstance(d, dict):
                return None
            for k in (
                "exchangeInstrumentID",
                "ExchangeInstrumentID",
                "exchangeInstrumentId",
                "ExchangeInstrumentId",
                "exchangeInstrumentid",
                "ExchangeInstrumentid",
                "instrumentID",
                "InstrumentID",
                "instrumentId",
                "InstrumentId",
                "token",
                "Token",
            ):
                got = parse_iid(d.get(k))
                if got is not None:
                    return got
            return None

        iid = pick_from_dict(leaf)
        if iid is not None:
            return iid

        # Some brokers place instrument id only inside Touchline block.
        for subk in ("Touchline", "touchline", "TouchLine", "touchLine", "Quote", "quote"):
            sub = leaf.get(subk)
            if isinstance(sub, dict):
                iid = pick_from_dict(sub)
                if iid is not None:
                    return iid
        return None

    for leaf in _iter_quote_leaf_dicts(raw):
        if not isinstance(leaf, dict):
            continue
        iid = to_iid(leaf)
        if iid is None:
            continue
        px = _touchline_last_traded_price(leaf)
        if px is not None and px > 0 and iid not in ltp_map:
            ltp_map[iid] = float(px)

        tl = leaf.get("Touchline") or leaf.get("touchline") or leaf.get("TouchLine") or leaf.get("touchLine")
        atp: float | None = None
        if isinstance(tl, dict):
            atp = _positive_float(
                tl.get("AverageTradedPrice")
                or tl.get("averageTradedPrice")
                or tl.get("ATP")
                or tl.get("atp")
                or tl.get("VWAP")
                or tl.get("vwap")
            )
        if atp is None or atp <= 0:
            atp = _positive_float(
                leaf.get("AverageTradedPrice")
                or leaf.get("averageTradedPrice")
                or leaf.get("ATP")
                or leaf.get("atp")
            )
        if atp is not None and atp > 0 and iid not in atp_map:
            atp_map[iid] = float(atp)

    for k, v in _extract_ltp_map_from_quote_response(raw).items():
        ik = int(k)
        if ik not in ltp_map and isinstance(v, (int, float)) and float(v) > 0:
            ltp_map[ik] = float(v)
    for k, v in _extract_atp_map_from_quote_response(raw).items():
        ik = int(k)
        if ik not in atp_map and isinstance(v, (int, float)) and float(v) > 0:
            atp_map[ik] = float(v)

    return ltp_map, atp_map


def _flip_quote_day_ref_maps_from_response(
    raw: object,
) -> tuple[dict[int, float], dict[int, float], dict[int, float]]:
    """Per-token prev close, net % change, session open from REST quote JSON."""
    from xts_md import (
        _day_open_from_touchlike,
        _iter_quote_leaf_dicts,
        _net_pct_from_touchlike,
        _prev_close_from_touchlike,
        _touchline_derived_price,
    )

    prev_map: dict[int, float] = {}
    pct_map: dict[int, float] = {}
    open_map: dict[int, float] = {}

    def to_iid(leaf: dict[str, object]) -> int | None:
        def parse_iid(v: object) -> int | None:
            if v is None or isinstance(v, bool):
                return None
            try:
                s = str(v).strip()
                if not s:
                    return None
                i = int(s) if s.isdigit() else int(float(s))
                return i if i > 0 else None
            except Exception:
                return None

        def pick_from_dict(d: dict[str, object] | None) -> int | None:
            if not isinstance(d, dict):
                return None
            for k in (
                "exchangeInstrumentID",
                "ExchangeInstrumentID",
                "exchangeInstrumentId",
                "ExchangeInstrumentId",
                "instrumentID",
                "InstrumentID",
                "instrumentId",
                "InstrumentId",
                "token",
                "Token",
            ):
                got = parse_iid(d.get(k))
                if got is not None:
                    return got
            return None

        iid = pick_from_dict(leaf)
        if iid is not None:
            return iid
        for subk in ("Touchline", "touchline", "TouchLine", "touchLine", "Quote", "quote"):
            sub = leaf.get(subk)
            if isinstance(sub, dict):
                iid = pick_from_dict(sub)
                if iid is not None:
                    return iid
        return None

    for leaf in _iter_quote_leaf_dicts(raw):
        if not isinstance(leaf, dict):
            continue
        iid = to_iid(leaf)
        if iid is None:
            continue
        leaf_ltp: float | None = None
        px_leaf = _touchline_derived_price(leaf)
        if px_leaf is not None and float(px_leaf) > 0:
            leaf_ltp = float(px_leaf)
        dicts: list[dict[str, object]] = [leaf]
        for subk in ("Touchline", "touchline", "TouchLine", "touchLine", "Quote", "quote"):
            sub = leaf.get(subk)
            if isinstance(sub, dict):
                dicts.append(sub)
        for d in dicts:
            if iid not in prev_map:
                pc = _prev_close_from_touchlike(d, ltp_hint=leaf_ltp)
                if pc is not None and float(pc) > 0:
                    prev_map[iid] = float(pc)
            if iid not in pct_map:
                pt = _net_pct_from_touchlike(d)
                if pt is not None and pt == pt:
                    pct_map[iid] = float(pt)
            if iid not in open_map:
                op = _day_open_from_touchlike(d)
                if op is not None and float(op) > 0:
                    open_map[iid] = float(op)

    return prev_map, pct_map, open_map


def _overlay_tick_engine_quote_maps(
    instruments: list[object],
    ltp_map: dict[int, float],
    atp_map: dict[int, float],
) -> None:
    """Fill gaps from TickEngine when broker listQuotes is empty or slow."""
    try:
        from market.tick_engine import get_tick_engine

        te = get_tick_engine()
    except Exception:
        return
    for inst in instruments:
        if not isinstance(inst, dict):
            continue
        tid = inst.get("exchangeInstrumentID", inst.get("ExchangeInstrumentID"))
        try:
            iid = int(tid)
        except Exception:
            continue
        if iid <= 0:
            continue
        row = te.get_token_row(iid)
        if not row:
            continue
        ltp = float(row.get("ltp") or 0.0)
        atp = float(row.get("atp") or 0.0)
        if atp > 0 and iid not in atp_map:
            atp_map[iid] = atp


def _flip_prev_close_sane(ltp: float, prev: float) -> bool:
    return float(prev) > 0 and abs(float(prev) - float(ltp)) >= max(0.01, float(ltp) * 1e-5)


def _flip_bootstrap_reconcile_day_refs(
    merged_ltp: dict[int, float],
    merged_prev: dict[int, float],
    merged_pct: dict[int, float],
) -> None:
    """Drop prev==LTP placeholders; derive prev from non-zero broker % when needed."""
    for tid, lt in list(merged_ltp.items()):
        if float(lt) <= 0:
            continue
        pc = merged_prev.get(tid)
        pct = merged_pct.get(tid)
        if pc is not None and not _flip_prev_close_sane(float(lt), float(pc)):
            merged_prev.pop(tid, None)
            pc = None
        if pct is not None and abs(float(pct)) <= 1e-6:
            merged_pct.pop(tid, None)
            pct = None
        if (pc is None or float(pc) <= 0) and pct is not None and float(lt) > 0:
            implied = float(lt) / (1.0 + float(pct) / 100.0)
            if _flip_prev_close_sane(float(lt), implied):
                merged_prev[tid] = implied
                pc = implied
        if pc is not None and float(pc) > 0 and float(lt) > 0 and (pct is None or abs(float(pct)) <= 1e-6):
            merged_pct[tid] = (float(lt) - float(pc)) / float(pc) * 100.0


@app.post("/api/md/atp_snapshot")
def md_atp_snapshot():
    """
    REST snapshot: calls /instruments/quotes and returns instrumentId -> ATP.
    Frontend can use this to populate 'Mace' cells when socket ticks don't include ATP.
    """
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    instruments = data.get("instruments") or []
    xts_message_code = int(data.get("xtsMessageCode") or 1501)
    if not isinstance(instruments, list) or not instruments:
        return jsonify({"ok": False, "error": "instruments[] required"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        cli = _MD_STREAMER.rest_client()

        raw = cli.get_quote(instruments=instruments, xts_message_code=xts_message_code, publish_format="JSON")
        atp_map = _extract_atp_map_from_quote_response(raw)
        # Touchline (1501) ATP matches XTS Snap Quote; 1502 depth quotes are often stale on FO legs.
        if int(xts_message_code) != 1501:
            _overlay_touchline_atp_map(cli, instruments, atp_map)
        elif not atp_map:
            try:
                raw2 = cli.get_quote(instruments=instruments, xts_message_code=1502, publish_format="JSON")
                for k, v in _extract_atp_map_from_quote_response(raw2).items():
                    ik = int(k)
                    if float(v) > 0 and atp_map.get(ik, 0.0) <= 0:
                        atp_map[ik] = float(v)
            except Exception:
                pass

        _prime_tick_engine_atp1501(atp_map)

        return jsonify(
            {
                "ok": True,
                "xtsMessageCode": int(xts_message_code),
                "count": int(len(atp_map)),
                "atpMap": atp_map,
            }
        )
    except Exception as e:
        app.logger.exception("md_atp_snapshot failed")
        return jsonify({"ok": False, "error": str(e), "detail": repr(e)}), 500


@app.post("/api/md/quote_snapshot")
def md_quote_snapshot():
    """
    REST snapshot: calls /instruments/quotes and returns instrumentId -> { ltp, atp } (best-effort).
    Used as a fallback when socket stream omits fields.
    """
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    instruments = data.get("instruments") or []
    xts_message_code = int(data.get("xtsMessageCode") or 1502)
    if not isinstance(instruments, list) or not instruments:
        return jsonify({"ok": False, "error": "instruments[] required"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        cli = _MD_STREAMER.rest_client()

        raw = cli.get_quote(instruments=instruments, xts_message_code=xts_message_code, publish_format="JSON")
        ltp_map, atp_map = _flip_quote_pair_maps_from_response(raw)
        prev_map, pct_map, open_map = _flip_quote_day_ref_maps_from_response(raw)
        if int(xts_message_code) != 1501:
            _overlay_touchline_atp_map(cli, instruments, atp_map)
        if (not atp_map or not ltp_map or not prev_map) and int(xts_message_code) != 1501:
            try:
                raw2 = cli.get_quote(instruments=instruments, xts_message_code=1501, publish_format="JSON")
                l2, a2 = _flip_quote_pair_maps_from_response(raw2)
                p2, c2, o2 = _flip_quote_day_ref_maps_from_response(raw2)
                for k, v in l2.items():
                    ik = int(k)
                    if float(v) > 0 and (ik not in ltp_map or ltp_map.get(ik, 0.0) <= 0):
                        ltp_map[ik] = float(v)
                for k, v in a2.items():
                    ik = int(k)
                    if float(v) > 0 and (ik not in atp_map or atp_map.get(ik, 0.0) <= 0):
                        atp_map[ik] = float(v)
                for k, v in p2.items():
                    ik = int(k)
                    lt = ltp_map.get(ik, 0.0)
                    if float(v) > 0 and (ik not in prev_map or (lt > 0 and not _flip_prev_close_sane(float(lt), float(prev_map[ik])))):
                        if lt <= 0 or _flip_prev_close_sane(float(lt), float(v)):
                            prev_map[ik] = float(v)
                for k, v in c2.items():
                    ik = int(k)
                    if abs(float(v)) > 1e-6 and (ik not in pct_map or abs(float(pct_map.get(ik, 0.0))) <= 1e-6):
                        pct_map[ik] = float(v)
                for k, v in o2.items():
                    ik = int(k)
                    if float(v) > 0 and ik not in open_map:
                        open_map[ik] = float(v)
            except Exception:
                pass

        _flip_bootstrap_reconcile_day_refs(ltp_map, prev_map, pct_map)
        _overlay_tick_engine_quote_maps(instruments, ltp_map, atp_map)

        return jsonify(
            {
                "ok": True,
                "xtsMessageCode": int(xts_message_code),
                "countLtp": int(len(ltp_map)),
                "countAtp": int(len(atp_map)),
                "ltpMap": ltp_map,
                "atpMap": atp_map,
                "prevCloseMap": {str(k): float(v) for k, v in prev_map.items() if float(v) > 0},
                "percentChangeMap": {str(k): float(v) for k, v in pct_map.items()},
                "dayOpenMap": {str(k): float(v) for k, v in open_map.items() if float(v) > 0},
            }
        )
    except Exception as e:
        app.logger.exception("md_quote_snapshot failed")
        return jsonify({"ok": False, "error": str(e), "detail": repr(e)}), 500


@app.post("/api/md/instruments_by_id")
def md_instruments_by_id():
    """
    Proxy: POST /search/instrumentsbyid (Symphony/XTS Binary Marketdata).
    Doc: https://developers.symphonyfintech.in/doc/apimarketdata/#search-instruments-by-id
    """
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    data = request.get_json(silent=True) or {}
    instruments = data.get("instruments") or []
    if not isinstance(instruments, list) or not instruments:
        return jsonify({"ok": False, "error": "instruments[] required"}), 400

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
        cli = _MD_STREAMER.rest_client()

        raw = cli.search_by_instrument_id(instruments=instruments)
        return jsonify({"ok": True, "raw": raw})
    except Exception as e:
        app.logger.exception("md_instruments_by_id failed")
        return jsonify({"ok": False, "error": str(e), "detail": repr(e)}), 500


def _sse_is_last_trade(p) -> bool:
    """True for socket / Fyers last-trade. ATP/REST/hot-focus must not ride this path."""
    if not isinstance(p, dict):
        return False
    if (
        p.get("_atpOnly")
        or p.get("_snapshot")
        or p.get("_fromRestQuote")
        or p.get("_gapFill")
        or p.get("_hotLtp")
    ):
        return False
    try:
        ltp = float(p.get("ltp") or 0.0)
    except Exception:
        return False
    if ltp <= 0:
        return False
    if p.get("_fyersLtp") is True:
        return True
    try:
        mc = int(p.get("messageCode") or 0)
    except Exception:
        mc = 0
    return mc != 1502


def _sse_collapse_non_ltp(events: list) -> list:
    """Mace/snapshot flood: latest per token. Never keep a REST LTP on the payload."""
    latest: dict[int, dict] = {}
    order: list[int] = []
    extra: list = []
    for p in events:
        if not isinstance(p, dict):
            extra.append(p)
            continue
        try:
            tid = int(p.get("exchangeInstrumentID") or p.get("token") or 0)
        except Exception:
            tid = 0
        if tid <= 0:
            extra.append(p)
            continue
        row = dict(p)
        if row.get("_atpOnly") or row.get("_snapshot") or row.get("_fromRestQuote"):
            row.pop("ltp", None)
            row.pop("_ltp1501", None)
        if tid not in latest:
            order.append(tid)
        latest[tid] = row
    return extra + [latest[tid] for tid in order]


@app.get("/api/md/stream")
def md_stream():
    username = (_current_user() or "").strip().upper()
    if not username:
        return jsonify({"ok": False, "error": "Unauthorized"}), 401

    try:
        _ensure_market_streamer(username)
        from market.dashboard_connector import wire_market_streamer

        wire_market_streamer(_MD_STREAMER)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    q = _MD_STREAMER.add_listener()

    def gen():
        # Bytes-only: Werkzeug direct_passthrough asserts applications must write bytes.
        # No stream_with_context — request teardown was killing SSE (LookupError / ~1.5s lag).
        def sse(chunk: str) -> bytes:
            return chunk.encode("utf-8")

        try:
            yield sse(":" + (" " * 2048) + "\n\n")
            yield sse("event: ready\ndata: {}\n\n")
            while True:
                try:
                    first = q.get(timeout=15)
                except queue.Empty:
                    counts = {}
                    try:
                        counts = _MD_STREAMER.feed_rx_counts()
                    except Exception:
                        counts = {}
                    yield sse(": ping " + json.dumps(counts, separators=(",", ":")) + "\n\n")
                    continue
                # Last-trade: emit immediately — do not wait to drain ATP flood (that was the flow break).
                if _sse_is_last_trade(first):
                    yield sse(f"data: {json.dumps(first, separators=(',', ':'))}\n\n")
                    while True:
                        try:
                            p = q.get_nowait()
                        except queue.Empty:
                            break
                        if _sse_is_last_trade(p):
                            yield sse(f"data: {json.dumps(p, separators=(',', ':'))}\n\n")
                        else:
                            # Collapse remaining non-LTP in this drain.
                            rest = [p]
                            while True:
                                try:
                                    rest.append(q.get_nowait())
                                except queue.Empty:
                                    break
                            prints2: list = []
                            other: list = []
                            for x in rest:
                                if _sse_is_last_trade(x):
                                    prints2.append(x)
                                else:
                                    other.append(x)
                            for x in prints2:
                                yield sse(f"data: {json.dumps(x, separators=(',', ':'))}\n\n")
                            for x in _sse_collapse_non_ltp(other):
                                yield sse(f"data: {json.dumps(x, separators=(',', ':'))}\n\n")
                            break
                    continue
                burst: list = [first]
                while True:
                    try:
                        burst.append(q.get_nowait())
                    except queue.Empty:
                        break
                prints: list = []
                rest: list = []
                for p in burst:
                    if _sse_is_last_trade(p):
                        prints.append(p)
                    else:
                        rest.append(p)
                for p in prints:
                    yield sse(f"data: {json.dumps(p, separators=(',', ':'))}\n\n")
                for p in _sse_collapse_non_ltp(rest):
                    yield sse(f"data: {json.dumps(p, separators=(',', ':'))}\n\n")
        finally:
            try:
                _MD_STREAMER.remove_listener(q)
            except Exception:
                pass

    resp = app.response_class(
        gen(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
        direct_passthrough=True,
    )
    resp.implicit_sequence_conversion = False
    return resp


def _walk_numbers(obj, out: list[tuple[str, float]]):
    if isinstance(obj, dict):
        for k, v in obj.items():
            _walk_numbers(v, out)
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                out.append((str(k), float(v)))
            elif isinstance(v, str):
                s = v.strip()
                if not s:
                    continue
                # Many broker APIs return amounts as strings (sometimes with commas)
                s2 = s.replace(",", "")
                try:
                    out.append((str(k), float(s2)))
                except Exception:
                    pass
    elif isinstance(obj, list):
        for v in obj:
            _walk_numbers(v, out)


def _json_no_store(payload: object, *, status: int = 200):
    """Portfolio / orders JSON must not be cached by browsers or intermediaries."""
    r = make_response(jsonify(payload), int(status))
    r.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    r.headers["Pragma"] = "no-cache"
    r.headers["Expires"] = "0"
    return r


def _pick_best(pairs: list[tuple[str, float]], keys: set[str]) -> float | None:
    best = None
    for k, v in pairs:
        k_norm = str(k).strip().lower().replace(" ", "").replace("_", "")
        if k_norm in keys and v is not None:
            if best is None or v > best:
                best = v
    return best


@app.get("/api/margin")
def api_margin():
    # Basic auth guard
    username = (_current_user() or "").strip().upper()
    if not username:
        return _json_no_store(
            {
                "status": "ok",
                "available": 0.0,
                "used": 0.0,
                "free": 0.0,
                "used_pct": 0.0,
                "free_pct": 0.0,
                "hidden": True,
            }
        )

    now = time.time()
    hidden = False

    state = _MARGIN_BY_USER.setdefault(username, {"available": 0.0, "used": 0.0, "free": 0.0})
    last_ts = float(_LAST_MARGIN_FETCH_TS_BY_USER.get(username, 0.0) or 0.0)
    busy = bool(_BUSY_MARGIN_BY_USER.get(username, False))

    if not busy and (now - last_ts >= 1.0):
        _BUSY_MARGIN_BY_USER[username] = True
        try:
            ix, client_id = _ensure_ix_client(username)

            if not ix:
                hidden = True
            else:
                raw_cid = str(client_id or "").strip()
                oc = "*****" if raw_cid.upper().endswith("PRO") else (raw_cid or None)
                rb = None
                try:
                    rb = ix.get_balance(client_id=oc)
                except Exception:
                    try:
                        rb = ix.get_balance(client_id=None)
                    except Exception:
                        rb = None
                if isinstance(rb, dict) and str(rb.get("type") or "").lower() == "error":
                    try:
                        rb = ix.get_balance(client_id=None)
                    except Exception:
                        rb = None
                rp = None
                if not isinstance(rb, dict) or rb.get("type") != "success":
                    try:
                        rp = ix.get_profile(client_id=oc)
                    except Exception:
                        rp = None

                pairs: list[tuple[str, float]] = []
                _walk_numbers(rb, pairs)
                if rp is not None:
                    _walk_numbers(rp, pairs)

                avail_keys = {
                    "netmarginavailable",
                    "availablemargin",
                    "cashavailable",
                    "netcashavailable",
                    "netavailable",
                    "available",
                    "netmarginavailablefortrading",
                    "cashmarginavailable",
                    "networth",
                    "collateral",
                }
                used_keys = {
                    "marginutilized",
                    "utilisedmargin",
                    "utilizedmargin",
                    "usedmargin",
                    "marginused",
                    "spanmargin",
                    "exposuremargin",
                    "premiumpresent",
                }
                free_keys = {"freecash", "freemargin", "availablefunds", "unutilizedmargin", "unutilisedmargin"}

                avail = _pick_best(pairs, avail_keys)
                used = _pick_best(pairs, used_keys)
                free = _pick_best(pairs, free_keys)

                # Derive when missing
                avail = float(avail or 0.0)
                used = float(used or 0.0)
                free = float(free or 0.0)
                if avail > 0 and used <= 0 and free > 0:
                    used = max(0.0, avail - free)
                if avail > 0 and free <= 0 and used > 0:
                    free = max(0.0, avail - used)
                if avail <= 0 and (used > 0 or free > 0):
                    avail = max(used + free, 1.0)

                if avail > 0:
                    state["available"] = avail
                    state["used"] = max(0.0, used)
                    state["free"] = max(0.0, avail - state["used"]) if free <= 0 else max(0.0, free)

            _LAST_MARGIN_FETCH_TS_BY_USER[username] = now
        except Exception:
            hidden = True
        finally:
            _BUSY_MARGIN_BY_USER[username] = False

    avail = float(state.get("available", 0.0) or 0.0)
    used = float(state.get("used", 0.0) or 0.0)
    free = float(state.get("free", avail) or avail)
    total = avail if avail > 0 else 1.0
    used_pct = round((used / total) * 100.0, 1)
    free_pct = round((free / total) * 100.0, 1)

    return _json_no_store(
        {
            "status": "ok",
            "available": avail,
            "used": used,
            "free": free,
            "used_pct": used_pct,
            "free_pct": free_pct,
            "hidden": bool(hidden),
        }
    )


def _ix_pro_placeholder() -> str:
    ph = str(_env("XTS_IX_PRO_PLACEHOLDER_CLIENT_ID", "*****")).strip()
    return ph if ph else "*****"


def _ix_id_looks_proprietary_cli(cid: str) -> bool:
    """Investeria Pro logins use *PRO ids (e.g. SR01PRO); sending that string as clientID → CLI order (rejected)."""
    c = str(cid or "").strip().upper()
    return len(c) >= 6 and c.endswith("PRO")


def _ix_order_client_for(ix: XtsInteractiveClient, client_id: str) -> str | None:
    """
    Proprietary *PRO users: real ID as clientID = "CLI" (rejected); omitting = "ClientID cannot be empty".
    V33 Investeria build uses placeholder ``*****`` in the order body; same default here via
    XTS_IX_PRO_PLACEHOLDER_CLIENT_ID (default *****).
    """
    if str(_env("XTS_IX_OMIT_ORDER_CLIENT_ID", "")).strip().lower() in ("1", "true", "yes"):
        return None

    env_oid = str(_env("XTS_IX_ORDER_CLIENT_ID", "")).strip()
    if env_oid:
        return env_oid

    cid = str(client_id or "").strip()

    if getattr(ix, "is_investor_client", False):
        return None

    if getattr(ix, "is_pro_client", False) or _ix_id_looks_proprietary_cli(cid):
        return _ix_pro_placeholder()

    return cid or None


def _ix_query_client_for(ix: XtsInteractiveClient, client_id: str) -> str | None:
    """
    clientID for portfolio/order-book GETs.

    PRO: same ***** placeholder as place_order. Omitting → e-order-0003
    "ClientID is not provided". Sending SR01PRO → 400 / CLI reject.
    """
    if str(_env("XTS_IX_OMIT_ORDER_CLIENT_ID", "")).strip().lower() in ("1", "true", "yes"):
        return None
    if str(_env("XTS_IX_OMIT_QUERY_CLIENT_ID", "")).strip().lower() in ("1", "true", "yes"):
        return None

    cid = str(client_id or "").strip()

    if getattr(ix, "is_investor_client", False):
        return None

    if getattr(ix, "is_pro_client", False) or _ix_id_looks_proprietary_cli(cid):
        return _ix_pro_placeholder()

    env_qid = str(_env("XTS_IX_QUERY_CLIENT_ID", "")).strip()
    if env_qid and not _ix_id_looks_proprietary_cli(env_qid):
        return env_qid

    return cid or None


def _ix_rate_limited(err: BaseException) -> bool:
    s = str(err).lower()
    return (
        "429" in s
        or "too many requests" in s
        or "e_apirl" in s
        or "e-apirl" in s
        or "e-api-0004" in s
        or "apirl_0004" in s
        or "apirl-0004" in s
        or "max limit" in s
        or "rate limit" in s
        or "rate-limit" in s
    )


def _ix_auth_retry_text(err_msg: str) -> bool:
    """True when XTS rejected the request due to missing/expired interactive token."""
    s = (err_msg or "").lower()
    if "e-session-0005" in s or "e-session" in s:
        return True
    if "token/authorization" in s or "authorization not found" in s:
        return True
    if "invalid token" in s or "token expired" in s or "session expired" in s:
        return True
    if "please provide token" in s or "token to authenticate" in s:
        return True
    if "please login" in s or "re-login" in s or "relogin" in s:
        return True
    if "no token" in s or "login required" in s:
        return True
    return False


def _ix_session_error(err: BaseException) -> bool:
    return _ix_auth_retry_text(str(err))


def _ix_empty_broker_error(err: BaseException) -> bool:
    return _xts_empty_data_error(err)


def _ix_is_bad_client_id_error(err: BaseException) -> bool:
    if _ix_rate_limited(err) or _ix_empty_broker_error(err) or _ix_session_error(err):
        return False
    if _xts_unmapped_client_error(err):
        return True
    s = str(err).lower()
    return (
        "400" in s
        or "bad request" in s
        or "clientid" in s
        or "client id" in s
        or "e-order-0003" in s
        or "not mapped" in s
    )


def _ix_query_candidates(ix: XtsInteractiveClient, client_id: str) -> list:
    """PRO dealer: ***** then omit. Do not send SR01 / *PRO — not mapped / CLI reject."""
    out: list = []
    ph = _ix_pro_placeholder()
    if ph not in out:
        out.append(ph)
    if None not in out:
        out.append(None)
    return out


def _ix_payload_row_count(data: Any) -> int:
    if isinstance(data, list):
        return len(data)
    if not isinstance(data, dict):
        return 0
    res = data.get("result") if data.get("result") is not None else data.get("Result")
    if isinstance(res, list):
        return len(res)
    if isinstance(res, dict):
        for k in (
            "positionList",
            "PositionList",
            "orderList",
            "OrderList",
            "tradeList",
            "TradeList",
            "positions",
        ):
            v = res.get(k)
            if isinstance(v, list):
                return len(v)
    return 0


_IX_QUERY_OC_OK: dict[int, Any] = {}


def _ix_empty_broker_payload() -> dict:
    return {"type": "success", "result": {"positionList": [], "orderList": [], "tradeList": []}}


_IX_RELOGIN_LOCK = threading.Lock()
_IX_RELOGIN_AT: dict[str, float] = {}
_IX_CLIENT_LOCK = threading.Lock()
_IX_RELOGIN_GAP_SEC = 15.0


def _ix_invoke_query(ix: XtsInteractiveClient, fn, oc):
    """Call broker GET; on e-session-0005 re-login once per key (parallel GETs must not dual-login)."""
    try:
        return fn(oc)
    except Exception as e:
        if not _ix_session_error(e):
            raise
        key = str(getattr(ix, "api_key", "") or id(ix))
        with _IX_RELOGIN_LOCK:
            last = float(_IX_RELOGIN_AT.get(key, 0) or 0)
            if time.time() - last > _IX_RELOGIN_GAP_SEC:
                app.logger.warning("ix token/session expired — re-login once (%s)", e)
                try:
                    ix.login()
                    _IX_RELOGIN_AT[key] = time.time()
                except Exception as le:
                    app.logger.warning("ix re-login failed: %s", le)
                    raise e from le
        # Fresh login still cannot fetch positions while Investeria quota is cooling.
        if any(
            ":pos" in str(k) and float(v or 0) > time.time() for k, v in _IX_PORTFOLIO_COOLDOWN.items()
        ):
            raise e
        return fn(oc)


def _ix_call_query(ix: XtsInteractiveClient, client_id: str, fn):
    """Try ***** then omit. Keep first payload that has rows. Empty-data is not a crash.
    Rate-limit is not retried with another clientID — same GET /portfolio/* quota."""
    last_session = None
    saw_empty = False
    best = None
    best_n = -1
    cands = _ix_query_candidates(ix, client_id)
    ph = _ix_pro_placeholder()
    remembered = _IX_QUERY_OC_OK.get(id(ix), "__unset__")
    if remembered not in (ph, None, "__unset__"):
        _IX_QUERY_OC_OK.pop(id(ix), None)
        remembered = "__unset__"
    if remembered != "__unset__":
        cands = [remembered] + [c for c in cands if c != remembered]
    for oc in cands:
        try:
            data = _ix_invoke_query(ix, fn, oc)
            n = _ix_payload_row_count(data)
            if n > best_n:
                best, best_n = data, n
            if n > 0:
                _IX_QUERY_OC_OK[id(ix)] = oc
                return data
        except Exception as e:
            if _ix_empty_broker_error(e):
                saw_empty = True
                continue
            if _ix_rate_limited(e):
                raise
            if _ix_session_error(e):
                last_session = e
                app.logger.warning("ix query still unauthorized after re-login (%s)", e)
                break
            if _ix_is_bad_client_id_error(e):
                if _IX_QUERY_OC_OK.get(id(ix)) == oc:
                    _IX_QUERY_OC_OK.pop(id(ix), None)
                app.logger.info("ix query clientID %r rejected (%s)", oc, e)
                continue
            raise
    if best is not None:
        return best
    if last_session is not None and not saw_empty:
        raise last_session
    return _ix_empty_broker_payload()


def _ix_should_retry_auth(err_msg: str) -> bool:
    return _ix_auth_retry_text(err_msg)


def _v33_style_order_unique_identifier(exchange_instrument_id: int, order_side: str) -> str:
    """
    Same pattern as XTS_OPTIONS_DASHBOARD `_place_real_order`:
    OPT{inst_id last 6}{B|S}{7-digit from epoch ms} for XTS deduplication.
    """
    iid = int(exchange_instrument_id)
    tail = str(iid)[-6:]
    ch = (order_side or "BUY")[:1].upper()
    if ch not in ("B", "S"):
        ch = "B"
    suf = int(time.time() * 1000) % 10000000
    return f"OPT{tail}{ch}{suf:07d}"


def _fo_price_tick() -> float:
    try:
        v = float(_env("XTS_IX_PRICE_TICK", "0.05") or "0.05")
        return v if v > 0 else 0.05
    except Exception:
        return 0.05


def _algo_limit_buf() -> float:
    """Fraction away from LTP so LIMIT fills like MARKET. Env is percent (default 5)."""
    try:
        v = float(_env("XTS_IX_ALGO_LIMIT_PCT", "5") or "5")
        return max(0.5, min(25.0, v)) / 100.0
    except Exception:
        return 0.05


def _tight_limit_buf(px: float) -> float:
    """~0.4% of premium, 0.20–0.50 — Nifty Ladder LIMIT must not walk the book."""
    tick = _fo_price_tick()
    base = float(px) if px and px > 0 else 100.0
    ticks = int(round((base * 0.004) / tick))
    ticks = max(4, min(10, ticks))
    return ticks * tick


def _round_limit_to_tick(px: float, *, side: str) -> float:
    tick = _fo_price_tick()
    if tick <= 0:
        tick = 0.05
    if str(side).upper() == "BUY":
        n = math.ceil((float(px) / tick) - 1e-9)
    else:
        n = math.floor((float(px) / tick) + 1e-9)
    return round(max(tick, n * tick), 2)


def _marketable_limit_price(side: str, ltp: float) -> float:
    buf = _algo_limit_buf()
    raw = float(ltp) * (1.0 + buf) if str(side).upper() == "BUY" else float(ltp) * (1.0 - buf)
    return _round_limit_to_tick(raw, side=side)


def _tight_marketable_limit(side: str, ltp: float, bid: float, ask: float) -> float:
    if str(side).upper() == "SELL":
        ref = bid if bid > 0 else ltp
        buf = _tight_limit_buf(ref)
        return _round_limit_to_tick(ref - buf, side=side)
    ref = ask if ask > 0 else ltp
    buf = _tight_limit_buf(ref)
    return _round_limit_to_tick(ref + buf, side=side)


def _tick_engine_book(iid: int) -> tuple[float, float, float]:
    try:
        from market.tick_engine import get_tick_engine

        row = get_tick_engine().get_token_row(int(iid))
        if not row:
            return 0.0, 0.0, 0.0
        ltp = float(row.get("ltp") or 0.0)
        bid = float(row.get("bid") or 0.0)
        ask = float(row.get("ask") or 0.0)
        return (ltp if ltp > 0 else 0.0, bid if bid > 0 else 0.0, ask if ask > 0 else 0.0)
    except Exception:
        return 0.0, 0.0, 0.0


def _tick_engine_ltp(iid: int) -> float:
    try:
        from market.tick_engine import get_tick_engine

        row = get_tick_engine().get_token_row(int(iid))
        if not row:
            return 0.0
        v = float(row.get("ltp") or 0.0)
        return v if v > 0 else 0.0
    except Exception:
        return 0.0


def _quote_ltp_one(username: str, seg: int, iid: int) -> float:
    try:
        _ensure_market_streamer(username)
        cli = _MD_STREAMER.rest_client()
        inst = [{"exchangeSegment": int(seg), "exchangeInstrumentID": int(iid)}]
        raw = cli.get_quote(instruments=inst, xts_message_code=1501, publish_format="JSON")
        m = _extract_ltp_map_from_quote_response(raw)
        v = float(m.get(int(iid)) or 0.0)
        return v if v > 0 else 0.0
    except Exception:
        return 0.0


def _body_px(body: dict[str, Any], *keys: str) -> float:
    for key in keys:
        try:
            v = float(body.get(key) or 0)
            if v > 0:
                return v
        except Exception:
            pass
    return 0.0


def _resolve_order_ltp(body: dict[str, Any], iid: int, seg: int, username: str) -> float:
    v = _body_px(body, "ltp", "LTP", "lastTradedPrice", "LastTradedPrice")
    if v > 0:
        return v
    live = _tick_engine_ltp(iid)
    if live > 0:
        return live
    return _quote_ltp_one(username, seg, iid)


_ALLOWED_TIF = {"IOC", "DAY", "EOS"}


def _payload_tif(payload: dict[str, Any], default: str = "IOC") -> str:
    t = str(payload.get("timeInForce") or default).strip().upper() or default
    return t if t in _ALLOWED_TIF else default


def _xts_place_reject_reason(res: Any) -> str | None:
    """Place may return type=success with OrderStatus Cancelled/Rejected (16388)."""
    if not isinstance(res, dict):
        return None
    typ = str(res.get("type") or "").strip().lower()
    if typ == "error":
        data = res.get("data") if isinstance(res.get("data"), dict) else {}
        desc = str(
            res.get("description")
            or (data.get("description") if isinstance(data, dict) else "")
            or res.get("error")
            or "Order rejected"
        ).strip()
        return desc or "Order rejected"
    inner = res.get("result") or res.get("Result") or res
    rows: list[Any]
    if isinstance(inner, list):
        rows = inner
    elif isinstance(inner, dict):
        lst = inner.get("list") or inner.get("orderList") or inner.get("OrderList")
        rows = lst if isinstance(lst, list) else [inner]
    else:
        rows = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        st = str(row.get("OrderStatus") or row.get("orderStatus") or "").upper()
        reason = str(
            row.get("CancelRejectReason")
            or row.get("cancelRejectReason")
            or row.get("OrderRejectReason")
            or row.get("RejectReason")
            or row.get("Reason")
            or row.get("description")
            or ""
        ).strip()
        blob = f"{st} {reason}"
        if "REJECT" in st or st in {"CANCELLED", "CANCELED"} or "16388" in blob or "cancelled by system" in blob.lower():
            return reason or f"Order {st or 'rejected'}"
    return None


def _coerce_algo_limit_order(
    payload: dict[str, Any],
    *,
    body: dict[str, Any],
    side: str,
    iid: int,
    seg: int,
    username: str,
) -> dict[str, Any]:
    """ALGO accounts reject MARKET and price 0 — convert to LIMIT around LTP. Keep requested DAY/EOS/IOC."""
    live_reprice = bool(body.get("liveReprice") or body.get("live_reprice"))
    eng_ltp, eng_bid, eng_ask = _tick_engine_book(iid)
    body_ltp = _body_px(body, "ltp", "LTP", "lastTradedPrice", "LastTradedPrice")
    body_bid = _body_px(body, "bid", "Bid", "bestBid", "BestBid")
    body_ask = _body_px(body, "ask", "Ask", "bestAsk", "BestAsk")
    ltp = eng_ltp or body_ltp
    bid = eng_bid or body_bid
    ask = eng_ask or body_ask

    if live_reprice and (ltp > 0 or bid > 0 or ask > 0):
        if ltp <= 0:
            ltp = _resolve_order_ltp(body, iid, seg, username)
        tight = _tight_marketable_limit(side, ltp, bid, ask)
        if tight > 0:
            payload["orderType"] = "LIMIT"
            payload["timeInForce"] = _payload_tif(payload, "IOC")
            payload["limitPrice"] = tight
            payload["_fillHint"] = {"ltp": ltp, "bid": bid, "ask": ask, "limitPrice": tight}
            return payload

    order_type = str(payload.get("orderType") or "").strip().upper()
    try:
        limit_price = float(payload.get("limitPrice") or 0)
    except Exception:
        limit_price = 0.0
    if order_type == "LIMIT" and limit_price > 0:
        payload["_fillHint"] = {"ltp": ltp, "bid": bid, "ask": ask, "limitPrice": limit_price}
        return payload

    if ltp <= 0:
        ltp = _resolve_order_ltp(body, iid, seg, username)
    if ltp <= 0:
        raise ValueError(
            "ALGO accounts cannot send MARKET/price-0 orders and no LTP was available to convert to LIMIT"
        )
    payload["orderType"] = "LIMIT"
    payload["limitPrice"] = _marketable_limit_price(side, ltp)
    payload["timeInForce"] = "IOC"
    payload["_fillHint"] = {"ltp": ltp, "bid": bid, "ask": ask, "limitPrice": payload["limitPrice"]}
    app.logger.info(
        "algo MARKET->LIMIT iid=%s side=%s ltp=%s limit=%s",
        iid,
        side,
        ltp,
        payload["limitPrice"],
    )
    return payload


# Investeria interactive POST /interactive/orders validates exchangeSegment as string enum (Joi string.base), not int.
_IX_SEGMENT_ID_TO_NAME = {
    1: "NSECM",
    2: "NSEFO",
    3: "NSECD",
    11: "BSECM",
    12: "BSEFO",
    51: "MCXFO",
}


def _ix_segment_as_enum_string(seg_int: int) -> str:
    name = _IX_SEGMENT_ID_TO_NAME.get(int(seg_int))
    if name:
        return name
    raise ValueError(
        f"exchangeSegment code {seg_int} — no string mapping (use 2=NSEFO, 12=BSEFO, or pass NSEFO/BSEFO in JSON)"
    )


def _ensure_ix_client(username: str) -> tuple[XtsInteractiveClient | None, str]:
    """
    Ensure interactive client is logged in (best-effort).
    Returns (client or None, client_id string possibly empty).
    Proactively calls login() again when the cached session is older than XTS_IX_TOKEN_MAX_AGE_SEC
    (default 18h) so the Authorization token is not expired on the wire.
    """
    users = _load_users()
    rec = users.get(username)
    client_id = ""
    if has_request_context():
        client_id = str(session.get("client_id") or "").strip()
    if not client_id and isinstance(rec, dict):
        client_id = str(rec.get("user_id") or rec.get("client_id") or "").strip()

    with _IX_CLIENT_LOCK:
        ix = _XTS_IX.get(username)
        try:
            max_age = float(str(_env("XTS_IX_TOKEN_MAX_AGE_SEC", str(18 * 3600))).strip() or str(18 * 3600))
        except ValueError:
            max_age = float(18 * 3600)

        if ix is not None and getattr(ix, "_xts", None) is None:
            try:
                ix.login()
                app.logger.info("interactive XTS session restored (was missing token) for %s", username)
            except Exception as ex:
                app.logger.warning("interactive restore failed for %s: %s", username, ex)
                _XTS_IX.pop(username, None)
                ix = None

        if ix is not None:
            xts = getattr(ix, "_xts", None)
            age = time.time() - float(getattr(xts, "created_at", 0.0)) if xts else max_age + 1.0
            if age > max_age:
                try:
                    ix.login()
                    app.logger.info("interactive XTS session refreshed for %s (token age)", username)
                except Exception as ex:
                    app.logger.warning("interactive refresh failed for %s, will re-create: %s", username, ex)
                    _XTS_IX.pop(username, None)
                    ix = None

        if not ix and isinstance(rec, dict) and rec.get("ix_key") and rec.get("ix_secret"):
            ix = XtsInteractiveClient(api_key=str(rec["ix_key"]), api_secret=str(rec["ix_secret"]))
            ix.timeout_s = 6.0
            ix.login()
            _XTS_IX[username] = ix
        return ix, client_id


_IX_PORTFOLIO_LOCK = threading.Lock()
_IX_PORTFOLIO_CACHE: dict[str, tuple[float, Any]] = {}
_IX_PORTFOLIO_COOLDOWN: dict[str, float] = {}


_IX_POS_COOL_SEC = 300.0
_IX_POS_COOL_MAX = 900.0
_IX_PORTFOLIO_STRIKES: dict[str, int] = {}


def _ix_portfolio_ttl(cache_key: str) -> float:
    if ":tradebook" in cache_key:
        return 20.0
    if ":pos:DayWise" in cache_key:
        return 90.0
    if ":orderbook" in cache_key:
        return 8.0
    if ":pos:" in cache_key:
        return 12.0
    return 8.0


def _ix_cool_bucket(cache_key: str) -> str:
    """NetWise + DayWise share one GET /portfolio/positions quota."""
    parts = str(cache_key).split(":")
    if len(parts) >= 2 and parts[1] == "pos":
        return f"{parts[0]}:pos"
    return cache_key


def _ix_next_cool_sec(bucket: str) -> float:
    n = int(_IX_PORTFOLIO_STRIKES.get(bucket, 0) or 0) + 1
    _IX_PORTFOLIO_STRIKES[bucket] = n
    wait = _IX_POS_COOL_SEC if n <= 1 else _IX_POS_COOL_SEC * (3 ** (n - 1))
    return float(min(_IX_POS_COOL_MAX, wait))


def _ix_cool_until(cache_key: str) -> float:
    return max(
        float(_IX_PORTFOLIO_COOLDOWN.get(cache_key, 0) or 0),
        float(_IX_PORTFOLIO_COOLDOWN.get(_ix_cool_bucket(cache_key), 0) or 0),
    )


def _ix_portfolio_cached(cache_key: str, fetcher):
    """Serialize broker GETs; positions Net/Day share one cooldown on e-api-0004."""
    now = time.time()
    with _IX_PORTFOLIO_LOCK:
        hit = _IX_PORTFOLIO_CACHE.get(cache_key)
        cool_until = _ix_cool_until(cache_key)
        ttl = _ix_portfolio_ttl(cache_key)
        if hit and now - hit[0] < ttl:
            return hit[1], False
        if cool_until > now:
            if hit:
                return hit[1], True
            return _ix_empty_broker_payload(), True
        try:
            data = fetcher()
            _IX_PORTFOLIO_CACHE[cache_key] = (time.time(), data)
            _IX_PORTFOLIO_COOLDOWN.pop(cache_key, None)
            bucket = _ix_cool_bucket(cache_key)
            _IX_PORTFOLIO_COOLDOWN.pop(bucket, None)
            _IX_PORTFOLIO_STRIKES.pop(bucket, None)
            return data, False
        except Exception as e:
            if _ix_empty_broker_error(e):
                empty = _ix_empty_broker_payload()
                _IX_PORTFOLIO_CACHE[cache_key] = (time.time(), empty)
                return empty, False
            if _ix_rate_limited(e):
                bucket = _ix_cool_bucket(cache_key)
                wait = _ix_next_cool_sec(bucket)
                until = time.time() + wait
                _IX_PORTFOLIO_COOLDOWN[cache_key] = until
                _IX_PORTFOLIO_COOLDOWN[bucket] = until
                app.logger.warning(
                    "ix %s rate-limited — cooling %.0fs (broker quota; will not retry until then) (%s)",
                    cache_key,
                    wait,
                    e,
                )
                if hit:
                    return hit[1], True
                return _ix_empty_broker_payload(), True
            if _ix_session_error(e):
                app.logger.warning("ix %s session error after re-login (%s) — empty book", cache_key, e)
                if hit:
                    return hit[1], True
                return _ix_empty_broker_payload(), True
            if _ix_is_bad_client_id_error(e):
                app.logger.info("ix %s bad clientID (%s) — empty book", cache_key, e)
                empty = _ix_empty_broker_payload()
                return empty, True
            if hit:
                app.logger.warning("ix %s failed (%s) — serving cached snapshot", cache_key, e)
                return hit[1], True
            raise


@app.get("/api/ix/orderbook")
def api_ix_orderbook():
    username = (_current_user() or "").strip().upper()
    if not username:
        return _json_no_store({"ok": False, "error": "Unauthorized"}, status=401)
    try:
        ix, client_id = _ensure_ix_client(username)
        if not ix:
            return _json_no_store({"ok": False, "error": "Interactive credentials missing for this user"}, status=400)
        data, stale = _ix_portfolio_cached(
            f"{username}:orderbook",
            lambda: _ix_call_query(ix, client_id, lambda oc: ix.get_order_book(client_id=oc)),
        )
        return _json_no_store({"ok": True, "raw": data, "stale": stale})
    except Exception as e:
        if _ix_empty_broker_error(e):
            return _json_no_store({"ok": True, "raw": _ix_empty_broker_payload(), "stale": False})
        if _ix_rate_limited(e) or _ix_session_error(e):
            return _json_no_store({"ok": True, "raw": _ix_empty_broker_payload(), "stale": True})
        app.logger.exception("api_ix_orderbook")
        return _json_no_store({"ok": False, "error": str(e)}, status=500)


@app.get("/api/ix/tradebook")
def api_ix_tradebook():
    username = (_current_user() or "").strip().upper()
    if not username:
        return _json_no_store({"ok": False, "error": "Unauthorized"}, status=401)
    try:
        ix, client_id = _ensure_ix_client(username)
        if not ix:
            return _json_no_store({"ok": False, "error": "Interactive credentials missing for this user"}, status=400)
        data, stale = _ix_portfolio_cached(
            f"{username}:tradebook",
            lambda: _ix_call_query(ix, client_id, lambda oc: ix.get_trade_book(client_id=oc)),
        )
        return _json_no_store({"ok": True, "raw": data, "stale": stale})
    except Exception as e:
        if _ix_empty_broker_error(e):
            return _json_no_store({"ok": True, "raw": _ix_empty_broker_payload(), "stale": False})
        if _ix_rate_limited(e) or _ix_session_error(e):
            return _json_no_store({"ok": True, "raw": _ix_empty_broker_payload(), "stale": True})
        app.logger.exception("api_ix_tradebook")
        return _json_no_store({"ok": False, "error": str(e)}, status=500)


@app.get("/api/ix/positions")
def api_ix_positions():
    username = (_current_user() or "").strip().upper()
    if not username:
        return _json_no_store({"ok": False, "error": "Unauthorized"}, status=401)
    day_or_net = (request.args.get("dayOrNet", type=str) or "NetWise").strip() or "NetWise"
    try:
        ix, client_id = _ensure_ix_client(username)
        if not ix:
            return _json_no_store({"ok": False, "error": "Interactive credentials missing for this user"}, status=400)
        data, stale = _ix_portfolio_cached(
            f"{username}:pos:{day_or_net}",
            lambda: _ix_call_query(
                ix, client_id, lambda oc: ix.get_positions(day_or_net=day_or_net, client_id=oc)
            ),
        )
        return _json_no_store({"ok": True, "raw": data, "dayOrNet": day_or_net, "stale": stale})
    except Exception as e:
        if _ix_empty_broker_error(e):
            return _json_no_store(
                {"ok": True, "raw": _ix_empty_broker_payload(), "dayOrNet": day_or_net, "stale": False}
            )
        if _ix_rate_limited(e) or _ix_session_error(e):
            return _json_no_store(
                {"ok": True, "raw": _ix_empty_broker_payload(), "dayOrNet": day_or_net, "stale": True}
            )
        app.logger.exception("api_ix_positions")
        return _json_no_store({"ok": False, "error": str(e)}, status=500)


@app.post("/api/ix/place_order")
def api_ix_place_order():
    username = (_current_user() or "").strip().upper()
    if not username:
        return _json_no_store({"ok": False, "error": "Unauthorized"}, status=401)
    try:
        body = request.get_json(silent=True) or {}
        ix, client_id = _ensure_ix_client(username)
        if not ix:
            return _json_no_store({"ok": False, "error": "Interactive credentials missing for this user"}, status=400)

        seg_raw = body.get("exchangeSegment")
        if seg_raw is None:
            seg_raw = body.get("ExchangeSegment")
        seg = _parse_segment(seg_raw)
        iid = int(
            body.get("exchangeInstrumentID")
            or body.get("exchangeInstrumentId")
            or body.get("ExchangeInstrumentID")
            or 0
        )
        side = str(body.get("orderSide") or body.get("OrderSide") or "").strip().upper()
        qty = int(body.get("orderQuantity") or body.get("OrderQuantity") or 0)

        if seg <= 0 or iid <= 0:
            return _json_no_store({"ok": False, "error": "Missing exchangeSegment/exchangeInstrumentID"}, status=400)
        if side not in ("BUY", "SELL"):
            return _json_no_store({"ok": False, "error": "orderSide must be BUY or SELL"}, status=400)
        if qty <= 0:
            return _json_no_store({"ok": False, "error": "orderQuantity must be > 0"}, status=400)

        try:
            seg_for_ix = _ix_segment_as_enum_string(seg)
        except ValueError as ve:
            return _json_no_store({"ok": False, "error": str(ve)}, status=400)

        order_type = str(body.get("orderType") or "MARKET").strip().upper()
        # Defaults match V33 _place_real_order: NRML + IOC + WEBAPI. Override with env XTS_IX_ORDER_TIF (e.g. DAY).
        product_type = str(body.get("productType") or "NRML").strip().upper()
        time_in_force = str(body.get("timeInForce") or _env("XTS_IX_ORDER_TIF", "IOC")).strip().upper() or "IOC"
        disclosed = int(body.get("disclosedQuantity") or 0)
        limit_price = float(body.get("limitPrice") or 0)
        stop_price = float(body.get("stopPrice") or 0)
        api_src = str(body.get("apiOrderSource") or "WEBAPI").strip() or "WEBAPI"

        # orderQuantity = total contracts (lots × lot_size), same as V33 `qty * lot_size`
        oui_in = body.get("orderUniqueIdentifier") or body.get("OrderUniqueIdentifier")
        uniq = str(oui_in).strip() if oui_in is not None and str(oui_in).strip() else _v33_style_order_unique_identifier(iid, side)

        payload = {
            "exchangeSegment": seg_for_ix,
            "exchangeInstrumentID": iid,
            "productType": product_type,
            "orderType": order_type,
            "orderSide": side,
            "timeInForce": time_in_force,
            "disclosedQuantity": disclosed,
            "orderQuantity": qty,
            "limitPrice": limit_price,
            "stopPrice": stop_price,
            "orderUniqueIdentifier": uniq,
            "apiOrderSource": api_src,
        }
        try:
            payload = _coerce_algo_limit_order(
                payload, body=body, side=side, iid=iid, seg=seg, username=username
            )
        except ValueError as ve:
            return _json_no_store({"ok": False, "error": str(ve)}, status=400)

        fill_hint = payload.pop("_fillHint", None)

        oc = _ix_order_client_for(ix, client_id)
        try:
            res = ix.place_order(client_id=oc, order=payload)
        except Exception as e1:
            if not _ix_should_retry_auth(str(e1)):
                raise
            app.logger.warning("place_order auth retry after: %s", e1)
            _XTS_IX.pop(username, None)
            ix2, cid2 = _ensure_ix_client(username)
            if not ix2:
                raise RuntimeError("Interactive re-login failed after token error") from e1
            res = ix2.place_order(client_id=_ix_order_client_for(ix2, cid2), order=payload)
        reject = _xts_place_reject_reason(res)
        if reject:
            return _json_no_store(
                {"ok": False, "error": reject, "request": payload, "raw": res, "fillHint": fill_hint},
                status=400,
            )
        return _json_no_store({"ok": True, "request": payload, "raw": res, "fillHint": fill_hint})
    except Exception as e:
        app.logger.exception("api_ix_place_order")
        return _json_no_store(
            {
                "ok": False,
                "error": str(e),
                "note": "Pro *PRO users use clientID placeholder (default *****). Env: XTS_IX_ORDER_CLIENT_ID, "
                "XTS_IX_PRO_PLACEHOLDER_CLIENT_ID, XTS_IX_OMIT_ORDER_CLIENT_ID=1.",
            },
            status=500,
        )


def _num_int(x, default=0) -> int:
    try:
        if x is None:
            return int(default)
        if isinstance(x, (int, float)):
            return int(x)
        s = str(x).replace(",", "").strip()
        if not s:
            return int(default)
        return int(float(s))
    except Exception:
        return int(default)


def _position_net_qty(p: dict) -> int:
    """Signed open qty. XTS sometimes leaves NetPosition at 0 while open buy/sell is set."""
    net = _num_int(
        p.get("NetPosition")
        or p.get("netPosition")
        or p.get("Quantity")
        or p.get("quantity")
        or p.get("NetQuantity")
        or p.get("netQuantity")
        or 0,
        0,
    )
    if net != 0:
        return net
    long_q = _num_int(p.get("LongPosition") or p.get("longPosition") or 0, 0)
    short_q = _num_int(p.get("ShortPosition") or p.get("shortPosition") or 0, 0)
    if long_q or short_q:
        return int(long_q - short_q)
    obq = _num_int(p.get("OpenBuyQuantity") or p.get("openBuyQuantity") or 0, 0)
    osq = _num_int(p.get("OpenSellQuantity") or p.get("openSellQuantity") or 0, 0)
    return int(obq - osq)


_SEGMENT_MAP = {
    # Common XTS segments (string -> numeric)
    "NSECM": 1,
    "NSEFO": 2,
    "NSECD": 3,
    "BSECM": 11,
    "BSEFO": 12,
    "MCXFO": 51,
}


def _parse_segment(seg_val):
    if seg_val is None:
        return 0
    if isinstance(seg_val, (int, float)):
        return int(seg_val)
    s = str(seg_val).strip().upper()
    if s.isdigit():
        return int(s)
    return int(_SEGMENT_MAP.get(s, 0))




@app.post("/api/ix/exit_open_positions")
def api_ix_exit_open_positions():
    """
    Exit a percentage of ALL open positions (NetWise) across instruments.
    Floors quantity to whole market lots (Marketlot) to avoid odd-lot exits.
    Body: { percent: 25|50|75|100 }
    """
    username = (_current_user() or "").strip().upper()
    if not username:
        return _json_no_store({"ok": False, "error": "Unauthorized"}, status=401)
    try:
        body = request.get_json(silent=True) or {}
        percent = float(body.get("percent") or 0)
        if percent <= 0:
            return _json_no_store({"ok": False, "error": "percent must be > 0"}, status=400)
        if percent > 100:
            percent = 100.0

        ix, client_id = _ensure_ix_client(username)
        if not ix:
            return _json_no_store({"ok": False, "error": "Interactive credentials missing for this user"}, status=400)

        pos = _ix_call_query(
            ix, client_id, lambda oc: ix.get_positions(day_or_net="NetWise", client_id=oc)
        )
        res = pos.get("result") if isinstance(pos, dict) else None
        pos_list = []
        if isinstance(res, dict) and isinstance(res.get("positionList"), list):
            pos_list = res.get("positionList") or []
        elif isinstance(res, list):
            pos_list = res
        elif isinstance(pos.get("result"), list):
            pos_list = pos.get("result") or []

        exited = []
        skipped = []
        errors = []

        for p in (pos_list or []):
            try:
                net_qty = _position_net_qty(p if isinstance(p, dict) else {})
                if net_qty == 0:
                    continue

                iid = _num_int(p.get("ExchangeInstrumentID") or p.get("ExchangeInstrumentId") or p.get("exchangeInstrumentID") or 0, 0)
                seg = _parse_segment(p.get("ExchangeSegment") or p.get("exchangeSegment") or 0)
                if iid <= 0 or seg <= 0:
                    skipped.append({"reason": "missing_segment_or_instrument", "row": p})
                    continue

                lot = _num_int(p.get("Marketlot") or p.get("MarketLot") or p.get("marketlot") or 1, 1)
                if lot <= 0:
                    lot = 1

                abs_qty = abs(int(net_qty))
                if percent >= 100.0:
                    exit_qty = abs_qty
                else:
                    raw = abs_qty * (percent / 100.0)
                    exit_qty = int(raw // lot) * lot

                if exit_qty < lot:
                    skipped.append({"reason": "below_one_lot", "instrument": iid, "segment": seg, "net_qty": net_qty, "lot": lot})
                    continue

                exit_side = "SELL" if net_qty > 0 else "BUY"
                product_type = str(p.get("ProductType") or p.get("productType") or "MIS").strip().upper() or "MIS"
                # Gateway Joi: orderUniqueIdentifier max 20 chars (long sow-exit-… uuid was rejected)
                uniq = _v33_style_order_unique_identifier(iid, exit_side)
                seg_name = _ix_segment_as_enum_string(seg)
                payload = {
                    "exchangeSegment": seg_name,
                    "exchangeInstrumentID": int(iid),
                    "productType": product_type,
                    "orderType": "LIMIT",
                    "orderSide": exit_side,
                    "timeInForce": "IOC",
                    "disclosedQuantity": 0,
                    "orderQuantity": int(exit_qty),
                    "limitPrice": 0,
                    "stopPrice": 0,
                    "orderUniqueIdentifier": uniq,
                    "apiOrderSource": "WEBAPI",
                }
                coerce_body = dict(p) if isinstance(p, dict) else {}
                coerce_body["liveReprice"] = True
                payload = _coerce_algo_limit_order(
                    payload, body=coerce_body, side=exit_side, iid=int(iid), seg=seg, username=username
                )
                payload.pop("_fillHint", None)
                oc_exit = _ix_order_client_for(ix, client_id)
                r = ix.place_order(client_id=oc_exit, order=payload)
                exited.append(
                    {
                        "segment": seg,
                        "instrument": iid,
                        "net_qty": net_qty,
                        "exit_qty": exit_qty,
                        "side": exit_side,
                        "request": payload,
                        "raw": r,
                    }
                )
            except Exception as ie:
                errors.append({"error": str(ie), "row": p})

        return _json_no_store(
            {
                "ok": True,
                "percent": percent,
                "exited": exited,
                "skipped": skipped,
                "errors": errors,
                "counts": {"exited": len(exited), "skipped": len(skipped), "errors": len(errors)},
            }
        )
    except Exception as e:
        app.logger.exception("api_ix_exit_open_positions")
        return _json_no_store({"ok": False, "error": str(e)}, status=500)






if __name__ == "__main__":
    # Default off: debug=True spawns a Werkzeug reloader (2 Python processes + file watcher CPU on Windows).
    import logging

    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    _debug = str(_env("FLASK_DEBUG", "0")).strip().lower() in ("1", "true", "yes", "on")
    _reloader = str(_env("FLASK_RELOADER", "0")).strip().lower() in ("1", "true", "yes", "on")
    app.run(
        host=str(_env("FLASK_HOST", "0.0.0.0")),
        port=int(_env("FLASK_PORT", "5000")),
        debug=_debug,
        use_reloader=_reloader and _debug,
        threaded=True,
    )

