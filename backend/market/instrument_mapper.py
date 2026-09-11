"""
Token → human-readable symbol mapping for NIFTY / BANKNIFTY / SENSEX spot and options.
Registers chain rows from /api/chain/resolve style payloads.
"""

from __future__ import annotations

import threading
from typing import Any, Literal

IndexName = Literal["NIFTY", "BANKNIFTY", "SENSEX"]

# Default index spot tokens (NSE-style; broker may override via register_index_token)
DEFAULT_SPOT: dict[IndexName, tuple[int, int]] = {
    "NIFTY": (1, 26000),
    "BANKNIFTY": (1, 26001),
    "SENSEX": (1, 26065),
}


class InstrumentMapper:
    """
    Key internal: int(exchangeInstrumentID) for options/indices on subscribed segment.
    Stores (segment, token) for ambiguity; fast path uses token-only when unique.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._by_token: dict[int, dict[str, Any]] = {}
        self._by_seg_token: dict[tuple[int, int], dict[str, Any]] = {}

    def register_index_spot(self, name: IndexName, segment: int, token: int) -> None:
        with self._lock:
            meta = {
                "kind": "INDEX",
                "index": name,
                "segment": int(segment),
                "token": int(token),
                "symbol": name,
            }
            self._by_token[int(token)] = meta
            self._by_seg_token[(int(segment), int(token))] = meta

    def register_default_indices(self) -> None:
        for name, (seg, tok) in DEFAULT_SPOT.items():
            self.register_index_spot(name, seg, tok)

    def register_option_chain(
        self,
        *,
        index: IndexName,
        option_segment: int,
        instrument_map: dict[str, dict[str, int]],
        expiry_label: str,
    ) -> None:
        """instrument_map: strike string -> {ce, pe} exchangeInstrumentID integers."""
        with self._lock:
            for strike_s, row in instrument_map.items():
                try:
                    strike = float(strike_s)
                except Exception:
                    continue
                ce = int(row["ce"])
                pe = int(row["pe"])
                seg = int(option_segment)
                self._by_token[ce] = {
                    "kind": "CE",
                    "index": index,
                    "segment": seg,
                    "token": ce,
                    "symbol": f"{index}{int(strike)}CE",
                    "strike": strike,
                    "expiry": expiry_label,
                }
                self._by_token[pe] = {
                    "kind": "PE",
                    "index": index,
                    "segment": seg,
                    "token": pe,
                    "symbol": f"{index}{int(strike)}PE",
                    "strike": strike,
                    "expiry": expiry_label,
                }
                self._by_seg_token[(seg, ce)] = self._by_token[ce]
                self._by_seg_token[(seg, pe)] = self._by_token[pe]

    def describe(self, segment: int | None, token: int) -> dict[str, Any]:
        with self._lock:
            if segment is not None:
                hit = self._by_seg_token.get((int(segment), int(token)))
                if hit:
                    return dict(hit)
            hit = self._by_token.get(int(token))
            return dict(hit) if hit else {"kind": "UNKNOWN", "token": int(token), "symbol": ""}

    def enrich_tick(self, segment: int | None, token: int, tick: dict[str, Any]) -> dict[str, Any]:
        d = self.describe(segment, token)
        out = dict(tick)
        sym = str(d.get("symbol") or "")
        out["symbol"] = sym or out.get("symbol", "")
        out["_meta"] = d
        return out


_mapper: InstrumentMapper | None = None


def get_instrument_mapper() -> InstrumentMapper:
    global _mapper
    if _mapper is None:
        _mapper = InstrumentMapper()
        _mapper.register_default_indices()
    return _mapper
