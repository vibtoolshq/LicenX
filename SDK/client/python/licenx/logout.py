"""
VCON Python Client SDK - Logout Manager
Handles clean manual logout and automated graceful exit hooks (atexit / signal).
Notifies server to unbind current HWID instantly, freeing up the device limit slot
so the license can be activated on another PC immediately.
"""

import atexit
import os
import signal
from typing import Optional, Callable
from .device import DeviceManager
from .server import ServerCommunicator
from .storage import BackgroundLicenseWorker


class LogoutManager:
    def __init__(
        self,
        communicator: ServerCommunicator,
        storage: BackgroundLicenseWorker,
        auto_logout_on_exit: bool = True,
    ):
        self.communicator = communicator
        self.storage = storage
        self.auto_logout_on_exit = auto_logout_on_exit
        self._current_license_key: Optional[str] = None
        self._current_hwid: Optional[str] = None
        # Never put failed release credentials on disk. Reconcile on a future
        # explicit user logout/login only, not from an invalidation callback.
        self._pending_release: Optional[tuple] = None
        self._exit_hook_registered = False
        self._exit_cleanup_started = False
        self._stop_realtime_callback: Optional[Callable[[], None]] = None

        if self.auto_logout_on_exit:
            self._register_exit_hooks()

    def set_realtime_stop_callback(self, callback: Callable[[], None]) -> None:
        self._stop_realtime_callback = callback

    def set_active_session(self, license_key: Optional[str], hwid: Optional[str] = None) -> None:
        """Keep the verified login HWID stable for the matching logout call."""
        self._current_license_key = license_key
        self._current_hwid = hwid if license_key and hwid else None

    def has_pending_release(self) -> bool:
        """A failed remote logout leaves a RAM-only release to reconcile."""
        return self._pending_release is not None

    def retry_pending_logout(self) -> bool:
        """One bounded, explicit retry; a failure never grants license access."""
        pending = self._pending_release
        if pending is None:
            return True
        try:
            success = bool(self.communicator.send_logout(*pending))
        except Exception:
            success = False
        if success:
            self._pending_release = None
        return success

    def logout(self, license_key: Optional[str] = None, clear_saved_data: bool = True) -> bool:
        """
        Logs out active session and unbinds device from server.
        """
        key = license_key or self._current_license_key
        hwid = (
            (self._current_hwid or DeviceManager.get_hwid())
            if key and key == self._current_license_key
            else DeviceManager.get_hwid() if key else None
        )

        # Stop WSS before unbinding the device, including automatic exit paths.
        if self._stop_realtime_callback:
            try:
                self._stop_realtime_callback()
            except Exception:
                pass
        # Stop background worker thread
        self.storage.stop_monitoring()

        if clear_saved_data:
            self.storage.clear_session()

        success = True
        if key:
            # A failed unbind does not release the server slot. Never invent
            # a successful logout or silently forget which device was bound.
            try:
                success = bool(self.communicator.send_logout(key, hwid))
            except Exception:
                success = False
            if success:
                if self._pending_release == (key, hwid):
                    self._pending_release = None
            elif self._pending_release is None:
                self._pending_release = (key, hwid)

        self._current_license_key = None
        self._current_hwid = None
        return success

    def _register_exit_hooks(self) -> None:
        """Hooks Python process termination to execute auto-logout"""
        if self._exit_hook_registered:
            return

        def _on_exit():
            if self._current_license_key and not self._exit_cleanup_started:
                self._exit_cleanup_started = True
                try:
                    self.logout(self._current_license_key, clear_saved_data=False)
                except Exception:
                    pass

        atexit.register(_on_exit)

        previous_handlers = {}

        def _sig_handler(signum, frame):
            previous_handler = previous_handlers.get(signum, signal.SIG_DFL)

            if previous_handler == signal.SIG_IGN:
                return

            _on_exit()

            if callable(previous_handler):
                previous_handler(signum, frame)
            elif previous_handler == signal.SIG_DFL:
                signal.signal(signum, signal.SIG_DFL)
                os.kill(os.getpid(), signum)

        try:
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[signum] = signal.getsignal(signum)
                signal.signal(signum, _sig_handler)
        except Exception:
            # In some thread or non-main thread contexts, signal registration might not be allowed
            pass

        self._exit_hook_registered = True
