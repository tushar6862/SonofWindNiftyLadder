"""
5 EMA on 1-minute candle closes from Symphony OHLC API.

Formula (pandas parity):
    df['ema5'] = df['close'].ewm(span=5, adjust=False).mean()

Data: GET /instruments/ohlc?compressionValue=60
Docs: https://developers.symphonyfintech.in/doc/apimarketdata/#OHLC
"""

from __future__ import annotations

import json
import logging
import re
import statistics
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

_log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
_EMA21_SPAN = 5


def compute_ema21_from_closes(closes: list[float]) -> float:
    """
    EMA(5) on 1-min closes — same as:
    ``df['close'].ewm(span=5, adjust=False).mean().iloc[-1]``
    """
    vals = [float(c) for c in closes if float(c) > 0]
    if not vals:
        return 0.0
    try:
        import pandas as pd

        return float(pd.Series(vals).ewm(span=_EMA21_SPAN, adjust=False).mean().iloc[-1])
    except Exception:
        alpha = 2.0 / (_EMA21_SPAN + 1)
        ema = vals[0]
        for c in vals[1:]:
            ema = alpha * c + (1.0 - alpha) * ema
        return float(ema)


def _ist_minute_key(ts: float) -> int:
    """Live tick epoch → IST minute bucket."""
    dt = datetime.fromtimestamp(float(ts), IST)
    return int(dt.strftime("%Y%m%d%H%M"))


def _ohlc_epoch_to_minute_key(ts: float) -> int:
    """XTS OHLC BarTime is IST wall-clock stored as UTC epoch (vendor quirk)."""
    dt = datetime.utcfromtimestamp(float(ts))
    return int(dt.strftime("%Y%m%d%H%M"))


def _ist_minute_key_from_dt(dt: datetime) -> int:
    return int(dt.astimezone(IST).strftime("%Y%m%d%H%M"))


def _format_xts_time(dt: datetime) -> str:
    return dt.astimezone(IST).strftime("%b %d %Y %H%M%S")


def _session_start_ist(now: datetime | None = None) -> datetime:
    now = (now or datetime.now(IST)).astimezone(IST)
    return now.replace(hour=9, minute=15, second=0, microsecond=0)


def _session_end_ist(now: datetime | None = None) -> datetime:
    now = (now or datetime.now(IST)).astimezone(IST)
    return now.replace(hour=15, minute=30, second=0, microsecond=0)


def _ohlc_trustworthy(bars: list[MinuteBar], live_ltp: float) -> bool:
    """Reject broker OHLC when recent closes don't match touchline LTP scale."""
    if not bars:
        return False
    if not (live_ltp > 0):
        return True
    recent = [b.close for b in bars[-12:] if b.close > 0]
    if not recent:
        return False
    med = float(statistics.median(recent))
    if med <= 0:
        return False
    ratio = med / float(live_ltp)
    return 0.5 <= ratio <= 2.0


def _rescale_ohlc_bars_to_ltp(bars: list[MinuteBar], live_ltp: float) -> list[MinuteBar]:
    """
    XTS sometimes returns correct candle *shape* at wrong absolute scale (e.g. 42 vs LTP 420).
    Rescale all closes so recent median matches live LTP — preserves % moves for EMA(5).
    """
    if not bars or not (live_ltp > 0):
        return []
    recent = [b.close for b in bars[-24:] if b.close > 0]
    if not recent:
        return []
    med = float(statistics.median(recent))
    if med <= 0:
        return []
    factor = float(live_ltp) / med
    if not (0.02 <= factor <= 50.0):
        return []
    return [MinuteBar(b.minute_key, float(b.close) * factor) for b in bars]


@dataclass(frozen=True)
class MinuteBar:
    minute_key: int
    close: float


@dataclass
class _TokenEmaState:
    bootstrapped: bool = False
    # Completed 1-min closes keyed by IST minute (deduped).
    minute_closes: dict[int, float] = field(default_factory=dict)
    forming_minute: int = 0
    forming_close: float = 0.0

    def _ordered_completed_keys(self, *, now_minute: int | None = None) -> list[int]:
        cutoff = now_minute if now_minute is not None else self.forming_minute
        keys = [k for k in self.minute_closes if k > 0 and (cutoff <= 0 or k < cutoff)]
        keys.sort()
        return keys

    def display_ema(self) -> float:
        if not self.bootstrapped:
            return 0.0
        keys = self._ordered_completed_keys()
        closes = [self.minute_closes[k] for k in keys]
        if self.forming_close > 0:
            closes = closes + [self.forming_close]
        if not closes:
            return 0.0
        return compute_ema21_from_closes(closes)


