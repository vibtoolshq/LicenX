"""
VCON Python Client SDK - Main Client Interface (XLicenseClient)
Unified high-level facade providing intuitive methods for authentication, auto-login,
device HWID tracking, background heartbeat threading, and graceful device slot releasing.
"""

from typing import Optional, Dict, Any, Callable, Union
from .config import SDKConfig
from .device import DeviceManager
from .server import ServerCommunicator
from .storage import BackgroundLicenseWorker
from .login import LoginManager, LoginResult
from .logout import LogoutManager
from .realtime import RealtimeLicenseWorker


class XLicenseClient:
    """
    Main SDK Client class to embed in any Python application.

    Usage:
        from licenx import XLicenseClient

        client = XLicenseClient(app_version="1.0.0")

        # 1. Try Auto Login first
        res = client.auto_login()
        if not res.success:
            # 2. Ask user for key
            key = input("Enter License Key: ")
            res = client.login(key)

        if res.success:
            print(f"Unlocked! Tier: {client.get_tier()}")
        else:
            print(f"Access Denied: {res.message}")
    """

    def __init__(
        self,
        config_path: Optional[Union[str, SDKConfig]] = None,
        config: Optional[SDKConfig] = None,
        app_name: Optional[str] = None,
        server_url: Optional[str] = None,
        public_key_pem: Optional[str] = None,
        auto_logout_on_exit: Optional[bool] = None,
        auto_save_session: Optional[bool] = None,
        enable_background_heartbeat: Optional[bool] = None,
        ping_interval_seconds: Optional[int] = None,
        offline_grace_seconds: Optional[int] = None,
        on_license_revoked: Optional[Callable[[str], None]] = None,
        app_version: Optional[str] = None,
        useWebSocket: Optional[bool] = None,
        on_connection_state_change: Optional[Callable[[str], None]] = None,
    ):
        if isinstance(config_path, SDKConfig):
            self.config = config_path
        elif config:
            self.config = config
        elif app_name or server_url:
            self.config = SDKConfig(
                app_name=app_name or "vcon_default",
                server_url=server_url or "http://localhost:3000",
                public_key_pem=public_key_pem or "",
                app_version=app_version,
                auto_logout_on_exit=True if auto_logout_on_exit is None else auto_logout_on_exit,
                auto_save_session=True if auto_save_session is None else auto_save_session,
                enable_background_heartbeat=True if enable_background_heartbeat is None else enable_background_heartbeat,
                ping_interval_seconds=(
                    1200 if ping_interval_seconds is None else ping_interval_seconds
                ),
                offline_grace_seconds=(
                    0 if offline_grace_seconds is None else offline_grace_seconds
                ),
                useWebSocket=False if useWebSocket is None else useWebSocket,
            )
        else:
            self.config = SDKConfig.from_config_path(config_path)

        if app_version is not None:
            self.config.app_version = app_version
        if useWebSocket is not None:
            if type(useWebSocket) is not bool:
                raise ValueError("useWebSocket must be a boolean")
            self.config.useWebSocket = useWebSocket

        self.communicator = ServerCommunicator(self.config)
        self.server = self.communicator
        self.on_license_revoked = on_license_revoked

        # Background storage & heartbeat daemon worker
        self.storage = BackgroundLicenseWorker(
            app_name=self.config.app_name,
            ping_interval_seconds=self.config.ping_interval_seconds,
            offline_grace_seconds=self.config.offline_grace_seconds,
            on_invalidated=self._handle_license_revoked,
            on_heartbeat_success=self._handle_heartbeat_success,
        )

        # Realtime status is opt-in; never changes the legacy background loop.
        if self.config.useWebSocket:
            self.storage.enable_realtime(on_connection_state_change)
        self._realtime: Optional[RealtimeLicenseWorker] = None

        # Login manager
        self.login_manager = LoginManager(
            config=self.config,
            communicator=self.communicator,
            storage=self.storage,
        )

        # Logout manager
        self.logout_manager = LogoutManager(
            communicator=self.communicator,
            storage=self.storage,
            auto_logout_on_exit=self.config.auto_logout_on_exit,
        )

        self._authenticated = False
        self._current_key: Optional[str] = None
        self._license_payload: Optional[Dict[str, Any]] = None
        if self.config.useWebSocket:
            self.logout_manager.set_realtime_stop_callback(self._stop_realtime)

    def _stop_realtime(self) -> None:
        worker = getattr(self, "_realtime", None)
        self._realtime = None
        if worker:
            worker.stop()

    def _start_realtime(self, result: LoginResult) -> None:
        # Legacy callers and minimal fixture clients have no realtime config.
        if not getattr(getattr(self, "config", None), "useWebSocket", False):
            return
        self._stop_realtime()
        # Global/no-App licenses cannot be ticketed by the WS-02 gateway;
        # their normal signed HTTP verification remains fully supported.
        if not result.license_data or not result.license_data.get("app_id"):
            self.storage._set_realtime_state("HTTP_FALLBACK")
            return
        worker = RealtimeLicenseWorker(
            communicator=self.communicator,
            storage=self.storage,
            license_key=result.license_key or self._current_key,
            hwid=result.hwid or self.get_hwid(),
            signed_login_data=result.license_data,
        )
        self._realtime = worker
        worker.start()

    # -------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------

    def login(self, license_key: str, pin: Optional[str] = None) -> LoginResult:
        """
        Validates license key against server and binds current hardware.
        The legacy pin argument is accepted for compatibility but ignored;
        license PINs are only used by the web control panel.
        """
        if self._current_key and not self.logout():
            return LoginResult(
                success=False,
                status_code=503,
                message="Previous license session could not be closed. Please retry when the license server is reachable.",
                code="PREVIOUS_SESSION_LOGOUT_FAILED",
                license_key=license_key.strip().upper() or None,
            )

        result = self.login_manager.login(license_key)
        if result.success:
            self._authenticated = True
            self._current_key = license_key.strip()
            self._license_payload = result.license_data
            self.logout_manager.set_active_session(self._current_key)
            self._start_realtime(result)
        else:
            self._authenticated = False
            self._current_key = None
            self._license_payload = None
            self.logout_manager.set_active_session(None)

        return result

    def auto_login(self) -> LoginResult:
        """
        Attempts auto-login with stored license key from OS temp directory.
        Always verifies online with license server before approving.
        """
        result = self.login_manager.auto_login()
        if result.success:
            self._authenticated = True
            self._current_key = result.license_key or self.storage.load_saved_session()
            self._license_payload = result.license_data
            self.logout_manager.set_active_session(self._current_key)
            self._start_realtime(result)
        return result

    def logout(self, clear_saved_license: bool = True) -> bool:
        """
        Logs out active session, stops heartbeat thread, and notifies server
        to release hardware device slot immediately.
        """
        self._stop_realtime()
        success = self.logout_manager.logout(
            self._current_key,
            clear_saved_data=clear_saved_license,
        )
        self._authenticated = False
        self._current_key = None
        self._license_payload = None
        return success

    def is_authenticated(self) -> bool:
        """Safe authorization check; returns False if new-mode grace has expired."""
        if getattr(getattr(self, "config", None), "useWebSocket", False):
            return bool(self._authenticated and self.storage.is_authorized())
        return self._authenticated

    def has_login_session(self) -> bool:
        """New UI-continuity hint: retained key in memory, not authorization."""
        return self._authenticated

    def get_connection_state(self) -> str:
        """HTTP_ONLY / CONNECTED / RECONNECTING / OFFLINE_GRACE / PAUSED_UNVERIFIED / INVALIDATED."""
        return self.storage.get_realtime_state() if getattr(
            getattr(self, "config", None), "useWebSocket", False
        ) else "HTTP_ONLY"

    def is_valid(self) -> bool:
        """Alias for is_authenticated()"""
        return self.is_authenticated()

    def get_license_info(self) -> Optional[Dict[str, Any]]:
        """Returns verified license payload from server"""
        if getattr(getattr(self, "config", None), "useWebSocket", False) and not self.is_authenticated():
            return None
        return self._license_payload

    def get_tier(self) -> str:
        """Returns license tier (e.g. Standard, Pro, Enterprise, VIP)"""
        if self._license_payload and (
            not getattr(getattr(self, "config", None), "useWebSocket", False)
            or self.is_authenticated()
        ):
            return self._license_payload.get("tier", "Standard")
        return "None"

    def get_hwid(self) -> str:
        """Returns deterministic HWID string"""
        return DeviceManager.get_hwid()

    def get_device_telemetry(self) -> Dict[str, Any]:
        """Returns full device telemetry dict"""
        return DeviceManager.get_device_telemetry()

    def get_current_key(self) -> Optional[str]:
        """Returns active license key"""
        return self._current_key

    def ping(self) -> Dict[str, Any]:
        """
        Sends on-demand heartbeat ping to server to check license status.
        Returns server response dict including {'valid': bool, 'status': str, ...}.
        """
        key = self._current_key or self.storage.load_saved_session()
        if not key:
            return {"valid": False, "code": "NOT_AUTHENTICATED", "message": "No active session"}
        is_active, data = self.server.ping_heartbeat(key, self.get_hwid())
        if not is_active:
            reason = data.get("message") or data.get("code") or "Heartbeat failed"
            if getattr(getattr(self, "config", None), "useWebSocket", False):
                self.storage.realtime_signed_heartbeat(False, data)
            elif self.storage.should_invalidate_for_heartbeat_failure(data):
                self._handle_license_revoked(reason)
        else:
            if getattr(getattr(self, "config", None), "useWebSocket", False):
                self.storage.realtime_signed_heartbeat(True, data)
            else:
                self.storage.record_heartbeat_success()
        return data

    # -------------------------------------------------------------
    # Internal Event Handlers
    # -------------------------------------------------------------

    def _handle_license_revoked(self, reason: str) -> None:
        """Called when background 20-min heartbeat detects revocation / unbind"""
        self._stop_realtime()
        self._authenticated = False
        self._license_payload = None
        self._current_key = None
        try:
            # An automatic local invalidation (e.g. WSS TLS/security failure)
            # cannot justify deleting an active server-side device binding.
            # Deny locally, stop workers and clear local state without remote
            # unbind. Explicit user logout retains its original unbind path.
            self.logout_manager.set_active_session(None)
            self.logout_manager.logout(clear_saved_data=True)
        except Exception:
            pass
        print("\n[VCON-SDK] CRITICAL: License session invalidated; local authorization denied")
        if self.on_license_revoked:
            self.on_license_revoked(reason)

    def _handle_heartbeat_success(self, data: Dict[str, Any]) -> None:
        """Called on periodic successful heartbeat"""
        pass
