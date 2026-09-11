"""
API Binary market transport.

Real XTS/Investeria feeds use **Socket.IO over Engine.IO** (WebSocket upgrade), not a plain
``wss://`` URL. Production stack here:

- **Synchronous path (default):** ``xts_md.MarketDataStreamer`` + ``python-socketio.Client``
- **Tick path:** decoded dicts forwarded by ``dashboard_connector.wire_market_streamer``

To move to asyncio, upgrade deps to ``python-socketio>=5`` / ``python-engineio>=4`` and use:

.. code-block:: python

    import asyncio
    import socketio

    sio = socketio.AsyncClient()
    @sio.on("xts-binary-packet")
    async def _on(data):
        from market.packet_decoder import decode_xts_binary_packet
        for tick in decode_xts_binary_packet(bytes(data)):
            ...

    asyncio.run(sio.connect(url, transports=["websocket"], socketio_path="apibinarymarketdata/socket.io"))


This file keeps a thin **heartbeat / metrics** helper so strategies can observe feed health without
doubling transports.
"""

from __future__ import annotations

import time
from typing import Any, Callable


class FeedHeartbeatMonitor:
    """
    Attach around your binary callback to detect stalls (no packet for ``warn_after_s``).
    Not a substitute for Socket.IO/engine.io heartbeats — those are handled by the client library.
    """

    __slots__ = ("_last", "_rx", "_warn_after_s", "_lost_hint")

    def __init__(self, warn_after_s: float = 3.0) -> None:
        self._last = time.monotonic()
        self._rx = 0
        self._warn_after_s = float(warn_after_s)
        self._lost_hint = 0

    def mark_rx(self, n_bytes: int) -> dict[str, Any]:
        now = time.monotonic()
        gap_ms = (now - self._last) * 1000.0
        self._last = now
        self._rx += 1
        stalled = gap_ms > (self._warn_after_s * 1000.0)
        if stalled:
            self._lost_hint += 1
        return {
            "rx_count": self._rx,
            "gap_ms_since_last_packet": gap_ms,
            "bytes": n_bytes,
            "stalled": stalled,
            "stall_hints": self._lost_hint,
        }


def wrap_binary_handler(inner: Callable[[Any], None], monitor: FeedHeartbeatMonitor) -> Callable[[Any], None]:
    def _wrapped(data: Any) -> None:
        raw = bytes(data) if data is not None and not isinstance(data, str) else b""
        monitor.mark_rx(len(raw))
        inner(data)

    return _wrapped
