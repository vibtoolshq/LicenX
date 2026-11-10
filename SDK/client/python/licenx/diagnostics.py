"""LX-S01: process-local, bounded, allowlisted SDK diagnostics.

No license keys, URLs, tokens, HWIDs, raw exception strings or disk writes.
These observations NEVER authorize a session and are not durable audit records.
"""
from collections import deque
import ssl
import threading
import time
import uuid

_CODES = frozenset((
    "REALTIME_TLS_ERROR", "REALTIME_SOCKET_ERROR", "REALTIME_SECURITY_ERROR",
    "REALTIME_TICKET_ERROR", "REALTIME_TICKET_HTTP_ERROR", "REALTIME_TICKET_DISABLED", "REALTIME_TICKET_FORBIDDEN", "REALTIME_TICKET_UNAVAILABLE", "REALTIME_TICKET_RATE_LIMITED", "REALTIME_TICKET_TRANSPORT_ERROR",
    "SDK_HTTP_TLS_ERROR", "SDK_HTTP_NETWORK_ERROR", "SDK_HTTP_TIMEOUT",
    "SDK_HTTP_UNEXPECTED",
))
_STAGES = frozenset(("validate", "ticket", "tls_handshake", "ws_upgrade", "snapshot", "heartbeat"))
_MAX = 64


def tls_verify_code(error):
    """Numeric OpenSSL verification code only; never the message or certificate."""
    code = getattr(error, "verify_code", None)
    return code if type(code) is int and 0 <= code <= 1024 else None


class SafeDiagnosticBuffer:
    def __init__(self):
        self._items = deque(maxlen=_MAX)
        self._lock = threading.Lock()

    def record(self, stage, code, attempt=0, verify_code=None):
        if stage not in _STAGES or code not in _CODES:
            return None
        if type(attempt) is not int or not 0 <= attempt <= 20:
            return None
        if verify_code is not None and (
            stage != "tls_handshake"
            or code not in ("REALTIME_TLS_ERROR", "SDK_HTTP_TLS_ERROR")
            or type(verify_code) is not int or not 0 <= verify_code <= 1024
        ):
            return None
        entry = {
            "event_id": str(uuid.uuid4()),
            "observed_at_ms": int(time.time() * 1000),
            "stage": stage, "code": code, "attempt": attempt,
        }
        if verify_code is not None:
            entry["tls_verify_code"] = verify_code
        with self._lock:
            self._items.append(entry)
        return dict(entry)

    def snapshot(self):
        with self._lock:
            return [dict(item) for item in self._items]