class Ema21Engine:
    __slots__ = ("_lock", "_state")

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._state: dict[int, _TokenEmaState] = {}

    def reset_token(self, token: int) -> None:
        with self._lock:
            self._state.pop(int(token), None)

    def _get_or_create(self, token: int) -> _TokenEmaState:
        tid = int(token)
        st = self._state.get(tid)
        if st is None:
            st = _TokenEmaState()
            self._state[tid] = st
        return st

    def merge_minute_bars(self, token: int, bars: list[MinuteBar], *, overwrite: bool = False) -> None:
        """Merge 1-min closes into state (OHLC seed / tick-buffer rebuild)."""
        with self._lock:
            st = self._get_or_create(token)
            for bar in bars:
                if bar.minute_key <= 0 or bar.close <= 0:
                    continue
                if overwrite or bar.minute_key not in st.minute_closes:
                    st.minute_closes[bar.minute_key] = float(bar.close)
            if st.minute_closes:
                st.bootstrapped = True

    def bootstrap_from_bars(
        self,
        token: int,
        bars: list[MinuteBar],
        *,
        now_minute: int | None = None,
        live_ltp: float = 0.0,
        trust_ohlc: bool = True,
    ) -> float:
        with self._lock:
            clean = sorted(
                [b for b in bars if b.close > 0 and b.minute_key > 0],
                key=lambda b: b.minute_key,
            )
            if not clean:
                st = self._state.get(int(token))
                return st.display_ema() if st else 0.0

            if trust_ohlc and live_ltp > 0 and not _ohlc_trustworthy(clean, live_ltp):
                _log.warning(
                    "ema21 ohlc scale mismatch iid=%s ltp=%.2f ohlc_med=%.2f — using ticks only",
                    token,
                    live_ltp,
                    float(statistics.median([b.close for b in clean[-12:]])),
                )
                clean = []

            now_m = now_minute if now_minute is not None else _ist_minute_key(time.time())
            st = self._get_or_create(token)

            if clean:
                completed = [b for b in clean if b.minute_key < now_m]
                forming = next((b for b in reversed(clean) if b.minute_key == now_m), None)
                if not completed and len(clean) > 1 and clean[-1].minute_key >= now_m:
                    completed = clean[:-1]
                    forming = clean[-1]
                for bar in completed:
                    st.minute_closes[bar.minute_key] = float(bar.close)
                if forming and forming.minute_key == now_m:
                    st.forming_minute = forming.minute_key
                    st.forming_close = float(forming.close)
                else:
                    st.forming_minute = now_m
                    st.forming_close = 0.0
                st.bootstrapped = True
            elif live_ltp > 0:
                st.forming_minute = now_m
                st.forming_close = float(live_ltp)
                st.bootstrapped = bool(st.minute_closes)

            return st.display_ema()

    def seed_from_tick_buffer(self, token: int, entries: list[dict[str, Any]], *, overwrite: bool = False) -> int:
        """Rebuild 1-min closes from tick-engine buffer rows for one token."""
        tid = int(token)
        by_minute: dict[int, float] = {}
        for item in entries:
            if int(item.get("token") or 0) != tid:
                continue
            row = item.get("row") if isinstance(item.get("row"), dict) else item
            if not isinstance(row, dict):
                continue
            ltp = float(row.get("ltp") or 0.0)
            if ltp <= 0:
                continue
            ts = float(row.get("ts") or item.get("ts") or 0.0)
            if ts <= 0:
                continue
            mk = _ist_minute_key(ts)
            by_minute[mk] = ltp
        bars = [MinuteBar(k, c) for k, c in by_minute.items()]
        if bars:
            self.merge_minute_bars(tid, bars, overwrite=overwrite)
        return len(bars)

    def on_symphony_candle(self, token: int, bar_time: float, close: float) -> float:
        """Symphony CandleDataEvent (1505) or REST OHLC bar — 1-min close at BarTime."""
        if not (close > 0) or not (bar_time > 0):
            with self._lock:
                st = self._state.get(int(token))
                return st.display_ema() if st and st.bootstrapped else 0.0

        minute = _ohlc_epoch_to_minute_key(float(bar_time))
        tid = int(token)
        now_m = _ist_minute_key(time.time())

        with self._lock:
            st = self._get_or_create(tid)
            st.minute_closes[minute] = float(close)
            if minute >= now_m:
                st.forming_minute = minute
                st.forming_close = float(close)
            else:
                if st.forming_minute == minute:
                    st.forming_minute = 0
                    st.forming_close = 0.0
            st.bootstrapped = True
            return st.display_ema()

    def on_ltp(self, token: int, ltp: float, ts: float | None = None) -> float:
        if not (ltp > 0):
            with self._lock:
                st = self._state.get(int(token))
                return st.display_ema() if st and st.bootstrapped else 0.0

        minute = _ist_minute_key(float(ts or time.time()))
        tid = int(token)

        with self._lock:
            st = self._get_or_create(tid)
            if not st.bootstrapped:
                return 0.0

            # Finalize previous forming minute into completed dict.
            if (
                st.forming_minute > 0
                and minute != st.forming_minute
                and st.forming_close > 0
            ):
                st.minute_closes[st.forming_minute] = float(st.forming_close)

            st.forming_minute = minute
            st.forming_close = float(ltp)
            return st.display_ema()

    def get(self, token: int) -> float:
        with self._lock:
            st = self._state.get(int(token))
            return st.display_ema() if st else 0.0

    def minute_bar_count(self, token: int) -> int:
        with self._lock:
            st = self._state.get(int(token))
            if not st:
                return 0
            n = len(st.minute_closes)
            if st.forming_close > 0:
                n += 1
            return n


