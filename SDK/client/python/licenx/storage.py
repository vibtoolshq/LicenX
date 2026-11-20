"""
VCON Python Client SDK - Session Persistence & Background Daemon Engine
Rejects insecure temp-file sessions and runs a lightweight background daemon
thread to monitor periodic server validation (every 20 mins).
"""

import os
import tempfile
import threading
import time
from typing import Optional, Dict, Any, Callable
from .config import (
    MAX_OFFLINE_GRACE_SECONDS,
    MAX_PING_INTERVAL_SECONDS,
    MIN_PING_INTERVAL_SECONDS,
)


TRANSIENT_HEARTBEAT_CODES = {
    "SERVER_UNREACHABLE",
    "TIMEOUT",
    "REQUEST_ERROR",
    "UNKNOWN_ERROR",
    "SERVICE_UNAVAILABLE",
}

# Retry only while a verified transient outage is within offline grace.
HEARTBEAT_RETRY_INTERVAL_SECONDS = 30


class BackgroundLicenseWorker:
    def __init__(
        self,
        app_name: str,
        ping_interval_seconds: int = 1200,  # 20 minutes default
        offline_grace_seconds: int = 0,
        on_invalidated: Optional[Callable[[str], None]] = None,
        on_heartbeat_success: Optional[Callable[[Dict[str, Any]], None]] = None,
    ):
        if (
            type(ping_interval_seconds) is not int
            or not MIN_PING_INTERVAL_SECONDS <= ping_interval_seconds <= MAX_PING_INTERVAL_SECONDS
        ):
            raise ValueError(
                "ping_interval_seconds must be an integer between 60 and 1200 seconds"
            )
        if (
            type(offline_grace_seconds) is not int
            or not 0 <= offline_grace_seconds <= MAX_OFFLINE_GRACE_SECONDS
        ):
            raise ValueError(
                "offline_grace_seconds must be an integer between 0 and 3600 seconds"
            )

        self.app_name = app_name
        self.ping_interval_seconds = ping_interval_seconds
        self.offline_grace_seconds = offline_grace_seconds
        self.on_invalidated = on_invalidated
        self.on_heartbeat_success = on_heartbeat_success

        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._server_communicator = None
        self._current_license_key: Optional[str] = None
        self._current_hwid: Optional[str] = None
        self._state_lock = threading.Lock()
        self._offline_since: Optional[float] = None
        # WS-03 opt-in state only; the original heartbeat loop is unchanged by default.
        self._realtime_enabled = False
        self._realtime_connected = False
        self._realtime_paused = False
        # Default is the original strict invalidation. Only a trusted signed
        # per-App snapshot may enable keeping a UI-only session on an outage.
        self._keep_login_on_network_error = False
        self._realtime_state = "HTTP_ONLY"
        self._realtime_wake = threading.Event()
        self._on_realtime_state: Optional[Callable[[str], None]] = None
        self._session_file = os.path.join(
            tempfile.gettempdir(), f".vcon_session_{self.app_name}.dat"
        )

    # -------------------------------------------------------------
    # Session Persistence (Temp directory)
    # -------------------------------------------------------------

    def save_session(self, license_key: str, license_data: Dict[str, Any]) -> None:
        """Never persist license keys in reversible temporary files."""
        self.clear_session()

    def load_saved_session(self) -> Optional[str]:
        """Reject and remove legacy insecure saved sessions."""
        self.clear_session()
        return None

    def clear_session(self) -> None:
        """Deletes session file from temp storage"""
        try:
            if os.path.exists(self._session_file):
                os.remove(self._session_file)
        except Exception:
            pass

    # -------------------------------------------------------------
    # Background Daemon Heartbeat Thread (20-min cycle)
    # -------------------------------------------------------------

    def start_monitoring(
        self,
        server_communicator,
        license_key: str,
        hwid: str,
    ) -> None:
        """Starts background verification thread"""
        self.stop_monitoring()
        self._server_communicator = server_communicator
        self._current_license_key = license_key
        self._current_hwid = hwid
        self.record_heartbeat_success()
        if self._realtime_enabled:
            self._realtime_paused = False
            self._realtime_connected = False
            self._keep_login_on_network_error = False
            self._realtime_wake.clear()
            self._set_realtime_state("CONNECTING")
        self._stop_event.clear()
        self._running = True

        self._thread = threading.Thread(
            target=self._worker_loop,
            name=f"VCON-Worker-{self.app_name}",
            daemon=True,  # Daemon thread won't block main app exit
        )
        self._thread.start()

    def stop_monitoring(self) -> None:
        """Stops background thread safely"""
        self._running = False
        self._stop_event.set()
        self._realtime_wake.set()
        worker_thread = self._thread
        self._thread = None
        if (
            worker_thread
            and worker_thread.is_alive()
            and worker_thread is not threading.current_thread()
        ):
            worker_thread.join(timeout=1.0)

    def _worker_loop(self) -> None:
        """Periodic background heartbeat runner (RAM & CPU friendly)"""
        if self._realtime_enabled:
            self._realtime_worker_loop()
            return
        while self._running and not self._stop_event.is_set():
            remaining_grace = self._remaining_grace_seconds()
            wait_seconds = (
                self.ping_interval_seconds
                if remaining_grace is None
                else (min(HEARTBEAT_RETRY_INTERVAL_SECONDS, remaining_grace)
                      if remaining_grace > 0 else HEARTBEAT_RETRY_INTERVAL_SECONDS)
            )

            interrupted = self._stop_event.wait(timeout=wait_seconds)
            if interrupted or not self._running:
                break

            # Grace expiry pauses authorization; it is never a signed logout.
            # Keep the worker alive for bounded signed re-verification.
            if not self._server_communicator or not self._current_license_key or not self._current_hwid:
                break

            try:
                is_valid, data = self._server_communicator.ping_heartbeat(
                    self._current_license_key,
                    self._current_hwid,
                )
            except Exception:
                is_valid = False
                data = {
                    "message": "Heartbeat could not be verified; access is denied",
                    "code": "SERVER_UNREACHABLE",
                }

            if (not self._running or self._stop_event.is_set()
                    or (self._thread is not None
                        and self._thread is not threading.current_thread())):
                # A completed request from a prior monitor may not alter a
                # replacement session, even when it uses the same license key.
                break
            if is_valid:
                self.record_heartbeat_success()
                with self._state_lock:
                    self._realtime_paused = False
                if self.on_heartbeat_success:
                    try:
                        self.on_heartbeat_success(data)
                    except Exception:
                        print("[VCON-SDK] Heartbeat success callback failed")
                continue

            if not isinstance(data, dict):
                data = {"code": "INVALID_RESPONSE"}
            if self.should_invalidate_for_heartbeat_failure(data):
                self._invalidate(data.get("code", "LICENSE_INVALID"))
                break

    def enable_realtime(self, on_state_change: Optional[Callable[[str], None]] = None) -> None:
        """Called only for an opted-in SDK instance, before the first login."""
        self._realtime_enabled = True
        self._on_realtime_state = on_state_change
        self._set_realtime_state("HTTP_FALLBACK")

    def apply_signed_realtime_policy(self, keep_login: bool) -> None:
        """Trust only the verified signed and bound server snapshot caller."""
        if type(keep_login) is not bool:
            raise ValueError("Signed network policy must be Boolean")
        with self._state_lock:
            self._keep_login_on_network_error = keep_login

    def _set_realtime_state(self, state: str) -> None:
        if self._realtime_state == state:
            return
        self._realtime_state = state
        if self._on_realtime_state:
            try:
                self._on_realtime_state(state)
            except Exception:
                pass  # A host UI callback cannot break licensing.

    def get_realtime_state(self) -> str:
        return self._realtime_state

    def is_authorized(self) -> bool:
        """Check the monotonic offline deadline on *every* licensed operation."""
        expired = False
        with self._state_lock:
            if self._realtime_paused:
                return False
            if self._realtime_enabled and self._offline_since is not None:
                elapsed = time.monotonic() - self._offline_since
                if (elapsed < 0 or self.offline_grace_seconds == 0
                        or elapsed >= self.offline_grace_seconds):
                    self._realtime_paused = True
                    self._realtime_connected = False
                    expired = True
        if expired:
            self._set_realtime_state("PAUSED_UNVERIFIED")
            self._realtime_wake.set()
        return not expired

    def pause_for_signed_reverification(self) -> bool:
        """Deny protected actions while a WSS failure awaits fresh signed HTTP.

        Do not assume that a disconnected or rejected WebSocket grants any
        license permission; the following HTTPS proof must recover the session.
        """
        if not self._realtime_enabled or not self._running:
            return False
        with self._state_lock:
            self._realtime_paused = True
            self._realtime_connected = False
        self._set_realtime_state("PAUSED_UNVERIFIED")
        return True

    def enter_signed_http_fallback(self) -> bool:
        """Enter HTTP-only only after an already verified signed HTTPS heartbeat.

        Force old WSS connection status offline and wake signed HTTP monitoring.
        A socket event can never invoke this as an authorization grant.
        """
        if not self._realtime_enabled or not self._running:
            return False
        with self._state_lock:
            if self._realtime_paused:
                return False
            self._realtime_connected = False
            self._keep_login_on_network_error = False
        self._set_realtime_state("HTTP_FALLBACK")
        self._realtime_wake.set()
        return True

    def set_realtime_connected(self, connected: bool) -> bool:
        """Call TRUE only after a *signed, bound* snapshot; never from socket open."""
        if not self._realtime_enabled or not self._running:
            return False
        if connected:
            # A WSS snapshot cannot reset an already expired offline grace.
            # The realtime caller must first get a fresh signed HTTPS proof.
            if not self.is_authorized():
                self._realtime_wake.set()
                return False
            with self._state_lock:
                elapsed = (None if self._offline_since is None
                           else time.monotonic() - self._offline_since)
                expired = (self._realtime_paused or
                           (elapsed is not None and
                            (elapsed < 0 or elapsed >= self.offline_grace_seconds)))
                if expired:
                    self._realtime_paused = True
                    self._realtime_connected = False
                else:
                    self._realtime_connected = True
                    self._offline_since = None
            if expired:
                self._set_realtime_state("PAUSED_UNVERIFIED")
                self._realtime_wake.set()
                return False
            self._set_realtime_state("CONNECTED")
            self._realtime_wake.set()
            return True
        with self._state_lock:
            was_connected = self._realtime_connected
            prior_state = self._realtime_state
            self._realtime_connected = False
            # A normal socket CLOSE has no signed terminal authority, but it
            # must begin the bounded offline deadline just like a failed HTTP
            # heartbeat. A fresh verified HTTP fallback is a distinct state.
            if (was_connected or prior_state in ("CONNECTING", "RECONNECTING")) and self._offline_since is None:
                self._offline_since = time.monotonic()
            offline = self._offline_since is not None
            if offline:
                elapsed = time.monotonic() - self._offline_since
                if (elapsed < 0 or self.offline_grace_seconds == 0
                        or elapsed >= self.offline_grace_seconds):
                    self._realtime_paused = True
            paused = self._realtime_paused
            verified_fallback = (prior_state == "HTTP_FALLBACK"
                                 and not offline and not paused)
        state = ("PAUSED_UNVERIFIED" if paused else
                 "OFFLINE_GRACE" if offline else
                 "HTTP_FALLBACK" if verified_fallback else "RECONNECTING")
        self._set_realtime_state(state)
        self._realtime_wake.set()
        return True

    def realtime_signed_heartbeat(self, valid: bool, data: Dict[str, Any]) -> bool:
        """Handle authoritative HTTPS heartbeat result; never trust unsigned WS messages."""
        if not self._realtime_enabled or not self._running:
            return False
        if valid:
            with self._state_lock:
                self._offline_since = None
                self._realtime_paused = False
                connected = self._realtime_connected
            self._set_realtime_state("CONNECTED" if connected else "HTTP_FALLBACK")
            if self.on_heartbeat_success:
                try:
                    self.on_heartbeat_success(data)
                except Exception:
                    pass
            return True
        code = data.get("code") if isinstance(data, dict) else None
        if isinstance(data, dict) and data.get("_licenx_terminal_denial") is True:
            # Only a server-attributed HTTPS terminal denial ends the UI login.
            self._invalidate(code if isinstance(code, str) else "LICENSE_INVALID")
            return False
        with self._state_lock:
            now = time.monotonic()
            if self._offline_since is None:
                self._offline_since = now
            elapsed = now - self._offline_since
            expired = (elapsed < 0 or self.offline_grace_seconds == 0
                       or elapsed >= self.offline_grace_seconds)
            # Unverified TLS/signature/protocol data never extends authorization.
            # A transient outage may use only the existing bounded grace.
            if expired or code not in TRANSIENT_HEARTBEAT_CODES:
                self._realtime_paused = True
            paused = self._realtime_paused
            self._realtime_connected = False
        # Keep the in-memory UI session, retry HTTPS and WSS in the background.
        # Signed per-App policy parsing remains strict; transport failure no
        # longer forces UI logout. Protected-operation grace stays bounded.
        self._set_realtime_state("PAUSED_UNVERIFIED" if paused else "OFFLINE_GRACE")
        return False

    def _realtime_worker_loop(self) -> None:
        """Signed HTTP fallback after a WS disconnect. Never blocks the caller/UI."""
        first = True
        while self._running and not self._stop_event.is_set():
            interval = 2.0 if first else HEARTBEAT_RETRY_INTERVAL_SECONDS
            first = False
            self._realtime_wake.wait(timeout=interval)
            self._realtime_wake.clear()
            if (not self._running or self._stop_event.is_set()
                    or (self._thread is not None
                        and self._thread is not threading.current_thread())):
                break
            with self._state_lock:
                connected = self._realtime_connected
            if connected:
                continue
            if not self._server_communicator or not self._current_license_key or not self._current_hwid:
                break
            try:
                valid, data = self._server_communicator.ping_heartbeat(
                    self._current_license_key, self._current_hwid
                )
            except Exception:
                valid, data = False, {"code": "SERVER_UNREACHABLE"}
            if (not self._running or self._stop_event.is_set()
                    or (self._thread is not None
                        and self._thread is not threading.current_thread())):
                # A delayed HTTPS result from a replaced monitor must never
                # grant or revoke permissions for a new login/session.
                break
            self.realtime_signed_heartbeat(valid, data)

    def should_invalidate_for_heartbeat_failure(self, data: Dict[str, Any]) -> bool:
        """Only a nonce-bound, signature-verified terminal denial ends login."""
        if isinstance(data, dict) and data.get("_licenx_terminal_denial") is True:
            return True

        code = data.get("code") if isinstance(data, dict) else None
        now = time.monotonic()
        with self._state_lock:
            if self._offline_since is None:
                self._offline_since = now
            elapsed = now - self._offline_since
            if (code not in TRANSIENT_HEARTBEAT_CODES
                    or elapsed < 0 or self.offline_grace_seconds == 0
                    or elapsed >= self.offline_grace_seconds):
                self._realtime_paused = True
        return False

    def record_heartbeat_success(self) -> None:
        with self._state_lock:
            self._offline_since = None

    def _remaining_grace_seconds(self) -> Optional[float]:
        with self._state_lock:
            if self._offline_since is None:
                return None
            elapsed = time.monotonic() - self._offline_since
            # A monotonic anomaly must never extend licensed-operation grace.
            if elapsed < 0:
                return 0.0
            return max(0.0, self.offline_grace_seconds - elapsed)

    def _grace_expired(self) -> bool:
        remaining = self._remaining_grace_seconds()
        return remaining is not None and remaining <= 0

    def _invalidate(self, reason: str) -> None:
        self.clear_session()
        self._running = False
        self._stop_event.set()
        self._realtime_wake.set()
        if self._realtime_enabled:
            with self._state_lock:
                self._realtime_paused = True
                self._realtime_connected = False
            self._set_realtime_state("INVALIDATED")
        self.record_heartbeat_success()
        if self.on_invalidated:
            self.on_invalidated(reason)


# Alias for backward-compatibility and clean imports
LicenseStorage = BackgroundLicenseWorker
