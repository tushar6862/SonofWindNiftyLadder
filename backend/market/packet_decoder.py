"""
Binary payloads on Socket.IO ``xts-binary-packet``.

Matched to ``XTS_OPTIONS_DASHBOARD/MarketDataSocketClient.decode_xts_binary_packet``:
-strip engine.io framing bytes ahead of gzip flag
-full 16-byte gzip chunk header (+ zlib deflate body)
-non-gzip: remaining bytes ARE the inner buffer (NOT 14-byte size prefix + slice)
-scan inner buffer for multiple 1501/1502 messages (legacy 1502 divisor path)

Older implementation mis-framed payloads and yielded zero ticks → blank option-chain LTP.
"""

from __future__ import annotations

import struct
import time
import zlib
from typing import Any, Iterable

# ────────────────────────────────────────────────────────────────────────────────


def inflate_raw(deflate_bytes: bytes) -> bytes:
    d = zlib.decompressobj(-15)
    return d.decompress(deflate_bytes) + d.flush()


_MSG_VER_EXTENDED = 4
_ROW_STRUCT = struct.Struct("<idIh")

PRICE_DIVISORS: dict[int, int] = {
    1: 100,
    11: 100,
    2: 100,
    12: 100,
    51: 100,
    3: 10000000,
    13: 10000,
    4: 10000,
}


def _read_depth_row(payload: bytes | memoryview, off: int):
    if off + 18 > len(payload):
        raise struct.error("eof depth row")
    sz, pr, to, mm = _ROW_STRUCT.unpack_from(payload, off)
    off += 18
    return off, {"Size": int(sz), "Price": float(pr), "TotalOrders": int(to), "mm": int(mm)}


def _read_common_header(payload: bytes | memoryview, off: int):
    if off + 14 > len(payload):
        raise struct.error("eof header")
    msg_ver, _app_type = struct.unpack_from("<HH", payload, off)
    off += 4
    off += 8
    if msg_ver >= _MSG_VER_EXTENDED:
        if off + 12 > len(payload):
            raise struct.error("eof ext header")
        off += 12
    if off + 14 > len(payload):
        raise struct.error("eof seg/inst/ts")
    ex_seg, ex_id = struct.unpack_from("<hi", payload, off)
    off += 6
    off += 8
    return off, int(ex_seg), int(ex_id)


def _read_touch_tail(payload: bytes | memoryview, off: int):
    need = 8 + 8 + 4 + 12 + 8 + 8 + 8 + 32 + 8 + 8
    if off + need > len(payload):
        raise struct.error("eof touch tail")
    off += 8
    ltp = struct.unpack_from("<d", payload, off)[0]
    off += 8
    ltq = struct.unpack_from("<i", payload, off)[0]
    off += 4
    tbu, tsu, ttq = struct.unpack_from("<III", payload, off)
    off += 12
    atp = struct.unpack_from("<d", payload, off)[0]
    off += 8
    ltt = struct.unpack_from("<q", payload, off)[0]
    off += 8
    pct = struct.unpack_from("<d", payload, off)[0]
    off += 8
    o, h, low, c = struct.unpack_from("<dddd", payload, off)
    off += 32
    tvt = struct.unpack_from("<d", payload, off)[0]
    off += 8
    off += 8
    return off, {
        "LastTradedPrice": float(ltp),
        "LastTradedQuantity": int(ltq),
        "TotalBuyQuantity": int(tbu),
        "TotalSellQuantity": int(tsu),
        "TotalTradedQuantity": int(ttq),
        "AverageTradedPrice": float(atp),
        "LastTradedTime": int(ltt),
        "PercentChange": float(pct),
        "Open": float(o),
        "High": float(h),
        "Low": float(low),
        "Close": float(c),
        "TotalValueTraded": float(tvt),
    }


def _decode_touchline_1501_payload(payload: bytes, start: int = 0):
    off = start
    if off + 2 > len(payload):
        return None, start
    code = struct.unpack_from("<H", payload, off)[0]
    off += 2
    if code != 1501:
        return None, start
    off, ex_seg, ex_id = _read_common_header(payload, off)
    off, bid_top = _read_depth_row(payload, off)
    off, ask_top = _read_depth_row(payload, off)
    off, touch = _read_touch_tail(payload, off)
    touch["BidInfo"] = bid_top
    touch["AskInfo"] = ask_top
    return (
        {"MessageCode": 1501, "ExchangeSegment": ex_seg, "ExchangeInstrumentID": ex_id, "Touchline": touch},
        off,
    )


