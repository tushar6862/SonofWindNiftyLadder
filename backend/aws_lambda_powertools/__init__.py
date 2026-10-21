"""Stdlib stand-in so the Fyers data socket can import.

fyers_apiv3's websocket logger subclasses aws_lambda_powertools.Logger.
That package is not installed: its pinned deps (aiohttp 3.9.3) do not
build on this Python, and the REST quote path never needed it. The data
socket only logs through info/debug/error/exception, so a logging.Logger
with the same constructor is enough for live ticks.
"""

from __future__ import annotations

import logging


class Logger(logging.Logger):
    def __init__(
        self,
        service: str = "fyers",
        level: str | int = "INFO",
        child: bool = False,
        location: str | None = None,
        logger_handler: logging.Handler | None = None,
        **kwargs: object,
    ) -> None:
        del child, location, kwargs
        super().__init__(service or "fyers", logging.NOTSET)
        if isinstance(level, str):
            self.setLevel(getattr(logging, level.upper(), logging.INFO))
        else:
            self.setLevel(int(level))
        if logger_handler is not None and logger_handler not in self.handlers:
            self.addHandler(logger_handler)
            self.propagate = False
