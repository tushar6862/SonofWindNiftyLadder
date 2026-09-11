"""
Strike-wise option chain with CE/PE live merge + ATM / ITM / OTM classification.
"""

from __future__ import annotations

import threading
from typing import Any, Literal

from market.tick_engine import get_tick_engine

Mny = Literal["ATM", "ITM", "OTM"]


def _moneyness_call(spot: float, strike: float) -> Mny:
    if spot <= 0:
        return "ATM"
    d = strike - spot
    if abs(d) < 1e-6 * max(1.0, spot):
        return "ATM"
    return "ITM" if d < 0 else "OTM"


def _moneyness_put(spot: float, strike: float) -> Mny:
    if spot <= 0:
        return "ATM"
    d = spot - strike
    if abs(d) < 1e-6 * max(1.0, spot):
        return "ATM"
    return "ITM" if d < 0 else "OTM"


class OptionChainManager:
    __slots__ = ("_lock", "_index", "_expiry", "_step", "_option_segment", "_instrument_map", "_spot_cached")

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._index = ""
        self._expiry = ""
        self._step = 50.0
        self._option_segment = 2
        self._instrument_map: dict[str, dict[str, int]] = {}
        self._spot_cached: float = 0.0

    def update_from_resolve(
        self,
        *,
        index: str,
        expiry_ui: str,
        spot_ltp: float,
        step: float,
        option_segment: int,
        instrument_map: dict[str, dict[str, int]],
        atm_strike: int,
    ) -> None:
        with self._lock:
            self._index = str(index).upper()
            self._expiry = str(expiry_ui)
            self._step = float(step)
            self._option_segment = int(option_segment)
            self._instrument_map = dict(instrument_map)
            self._spot_cached = float(spot_ltp)
        _ = atm_strike

    def set_spot(self, spot_ltp: float) -> None:
        with self._lock:
            self._spot_cached = float(spot_ltp)

    def snapshot(self) -> dict[str, Any]:
        """Read-only copy of last resolved chain (for hedge / diagnostics)."""
        with self._lock:
            return {
                "index": str(self._index),
                "expiry": str(self._expiry),
                "step": float(self._step),
                "option_segment": int(self._option_segment),
                "instrument_map": dict(self._instrument_map),
                "spot_ltp": float(self._spot_cached),
            }

    def lookup_ce_pe(self, strike: int) -> tuple[int | None, int | None]:
        """
        Resolve CE/PE instrument ids for a strike from the cached instrument map.
        Tries several string keys and snaps to the chain step grid when needed.
        """
        with self._lock:
            imap = dict(self._instrument_map)
            step = float(self._step) if self._step else 50.0

        if not imap:
            return None, None

        def _row_hit(key: str) -> tuple[int | None, int | None]:
            row = imap.get(key)
            if not isinstance(row, dict):
                return None, None
            try:
                ce = int(row.get("ce") or 0)
                pe = int(row.get("pe") or 0)
            except Exception:
                return None, None
            if ce > 0 and pe > 0:
                return ce, pe
            return None, None

        s_int = int(strike)
        for key in (str(s_int), str(float(s_int))):
            hit = _row_hit(key)
            if hit[0] and hit[1]:
                return hit

        if step > 0:
            snapped = int(round(float(s_int) / step) * step)
            for key in (str(snapped), str(float(snapped))):
                hit = _row_hit(key)
                if hit[0] and hit[1]:
                    return hit

        return None, None

    def lookup_option_leg(self, strike: int, leg: str) -> int | None:
        """Return CE or PE instrument id at ``strike`` (same row as chain map), or None."""
        lr = str(leg or "").strip().upper()
        if lr == "CALL":
            lr = "CE"
        if lr == "PUT":
            lr = "PE"
        if lr not in ("CE", "PE"):
            return None
        field = "ce" if lr == "CE" else "pe"
        with self._lock:
            imap = dict(self._instrument_map)
            step = float(self._step) if self._step else 50.0

        if not imap:
            return None

        def _tid_for_key(key: str) -> int | None:
            row = imap.get(key)
            if not isinstance(row, dict):
                return None
            try:
                tid = int(row.get(field) or 0)
            except Exception:
                return None
            return tid if tid > 0 else None

        s_int = int(strike)
        for key in (str(s_int), str(float(s_int))):
            t = _tid_for_key(key)
            if t:
                return t
        if step > 0:
            snapped = int(round(float(s_int) / step) * step)
            for key in (str(snapped), str(float(snapped))):
                t = _tid_for_key(key)
                if t:
                    return t
        return None

    def compose_strike_rows(self) -> dict[str, Any]:
        eng = get_tick_engine()
        live = eng.live_tokens_view()

        with self._lock:
            idx = self._index
            exp = self._expiry
            step = self._step
            opt_seg = self._option_segment
            imap = dict(self._instrument_map)
            spot = float(self._spot_cached)

        strikes_out: list[dict[str, Any]] = []
        for strike_s in sorted(imap.keys(), key=lambda x: float(x)):
            row = imap[strike_s]
            strike = float(strike_s)
            ce_tok = int(row["ce"])
            pe_tok = int(row["pe"])
            ce_live = live.get(ce_tok) or {}
            pe_live = live.get(pe_tok) or {}
            strikes_out.append(
                {
                    "strike": strike,
                    "ce": {
                        "token": ce_tok,
                        "segment": opt_seg,
                        "moneyness": _moneyness_call(spot, strike),
                        "live": ce_live,
                    },
                    "pe": {
                        "token": pe_tok,
                        "segment": opt_seg,
                        "moneyness": _moneyness_put(spot, strike),
                        "live": pe_live,
                    },
                }
            )

        return {
            "index": idx,
            "expiry": exp,
            "step": step,
            "optionSegment": opt_seg,
            "spotRef": spot,
            "strikes": strikes_out,
        }

    def filter_moneyness(self, which: Mny) -> dict[str, Any]:
        full = self.compose_strike_rows()
        strikes = [s for s in full["strikes"] if s["ce"]["moneyness"] == which or s["pe"]["moneyness"] == which]
        return {**full, "strikes": strikes, "filter": which}


_ocm_by_user: dict[str, OptionChainManager] = {}


def _norm_user(username: str) -> str:
    return (username or "").strip().upper()


def get_option_chain_manager(username: str) -> OptionChainManager:
    """Dedicated chain state per logged-in dashboard user (shared singleton caused cross-user bleed)."""
    u = _norm_user(username)
    if not u:
        u = "__ANON__"
    ocm = _ocm_by_user.get(u)
    if ocm is None:
        ocm = OptionChainManager()
        _ocm_by_user[u] = ocm
    return ocm
