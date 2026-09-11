import json
import time
from dataclasses import dataclass
from typing import Any

import requests


def _generic_broker_text(msg: str) -> bool:
    s = (msg or "").lower().strip()
    if not s:
        return True
    if "code=" in s:
        return False
    return s in (
        "bad request",
        "description=bad request",
        "message=bad request",
        "error=bad request",
    )


def _xts_error_body(data: dict[str, Any] | None) -> dict[str, Any] | None:
    """Investeria sometimes wraps {err: true, data: {type, code, description}}."""
    if not isinstance(data, dict):
        return None
    inner = data.get("data")
    if isinstance(inner, dict) and (
        inner.get("type") or inner.get("code") or inner.get("description") or inner.get("message")
    ):
        return inner
    return data


def _xts_unmapped_client_error(err: BaseException) -> bool:
    s = str(err).lower()
    return (
        "not mapped under dealer" in s
        or "e-portfolio-00005" in s
        or "supplied client" in s
    )


def _xts_empty_data_error(err: BaseException) -> bool:
    """XTS returns type=error instead of [] when the book/portfolio has no rows."""
    if _xts_unmapped_client_error(err):
        return False
    s = str(err).lower()
    return (
        "e-portfolio-0005" in s
        or "data not available" in s
        or "no data available" in s
        or "no records" in s
        or "no position" in s
    )


def _xts_payload_is_error(data: dict[str, Any] | None) -> bool:
    if not isinstance(data, dict):
        return False
    if data.get("err") is True:
        return True
    body = _xts_error_body(data) or data
    return str(body.get("type") or "").lower() == "error"


def _xts_error_message(data: dict[str, Any] | None, r: requests.Response | None = None) -> str:
    """
    XTS returns JSON like { "type":"error", "code":"...", "description":"..." }.
    Plain HTTP 400 often has empty/minimal JSON — include status + raw body so debugging isn't just 'Bad Request'.
    """
    data = _xts_error_body(data) or data
    parts: list[str] = []
    if isinstance(data, dict):
        code = data.get("code")
        if code is not None and str(code).strip():
            parts.append(f"code={code}")
        for key in ("description", "message", "error", "detail", "ErrorMessage"):
            v = data.get(key)
            if v is not None and str(v).strip():
                parts.append(f"{key}={v}")
        fault = data.get("fault")
        if isinstance(fault, dict):
            fs = fault.get("faultstring") or fault.get("message")
            if fs:
                parts.append(f"fault={fs}")
        if not parts:
            dumped = json.dumps(data, default=str)
            if dumped and dumped != "{}":
                parts.append(dumped[:3500])

    raw = ""
    if r is not None:
        try:
            raw = (r.text or "").strip()
        except Exception:
            raw = ""

    msg = " | ".join(parts) if parts else ""

    http_line = ""
    if r is not None:
        try:
            http_line = f"HTTP {r.status_code} {r.reason or ''}".strip()
        except Exception:
            http_line = f"HTTP {r.status_code}"

    if msg and not _generic_broker_text(msg):
        if raw and raw not in msg:
            return f"{msg} | body={raw[:2500]}"
        return msg

    if raw:
        return f"{http_line} | {raw[:3500]}" if http_line else raw[:3500]
    return http_line or msg or "Unknown error"


XTS_SOURCE = "WEBAPI"
XTS_ROOT = "https://trading.investeria.in"


@dataclass
class XtsSession:
    token: str
    user_id: str
    is_investor_client: bool
    is_pro_client: bool
    created_at: float


