"""WS-03 focused regressions. No live license, VPS, database or credentials."""
import base64
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from cryptography.hazmat.primitives.asymmetric import ed25519, rsa, padding
from cryptography.hazmat.primitives import hashes, serialization

from licenx.client import XLicenseClient
from licenx.config import SDKConfig, SDKConfigError
from licenx.realtime import RealtimeLicenseWorker, _RealtimeSecurityError
from licenx.server import ServerCommunicator
from licenx.storage import BackgroundLicenseWorker


def public_pem(private):
    return private.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode("ascii")


def signed(packet, private):
    body = json.dumps(packet, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    if isinstance(private, ed25519.Ed25519PrivateKey):
        sig = private.sign(body.encode("utf-8"))
    else:
        sig = private.sign(body.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256())
    return dict(packet, signature=base64.b64encode(sig).decode("ascii"))


class FakeWebSocket:
    def __init__(self, frames):
        self.frames = list(frames)
        self.sent = []
        self.closed = False
        self.timeouts = []

    def send(self, msg):
        self.sent.append(json.loads(msg))

    def recv(self):
        if self.frames:
            return json.dumps(self.frames.pop(0), ensure_ascii=False)
        raise StopIteration("test socket closed")

    def settimeout(self, value):
        self.timeouts.append(value)

    def close(self):
        self.closed = True


class FakeWebSocketModule:
    class WebSocketTimeoutException(Exception):
        pass

    def __init__(self, socket):
        self.socket = socket
        self.calls = []

    def create_connection(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.socket


class RealtimeSdkTests(unittest.TestCase):
    def setUp(self):
        self.key = ed25519.Ed25519PrivateKey.generate()
        self.config = SDKConfig(
            app_name="my-app", server_url="https://licensing.example.test",
            public_key_pem=public_pem(self.key), app_version="1.0.0",
            offline_grace_seconds=20, auto_logout_on_exit=False,
            useWebSocket=True,
        )
        self.communicator = ServerCommunicator(self.config)
        self.storage = BackgroundLicenseWorker("realtime-test", offline_grace_seconds=20)
        self.storage.enable_realtime()
        self.storage._running = True
        self.storage._stop_event.clear()
        self.worker = RealtimeLicenseWorker(
            self.communicator, self.storage, "TEST-LICENSE", "HWID-TEST",
            {"app_id": "app-one", "status": "active", "hwid": "HWID-TEST"},
        )

    def tearDown(self):
        self.worker.stop()
        self.storage.stop_monitoring()

    def test_flag_defaults_false_and_legacy_export_omits_it(self):
        old = SDKConfig(public_key_pem=self.config.public_key_pem)
        self.assertFalse(old.useWebSocket)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "old.json")
            old.export_to_file(path)
            with open(path, encoding="utf-8") as handle:
                self.assertNotIn("useWebSocket", json.load(handle))
            self.config.export_to_file(path)
            with open(path, encoding="utf-8") as handle:
                self.assertTrue(json.load(handle)["useWebSocket"])
        with self.assertRaisesRegex(ValueError, "useWebSocket must be a boolean"):
            SDKConfig(useWebSocket="true")

    def test_python_config_opt_in_is_literal_and_strict(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "licenx.config.py")
            config = {
                "app_name": "my-app", "server_url": "https://licensing.example.test",
                "public_key_pem": self.config.public_key_pem, "useWebSocket": True,
            }
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("app_config = " + repr(config) + "\n")
            self.assertTrue(SDKConfig.from_python_file(path).useWebSocket)
            config["useWebSocket"] = "true"
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("app_config = " + repr(config) + "\n")
            with self.assertRaisesRegex(SDKConfigError, "must be a boolean"):
                SDKConfig.from_python_file(path)

    def test_bound_snapshot_rsa_ed25519_and_unicode(self):
        for private in (self.key, rsa.generate_private_key(public_exponent=65537, key_size=2048)):
            with self.subTest(key_type=type(private).__name__):
                self.communicator.config.public_key_pem = public_pem(private)
                snap = {
                    "type": "license.snapshot", "app_id": "app-one",
                    "license_id": "license-\u09ac\u09be\u0982\u09b2\u09be", "device_id": "dev-1",
                    "version": 10, "valid": True, "server_time": int(time.time() * 1000),
                }
                result = self.worker._verify_snapshot(signed(snap, private))
                self.assertEqual(result["version"], 10)
                self.worker._identity = None
                self.worker._version = -1
        self.communicator.config.public_key_pem = public_pem(self.key)

    def test_snapshot_wrong_app_expired_and_invalid_signature_fail_closed(self):
        payload = {
            "type": "license.snapshot", "app_id": "bad-app", "license_id": "lic-1",
            "device_id": "dev-1", "version": 1, "valid": True,
            "server_time": int(time.time() * 1000),
        }
        with self.assertRaises(_RealtimeSecurityError):
            self.worker._verify_snapshot(signed(payload, self.key))
        payload["app_id"] = "app-one"
        bad = signed(payload, self.key)
        bad["device_id"] = "tampered"
        with self.assertRaises(_RealtimeSecurityError):
            self.worker._verify_snapshot(bad)
        payload["server_time"] = int(time.time() * 1000) - 999_999
        with self.assertRaises(_RealtimeSecurityError):
            self.worker._verify_snapshot(signed(payload, self.key))

    def test_event_scope_signature_version_and_expiry_rejected(self):
        snap = {
            "type": "license.snapshot", "app_id": "app-one", "license_id": "lic-one",
            "device_id": "dev-one", "version": 20, "valid": True,
            "server_time": int(time.time() * 1000),
        }
        self.worker._verify_snapshot(signed(snap, self.key))
        now = int(time.time() * 1000)
        e = {
            "type": "license.state_changed", "event_id": "21", "version": 21,
            "event_type": "device.changed", "app_id": "app-one",
            "license_id": "lic-one", "device_id": "dev-one",
            "issued_at": now, "expires_at": now + 30_000,
        }
        self.assertTrue(self.worker._verify_event(signed(e, self.key)))
        self.assertFalse(self.worker._verify_event(signed(e, self.key)))
        e["event_id"] = "22"
        e["version"] = 22
        e["app_id"] = "other-app"
        with self.assertRaises(_RealtimeSecurityError):
            self.worker._verify_event(signed(e, self.key))
        e["app_id"] = "app-one"
        e["expires_at"] = now - 1
        with self.assertRaises(_RealtimeSecurityError):
            self.worker._verify_event(signed(e, self.key))

    def test_wss_one_time_ticket_header_no_origin_and_signed_revalidation(self):
        now = int(time.time() * 1000)
        snap = signed({
            "type": "license.snapshot", "app_id": "app-one", "license_id": "lic-one",
            "device_id": "dev-one", "valid": True, "server_time": now, "version": 10,
        }, self.key)
        event = signed({
            "type": "license.state_changed", "event_id": "11", "version": 11,
            "event_type": "license.changed", "app_id": "app-one",
            "license_id": "lic-one", "device_id": None,
            "issued_at": now, "expires_at": now + 30_000,
        }, self.key)
        sock = FakeWebSocket([{"type":"welcome"}, snap, event])
        mod = FakeWebSocketModule(sock)
        def ping(_key, _hwid):
            self.worker._stop_event.set()
            return True, {"valid": True, "code": "OK", "status":"active"}
        with patch.object(self.communicator, "_http_post", return_value=(200, {"ticket": "A"*43})), patch.object(
            self.communicator, "ping_heartbeat", side_effect=ping
        ) as signed_http:
            self.worker._run_connection(mod)
        self.assertEqual(len(mod.calls), 1)
        self.assertEqual(mod.calls[0][0], "wss://licensing.example.test/api/realtime")
        self.assertEqual(mod.calls[0][1]["header"], ["Authorization: Bearer " + "A"*43])
        self.assertTrue(mod.calls[0][1]["suppress_origin"])
        self.assertEqual(sock.sent, [{"type": "license.hello"}])
        signed_http.assert_called_once_with("TEST-LICENSE", "HWID-TEST")
        self.assertTrue(sock.closed)
        self.assertEqual(self.storage.get_realtime_state(), "CONNECTED")

    def test_invalid_snapshot_never_connects_or_grants_access(self):
        now = int(time.time() * 1000)
        packet = {
            "type": "license.snapshot", "app_id": "app-one", "license_id": "lic-one",
            "device_id": "dev-one", "valid": True, "server_time": now, "version": 1,
            "signature": "FAKE",
        }
        sock = FakeWebSocket([packet])
        mod = FakeWebSocketModule(sock)
        with patch.object(self.communicator, "_http_post", return_value=(200, {"ticket": "B"*43})):
            with self.assertRaises(_RealtimeSecurityError):
                self.worker._run_connection(mod)
        self.assertNotEqual(self.storage.get_realtime_state(), "CONNECTED")
        self.assertTrue(sock.closed)

    def test_transient_network_outage_retains_ui_session_but_pauses_operations(self):
        self.storage.offline_grace_seconds = 0
        self.storage.apply_signed_realtime_policy(True)  # simulate verified ON policy
        client = XLicenseClient.__new__(XLicenseClient)
        client.config = self.config
        client.storage = self.storage
        client._authenticated = True
        client._current_key = "TEST-LICENSE"
        client._license_payload = {"tier": "Pro", "valid": True}
        self.assertTrue(client.is_authenticated())
        self.storage.realtime_signed_heartbeat(False, {"code": "TIMEOUT"})
        self.assertEqual(client.get_connection_state(), "PAUSED_UNVERIFIED")
        self.assertTrue(client.has_login_session())
        self.assertFalse(client.is_authenticated())
        self.assertFalse(client.is_valid())
        self.assertIsNone(client.get_license_info())
        self.assertEqual(client.get_tier(), "None")
        self.storage.realtime_signed_heartbeat(True, {"valid": True})
        self.assertTrue(client.is_authenticated())
        self.assertEqual(client.get_tier(), "Pro")
        self.assertEqual(client.get_connection_state(), "HTTP_FALLBACK")

    def test_grace_is_bounded_and_revocation_never_gets_grace(self):
        self.storage.offline_grace_seconds = 20
        self.storage.apply_signed_realtime_policy(True)  # verified ON retains UI after grace
        with patch("licenx.storage.time.monotonic", side_effect=[100.0, 121.0]):
            self.storage.realtime_signed_heartbeat(False, {"code":"SERVER_UNREACHABLE"})
            self.assertEqual(self.storage.get_realtime_state(), "OFFLINE_GRACE")
            self.assertTrue(self.storage.is_authorized())
            self.storage.realtime_signed_heartbeat(False, {"code":"TIMEOUT"})
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.assertFalse(self.storage.is_authorized())
        revoked = Mock()
        self.storage.on_invalidated = revoked
        self.storage.realtime_signed_heartbeat(False, {"code":"LICENSE_INACTIVE"})
        revoked.assert_called_once_with("LICENSE_INACTIVE")
        self.assertEqual(self.storage.get_realtime_state(), "INVALIDATED")
        self.assertFalse(self.storage.is_authorized())

    def test_signed_app_policy_changes_network_error_continuity(self):
        snapshot = {
            "type": "license.snapshot", "app_id": "app-one",
            "license_id": "lic-1", "device_id": "device-1",
            "version": 3, "valid": True, "server_time": int(time.time() * 1000),
            "keep_login_on_network_error": True,
        }
        self.worker._verify_snapshot(signed(snapshot, self.key))
        self.assertTrue(self.storage._keep_login_on_network_error)
        # App policy is part of the signature: payload tampering is rejected.
        forged = signed(snapshot, self.key)
        forged["keep_login_on_network_error"] = False
        with self.assertRaises(_RealtimeSecurityError):
            self.worker._verify_snapshot(forged)
        snapshot["version"] = 4
        snapshot["keep_login_on_network_error"] = False
        self.worker._verify_snapshot(signed(snapshot, self.key))
        self.assertFalse(self.storage._keep_login_on_network_error)
        snapshot["version"] = 5
        snapshot["keep_login_on_network_error"] = "true"
        with self.assertRaises(_RealtimeSecurityError):
            self.worker._verify_snapshot(signed(snapshot, self.key))

    def test_policy_off_invalidates_after_network_grace_and_policy_on_pauses(self):
        invalidated = Mock()
        self.storage.on_invalidated = invalidated
        self.storage.offline_grace_seconds = 0
        self.assertFalse(self.storage._keep_login_on_network_error)
        self.storage.realtime_signed_heartbeat(False, {"code": "TIMEOUT"})
        invalidated.assert_called_once_with("NETWORK_GRACE_EXPIRED")
        self.assertEqual(self.storage.get_realtime_state(), "INVALIDATED")
        self.assertFalse(self.storage.is_authorized())

        # A second opt-in session has a signed ON policy and retains UI only.
        fresh = BackgroundLicenseWorker("policy-on", offline_grace_seconds=0)
        fresh.enable_realtime()
        fresh._running = True
        fresh.apply_signed_realtime_policy(True)
        fresh.on_invalidated = Mock()
        fresh.realtime_signed_heartbeat(False, {"code": "SERVER_UNREACHABLE"})
        self.assertEqual(fresh.get_realtime_state(), "PAUSED_UNVERIFIED")
        fresh.on_invalidated.assert_not_called()
        self.assertFalse(fresh.is_authorized())
        fresh.realtime_signed_heartbeat(True, {"valid": True})
        self.assertTrue(fresh.is_authorized())
        fresh.stop_monitoring()

    def test_old_snapshot_without_policy_defaults_secure_off(self):
        self.storage.apply_signed_realtime_policy(True)
        snap = {
            "type": "license.snapshot", "app_id": "app-one",
            "license_id": "lic-1", "device_id": "device-1",
            "version": 1, "valid": True,
            "server_time": int(time.time() * 1000),
        }
        self.worker._verify_snapshot(signed(snap, self.key))
        self.assertFalse(self.storage._keep_login_on_network_error)

    def test_stop_is_idempotent_and_does_not_persist_tokens(self):
        sock = FakeWebSocket([])
        self.worker._socket = sock
        self.worker.stop()
        self.worker.stop()
        self.assertTrue(sock.closed)
        self.assertIsNone(self.worker._socket)
        with tempfile.TemporaryDirectory() as d:
            self.storage._session_file = os.path.join(d, "no-plaintext-license.dat")
            self.storage.save_session("SHOULD-NOT-SAVE", {"ticket": "A"*43})
            self.assertFalse(os.path.exists(self.storage._session_file))

    def test_realtime_disabled_preserves_original_auth_contract(self):
        client = XLicenseClient.__new__(XLicenseClient)
        client.config = SDKConfig(useWebSocket=False)
        client._authenticated = False
        client._license_payload = {"valid": True, "tier": "Legacy"}
        self.assertFalse(client.is_authenticated())
        self.assertEqual(client.get_tier(), "Legacy")
        self.assertEqual(client.get_license_info()["tier"], "Legacy")
        self.assertEqual(client.get_connection_state(), "HTTP_ONLY")

    def test_start_never_blocks_the_calling_thread(self):
        started = threading.Event()
        def slow_run():
            started.set()
            self.worker._stop_event.wait(timeout=0.5)
        with patch.object(self.worker, "_run", side_effect=slow_run):
            began = time.monotonic()
            self.worker.start()
            self.assertLess(time.monotonic() - began, 0.2)
            self.assertTrue(started.wait(timeout=0.3))
            self.worker.stop()


if __name__ == "__main__":
    unittest.main()
