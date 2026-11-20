"""Optional, fail-closed realtime transport for the LicenX Python SDK.

The existing signed HTTPS login/heartbeat remain authoritative. WebSocket frames
do not grant privileges without a trusted signed snapshot and device-bound
server ticket. No ticket or license key is stored on disk.
"""
import json
import random
import re
import ssl
import threading
import time
from typing import Optional
from urllib.parse import urlsplit

from .storage import TRANSIENT_HEARTBEAT_CODES
from .diagnostics import tls_verify_code

_TICKET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{40,60}$")
_FRAME_LIMIT = 16384
_MAX_BACKOFF = 60.0
_SNAPSHOT_WAIT = 10.0


def _verified_wss_context():
    """Strict server TLS: keep OS roots and add the realtime extra's CA bundle."""
    context = ssl.create_default_context(purpose=ssl.Purpose.SERVER_AUTH)
    try:
        import certifi  # Only needed when the optional WSS transport is used.
        context.load_verify_locations(cafile=certifi.where())
    except (ImportError, OSError, ValueError, TypeError):
        # Never connect with reduced verification if bundled roots are missing.
        raise ssl.SSLError("REALTIME_CA_BUNDLE_UNAVAILABLE") from None
    return context


class _RealtimeSecurityError(Exception):
    """Internal constant-code denial; never expose remote exception text."""


