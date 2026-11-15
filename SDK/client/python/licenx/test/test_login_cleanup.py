import unittest
from unittest.mock import Mock, patch

from licenx.config import SDKConfig
from licenx.device import DeviceManager
from licenx.login import LoginManager


class LoginBindingCleanupTests(unittest.TestCase):
    def setUp(self):
        self.communicator = Mock()
        self.storage = Mock()
        self.manager = LoginManager(
            SDKConfig(),
            self.communicator,
            self.storage,
        )

    def test_signature_rejection_never_unbinds_existing_device(self):
        self.communicator.validate_license.return_value = (
            False,
            403,
            {"code": "SIGNATURE_FAILED", "error": "Signature rejected"},
        )
        self.communicator.send_logout.return_value = True

        with patch.object(
            DeviceManager, "get_validation_telemetry", return_value={}
        ), patch.object(DeviceManager, "get_hwid", return_value="HWID-TEST"):
            result = self.manager.login(" lic-test ")

        self.assertFalse(result.success)
        self.assertEqual(result.code, "SIGNATURE_FAILED")
        self.communicator.send_logout.assert_not_called()

    def test_signed_login_ignores_client_clock_without_unbind(self):
        self.communicator.validate_license.return_value = (
            True,
            200,
            {"valid": True, "server_time": 123},
        )
        with patch.object(
            DeviceManager, "get_validation_telemetry", return_value={}
        ), patch.object(DeviceManager, "get_hwid", return_value="HWID-TEST"), patch(
            "licenx.login.OfflineGuard.is_clock_tampered", return_value=True
        ) as clock_gate:
            result = self.manager.login("LIC-TEST")

        self.assertTrue(result.success)
        self.assertEqual(result.code, "OK")
        clock_gate.assert_not_called()
        self.communicator.send_logout.assert_not_called()

    def test_ordinary_server_denial_does_not_send_logout(self):
        self.communicator.validate_license.return_value = (
            False,
            403,
            {"code": "LICENSE_REVOKED", "message": "License revoked"},
        )

        with patch.object(
            DeviceManager, "get_validation_telemetry", return_value={}
        ), patch.object(DeviceManager, "get_hwid", return_value="HWID-TEST"):
            result = self.manager.login("LIC-TEST")

        self.assertFalse(result.success)
        self.assertEqual(result.code, "LICENSE_REVOKED")
        self.assertIsNone(result.request_id)
        self.communicator.send_logout.assert_not_called()

    def test_server_request_id_is_exposed_on_failed_login_result(self):
        request_id = "74dedd91-e751-465e-a17e-6f6ceebedd8a"
        self.communicator.validate_license.return_value = (
            False,
            500,
            {
                "code": "HTTP_500",
                "error": "License server rejected the request (HTTP 500)",
                "request_id": request_id,
            },
        )

        with patch.object(
            DeviceManager, "get_validation_telemetry", return_value={}
        ), patch.object(DeviceManager, "get_hwid", return_value="HWID-TEST"):
            result = self.manager.login("LICENX-TEST")

        self.assertFalse(result.success)
        self.assertEqual(result.status_code, 500)
        self.assertEqual(result.code, "HTTP_500")
        self.assertEqual(result.request_id, request_id)
        self.communicator.send_logout.assert_not_called()

    def test_cleanup_failure_does_not_replace_signature_rejection(self):
        self.communicator.validate_license.return_value = (
            False,
            403,
            {"code": "SIGNATURE_FAILED", "error": "Signature rejected"},
        )
        self.communicator.send_logout.side_effect = RuntimeError("network failure")

        with patch.object(
            DeviceManager, "get_validation_telemetry", return_value={}
        ), patch.object(DeviceManager, "get_hwid", return_value="HWID-TEST"), patch(
            "builtins.print"
        ) as print_warning:
            result = self.manager.login("LIC-TEST")

        self.assertFalse(result.success)
        self.assertEqual(result.code, "SIGNATURE_FAILED")
        # An untrusted validation response has no authenticated device proof.
        # Never attempt remote cleanup or emit a misleading cleanup warning.
        self.communicator.send_logout.assert_not_called()
        print_warning.assert_not_called()


if __name__ == "__main__":
    unittest.main()
