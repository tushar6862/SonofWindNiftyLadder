"""
Optional Redis pub/sub for tick snapshots and option-chain JSON.
Set REDIS_URL (e.g. redis://127.0.0.1:6379/0) to enable.
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

try:
    import redis

    _HAS_REDIS = True
except Exception:
    redis = None  # type: ignore
    _HAS_REDIS = False


class RedisPublisher:
    def __init__(self) -> None:
        self._url = (os.getenv("REDIS_URL") or "").strip()
        self._prefix = (os.getenv("REDIS_KEY_PREFIX") or "sow").strip() or "sow"
        self._r: Any = None
        self.enabled = bool(self._url) and _HAS_REDIS
        if self.enabled:
            try:
                self._r = redis.from_url(self._url, decode_responses=True)
                self._r.ping()
            except Exception:
                self._r = None
                self.enabled = False

    def publish_tick(self, token: int, row: dict[str, Any]) -> None:
        if not self._r:
            return
        key = f"{self._prefix}:tick:{token}"
        payload = json.dumps(row, separators=(",", ":"))
        self._r.setex(key, 30, payload)
        self._r.publish(f"{self._prefix}:ticks", payload)

    def publish_chain(self, snapshot: dict[str, Any]) -> None:
        if not self._r:
            return
        key = f"{self._prefix}:chain:latest"
        self._r.setex(key, 5, json.dumps(snapshot, separators=(",", ":")))
        self._r.publish(f"{self._prefix}:chain", "1")
