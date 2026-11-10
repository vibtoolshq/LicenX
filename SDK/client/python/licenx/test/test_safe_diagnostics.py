"""LX-S01 regression contracts; synthetic only, no real license/server/HTTP."""
import ssl
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from licenx.config import SDKConfig
from licenx.diagnostics import SafeDiagnosticBuffer, tls_verify_code
from licenx.server import ServerCommunicator
from licenx.realtime import RealtimeLicenseWorker


class SafeDiagnosticsTests(unittest.TestCase):
    def test_bounded_local_allowlist_drops_arbitrary_payloads(self):
        buf = SafeDiagnosticBuffer()
        self.assertIsNone(buf.record("tls_handshake", "SECRET_CREDENTIAL"))
        self.assertIsNone(buf.record("arbitrary", "REALTIME_TLS_ERROR"))
        for i in range(90):
            self.assertIsNotNone(buf.record("tls_handshake", "REALTIME_TLS_ERROR", min(i,20)))
        self.assertEqual(len(buf.snapshot()), 64)
        self.assertNotIn("SECRET_CREDENTIAL", str(buf.snapshot()))
        self.assertTrue(all(item["stage"] == "tls_handshake" for item in buf.snapshot()))

    def test_numeric_tls_metadata_never_emits_exception_text(self):
        code = tls_verify_code(ssl.SSLCertVerificationError("password=private-sentinel"))
        self.assertIsNone(code)
        buffer = SafeDiagnosticBuffer()
        buffer.record("tls_handshake", "REALTIME_TLS_ERROR", verify_code=20)
        self.assertEqual(buffer.snapshot()[0]["tls_verify_code"], 20)
        self.assertNotIn("private-sentinel", str(buffer.snapshot()))

    def test_wss_tls_failure_retains_safe_code_and_fails_closed(self):
        communicator = ServerCommunicator(SDKConfig(server_url="https://example.test"))
        storage = SimpleNamespace(_running=True, _invalidate=Mock())
        worker = RealtimeLicenseWorker(
            communicator, storage, "SECRET-LICENSE", "RAW-HWID",
            {"app_id": "app-one"},
        )
        with patch.dict(sys.modules, {"websocket": SimpleNamespace()}), patch.object(
            worker, "_run_connection",
            side_effect=ssl.SSLError("private credential in arbitrary exception")
        ):
            worker._run()
        storage._invalidate.assert_called_once_with("REALTIME_TLS_ERROR")
        events = communicator.get_diagnostics()
        self.assertEqual(events[-1]["code"], "REALTIME_TLS_ERROR")
        self.assertNotIn("SECRET-LICENSE", str(events))
        self.assertNotIn("RAW-HWID", str(events))
        self.assertNotIn("private credential", str(events))

    def test_ticket_denial_classified_by_safe_server_code(self):
        communicator = ServerCommunicator(SDKConfig(server_url="https://example.test"))
        communicator._http_post = Mock(return_value=(404, {"code": "REALTIME_DISABLED"}))
        storage = SimpleNamespace(_running=True)
        worker = RealtimeLicenseWorker(
            communicator, storage, "SECRET-LICENSE", "RAW-HWID",
            {"app_id": "app-one"},
        )
        ticket, status = worker._post_ticket()
        self.assertIsNone(ticket)
        self.assertEqual(status, 404)
        self.assertEqual(communicator.get_diagnostics()[-1]["code"], "REALTIME_TICKET_DISABLED")

    def test_signed_diagnostic_bearer_is_ram_only_not_part_of_license_result(self):
        communicator = ServerCommunicator(SDKConfig(
            app_name="app-one", server_url="https://example.test", app_version="1.0.0"
        ))
        token = "A" * 43

        def fake_http(_url, body, _timeout):
            return 200, {
                "valid": True, "signature": "synthetic", "nonce": body["nonce"],
                "request_app": body["app_name"], "license_key": body["license_key"],
                "hwid": body["hwid"], "diagnostic_token": token,
            }

        with patch.object(communicator, "_http_post", side_effect=fake_http), patch.object(
            communicator, "verify_signature", return_value=True
        ):
            valid, status, data = communicator.validate_license("LICENSE-TEST", "HWID-TEST", {})
        self.assertTrue(valid)
        self.assertEqual(status, 200)
        self.assertNotIn("diagnostic_token", data)
        self.assertEqual(communicator._diagnostic_token, token)


if __name__ == "__main__":
    unittest.main()
