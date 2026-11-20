"""Phase-04 F05: validated candidate handoff, no pre-validation unbind.

All server/device operations are isolated mocks; no customer license is used.
"""
import unittest
from unittest.mock import Mock, patch

from licenx.client import XLicenseClient
from licenx.config import SDKConfig
from licenx.device import DeviceManager
from licenx.login import LoginResult
from licenx.logout import LogoutManager


class ClientSessionReplacementTests(unittest.TestCase):
    def setUp(self):
        self.config = SDKConfig(
            app_name="test-app", app_version="1.0.0",
            useWebSocket=False, enable_background_heartbeat=True,
        )
        self.communicator = Mock()
        self.communicator.send_logout.return_value = True
        self.candidate_transport = Mock()
        self.candidate_transport.send_logout.return_value = True
        self.storage = Mock()
        self.storage._remaining_grace_seconds.return_value = None
        self.storage._realtime_paused = False

        def pause_uncertain_release(_data):
            self.storage._remaining_grace_seconds.return_value = 0.0
            self.storage._realtime_paused = True
            return False

        self.storage.should_invalidate_for_heartbeat_failure.side_effect = pause_uncertain_release
        self.logout_manager = LogoutManager(
            self.communicator, self.storage, auto_logout_on_exit=False,
        )
        self.logout_manager.set_active_session("OLD-KEY", "HWID-OLD")
        self.client = XLicenseClient.__new__(XLicenseClient)
        self.client.config = self.config
        self.client.communicator = self.communicator
        self.client.server = self.communicator
        self.client._authenticated = True
        self.client._current_key = "OLD-KEY"
        self.client._license_payload = {"tier": "Old"}
        self.client.storage = self.storage
        self.client.logout_manager = self.logout_manager
        self.client.login_manager = Mock()
        self.client.login_manager.communicator = self.communicator

    def attempt(self, key="NEW-KEY"):
        with patch("licenx.client.ServerCommunicator", return_value=self.candidate_transport), \
                patch.object(DeviceManager, "get_validation_telemetry", return_value={}), \
                patch.object(DeviceManager, "get_hwid", return_value="HWID-NEW"):
            return self.client.login(key)

    @staticmethod
    def result(success, key="NEW-KEY"):
        return LoginResult(
            success, 200 if success else 403,
            "Verified" if success else "Rejected",
            "OK" if success else "LICENSE_REVOKED",
            license_data={"tier": "New"} if success else None,
            hwid="HWID-NEW", license_key=key,
        )

    def test_first_login_uses_normal_legacy_path_without_unbind(self):
        self.client._authenticated = False
        self.client._current_key = None
        self.client.login_manager.login.return_value = self.result(True)
        result = self.client.login("NEW-KEY")
        self.assertTrue(result.success)
        self.communicator.send_logout.assert_not_called()
        self.client.login_manager.login.assert_called_once_with("NEW-KEY")
        self.assertIs(self.client.communicator, self.communicator)

    def test_successful_replacement_verifies_before_releasing_old_device(self):
        events = []

        def verify(**_kwargs):
            events.append("verified")
            self.assertTrue(self.client.is_authenticated())
            self.assertEqual(self.client.get_current_key(), "OLD-KEY")
            self.storage.stop_monitoring.assert_not_called()
            self.storage.save_session.assert_not_called()
            self.communicator.send_logout.assert_not_called()
            return True, 200, {"valid": True, "tier": "New"}

        def release(key, hwid):
            events.append("old-released")
            self.assertEqual((key, hwid), ("OLD-KEY", "HWID-OLD"))
            self.storage.stop_monitoring.assert_not_called()
            return True

        self.candidate_transport.validate_license.side_effect = verify
        self.communicator.send_logout.side_effect = release
        result = self.attempt()
        self.assertTrue(result.success)
        self.assertEqual(events, ["verified", "old-released"])
        self.assertIs(self.client.communicator, self.candidate_transport)
        self.assertIs(self.client.server, self.candidate_transport)
        self.assertIs(self.logout_manager.communicator, self.candidate_transport)
        self.assertEqual(self.logout_manager._current_license_key, "NEW-KEY")
        self.assertEqual(self.logout_manager._current_hwid, "HWID-NEW")
        self.assertTrue(self.client.is_authenticated())
        self.assertEqual(self.client.get_license_info()["tier"], "New")
        self.storage.stop_monitoring.assert_called_once()
        self.storage.save_session.assert_called_once_with(
            "NEW-KEY", {"valid": True, "tier": "New"},
        )
        self.storage.start_monitoring.assert_called_once_with(
            server_communicator=self.candidate_transport,
            license_key="NEW-KEY", hwid="HWID-NEW",
        )
        self.candidate_transport.send_logout.assert_not_called()
        self.client.login_manager.login.assert_not_called()

    def test_failed_signed_validation_preserves_old_session_and_worker(self):
        # The temporary candidate transport must never reset the old session's
        # in-memory one-use v2 release capability.
        self.communicator._logout_proof = "OLD-PROOF-IN-RAM"
        self.communicator._logout_proof_session = ("OLD-KEY", "HWID-OLD")
        self.candidate_transport.validate_license.return_value = (
            False, 403, {"code": "LICENSE_REVOKED", "message": "Rejected"},
        )
        result = self.attempt()
        self.assertFalse(result.success)
        self.assertEqual(result.code, "LICENSE_REVOKED")
        self.assertTrue(self.client.has_login_session())
        self.assertTrue(self.client.is_authenticated())
        self.assertEqual(self.client.get_current_key(), "OLD-KEY")
        self.assertIs(self.client.communicator, self.communicator)
        self.assertEqual(self.logout_manager._current_license_key, "OLD-KEY")
        self.storage.stop_monitoring.assert_not_called()
        self.storage.start_monitoring.assert_not_called()
        self.communicator.send_logout.assert_not_called()
        self.candidate_transport.send_logout.assert_not_called()
        self.assertEqual(self.communicator._logout_proof, "OLD-PROOF-IN-RAM")
        self.assertEqual(self.communicator._logout_proof_session, ("OLD-KEY", "HWID-OLD"))

    def test_network_exception_during_candidate_keeps_old_proof_and_session(self):
        self.candidate_transport.validate_license.side_effect = OSError("PRIVATE URL")
        result = self.attempt()
        self.assertEqual(result.code, "VALIDATION_UNAVAILABLE")
        self.assertNotIn("PRIVATE", str(result))
        self.assertTrue(self.client.is_authenticated())
        self.assertEqual(self.client.get_current_key(), "OLD-KEY")
        self.assertIs(self.client.communicator, self.communicator)
        self.storage.stop_monitoring.assert_not_called()
        self.communicator.send_logout.assert_not_called()

    def test_failed_authenticated_old_release_retains_original_session(self):
        self.candidate_transport.validate_license.return_value = (
            True, 200, {"valid": True, "tier": "New"},
        )
        self.communicator.send_logout.return_value = False
        result = self.attempt()
        self.assertEqual(result.code, "PREVIOUS_SESSION_LOGOUT_FAILED")
        self.assertFalse(result.success)
        self.assertTrue(self.client.has_login_session())
        self.assertFalse(self.client.is_authenticated(),
                         "uncertain old release must pause protected operations")
        self.assertEqual(self.client.get_current_key(), "OLD-KEY")
        self.assertEqual(self.logout_manager._current_license_key, "OLD-KEY")
        self.storage.stop_monitoring.assert_not_called()
        self.storage.start_monitoring.assert_not_called()
        self.storage.should_invalidate_for_heartbeat_failure.assert_called_once_with(
            {"code": "DENIAL_UNVERIFIED"}
        )
        self.assertIs(self.client.communicator, self.communicator)
        self.communicator.send_logout.assert_called_once_with("OLD-KEY", "HWID-OLD")
        # Only the NEW candidate's verified v2 binding may be cleaned up.
        self.candidate_transport.send_logout.assert_called_once_with(
            "NEW-KEY", "HWID-NEW",
        )
        self.assertFalse(self.logout_manager.has_pending_release())

    def test_same_key_revalidation_never_unbinds_current_device(self):
        self.candidate_transport.validate_license.return_value = (
            True, 200, {"valid": True, "tier": "Renewed"},
        )
        result = self.attempt("OLD-KEY")
        self.assertTrue(result.success)
        self.assertEqual(self.client.get_current_key(), "OLD-KEY")
        self.assertEqual(self.client.get_tier(), "Renewed")
        self.communicator.send_logout.assert_not_called()
        self.candidate_transport.send_logout.assert_not_called()
        self.storage.stop_monitoring.assert_called_once()
        self.storage.start_monitoring.assert_called_once()

    def test_late_candidate_reply_cannot_reauthorize_changed_session(self):
        def changed(**_kwargs):
            self.client._authenticated = False
            self.client._current_key = None
            return True, 200, {"valid": True}

        self.candidate_transport.validate_license.side_effect = changed
        result = self.attempt()
        self.assertEqual(result.code, "SESSION_CHANGED")
        self.assertFalse(self.client.is_authenticated())
        self.storage.stop_monitoring.assert_not_called()
        self.candidate_transport.send_logout.assert_called_once_with(
            "NEW-KEY", "HWID-NEW",
        )
        self.communicator.send_logout.assert_not_called()


if __name__ == "__main__":
    unittest.main()
