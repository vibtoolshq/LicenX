"""LX-S02: isolated signed HTTPS recovery and RAM-only pending-release regressions.

No real license, customer device, VPS, SDK installation, UI or sending.
"""
import ssl
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from licenx.client import XLicenseClient
from licenx.config import SDKConfig
from licenx.device import DeviceManager
from licenx.login import LoginResult
from licenx.logout import LogoutManager
from licenx.realtime import RealtimeLicenseWorker
from licenx.server import ServerCommunicator
from licenx.storage import BackgroundLicenseWorker


class SignedHttpRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.communicator = ServerCommunicator(SDKConfig(
            app_name="test-app", server_url="https://example.test", app_version="1.2.4",
            useWebSocket=True,
        ))
        self.storage = BackgroundLicenseWorker("test-app")
        self.storage.enable_realtime()
        self.storage._running = True
        self.storage._stop_event.clear()
        self.worker = RealtimeLicenseWorker(
            self.communicator, self.storage, "TEST-KEY", "HWID-FIXTURE",
            {"app_id":"app-fixture"},
        )

    def tearDown(self):
        self.worker.stop()
        self.storage.stop_monitoring()

    def _run_failure(self, error, signed_result):
        def assert_paused_before_http(*_args):
            # No protected CalGrid operation may run while TLS is being checked.
            self.assertFalse(self.storage.is_authorized())
            self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
            return signed_result
        self.communicator.ping_heartbeat = Mock(side_effect=assert_paused_before_http)
        module = SimpleNamespace()
        with patch.dict(sys.modules, {"websocket": module}), patch.object(
            self.worker, "_run_connection", side_effect=error
        ):
            self.worker._run()

    def test_ws_tls_fails_but_fresh_verified_https_allows_http_only(self):
        # Simulate an earlier signed WSS connection, then its TLS reconnect loss.
        self.storage.set_realtime_connected(True)
        self._run_failure(ssl.SSLCertVerificationError("SECRET EXCEPTION"), (
            True, {"valid":True, "status":"active"},
        ))
        self.assertEqual(self.storage.get_realtime_state(), "HTTP_FALLBACK")
        self.assertFalse(self.storage._realtime_connected, "stale WSS must not suppress HTTPS monitoring")
        self.assertTrue(self.storage._realtime_wake.is_set())
        self.assertTrue(self.storage._running)
        self.assertTrue(self.storage.is_authorized())
        self.assertFalse(self.storage._keep_login_on_network_error)
        self.communicator.ping_heartbeat.assert_called_once_with("TEST-KEY", "HWID-FIXTURE")
        assert self.communicator.get_diagnostics()[-1]["code"] == "REALTIME_TLS_ERROR"
        self.assertNotIn("SECRET", str(self.communicator.get_diagnostics()))

    def test_ws_tls_and_unverifiable_http_fail_closed(self):
        revoked = Mock()
        self.storage.on_invalidated = revoked
        self._run_failure(ssl.SSLError("SECRET EXCEPTION"), (
            False, {"code":"HEARTBEAT_SIGNATURE_FAILED"},
        ))
        self.assertEqual(self.storage.get_realtime_state(), "INVALIDATED")
        self.assertFalse(self.storage.is_authorized())
        revoked.assert_called_once()

    def test_ws_tls_and_unreachable_signed_http_never_fallback(self):
        self._run_failure(ssl.SSLError("private tls"), (
            False, {"code":"SERVER_UNREACHABLE"},
        ))
        self.assertEqual(self.storage.get_realtime_state(), "INVALIDATED")
        self.assertFalse(self.storage._running)

    def test_ws_denied_ticket_requires_fresh_signed_https(self):
        self.storage.set_realtime_connected(True)
        self.communicator.ping_heartbeat = Mock(return_value=(True, {"valid":True}))
        self.worker._post_ticket = Mock(return_value=(None, 403))
        self.assertEqual(self.worker._run_connection(SimpleNamespace()), "HTTP_FALLBACK")
        self.assertEqual(self.storage.get_realtime_state(), "HTTP_FALLBACK")
        self.assertFalse(self.storage._realtime_connected)
        self.communicator.ping_heartbeat.assert_called_once()

    def test_ws_disabled_404_falls_back_but_busy_503_does_not(self):
        self.communicator.ping_heartbeat = Mock(return_value=(True, {"valid":True}))
        self.worker._post_ticket = Mock(return_value=(None, 404))
        self.assertEqual(self.worker._run_connection(SimpleNamespace()), "HTTP_FALLBACK")
        self.worker._post_ticket = Mock(return_value=(None, 503))
        self.assertIsNone(self.worker._run_connection(SimpleNamespace()))
        self.communicator.ping_heartbeat.assert_called_once()

    def test_403_ticket_with_bad_http_signature_does_not_grant_http_fallback(self):
        self.communicator.ping_heartbeat = Mock(return_value=(
            False, {"code":"HEARTBEAT_SIGNATURE_FAILED"},
        ))
        self.worker._post_ticket = Mock(return_value=(None, 403))
        self.assertIsNone(self.worker._run_connection(SimpleNamespace()))
        self.assertEqual(self.storage.get_realtime_state(), "INVALIDATED")
        self.assertFalse(self.storage.is_authorized())

    def test_repeated_non_tls_wss_failure_falls_back_only_after_verified_http(self):
        self.communicator.ping_heartbeat = Mock(return_value=(True, {"valid":True}))
        self.worker._retry_wait = Mock()
        with patch.dict(sys.modules, {"websocket": SimpleNamespace()}), patch.object(
            self.worker, "_run_connection",
            side_effect=[RuntimeError("SECRET"), RuntimeError("SECRET")],
        ) as attempt:
            self.worker._run()
        self.assertEqual(attempt.call_count, 2)
        self.assertEqual(self.storage.get_realtime_state(), "HTTP_FALLBACK")
        self.assertNotIn("SECRET", str(self.communicator.get_diagnostics()))

    def test_hw_id_cache_is_stable_when_synthetic_components_unchanged(self):
        old = DeviceManager._cached_hwid
        DeviceManager._cached_hwid = None
        try:
            with patch.object(DeviceManager, "get_motherboard_uuid", return_value="FIXTURE-UUID"), \
                    patch.object(DeviceManager, "get_disk_serial", return_value="FIXTURE-DISK"), \
                    patch.object(DeviceManager, "get_cpu_info", return_value="FIXTURE-CPU"), \
                    patch.object(DeviceManager, "get_mac_address", return_value="FIXTURE-MAC"):
                first = DeviceManager.get_hwid()
                again = DeviceManager.get_hwid()
                self.assertEqual(first, again)
                self.assertTrue(first.startswith("HWID-"))
        finally:
            DeviceManager._cached_hwid = old


class LogoutReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.communicator = Mock()
        self.storage = Mock()
        self.manager = LogoutManager(
            self.communicator, self.storage, auto_logout_on_exit=False
        )

    def test_failed_logout_keeps_ram_only_original_hwid_and_explicit_retry(self):
        self.communicator.send_logout.side_effect = [False, True]
        self.manager.set_active_session("OLD-LICENSE", "HWID-AT-LOGIN")
        with patch.object(DeviceManager, "get_hwid", return_value="HWID-CHANGED"):
            self.assertFalse(self.manager.logout())
        self.assertTrue(self.manager.has_pending_release())
        self.assertIsNone(self.manager._current_license_key)
        self.assertEqual(
            self.communicator.send_logout.call_args.args,
            ("OLD-LICENSE", "HWID-AT-LOGIN"),
        )
        self.assertTrue(self.manager.retry_pending_logout())
        self.assertFalse(self.manager.has_pending_release())
        self.assertEqual(self.communicator.send_logout.call_count, 2)
        self.storage.clear_session.assert_called_once()

    def test_failed_logout_exception_never_claims_success(self):
        self.manager.set_active_session("KEY", "ORIGINAL-HWID")
        self.communicator.send_logout.side_effect = OSError("private network error")
        self.assertFalse(self.manager.logout())
        self.assertTrue(self.manager.has_pending_release())
        self.assertFalse(self.manager.retry_pending_logout())

    def test_failed_release_blocks_next_login_until_successful_reconciliation(self):
        self.communicator.send_logout.side_effect = [False, False, True]
        self.manager.set_active_session("PREVIOUS", "PREVIOUS-HWID")
        self.assertFalse(self.manager.logout())
        client = XLicenseClient.__new__(XLicenseClient)
        client.logout_manager = self.manager
        client.login_manager = Mock()
        client.config = SDKConfig(useWebSocket=False)
        client.storage = self.storage
        client._authenticated = False
        client._current_key = None
        client._license_payload = None
        client.login_manager.login.return_value = LoginResult(
            True, 200, "verified", "OK", license_data={"valid":True},
            license_key="NEW", hwid="NEW-HWID"
        )
        blocked = client.login("NEW")
        self.assertFalse(blocked.success)
        self.assertEqual(blocked.code, "PREVIOUS_SESSION_LOGOUT_FAILED")
        client.login_manager.login.assert_not_called()
        allowed = client.login("NEW")
        self.assertTrue(allowed.success)
        self.assertEqual(client.login_manager.login.call_count, 1)
        self.assertEqual(self.manager._current_hwid, "NEW-HWID")
        self.assertFalse(self.manager.has_pending_release())
        self.assertEqual(self.communicator.send_logout.call_count, 3)

    def test_invalidation_cleanup_does_not_retry_pending_remote_logout(self):
        self.manager.set_active_session("PREVIOUS", "HWID")
        self.communicator.send_logout.return_value = False
        self.assertFalse(self.manager.logout())
        self.manager.set_active_session(None)
        self.assertTrue(self.manager.logout())
        self.assertEqual(self.communicator.send_logout.call_count, 1)
        self.assertTrue(self.manager.has_pending_release())


if __name__ == "__main__":
    unittest.main()
