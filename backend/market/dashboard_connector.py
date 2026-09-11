"""
Bridges ``MarketDataStreamer`` (Socket.IO thread) → ``TickEngine`` / ``OptionChainManager``.
Exposes JSON snapshots for dashboard / strategy workers.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

from market.instrument_mapper import get_instrument_mapper
from market.option_chain_manager import get_option_chain_manager
from market.tick_engine import get_tick_engine

_log = logging.getLogger(__name__)

_pipeline_attached = False


def wire_market_streamer(streamer: Any) -> None:
    """
    Idempotent: attach ``TickEngine.ingest`` to decoded ticks from the streamer.
    ``streamer`` must implement ``set_pipeline_sink(Callable[[dict], None])``.
    """
    global _pipeline_attached
    if _pipeline_attached:
        return
    if not hasattr(streamer, "set_pipeline_sink"):
        _log.warning("MarketDataStreamer has no set_pipeline_sink; pipeline not wired")
        return
    streamer.set_pipeline_sink(get_tick_engine().ingest)
    _pipeline_attached = True
    _log.info("market pipeline wired: Socket.IO → TickEngine")


def notify_chain_resolved(payload: dict[str, Any], username: str) -> None:
    """Call after successful ``/api/chain/resolve`` body (ok True)."""
    try:
        idx = str(payload.get("index") or "").upper()
        u = (username or "").strip().upper() or "__ANON__"
        get_option_chain_manager(u).update_from_resolve(
            index=idx,
            expiry_ui=str(payload.get("expiryUi") or ""),
            spot_ltp=float(payload.get("spotLtp") or 0.0),
            step=float(payload.get("step") or 50.0),
            option_segment=int(payload.get("optionSegment") or 2),
            instrument_map=dict(payload.get("instrumentMap") or {}),
            atm_strike=int(payload.get("atmStrike") or 0),
        )
        im = get_instrument_mapper()
        if idx in ("NIFTY", "BANKNIFTY", "SENSEX"):
            im.register_index_spot(
                idx,  # type: ignore[arg-type]
                int(payload.get("spotSegment") or 1),
                int(payload.get("spotToken") or 0),
            )
            im.register_option_chain(
                index=idx,  # type: ignore[arg-type]
                option_segment=int(payload.get("optionSegment") or 2),
                instrument_map=dict(payload.get("instrumentMap") or {}),
                expiry_label=str(payload.get("expiryUi") or ""),
            )
    except Exception:
        _log.exception("notify_chain_resolved failed")


def get_chain_snapshot_dict(index: str | None, username: str) -> dict[str, Any]:
    u = (username or "").strip().upper() or "__ANON__"
    snap = get_option_chain_manager(u).compose_strike_rows()
    if index and str(snap.get("index") or "").upper() != str(index).upper():
        return {"ok": False, "error": "index mismatch or chain not loaded", "requested": index}
    snap["benchmark"] = get_tick_engine().benchmark_summary()
    snap["ok"] = True
    return snap


def chain_snapshot_pandas(username: str = "__ANON__"):
    """Optional DataFrame view for analytics (requires pandas)."""
    import pandas as pd

    u = (username or "").strip().upper() or "__ANON__"
    data = get_option_chain_manager(u).compose_strike_rows()
    rows = []
    for s in data.get("strikes") or []:
        strike = s["strike"]
        for side in ("ce", "pe"):
            live = s[side].get("live") or {}
            rows.append(
                {
                    "strike": strike,
                    "side": side.upper(),
                    "moneyness": s[side].get("moneyness"),
                    "ltp": live.get("ltp"),
                    "bid": live.get("bid"),
                    "ask": live.get("ask"),
                    "oi": live.get("oi"),
                    "volume": live.get("volume"),
                }
            )
    return pd.DataFrame(rows)