def _decode_marketdepth_1502_sdk_payload(payload: bytes, start: int = 0):
    off = start
    if off + 2 > len(payload):
        return None, start
    code = struct.unpack_from("<H", payload, off)[0]
    off += 2
    if code != 1502:
        return None, start
    off, ex_seg, ex_id = _read_common_header(payload, off)
    if off + 4 > len(payload):
        return None, start
    bid_count = struct.unpack_from("<i", payload, off)[0]
    off += 4
    bids = []
    for _ in range(max(0, bid_count)):
        off, row = _read_depth_row(payload, off)
        bids.append(row)
    if off + 4 > len(payload):
        return None, start
    ask_count = struct.unpack_from("<i", payload, off)[0]
    off += 4
    asks = []
    for _ in range(max(0, ask_count)):
        off, row = _read_depth_row(payload, off)
        asks.append(row)
    off, tb = _read_depth_row(payload, off)
    off, ta = _read_depth_row(payload, off)
    off, touch = _read_touch_tail(payload, off)
    touch["BidInfo"] = bids[0] if bids else tb
    touch["AskInfo"] = asks[0] if asks else ta
    return (
        {"MessageCode": 1502, "ExchangeSegment": ex_seg, "ExchangeInstrumentID": ex_id, "Touchline": touch},
        off,
    )


def _decode_marketdepth_1502_legacy(payload: bytes):
    try:
        off = 0
        (message_code,) = struct.unpack_from("<H", payload, off)
        off += 2
        if message_code != 1502:
            return None
        (message_version,) = struct.unpack_from("<H", payload, off)
        off += 2
        off += 2
        off += 8
        if message_version >= 4:
            off += 8
            off += 4
        (exchange_segment,) = struct.unpack_from("<h", payload, off)
        off += 2
        (exchange_instrument_id,) = struct.unpack_from("<i", payload, off)
        off += 4
        off += 8
        divisor = PRICE_DIVISORS.get(int(exchange_segment), 1)
        (bid_count,) = struct.unpack_from("<i", payload, off)
        off += 4
        bids = []
        for _ in range(max(0, bid_count)):
            size, row_price_raw, total_orders, mm = struct.unpack_from("<qiIh", payload, off)
            off += 18
            bids.append(
                {"Size": int(size), "Price": row_price_raw / divisor, "TotalOrders": int(total_orders), "mm": mm}
            )
        (ask_count,) = struct.unpack_from("<i", payload, off)
        off += 4
        asks = []
        for _ in range(max(0, ask_count)):
            size, row_price_raw, total_orders, mm = struct.unpack_from("<qiIh", payload, off)
            off += 18
            asks.append(
                {"Size": int(size), "Price": row_price_raw / divisor, "TotalOrders": int(total_orders), "mm": mm}
            )
        off += 18
        off += 18
        off += 8
        (ltp_raw,) = struct.unpack_from("<i", payload, off)
        return {
            "MessageCode": 1502,
            "ExchangeSegment": exchange_segment,
            "ExchangeInstrumentID": exchange_instrument_id,
            "Touchline": {
                "LastTradedPrice": ltp_raw / divisor,
                "BidInfo": bids[0] if bids else {},
                "AskInfo": asks[0] if asks else {},
            },
        }
    except Exception:
        return None


def _decode_open_interest_1510_payload(payload: bytes, start: int = 0):
    off = start
    if off + 2 > len(payload):
        return None, start
    code = struct.unpack_from("<H", payload, off)[0]
    off += 2
    if code != 1510:
        return None, start
    off, ex_seg, ex_id = _read_common_header(payload, off)
    if off + 2 > len(payload):
        return None, start
    off += 2
    if off + 4 > len(payload):
        return None, start
    oi = struct.unpack_from("<i", payload, off)[0]
    off += 4
    if off + 2 + 8 + 1 > len(payload):
        return None, start
    off += 2
    off += 8
    is_str = struct.unpack_from("<b", payload, off)[0]
    off += 1
    if is_str == 1 and off + 1 <= len(payload):
        slen = struct.unpack_from("<b", payload, off)[0]
        off += 1 + max(0, int(slen))
    if off + 4 > len(payload):
        return None, start
    und_oi = struct.unpack_from("<i", payload, off)[0]
    off += 4
    return (
        {
            "MessageCode": 1510,
            "ExchangeSegment": ex_seg,
            "ExchangeInstrumentID": ex_id,
            "Touchline": {"OpenInterest": int(oi), "UnderlyingTotalOpenInterest": int(und_oi)},
        },
        off,
    )


