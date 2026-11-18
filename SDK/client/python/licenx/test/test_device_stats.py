"""SDK-STAT-01: report-only token, local validation and fixed HTTPS transport."""
import json
import unittest
from unittest.mock import patch

from licenx.config import SDKConfig
from licenx.server import ServerCommunicator


class Response:
    def __init__(self, code=202):
        self.code = code
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def getcode(self):
        return self.code


class TestDeviceStats(unittest.TestCase):
    def setUp(self):
        self.comm = ServerCommunicator(SDKConfig(
            server_url="https://license.example.invalid", app_name="ci_app",
            app_version="1.2.3", public_key_pem="unused-test-pem"
        ))

    def test_unverified_or_old_server_never_grants_reporting(self):
        self.assertEqual(self.comm.send_stats({"Sent": 1})["code"], "STATS_UNSUPPORTED")
        token = "Z" * 43
        requests_seen = []
        def fake_validate(_url, body, _timeout):
            requests_seen.append(dict(body))
            return 200, dict(valid=True, status="active", signature="signed", nonce=body["nonce"],
                request_app=body["app_name"], license_key=body["license_key"],
                hwid=body["hwid"], stats_capability=token)
        with patch.object(self.comm, "_http_post", side_effect=fake_validate), \
             patch.object(self.comm, "verify_signature", return_value=False):
            valid, _, data = self.comm.validate_license("CI-CHECK", "hwid-test", {"device_name":"CI"})
        self.assertFalse(valid)
        self.assertIsNone(self.comm._stats_capability)
        with patch.object(self.comm, "_http_post", side_effect=fake_validate), \
             patch.object(self.comm, "verify_signature", return_value=True):
            valid, _, data = self.comm.validate_license("CI-CHECK", "hwid-test", {"device_name":"CI"})
        self.assertTrue(valid)
        self.assertIsNone(self.comm._stats_capability)
        self.assertNotIn("stats_capability", data)
        self.assertNotIn("stats_capability_version", requests_seen[-1],
                         "existing login validation contract must not change")
        with patch.object(self.comm, "_http_post", side_effect=fake_validate), \
             patch.object(self.comm, "verify_signature", return_value=True):
            ready = self.comm.request_stats_capability("CI-CHECK", "hwid-test", {"device_name":"CI"})
        self.assertEqual(ready, {"success": True, "code": "STATS_CAPABILITY_READY"})
        self.assertEqual(requests_seen[-1]["stats_capability_version"], 1)
        self.assertNotIn("logout_proof_version", requests_seen[-1],
                         "reporting must not alter existing logout bearer")
        self.assertEqual(self.comm._stats_capability, token)

    def test_flat_dynamic_json_sent_once_with_bearer_and_never_leaked(self):
        self.comm._stats_capability = "Z" * 43
        with patch("urllib.request.urlopen", return_value=Response()) as send:
            result = self.comm.send_stats({"Total": 5000, "Sent": 200, "Failed": 4800})
        self.assertEqual(result, {"success": True, "code": "STATS_ACCEPTED"})
        self.assertEqual(send.call_count, 1)
        req = send.call_args.args[0]
        self.assertIn("Bearer ", req.get_header("Authorization"))
        self.assertEqual(json.loads(req.data), {"stats": {"Total": 5000, "Sent": 200, "Failed": 4800}})
        self.assertNotIn("ZZZZ", str(result))
        self.assertEqual(self.comm.send_stats({"Bad": [1]})["code"], "INVALID_STAT_VALUE")
        self.assertEqual(self.comm.send_stats({"Password": "secret"})["code"], "INVALID_STAT_LABEL")
        self.assertEqual(self.comm.send_stats({"Oversize": "z"*300})["code"], "INVALID_STAT_VALUE")

    def test_http_and_transport_errors_return_safe_codes(self):
        from urllib.error import HTTPError, URLError
        self.comm._stats_capability = "Z" * 43
        def http(code):
            return HTTPError("https://example.invalid", code, "denied", {}, None)
        for status, expected in [(401,"STATS_UNAUTHORIZED"),(404,"STATS_UNSUPPORTED"),(429,"STATS_RATE_LIMITED")]:
            with patch("urllib.request.urlopen", side_effect=http(status)):
                self.assertEqual(self.comm.send_stats({"Value": 1})["code"], expected)
        with patch("urllib.request.urlopen", side_effect=URLError("offline")):
            self.assertEqual(self.comm.send_stats({"Value": 1})["code"], "STATS_NETWORK_ERROR")


if __name__ == "__main__":
    unittest.main()
