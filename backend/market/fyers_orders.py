"""Flip demo orders. Live Flip orders stay on XTS. This path never calls XTS."""

from __future__ import annotations

import time
from typing import Any

import requests

_ORDERS_URL = "https://api-t1.fyers.in/api/v3/orders/sync"
_BOOK_URL = "https://api-t1.fyers.in/api/v3/orders"
# 2 is Traded. 5 is Rejected. 1 is Cancelled. 4 and 6 are still working.
_TRADED = 2
_DONE = {1, 2, 5, 7}


def place_market_order(*, instrument_id: int, side: str, qty: int) -> dict[str, Any]:
    from market.fyers_ltp import access_token_header, fyers_symbol_for_iid, has_access_token

    if not has_access_token():
        raise RuntimeError("Fyers not connected. Log in, then send the demo order again.")
    header = access_token_header()
    if not header:
        raise RuntimeError("Fyers not connected. Log in, then send the demo order again.")
    symbol = fyers_symbol_for_iid(instrument_id)
    if not symbol:
        raise RuntimeError("No Fyers symbol for this contract.")
    if side not in ("BUY", "SELL"):
        raise RuntimeError("orderSide must be BUY or SELL")
    if qty <= 0:
        raise RuntimeError("orderQuantity must be > 0")

    placed = requests.post(
        _ORDERS_URL,
        headers={"Authorization": header, "Content-Type": "application/json"},
        json={
            "symbol": symbol,
            "qty": qty,
            "type": 2,
            "side": 1 if side == "BUY" else -1,
            "productType": "INTRADAY",
            "limitPrice": 0,
            "stopPrice": 0,
            "validity": "DAY",
            "disclosedQty": 0,
            "offlineOrder": False,
            "stopLoss": 0,
            "takeProfit": 0,
            "orderTag": "flipdemo",
        },
        timeout=8,
    )
    body = _json(placed)
    if str(body.get("s") or "").lower() == "error":
        raise RuntimeError(str(body.get("message") or "Fyers rejected the order"))
    order_id = str(body.get("id") or body.get("order_id") or "").strip()
    row = _row_from(body, order_id)
    if order_id and not _filled(row):
        row = _wait_fill(header, order_id) or row
    if _rejected(row):
        raise RuntimeError(str(row.get("message") or "Fyers rejected the order"))
    filled = _qty(row.get("filledQty"))
    price = _px(row.get("tradedPrice"))
    if not _filled(row) or filled <= 0 or price <= 0:
        if order_id:
            _cancel(header, order_id)
        raise RuntimeError("Fyers order was not filled")
    traded = min(filled, qty)
    return {
        "broker": "fyers",
        "symbol": symbol,
        "orderId": order_id,
        "raw": {
            "type": "success",
            "result": {
                "ExchangeInstrumentID": instrument_id,
                "OrderStatus": "Filled",
                "CumulativeQuantity": traded,
                "OrderAverageTradedPrice": price,
                "OrderQuantity": qty,
            },
        },
    }


def _wait_fill(header: str, order_id: str) -> dict[str, Any] | None:
    last: dict[str, Any] | None = None
    for _ in range(8):
        time.sleep(0.25)
        last = _fetch(header, order_id)
        if last is None:
            continue
        if _filled(last) or _status(last) in _DONE:
            return last
    return last


def _fetch(header: str, order_id: str) -> dict[str, Any] | None:
    try:
        response = requests.get(
            _BOOK_URL,
            headers={"Authorization": header},
            params={"id": order_id},
            timeout=4,
        )
    except Exception:
        return None
    body = _json(response)
    book = body.get("orderBook")
    rows = book if isinstance(book, list) else []
    for row in rows:
        if isinstance(row, dict) and str(row.get("id") or "") == order_id:
            return row
    if len(rows) == 1 and isinstance(rows[0], dict):
        return rows[0]
    return _row_from(body, order_id)


def _cancel(header: str, order_id: str) -> None:
    try:
        requests.delete(
            _ORDERS_URL,
            headers={"Authorization": header, "Content-Type": "application/json"},
            json={"id": order_id},
            timeout=4,
        )
    except Exception:
        return


def _json(response: requests.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except Exception:
        body = {}
    return body if isinstance(body, dict) else {}


def _row_from(body: dict[str, Any], order_id: str) -> dict[str, Any]:
    if body.get("filledQty") is not None or body.get("tradedPrice") is not None or body.get("status") is not None:
        return body
    return {"id": order_id, "status": 6, "message": body.get("message") or ""}


def _status(row: dict[str, Any] | None) -> int:
    if not row:
        return 0
    try:
        return int(row.get("status") or 0)
    except Exception:
        return 0


def _filled(row: dict[str, Any] | None) -> bool:
    return _status(row) == _TRADED and _qty(None if row is None else row.get("filledQty")) > 0 and _px(None if row is None else row.get("tradedPrice")) > 0


def _rejected(row: dict[str, Any] | None) -> bool:
    return _status(row) in (1, 5, 7)


def _qty(value: Any) -> int:
    try:
        return max(0, int(float(value or 0)))
    except Exception:
        return 0


def _px(value: Any) -> float:
    try:
        number = float(value or 0)
    except Exception:
        return 0.0
    return number if number > 0 else 0.0