_engine: Ema21Engine | None = None


def get_ema21_engine() -> Ema21Engine:
    global _engine
    if _engine is None:
        _engine = Ema21Engine()
    return _engine


def _parse_pipe_candle_line(line: str) -> MinuteBar | None:
    line = line.strip().strip(",")
    if not line:
        return None
    parts = [p.strip() for p in line.split("|")]
    if len(parts) < 5:
        return None
    try:
        ts_raw = parts[0].split()[0]
        ts = float(ts_raw)
        close = float(parts[4].replace(",", ""))
    except Exception:
        return None
    if close <= 0:
        return None
    return MinuteBar(_ohlc_epoch_to_minute_key(ts), close)


def _parse_pipe_candle_blob(text: str) -> list[MinuteBar]:
    """XTS packs many 1-min bars in one string: ``ts|o|h|l|c|v|oi,ts|o|...``."""
    out: list[MinuteBar] = []
    for segment in re.split(r"[,]+", text):
        bar = _parse_pipe_candle_line(segment)
        if bar is not None:
            out.append(bar)
    return out


def _dict_looks_like_candle(obj: dict[str, Any]) -> bool:
    close = obj.get("Close") or obj.get("close") or obj.get("c")
    if close is None:
        return False
    try:
        if float(close) <= 0:
            return False
    except Exception:
        return False
    for k in obj:
        kn = str(k).lower()
        if kn in ("open", "high", "low", "volume", "openinterest", "barvolume"):
            return True
        if "timestamp" in kn or "bartime" in kn:
            return True
    return False


def _candle_bar_from_dict(obj: dict[str, Any]) -> MinuteBar | None:
    close_raw = obj.get("Close") or obj.get("close") or obj.get("c")
    if close_raw is None:
        return None
    try:
        close = float(close_raw)
    except Exception:
        return None
    if close <= 0:
        return None
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
    return MinuteBar(_ohlc_epoch_to_minute_key(ts), close)


def parse_ohlc_bars(raw: Any) -> list[MinuteBar]:
    """Extract 1-min bars (oldest first) from XTS OHLC JSON / pipe text."""
    bars: list[MinuteBar] = []
    seen: set[int] = set()

    def add_bar(bar: MinuteBar | None) -> None:
        if bar is None or bar.close <= 0 or bar.minute_key <= 0:
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
                for bar in _parse_pipe_candle_blob(s):
                    add_bar(bar)
                return
            for line in re.split(r"[\r\n]+", s):
                add_bar(_parse_pipe_candle_line(line))
            return
        if isinstance(obj, dict):
            dr = obj.get("dataReponse") or obj.get("dataResponse") or obj.get("DataResponse")
            if isinstance(dr, str) and "|" in dr:
                for bar in _parse_pipe_candle_blob(dr):
                    add_bar(bar)
            if _dict_looks_like_candle(obj):
                add_bar(_candle_bar_from_dict(obj))
                return
            for k in ("dataReponse", "dataResponse", "DataResponse", "result", "Result", "listCandles", "candles"):
                if k in obj and not (k in ("dataReponse", "dataResponse", "DataResponse") and isinstance(obj.get(k), str)):
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