class XtsInteractiveClient:
    def __init__(self, api_key: str, api_secret: str, timeout_s: float = 8.0):
        self.api_key = api_key
        self.api_secret = api_secret
        self.timeout_s = timeout_s
        self.session = requests.Session()
        self._xts: XtsSession | None = None

    @property
    def is_investor_client(self) -> bool:
        """True = retail login; XTS often omits clientID on orders. False = dealer must send clientID."""
        return bool(self._xts and self._xts.is_investor_client)

    @property
    def is_pro_client(self) -> bool:
        """Pro / proprietary login — gateway rejects 'CLI' style orders with clientID."""
        if not self._xts:
            return False
        return bool(getattr(self._xts, "is_pro_client", False))

    def _headers(self) -> dict[str, str]:
        h: dict[str, str] = {"Content-Type": "application/json"}
        if self._xts and self._xts.token:
            h["Authorization"] = self._xts.token
        return h

    def login(self) -> XtsSession:
        url = f"{XTS_ROOT}/interactive/user/session"
        payload = {"appKey": self.api_key, "secretKey": self.api_secret, "source": XTS_SOURCE}
        r = self.session.post(url, json=payload, timeout=self.timeout_s)
        r.raise_for_status()
        data = r.json()
        if data.get("type") != "success":
            raise RuntimeError(data.get("description") or "XTS interactive_login failed")
        res = data.get("result") or {}
        is_pro = bool(
            res.get("isProClient")
            or res.get("IsProClient")
            or str(res.get("userType") or res.get("UserType") or "").upper() in ("PRO", "PROCLIENT", "PROPRIETARY")
        )
        uid = str(res.get("userID") or "")
        if not is_pro and uid.upper().endswith("PRO") and len(uid) >= 6:
            is_pro = True
        xts = XtsSession(
            token=str(res.get("token") or ""),
            user_id=uid,
            is_investor_client=bool(res.get("isInvestorClient")),
            is_pro_client=is_pro,
            created_at=time.time(),
        )
        if not xts.token:
            raise RuntimeError("XTS login missing token")
        self._xts = xts
        return xts

    def get_balance(self, client_id: str | None = None) -> dict[str, Any]:
        url = f"{XTS_ROOT}/interactive/user/balance"
        params = {}
        if client_id:
            params["clientID"] = client_id
        r = self.session.get(url, params=params, headers=self._headers(), timeout=self.timeout_s)
        r.raise_for_status()
        return r.json()

    def get_profile(self, client_id: str | None = None) -> dict[str, Any]:
        url = f"{XTS_ROOT}/interactive/user/profile"
        params = {}
        if client_id:
            params["clientID"] = client_id
        r = self.session.get(url, params=params, headers=self._headers(), timeout=self.timeout_s)
        r.raise_for_status()
        return r.json()

    def _get(self, path: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if not self._xts or not str(getattr(self._xts, "token", "") or "").strip():
            raise RuntimeError("XTS interactive session has no token — login required")
        url = f"{XTS_ROOT}{path}"
        r = self.session.get(url, params=(params or {}), headers=self._headers(), timeout=self.timeout_s)
        try:
            data = r.json()
        except Exception:
            data = None

        if not r.ok or _xts_payload_is_error(data if isinstance(data, dict) else None):
            raise RuntimeError(_xts_error_message(data if isinstance(data, dict) else None, r))

        return data if isinstance(data, dict) else {"result": data}

    def _post(self, path: str, *, payload: dict[str, Any]) -> dict[str, Any]:
        if not self._xts or not str(getattr(self._xts, "token", "") or "").strip():
            raise RuntimeError("XTS interactive session has no token — login required")
        url = f"{XTS_ROOT}{path}"
        r = self.session.post(url, json=(payload or {}), headers=self._headers(), timeout=self.timeout_s)
        try:
            data = r.json()
        except Exception:
            data = None

        if not r.ok or _xts_payload_is_error(data if isinstance(data, dict) else None):
            raise RuntimeError(_xts_error_message(data if isinstance(data, dict) else None, r))

        return data if isinstance(data, dict) else {"result": data}

    def get_order_book(self, client_id: str | None = None) -> dict[str, Any]:
        """
        OrderBook
        Route (SDK): GET /interactive/orders
        """
        params: dict[str, Any] = {}
        if client_id:
            params["clientID"] = client_id
        try:
            return self._get("/interactive/orders", params=params)
        except Exception as e:
            if _xts_empty_data_error(e):
                return {"type": "success", "result": []}
            raise

    def get_trade_book(self, client_id: str | None = None) -> dict[str, Any]:
        """
        TradeBook
        Route (SDK): GET /interactive/orders/trades
        """
        params: dict[str, Any] = {}
        if client_id:
            params["clientID"] = client_id
        try:
            return self._get("/interactive/orders/trades", params=params)
        except Exception as e:
            if _xts_empty_data_error(e):
                return {"type": "success", "result": []}
            raise

    def get_positions(self, *, day_or_net: str = "NetWise", client_id: str | None = None) -> dict[str, Any]:
        """
        Positions
        Route (SDK): GET /interactive/portfolio/positions
        Query param (commonly): dayOrNet = DayWise / NetWise
        """
        params: dict[str, Any] = {"dayOrNet": str(day_or_net or "NetWise")}
        if client_id:
            params["clientID"] = client_id
        try:
            return self._get("/interactive/portfolio/positions", params=params)
        except Exception as e:
            if _xts_empty_data_error(e):
                return {"type": "success", "result": {"positionList": []}}
            raise

    def place_order(self, *, client_id: str | None = None, order: dict[str, Any]) -> dict[str, Any]:
        """
        Place Order
        Route (SDK): POST /interactive/orders
        """
        payload = dict(order or {})
        for k in list(payload.keys()):
            if k.lower() in ("clientid", "client_id"):
                del payload[k]
        if client_id:
            payload["clientID"] = client_id
        return self._post("/interactive/orders", payload=payload)

