"""Fill checks for a place response. Pending and rejected are not fills."""

from __future__ import annotations

from typing import Any

_FILL_STATES = {"FILLED", "COMPLETE", "COMPLETED", "TRADED"}
_OPEN_STATES = {
    "PENDING",
    "NEW",
    "OPEN",
    "REPLACED",
    "PENDINGNEW",
    "PENDINGREPLACE",
    "PARTIALLYFILLED",
    "PARTIALFILLED",
    "TRIGGERPENDING",
}
_TRADED_KEYS = (
    "CumulativeQuantity",
    "cumulativeQuantity",
    "FilledQuantity",
    "filledQuantity",
    "OrderQuantityTraded",
    "orderQuantityTraded",
    "TradedQuantity",
    "tradedQuantity",
)


def _rows(res: Any) -> list[dict[str, Any]]:
    top = res if isinstance(res, dict) else None
    if top is None:
        return []
    raw = top.get("raw")
    src = raw if isinstance(raw, dict) else top
    inner = src.get("result", src.get("Result"))
    if inner is None:
        inner = src
    if isinstance(inner, list):
        return [row for row in inner if isinstance(row, dict)]
    if isinstance(inner, dict):
        listed = inner.get("list") or inner.get("orderList") or inner.get("OrderList")
        if isinstance(listed, list):
            return [row for row in listed if isinstance(row, dict)]
        return [inner]
    return []


def _status(row: dict[str, Any]) -> str:
    raw = str(row.get("OrderStatus") or row.get("orderStatus") or "")
    return "".join(raw.upper().split())


def _num(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).replace(",", "").strip()
    if not text:
        return None
    try:
        return max(0, int(float(text)))
    except (TypeError, ValueError):
        return None


def _explicit_traded(row: dict[str, Any]) -> int | None:
    for key in _TRADED_KEYS:
        if key not in row or row.get(key) is None or str(row.get(key)).strip() == "":
            continue
        qty = _num(row.get(key))
        if qty is not None:
            return qty
    return None


def _row_traded_qty(row: dict[str, Any], sent_qty: int) -> int:
    explicit = _explicit_traded(row)
    status = _status(row)
    if explicit is not None:
        traded = explicit
    elif status in _FILL_STATES:
        order_qty = _num(row.get("OrderQuantity") if row.get("OrderQuantity") not in (None, "") else row.get("orderQuantity"))
        traded = order_qty if order_qty is not None and order_qty > 0 else (sent_qty if sent_qty > 0 else 0)
    else:
        traded = 0
    if sent_qty > 0:
        return min(sent_qty, traded)
    return traded


def response_traded_qty(res: Any, sent_qty: int = 0) -> int:
    """Traded quantity on the place or order-book response. An ack, pending, or reject with no trade is 0."""
    rows = _rows(res)
    if not rows:
        return 0
    return max(_row_traded_qty(row, sent_qty) for row in rows)


def response_is_full_fill(res: Any, sent_qty: int) -> bool:
    """True only when the whole order traded. Pending, open, new, rejected, and cancelled leftovers are not fills."""
    if sent_qty <= 0:
        return False
    matched = False
    for row in _rows(res):
        status = _status(row)
        traded = _row_traded_qty(row, sent_qty)
        if status in _OPEN_STATES or "PENDING" in status or "REJECT" in status:
            continue
        if status in {"CANCELLED", "CANCELED"} and traded < sent_qty:
            continue
        reason = str(
            row.get("CancelRejectReason")
            or row.get("cancelRejectReason")
            or row.get("OrderRejectReason")
            or row.get("RejectReason")
            or ""
        )
        blob = f"{status} {reason}".lower()
        if "16388" in blob or "cancelled by system" in blob:
            if traded < sent_qty:
                continue
        if traded >= sent_qty and (status in _FILL_STATES or status in {"CANCELLED", "CANCELED"} or _explicit_traded(row) is not None):
            matched = True
    return matched


def _self_check() -> None:
    sent = 65
    ack = {"type": "success", "result": {"AppOrderID": "1"}}
    pending = {"type": "success", "result": {"AppOrderID": "2", "OrderStatus": "Pending", "OrderQuantity": sent}}
    new = {"type": "success", "result": {"OrderStatus": "New", "LeavesQuantity": sent}}
    rejected = {"type": "success", "result": {"OrderStatus": "Rejected", "CancelRejectReason": "16388"}}
    cancelled = {"type": "success", "result": {"OrderStatus": "Cancelled", "CumulativeQuantity": 0}}
    partial = {"type": "success", "result": {"OrderStatus": "Cancelled", "CumulativeQuantity": 30, "OrderQuantity": sent}}
    filled = {
        "type": "success",
        "result": {"OrderStatus": "Filled", "CumulativeQuantity": sent, "OrderAverageTradedPrice": 12.5},
    }
    traded_status = {"type": "success", "result": {"OrderStatus": "Traded", "OrderQuantity": sent}}
    if response_traded_qty(ack, sent) != 0 or response_is_full_fill(ack, sent):
        raise SystemExit("ack is not a fill")
    if response_traded_qty(pending, sent) != 0 or response_is_full_fill(pending, sent):
        raise SystemExit("pending is not a fill")
    if response_traded_qty(new, sent) != 0 or response_is_full_fill(new, sent):
        raise SystemExit("new is not a fill")
    if response_traded_qty(rejected, sent) != 0 or response_is_full_fill(rejected, sent):
        raise SystemExit("rejected is not a fill")
    if response_traded_qty(cancelled, sent) != 0 or response_is_full_fill(cancelled, sent):
        raise SystemExit("cancelled with zero trade is not a fill")
    if response_traded_qty(partial, sent) != 30 or response_is_full_fill(partial, sent):
        raise SystemExit("partial must report traded qty and is not a full fill")
    if response_traded_qty(filled, sent) != sent or not response_is_full_fill(filled, sent):
        raise SystemExit("filled status with traded qty is a full fill")
    if response_traded_qty(traded_status, sent) != sent or not response_is_full_fill(traded_status, sent):
        raise SystemExit("traded status is a full fill")


if __name__ == "__main__":
    _self_check()