def _decode_inner_messages(payload: bytes) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    pos = 0
    total = len(payload)
    while pos < total:
        if pos + 2 > total:
            break
        peek = struct.unpack_from("<H", payload, pos)[0]
        parsed = None
        end = pos
        try:
            if peek == 1501:
                parsed, end = _decode_touchline_1501_payload(payload, pos)
            elif peek == 1502:
                try:
                    parsed, end = _decode_marketdepth_1502_sdk_payload(payload, pos)
                except (struct.error, IndexError, TypeError, ValueError):
                    parsed, end = None, pos
                if parsed is None:
                    legacy = _decode_marketdepth_1502_legacy(payload[pos:])
                    if legacy:
                        out.append(legacy)
                    break
            elif peek == 1510:
                parsed, end = _decode_open_interest_1510_payload(payload, pos)
            else:
                parsed, end = None, pos
        except (struct.error, IndexError, TypeError, ValueError):
            parsed, end = None, pos

        if parsed is None:
            break
        out.append(parsed)
        if end <= pos:
            break
        pos = end
    return out


def _instrument_int(x: Any) -> int | None:
    try:
        if x is None:
            return None
        return int(str(x).strip())
    except Exception:
        return None


def _msg_to_dashboard_row(msg: dict[str, Any]) -> dict[str, Any] | None:
    mc = msg.get("MessageCode")
    if mc not in (1501, 1502):
        return None
    seg_raw = msg.get("ExchangeSegment")
    tid = _instrument_int(msg.get("ExchangeInstrumentID"))
    if tid is None or tid <= 0:
        return None
    tl = msg.get("Touchline")
    if not isinstance(tl, dict):
        return None
    bi = tl.get("BidInfo")
    ai = tl.get("AskInfo")
    if not isinstance(bi, dict):
        bi = {}
    if not isinstance(ai, dict):
        ai = {}

    wall = time.time()
    ltp = float(tl.get("LastTradedPrice") or 0.0)
    bid = float(bi.get("Price") or 0.0)
    ask = float(ai.get("Price") or 0.0)
    atp = float(tl.get("AverageTradedPrice") or 0.0)
    prev_close = 0.0
    try:
        c = tl.get("Close")
        if c is not None and str(c).strip() != "":
            prev_close = float(c)
    except Exception:
        prev_close = 0.0
    pct_change: float | None = None
    try:
        p = tl.get("PercentChange")
        if p is not None and str(p).strip() != "":
            v = float(p)
            pct_change = v if v == v else None  # filter NaN
    except Exception:
        pct_change = None
    day_open = 0.0
    try:
        o = tl.get("Open")
        if o is not None and str(o).strip() != "":
            day_open = float(o)
    except Exception:
        day_open = 0.0
    day_high = day_low = 0.0
    try:
        hi = tl.get("High")
        if hi is not None and str(hi).strip() != "":
            day_high = float(hi)
        lo = tl.get("Low")
        if lo is not None and str(lo).strip() != "":
            day_low = float(lo)
    except Exception:
        day_high = day_low = 0.0
    if day_high > 0 and day_low > 0 and day_high < day_low:
        day_high, day_low = day_low, day_high
    ts_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(wall))

    try:
        seg_i = int(seg_raw) if seg_raw is not None else 0
    except Exception:
        seg_i = 0

    out: dict[str, Any] = {
        "symbol": "",
        "ltp": ltp,
        "atp": atp,
        "bid": bid,
        "ask": ask,
        "bid_qty": int(bi.get("Size") or 0),
        "ask_qty": int(ai.get("Size") or 0),
        "oi": int(tl.get("OpenInterest") or 0),
        "volume": int(tl.get("TotalTradedQuantity") or tl.get("LastTradedQuantity") or 0),
        "timestamp": ts_iso,
        "exchange_ts": int(tl.get("LastTradedTime") or 0),
        "segment": seg_i,
        "token": tid,
        "messageCode": int(mc),
        "exchangeSegment": seg_i,
        "exchangeInstrumentID": tid,
        "ts": time.time(),
    }
    # Previous-session close vs live LTP (TopBar day change — not drift vs chain snapshot).
    if prev_close > 0 and ltp > 0 and abs(prev_close - ltp) >= max(0.01, ltp * 1e-5):
        out["prevClose"] = prev_close
    if pct_change is not None and pct_change == pct_change:
        out["percentChange"] = pct_change
    if day_open > 0:
        out["dayOpen"] = day_open
    if day_high > 0 and day_low > 0 and day_high + 1e-9 >= day_low:
        out["dayHigh"] = day_high
        out["dayLow"] = day_low
    return out