def _filter_today_session(bars: list[MinuteBar], now: datetime | None = None) -> list[MinuteBar]:
    now = (now or datetime.now(IST)).astimezone(IST)
    start_m = _ist_minute_key_from_dt(_session_start_ist(now))
    end_m = _ist_minute_key_from_dt(_session_end_ist(now))
    return [b for b in bars if start_m <= b.minute_key <= end_m]


def fetch_intraday_1m_bars(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
) -> list[MinuteBar]:
    """
    Symphony GET /instruments/ohlc — compressionValue=60 (1 minute).
    See: https://developers.symphonyfintech.in/doc/apimarketdata/#OHLC
    """
    now = datetime.now(IST)
    day_start = _session_start_ist(now)
    if now < day_start:
        return []

    from datetime import timedelta

    merged: dict[int, MinuteBar] = {}
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
                    "ema21 ohlc error iid=%s: %s",
                    exchange_instrument_id,
                    raw.get("description") or raw.get("message"),
                )
            else:
                for bar in _filter_today_session(parse_ohlc_bars(raw), now):
                    merged[bar.minute_key] = bar
        except Exception as e:
            _log.warning("ema21 ohlc fail iid=%s: %s", exchange_instrument_id, e)
        cursor = chunk_end + timedelta(seconds=1)

    if merged:
        return sorted(merged.values(), key=lambda b: b.minute_key)
    return []


def _tick_buffer_entries() -> list[dict[str, Any]]:
    try:
        from market.tick_engine import get_tick_engine

        eng = get_tick_engine()
        with eng._lock:
            return list(eng._buf)
    except Exception:
        return []


def _parse_master_sensex_options(
    *,
    opt_side: str,
    strike_hint: float,
    expiry_hint: str = "",
    max_candidates: int = 24,
    strike_window: float = 2500.0,
) -> list[tuple[int, float]]:
    """Return [(iid, strike), ...] nearest strikes from today's cached master."""
    day = datetime.now(IST).strftime("%Y%m%d")
    paths = list(Path(__file__).resolve().parent.parent.glob(f"cache/instruments_master_{day}_*.txt"))
    if not paths:
        return []
    want_ce = str(opt_side).upper() in ("CE", "3", "CALL")
    exp_tok = re.sub(r"[\s\-_/]", "", str(expiry_hint or "")).upper()
    rows: list[tuple[int, float]] = []
    for path in sorted(paths, reverse=True):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for line in text.splitlines():
            if "|" not in line or "SENSEX" not in line:
                continue
            parts = [p.strip() for p in line.split("|")]
            if len(parts) < 20:
                continue
            exp = parts[16]
            exp_date = exp.split("T", 1)[0] if exp else ""
            line_u = line.upper().replace(" ", "")
            if exp_tok:
                exp_ok = exp_tok in line_u
                if not exp_ok and re.match(r"^(\d{4}-\d{2}-\d{2})$", exp_date):
                    exp_ok = exp_tok in exp_date.replace("-", "")
                if not exp_ok:
                    continue
            try:
                iid = int(parts[1])
                strike = float(parts[17])
                opt_code = parts[18].strip().upper()
            except Exception:
                continue
            disp = (parts[19] if len(parts) > 19 else "").upper()
            is_ce = opt_code in ("3", "CE", "CALL") or " CE " in f" {disp} "
            is_pe = opt_code in ("4", "PE", "PUT") or " PE " in f" {disp} "
            if want_ce and not is_ce:
                continue
            if not want_ce and not is_pe:
                continue
            if abs(strike - float(strike_hint)) > float(strike_window):
                continue
            rows.append((iid, strike))
        if rows:
            break
    rows.sort(key=lambda r: abs(r[1] - float(strike_hint)))
    out: list[tuple[int, float]] = []
    seen: set[int] = set()
    for iid, strike in rows:
        if iid in seen:
            continue
        seen.add(iid)
        out.append((iid, strike))
        if len(out) >= max_candidates:
            break
    return out


def _scale_bars_to_ltp(bars: list[MinuteBar], live_ltp: float) -> list[MinuteBar]:
    return _rescale_ohlc_bars_to_ltp(bars, live_ltp)