class RealtimeLicenseWorker:
    """Background WSS transport: opt-in, bounded, interruptible, no UI thread I/O."""

    def __init__(self, communicator, storage, license_key, hwid, signed_login_data):
        self.communicator = communicator
        self.storage = storage
        self.license_key = license_key.strip().upper()
        self.hwid = hwid
        self.login_app_id = signed_login_data.get("app_id")
        self._stop_event = threading.Event()
        self._thread = None
        self._socket = None
        self._socket_lock = threading.Lock()
        self._identity = None
        self._version = -1
        # Created only from a signature- and nonce-verified HTTPS login result.
        self._signed_server_time_ms = None
        self._signed_server_clock_at = None
        self._accept_signed_server_time(signed_login_data.get("server_time"))
        candidate = getattr(communicator, "_diagnostic_token", None)
        self._diagnostic_token = (
            candidate if isinstance(candidate, str)
            and re.fullmatch(r"[A-Za-z0-9_-]{43}", candidate) else None
        )

    def _report(self, stage, code, attempt=0, error=None):
        """Never log exception text, URLs, device fingerprints or credentials."""
        verify = tls_verify_code(error) if error is not None else None
        try:
            if self._diagnostic_token and hasattr(self.communicator, "send_diagnostic"):
                self.communicator.send_diagnostic(
                    self._diagnostic_token, stage, code,
                    min(max(attempt, 0), 20), verify,
                )
            elif hasattr(self.communicator, "record_diagnostic"):
                self.communicator.record_diagnostic(
                    stage, code, min(max(attempt, 0), 20), verify,
                )
        except Exception:
            pass  # Never interrupt fail-closed license handling.

    def start(self):
        """Never blocks the caller; an unavailable optional dependency means HTTP-only."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, name="LicenX-Realtime", daemon=True
        )
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        with self._socket_lock:
            socket = self._socket
            self._socket = None
        if socket is not None:
            try:
                socket.close()
            except Exception:
                pass
        thread = self._thread
        self._thread = None
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=1.0)

    def _retry_wait(self, attempt):
        # Reconnect jitter prevents simultaneous bursts after a VPS restart.
        delay = min(_MAX_BACKOFF, max(1.0, 2.0 ** min(attempt, 6)))
        self._stop_event.wait(delay * random.uniform(0.75, 1.25))

    def _post_ticket(self):
        """Request one-time ticket only after an already verified HTTPS login."""
        try:
            url = self.communicator._build_url("api/v1/realtime/ticket")
            status, body = self.communicator._http_post(
                url,
                {"license_key": self.license_key, "hwid": self.hwid,
                 "app_name": self.communicator.config.app_name},
                min(10, max(1, self.communicator.config.request_timeout_seconds)),
            )
        except Exception:
            self._report("ticket", "REALTIME_TICKET_TRANSPORT_ERROR")
            return None, 503
        if status != 200 or not isinstance(body, dict):
            server_code = body.get("code") if isinstance(body, dict) else None
            safe_code = {
                "REALTIME_DISABLED": "REALTIME_TICKET_DISABLED",
                "RESTORE_IN_PROGRESS": "REALTIME_TICKET_UNAVAILABLE",
                "REALTIME_UNAVAILABLE": "REALTIME_TICKET_UNAVAILABLE",
                "REALTIME_BROWSER_ORIGIN_DENIED": "REALTIME_TICKET_FORBIDDEN",
            }.get(server_code, {
                403: "REALTIME_TICKET_FORBIDDEN",
                401: "REALTIME_TICKET_FORBIDDEN",
                404: "REALTIME_TICKET_DISABLED",
                429: "REALTIME_TICKET_RATE_LIMITED",
                503: "REALTIME_TICKET_UNAVAILABLE",
            }.get(status, "REALTIME_TICKET_HTTP_ERROR"))
            self._report("ticket", safe_code)
            return None, status
        ticket = body.get("ticket")
        if not isinstance(ticket, str) or not _TICKET_PATTERN.fullmatch(ticket):
            raise _RealtimeSecurityError("REALTIME_TICKET_INVALID")
        return ticket, 200

    def _socket_url(self):
        http_url = self.communicator._build_url("api/realtime")
        parts = urlsplit(http_url)
        if parts.scheme == "https":
            return "wss://" + parts.netloc + parts.path
        if parts.scheme == "http":  # Only localhost/loopback allowed by _build_url.
            return "ws://" + parts.netloc + parts.path
        raise _RealtimeSecurityError("REALTIME_TLS_REQUIRED")

    def _receive(self, socket):
        raw = socket.recv()
        if not isinstance(raw, str) or len(raw) > _FRAME_LIMIT:
            raise _RealtimeSecurityError("REALTIME_FRAME_INVALID")
        try:
            payload = json.loads(raw)
        except (ValueError, TypeError):
            raise _RealtimeSecurityError("REALTIME_FRAME_INVALID")
        if not isinstance(payload, dict) or not isinstance(payload.get("type"), str):
            raise _RealtimeSecurityError("REALTIME_FRAME_INVALID")
        return payload

    def _verify(self, packet):
        signature = packet.get("signature")
        if not isinstance(signature, str) or not signature or len(signature) > 2048:
            raise _RealtimeSecurityError("REALTIME_SIGNATURE_INVALID")
        body = {key: value for key, value in packet.items() if key != "signature"}
        if not self.communicator.verify_signature(body, signature):
            raise _RealtimeSecurityError("REALTIME_SIGNATURE_INVALID")
        return body

    def _accept_signed_server_time(self, server_time_ms):
        """Anchor an authenticated server timestamp to elapsed, monotonic time."""
        if type(server_time_ms) is not int or not 0 < server_time_ms <= 2**53 - 1:
            return False
        self._signed_server_time_ms = server_time_ms
        self._signed_server_clock_at = time.monotonic()
        return True

    def _server_now_ms(self):
        """No local wall clock or timezone is ever used for license freshness."""
        if self._signed_server_time_ms is None or self._signed_server_clock_at is None:
            raise _RealtimeSecurityError("REALTIME_TIME_UNVERIFIED")
        elapsed = time.monotonic() - self._signed_server_clock_at
        if elapsed < 0:
            raise _RealtimeSecurityError("REALTIME_TIME_UNVERIFIED")
        return self._signed_server_time_ms + int(elapsed * 1000)

    def _verify_snapshot(self, packet):
        data = self._verify(packet)
        trusted_now = self._server_now_ms()
        if (data.get("type") != "license.snapshot"
                or data.get("valid") is not True
                or type(data.get("version")) is not int
                or data["version"] < 0
                or type(data.get("server_time")) is not int
                or abs(data["server_time"] - trusted_now) > 300_000):
            raise _RealtimeSecurityError("REALTIME_SNAPSHOT_INVALID")
        identity = (data.get("app_id"), data.get("license_id"), data.get("device_id"))
        if (not all(isinstance(value, str) and value for value in identity)
                or identity[0] != self.login_app_id
                or (self._identity is not None and self._identity != identity)
                or (self._version >= 0 and data["version"] < self._version)):
            raise _RealtimeSecurityError("REALTIME_BINDING_MISMATCH")
        policy = data.get("keep_login_on_network_error", False)
        if type(policy) is not bool:
            raise _RealtimeSecurityError("REALTIME_POLICY_INVALID")
        # Bound snapshot signature is checked before policy can take effect.
        self.storage.apply_signed_realtime_policy(policy)
        self._identity = identity
        self._version = data["version"]
        return data

    def _verify_event(self, packet):
        data = self._verify(packet)
        trusted_now = self._server_now_ms()
        if (data.get("type") != "license.state_changed"
                or type(data.get("version")) is not int
                or data["version"] < 0
                or data.get("event_id") != str(data["version"])
                or type(data.get("issued_at")) is not int
                or type(data.get("expires_at")) is not int
                or data["expires_at"] <= trusted_now
                or data["expires_at"] <= data["issued_at"]
                or data["expires_at"] - data["issued_at"] > 60_000
                or data["issued_at"] > trusted_now + 300_000):
            raise _RealtimeSecurityError("REALTIME_EVENT_INVALID")
        app_id, license_id, device_id = self._identity
        if (data.get("device_id") not in (None, device_id)
                or data.get("license_id") not in (None, license_id)
                or data.get("app_id") not in (None, app_id)
                or not any(data.get(key) is not None
                           for key in ("app_id", "license_id", "device_id"))):
            raise _RealtimeSecurityError("REALTIME_EVENT_SCOPE_INVALID")
        if data["version"] <= self._version:
            return False  # Signed duplicate or older event; ignore.
        self._version = data["version"]
        return True

    def _signed_check(self):
        try:
            valid, data = self.communicator.ping_heartbeat(self.license_key, self.hwid)
        except Exception:
            valid, data = False, {"code": "SERVER_UNREACHABLE"}
        if self._stop_event.is_set():
            return False
        # A signed but structurally invalid server clock is not a usable proof.
        if valid and (not isinstance(data, dict)
                      or type(data.get("server_time")) is not int
                      or not 0 < data["server_time"] <= 2**53 - 1):
            valid, data = False, {"code": "REALTIME_TIME_UNVERIFIED"}
        applied = self.storage.realtime_signed_heartbeat(valid, data)
        if valid and applied:
            self._accept_signed_server_time(data["server_time"])
        return bool(valid and applied)

    def _run_connection(self, websocket):
        ticket, status = self._post_ticket()
        if self._stop_event.is_set():
            return
        if not ticket:
            # Any ticket failure is WSS availability information, NOT a
            # signed license denial. Verify over HTTPS and keep WSS retries.
            self.storage.pause_for_signed_reverification()
            if self._signed_check() and self.storage.enter_signed_http_fallback():
                return "HTTP_FALLBACK"
            return None
        socket_url = self._socket_url()
        tls_options = (
            {"sslopt": {
                "context": _verified_wss_context(),
                "cert_reqs": ssl.CERT_REQUIRED,
                "check_hostname": True,
            }} if socket_url.startswith("wss://") else {}
        )
        socket = websocket.create_connection(
            socket_url, timeout=8,
            header=["Authorization: Bearer " + ticket],
            suppress_origin=True, enable_multithread=True,
            **tls_options,
        )
        with self._socket_lock:
            if self._stop_event.is_set():
                socket.close()
                return
            self._socket = socket
        try:
            socket.settimeout(8)
            socket.send(json.dumps({"type": "license.hello"}, separators=(",", ":")))
            deadline = time.monotonic() + _SNAPSHOT_WAIT
            while not self._stop_event.is_set() and time.monotonic() < deadline:
                try:
                    packet = self._receive(socket)
                except websocket.WebSocketTimeoutException:
                    continue
                if packet.get("type") in ("connected", "welcome"):
                    # SocketCore emits unsigned transport "connected" before hello.
                    # Never treat it as signed authorization or a license grant.
                    continue
                if packet.get("type") == "error":
                    # WSS errors are unsigned transport/control hints, never
                    # independent proof that the license is revoked or active.
                    control = packet.get("code")
                    if control not in (
                        "REALTIME_RESTORE_IN_PROGRESS",
                        "REALTIME_AUTH_REVOKED",
                        "REALTIME_ALREADY_REGISTERED",
                    ):
                        # Pause BEFORE raising: direct calls must never leave
                        # protected operations authorized on an unknown frame.
                        self.storage.pause_for_signed_reverification()
                        raise _RealtimeSecurityError("REALTIME_UNEXPECTED_FRAME")
                    self.storage.pause_for_signed_reverification()
                    self._report("ws_upgrade", "REALTIME_SOCKET_ERROR")
                    if self._signed_check():
                        self.storage.enter_signed_http_fallback()
                    return "HTTP_FALLBACK"
                self._verify_snapshot(packet)
                # After grace expiry a signed WSS snapshot alone cannot
                # resume protected operations; nonce-bound HTTP proof required.
                if not self.storage.is_authorized() and not self._signed_check():
                    return
                if not self.storage.set_realtime_connected(True):
                    return
                break
            else:
                if not self._stop_event.is_set():
                    raise _RealtimeSecurityError("REALTIME_SNAPSHOT_MISSING")
            # websocket-client's recv() hides control frames, so it cannot
            # reveal a missing pong. Read control frames ONLY to check a fresh
            # unpredictable client ping; they never authorize a license.
            from secrets import token_bytes
            from types import SimpleNamespace
            liveness_ping_interval = 30.0
            liveness_pong_deadline = 12.0
            next_ping = time.monotonic() + liveness_ping_interval
            pending_ping = None
            sent_at = None
            while not self._stop_event.is_set():
                now = time.monotonic()
                if pending_ping is not None and (
                    now < sent_at or now - sent_at >= liveness_pong_deadline
                ):
                    self.storage.pause_for_signed_reverification()
                    raise _RealtimeSecurityError("REALTIME_LIVENESS_EXPIRED")
                if pending_ping is None and now >= next_ping:
                    pending_ping = token_bytes(16)
                    sent_at = now
                    socket.ping(pending_ping)
                    continue
                try:
                    opcode, raw = socket.recv_data(control_frame=True)
                except websocket.WebSocketTimeoutException:
                    continue
                if opcode == websocket.ABNF.OPCODE_PONG:
                    if pending_ping is not None and raw == pending_ping:
                        pending_ping = None
                        sent_at = None
                        next_ping = time.monotonic() + liveness_ping_interval
                    continue
                if opcode == websocket.ABNF.OPCODE_PING:
                    continue  # Automatic pong processing is transport-only.
                if opcode == websocket.ABNF.OPCODE_CLOSE:
                    # A clean socket close is a transport outage, not a
                    # terminal revocation. Bound grace immediately; the
                    # fallback HTTP worker wakes without blocking the UI.
                    if not self._stop_event.is_set():
                        self.storage.set_realtime_connected(False)
                    return
                if opcode != websocket.ABNF.OPCODE_TEXT:
                    raise _RealtimeSecurityError("REALTIME_FRAME_INVALID")
                if isinstance(raw, bytes):
                    try:
                        raw = raw.decode("utf-8", "strict")
                    except UnicodeError:
                        raise _RealtimeSecurityError("REALTIME_FRAME_INVALID")
                if not isinstance(raw, str):
                    raise _RealtimeSecurityError("REALTIME_FRAME_INVALID")
                packet = self._receive(SimpleNamespace(recv=lambda: raw))
                if packet.get("type") != "license.state_changed":
                    self.storage.pause_for_signed_reverification()
                    raise _RealtimeSecurityError("REALTIME_UNEXPECTED_FRAME")
                if self._verify_event(packet):
                    # Events are notifications, never an offline authorization.
                    if not self._signed_check():
                        return
                    if packet.get("event_type") == "app.changed":
                        # Reconnect for a fresh signed App policy snapshot.
                        return
        finally:
            with self._socket_lock:
                if self._socket is socket:
                    self._socket = None
            try:
                socket.close()
            except Exception:
                pass

    def _run(self):
        try:
            import websocket  # optional: pip install 'licenx[realtime]'
        except ImportError:
            # No optional websocket-client dependency: preserve the signed
            # HTTP path, but never display a healthy fallback while paused.
            state = ("HTTP_FALLBACK" if self.storage.is_authorized()
                     else "PAUSED_UNVERIFIED")
            self.storage._set_realtime_state(state)
            return  # Signed HTTP worker remains active; no unsafe fallback.
        attempt = 0
        while not self._stop_event.is_set():
            try:
                started = time.monotonic()
                outcome = self._run_connection(websocket)
                # HTTP fallback and WSS retry remain concurrent: returning here
                # would permanently disable automatic realtime recovery.
                # Repeated short connections must back off.
                attempt = 0 if time.monotonic() - started >= 60.0 else min(attempt + 1, 6)
            except _RealtimeSecurityError as error:
                if not self._stop_event.is_set():
                    # Transport liveness/snapshot timeout is not a forged
                    # signature. Other invalid signed frames remain security errors.
                    self.storage.pause_for_signed_reverification()
                    if str(error) in (
                        "REALTIME_LIVENESS_EXPIRED", "REALTIME_SNAPSHOT_MISSING",
                    ):
                        self._report("ws_upgrade", "REALTIME_SOCKET_ERROR", attempt)
                    else:
                        self._report("snapshot", "REALTIME_SECURITY_ERROR", attempt)
                    if self._signed_check():
                        self.storage.enter_signed_http_fallback()
            except (ssl.SSLError, ssl.CertificateError) as error:
                if not self._stop_event.is_set():
                    # Immediately pause protected app operations before any
                    # diagnostic network I/O or HTTPS re-verification.
                    self.storage.pause_for_signed_reverification()
                    self._report("tls_handshake", "REALTIME_TLS_ERROR", attempt, error)
                    # WSS TLS failure is NOT a license revocation. Only a fresh,
                    # correctly signed HTTPS heartbeat may permit HTTP-only
                    # continuity; HTTPS TLS/signature failure remains fail-closed.
                    if self._signed_check():
                        self.storage.enter_signed_http_fallback()
                    # If HTTPS is also unavailable, remain paused and retry.
                    # TLS checks remain fully enabled for both transports.
            except Exception:
                # WSS transport failure is not proof of a revoked license.
                if not self._stop_event.is_set():
                    self.storage.set_realtime_connected(False)
                    self._report("ws_upgrade", "REALTIME_SOCKET_ERROR", attempt)
                    if self._signed_check():
                        self.storage.enter_signed_http_fallback()
            if self._stop_event.is_set() or not self.storage._running:
                break
            self.storage.set_realtime_connected(False)
            self._retry_wait(attempt)
            attempt = min(attempt + 1, 6)