def _decode_outer_symphony_primary(arr: bytes | bytearray) -> list[dict[str, Any]]:
    """Primary framing (gzip 16-byte header; raw inner when flag=0)."""
    msgs: list[dict[str, Any]] = []
    off = 0
    total = len(arr)

    while off < total:
        is_gzip = arr[off]
        off += 1
        if is_gzip == 1:
            if off + 16 > total:
                break
            _, _, _, _, _, _, cmp_size = struct.unpack_from("<HhihhHH", arr, off)
            off += 16
            if cmp_size <= 0 or off + cmp_size > total:
                break
            raw = bytes(arr[off : off + cmp_size])
            off += cmp_size
            try:
                inner = inflate_raw(raw)
            except Exception:
                continue
            msgs.extend(_decode_inner_messages(inner))
        elif is_gzip == 0 and off < total:
            msgs.extend(_decode_inner_messages(bytes(arr[off:])))
            break
        else:
            break
    return msgs


def _decode_outer_legacy_fallback(arr: bytes | bytearray) -> list[dict[str, Any]]:
    """Older sample used 14-byte chunk header before raw body for non-gzip."""
    msgs: list[dict[str, Any]] = []
    a = memoryview(arr)
    offset = 0
    while offset < len(a):
        fg = int.from_bytes(a[offset : offset + 1], "little", signed=False)
        offset += 1
        if fg == 1:
            if offset + 16 > len(a):
                break
            hdr = a[offset : offset + 16]
            cmp_sz = int.from_bytes(hdr[14:16], "little", signed=False)
            offset += 16
            if offset + cmp_sz > len(a):
                break
            blob = a[offset : offset + cmp_sz].tobytes()
            offset += cmp_sz
            try:
                inner = inflate_raw(blob)
            except Exception:
                continue
            msgs.extend(_decode_inner_messages(inner))
        else:
            if offset + 14 > len(a):
                break
            uh = a[offset : offset + 14]
            un_sz = int.from_bytes(uh[12:14], "little", signed=False)
            offset += 14
            if offset + un_sz > len(a):
                break
            body = a[offset : offset + un_sz].tobytes()
            offset += un_sz
            msgs.extend(_decode_inner_messages(body))
    return msgs


def decode_binary_packet_parts(packet_bytes: bytes | bytearray) -> list[dict[str, Any]]:
    """Socket ``bytes`` → inner message dicts (1501 / 1502 / …)."""
    arr = bytearray(packet_bytes if isinstance(packet_bytes, (bytes, bytearray)) else bytes(packet_bytes))

    if len(arr) >= 2 and arr[0] in (2, 3, 4, 5, 6) and arr[1] in (0, 1):
        arr = arr[1:]
    if len(arr) >= 3 and arr[0] in (0x00, 0x04) and arr[1] in (2, 3, 4, 5, 6) and arr[2] in (0, 1):
        arr = arr[2:]

    msgs = _decode_outer_symphony_primary(arr)
    if not msgs:
        msgs = _decode_outer_legacy_fallback(arr)
    return msgs


def decode_xts_binary_packet(packet_bytes: bytes) -> Iterable[dict[str, Any]]:
    for msg in decode_binary_packet_parts(packet_bytes):
        row = _msg_to_dashboard_row(msg)
        if row:
            yield row


def parse_touchline_1501_payload(payload: bytes):
    parsed, _ = _decode_touchline_1501_payload(payload, 0)
    return parsed