def _fetch_proxy_ohlc_bars(
    client: Any,
    *,
    exchange_segment: int,
    live_ltp: float,
    opt_side: str,
    strike_hint: float,
    expiry_hint: str = "",
) -> list[MinuteBar]:
    """When direct OHLC scale mismatches LTP, borrow shape from nearest liquid strike."""
    if not (live_ltp > 0):
        return []
    best: list[MinuteBar] = []
    best_err = 1e9
    for iid, _strike in _parse_master_sensex_options(
        opt_side=opt_side,
        strike_hint=strike_hint,
        expiry_hint=expiry_hint,
        max_candidates=80,
        strike_window=5000.0,
    ):
        cand = fetch_intraday_1m_bars(
            client,
            exchange_segment=int(exchange_segment),
            exchange_instrument_id=int(iid),
        )
        if not cand:
            continue
        recent = [b.close for b in cand[-8:] if b.close > 0]
        if not recent:
            continue
        med = float(statistics.median(recent))
        err = abs(med - float(live_ltp)) / float(live_ltp)
        if err < best_err:
            scaled = _scale_bars_to_ltp(cand, live_ltp)
            if scaled:
                best_err = err
                best = scaled
        if best_err < 0.08:
            break
    if best and best_err <= 0.25:
        _log.info(
            "ema21 proxy ohlc side=%s strike=%s ltp=%.2f err=%.1f%%",
            opt_side,
            strike_hint,
            live_ltp,
            best_err * 100.0,
        )
        return best
    return []


def fetch_and_bootstrap_ema21(
    client: Any,
    *,
    exchange_segment: int,
    exchange_instrument_id: int,
    live_ltp: float = 0.0,
    opt_side: str = "",
    strike_hint: float = 0.0,
    expiry_hint: str = "",
) -> tuple[float, int]:
    """REST OHLC + tick-buffer seed — returns (display_ema21, candle_count)."""
    tid = int(exchange_instrument_id)
    bars = fetch_intraday_1m_bars(
        client,
        exchange_segment=int(exchange_segment),
        exchange_instrument_id=tid,
    )

    eng = get_ema21_engine()
    eng.reset_token(tid)
    now_m = _ist_minute_key(time.time())

    ohlc_used = 0
    seed_bars: list[MinuteBar] = []
    if bars and (live_ltp <= 0 or _ohlc_trustworthy(bars, live_ltp)):
        seed_bars = bars
    elif bars and live_ltp > 0:
        scaled = _rescale_ohlc_bars_to_ltp(bars, live_ltp)
        if scaled:
            _log.info(
                "ema21 ohlc rescaled iid=%s ltp=%.2f med=%.2f",
                exchange_instrument_id,
                live_ltp,
                float(statistics.median([b.close for b in bars[-12:] if b.close > 0])),
            )
            seed_bars = scaled

    if seed_bars:
        ohlc_used = len(seed_bars)
        eng.bootstrap_from_bars(tid, seed_bars, now_minute=now_m, live_ltp=live_ltp, trust_ohlc=True)
    elif live_ltp > 0 and opt_side and strike_hint > 0:
        proxy = _fetch_proxy_ohlc_bars(
            client,
            exchange_segment=int(exchange_segment),
            live_ltp=live_ltp,
            opt_side=opt_side,
            strike_hint=float(strike_hint),
            expiry_hint=expiry_hint,
        )
        if proxy:
            ohlc_used = len(proxy)
            eng.bootstrap_from_bars(tid, proxy, now_minute=now_m, live_ltp=live_ltp, trust_ohlc=True)

    tick_n = eng.seed_from_tick_buffer(tid, _tick_buffer_entries(), overwrite=ohlc_used <= 0)

    if not ohlc_used and live_ltp > 0:
        eng.bootstrap_from_bars(tid, [], now_minute=now_m, live_ltp=live_ltp, trust_ohlc=False)

    if live_ltp > 0:
        ema = eng.on_ltp(tid, live_ltp)
    else:
        ema = eng.get(tid)

    candle_count = eng.minute_bar_count(tid)

    if ema > 0:
        _log.info(
            "ema21 bootstrap iid=%s ohlc=%s tick_min=%s display=%.2f",
            exchange_instrument_id,
            ohlc_used,
            tick_n,
            ema,
        )
    elif not bars and tick_n <= 0:
        _log.debug("ema21 ohlc empty iid=%s", exchange_instrument_id)

    return float(ema), int(candle_count)
