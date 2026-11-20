"""WS-03 focused regressions. No live license, VPS, database or credentials."""
import base64
import json
import os
import ssl
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
        self.pings = []

    def send(self, msg):
        self.sent.append(json.loads(msg))

    def recv(self):
        if self.frames:
            return json.dumps(self.frames.pop(0), ensure_ascii=False)
        raise StopIteration("test socket closed")

    def settimeout(self, value):
        self.timeouts.append(value)

    def ping(self, payload):
        self.pings.append(payload)

    def recv_data(self, control_frame=False):
        return FakeWebSocketModule.ABNF.OPCODE_TEXT, self.recv().encode("utf-8")

    def close(self):
        self.closed = True


class FakeWebSocketModule:
    class ABNF:
        OPCODE_TEXT = 1
        OPCODE_CLOSE = 8
        OPCODE_PING = 9
        OPCODE_PONG = 10

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
            {"app_id": "app-one", "status": "active", "hwid": "HWID-TEST",
             "server_time": int(time.time() * 1000)},
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

    def test_signed_realtime_ignores_wall_clock_and_timezone_jumps(self):
        now = self.worker._server_now_ms()
        snap = {
            "type": "license.snapshot", "app_id": "app-one",
            "license_id": "lic-one", "device_id": "dev-one",
            "version": 10, "valid": True, "server_time": now,
        }
        event = {
            "type": "license.state_changed", "event_id": "11", "version": 11,
            "event_type": "license.changed", "app_id": "app-one",
            "license_id": "lic-one", "device_id": None,
            "issued_at": now, "expires_at": now + 30_000,
        }
        for zone, wall_time in (("Pacific/Honolulu", 0), ("Asia/Dhaka", 4102444800)):
            with self.subTest(zone=zone), patch.dict(os.environ, {"TZ": zone}), patch(
                "licenx.realtime.time.time", return_value=wall_time
            ):
                self.worker._identity = None
                self.worker._version = -1
                self.worker._verify_snapshot(signed(snap, self.key))
                self.assertTrue(self.worker._verify_event(signed(event, self.key)))
                self.assertFalse(self.worker._verify_event(signed(event, self.key)))

        # Server event expiry is still enforced using authenticated server time.
        with patch("licenx.realtime.time.monotonic",
                   return_value=self.worker._signed_server_clock_at + 90):
            with self.assertRaises(_RealtimeSecurityError):
                self.worker._verify_event(signed(event, self.key))

    def test_realtime_requires_a_verified_server_clock_anchor(self):
        self.worker._signed_server_time_ms = None
        self.worker._signed_server_clock_at = None
        now = int(time.time() * 1000)
        snap = {
            "type": "license.snapshot", "app_id": "app-one",
            "license_id": "lic-one", "device_id": "dev-one",
            "version": 1, "valid": True, "server_time": now,
        }
        with self.assertRaisesRegex(_RealtimeSecurityError, "REALTIME_TIME_UNVERIFIED"):
            self.worker._verify_snapshot(signed(snap, self.key))
        with patch.object(self.communicator, "ping_heartbeat", return_value=(
            True, {"valid": True, "status": "active", "server_time": now}
        )):
            self.assertTrue(self.worker._signed_check())
        self.worker._verify_snapshot(signed(snap, self.key))

    def test_missing_server_time_on_heartbeat_is_never_authorized(self):
        with patch.object(self.communicator, "ping_heartbeat", return_value=(
            True, {"valid": True, "status": "active"}
        )):
            self.assertFalse(self.worker._signed_check())
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.assertFalse(self.storage.is_authorized())
        self.assertTrue(self.storage._running)

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
        # Real SocketCore sends unsigned connected BEFORE signed snapshot.
        # Both pre-auth transport notifications must grant no authorization.
        sock = FakeWebSocket([{"type":"connected", "clientId":"synthetic"}, {"type":"welcome"}, snap, event])
        mod = FakeWebSocketModule(sock)
        def ping(_key, _hwid):
            self.worker._stop_event.set()
            return True, {"valid": True, "code": "OK", "status":"active",
                          "server_time": now}
        with patch.object(self.communicator, "_http_post", return_value=(200, {"ticket": "A"*43})), patch.object(
            self.communicator, "ping_heartbeat", side_effect=ping
        ) as signed_http:
            self.worker._run_connection(mod)
        self.assertEqual(len(mod.calls), 1)
        self.assertEqual(mod.calls[0][0], "wss://licensing.example.test/api/realtime")
        self.assertEqual(mod.calls[0][1]["header"], ["Authorization: Bearer " + "A"*43])
        self.assertTrue(mod.calls[0][1]["suppress_origin"])
        tls = mod.calls[0][1]["sslopt"]
        self.assertEqual(tls["cert_reqs"], ssl.CERT_REQUIRED)
        self.assertTrue(tls["check_hostname"])
        self.assertIsInstance(tls["context"], ssl.SSLContext)
        self.assertEqual(tls["context"].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(tls["context"].check_hostname)
        self.assertEqual(sock.sent, [{"type": "license.hello"}])
        signed_http.assert_called_once_with("TEST-LICENSE", "HWID-TEST")
        self.assertTrue(sock.closed)
        self.assertEqual(self.storage.get_realtime_state(), "CONNECTED")

    def test_loopback_ws_does_not_require_certifi_or_tls_options(self):
        sock = FakeWebSocket([{"type": "error", "code": "REALTIME_RESTORE_IN_PROGRESS"}])
        mod = FakeWebSocketModule(sock)
        with patch.object(self.worker, "_post_ticket", return_value=("A" * 43, 200)), patch.object(
            self.worker, "_socket_url", return_value="ws://localhost:3000/api/realtime"
        ), patch.object(
            self.worker, "_signed_check", return_value=False
        ), patch("licenx.realtime._verified_wss_context", side_effect=AssertionError("no CA on ws")):
            self.worker._run_connection(mod)
        self.assertEqual(mod.calls[0][0], "ws://localhost:3000/api/realtime")
        self.assertNotIn("sslopt", mod.calls[0][1])
        self.assertTrue(sock.closed)

    def test_known_wss_control_errors_recheck_https_not_fake_snapshot(self):
        for code in ("REALTIME_RESTORE_IN_PROGRESS",
                     "REALTIME_AUTH_REVOKED", "REALTIME_ALREADY_REGISTERED"):
            with self.subTest(code=code):
                # WSS transport frames are untrusted: neither logout nor
                # authorization can come from an unsigned control response.
                sock = FakeWebSocket([{"type": "connected"},
                                      {"type": "error", "code": code}])
                invalidated = Mock()
                self.storage.on_invalidated = invalidated
                with patch.object(self.worker, "_post_ticket", return_value=("A" * 43, 200)), patch.object(
                    self.worker, "_signed_check", return_value=False
                ) as recheck, patch.object(self.worker, "_report") as diagnostic:
                    outcome = self.worker._run_connection(FakeWebSocketModule(sock))
                self.assertEqual(outcome, "HTTP_FALLBACK")
                recheck.assert_called_once()
                diagnostic.assert_called_once_with(
                    "ws_upgrade", "REALTIME_SOCKET_ERROR",
                )
                self.assertTrue(sock.closed)
                self.assertFalse(self.storage.is_authorized())
                invalidated.assert_not_called()
                self.assertTrue(self.storage._running)

    def test_unknown_wss_control_frame_is_still_security_error(self):
        sock = FakeWebSocket([{"type": "connected"},
                              {"type": "error", "code": "UNTRUSTED_FRAME"}])
        with patch.object(self.worker, "_post_ticket", return_value=("A" * 43, 200)):
            with self.assertRaisesRegex(_RealtimeSecurityError, "REALTIME_UNEXPECTED_FRAME"):
                self.worker._run_connection(FakeWebSocketModule(sock))
        self.assertTrue(sock.closed)
        self.assertFalse(self.storage.is_authorized())
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.assertTrue(self.storage._running, "unsigned control must not force a UI logout")

    def test_unexpected_frame_after_signed_snapshot_pauses_immediately(self):
        # A trusted WSS snapshot may have reenabled access, but a subsequent
        # unsigned unexpected frame must revoke protected-operation permission
        # BEFORE bubbling the security exception to the reconnect worker.
        snapshot = signed({
            "type": "license.snapshot", "app_id": "app-one",
            "license_id": "lic-one", "device_id": "dev-one",
            "valid": True, "version": 1,
            "server_time": self.worker._signed_server_time_ms,
        }, self.key)
        sock = FakeWebSocket([snapshot, {"type": "unexpected.control"}])
        with patch.object(self.worker, "_post_ticket", return_value=("A" * 43, 200)):
            with self.assertRaisesRegex(_RealtimeSecurityError, "REALTIME_UNEXPECTED_FRAME"):
                self.worker._run_connection(FakeWebSocketModule(sock))
        self.assertTrue(sock.closed)
        self.assertFalse(self.storage.is_authorized())
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.assertTrue(self.storage._running)

    def test_half_open_wss_requires_matching_pong_and_pauses_license_actions(self):
        server_epoch = self.worker._signed_server_time_ms
        snap = signed({
            "type": "license.snapshot", "app_id": "app-one",
            "license_id": "lic-one", "device_id": "dev-one",
            "valid": True, "version": 5, "server_time": server_epoch,
        }, self.key)
        clock = [500.0]
        self.worker._signed_server_clock_at = clock[0]
        invalidated = Mock()
        self.storage.on_invalidated = invalidated

        class BlackholeSocket(FakeWebSocket):
            def recv_data(self, control_frame=False):
                clock[0] += 8.0
                if self.pings and not getattr(self, "bogus_pong_sent", False):
                    self.bogus_pong_sent = True
                    return FakeWebSocketModule.ABNF.OPCODE_PONG, b"forged-pong"
                raise FakeWebSocketModule.WebSocketTimeoutException()

        sock = BlackholeSocket([snap])
        mod = FakeWebSocketModule(sock)
        with patch.object(self.worker, "_post_ticket", return_value=("A" * 43, 200)), patch(
            "licenx.realtime.time.monotonic", side_effect=lambda: clock[0]
        ):
            with self.assertRaisesRegex(_RealtimeSecurityError, "REALTIME_LIVENESS_EXPIRED"):
                self.worker._run_connection(mod)
        self.assertEqual(len(sock.pings), 1)
        self.assertTrue(sock.closed)
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.assertFalse(self.storage.is_authorized())
        invalidated.assert_not_called()
        self.assertTrue(self.storage._running)

    def test_matching_pong_keeps_healthy_wss_connected_without_granting_new_rights(self):
        server_epoch = self.worker._signed_server_time_ms
        snap = signed({
            "type": "license.snapshot", "app_id": "app-one",
            "license_id": "lic-one", "device_id": "dev-one",
            "valid": True, "version": 5, "server_time": server_epoch,
        }, self.key)
        clock = [500.0]
        self.worker._signed_server_clock_at = clock[0]

        class ResponsiveSocket(FakeWebSocket):
            def recv_data(self, control_frame=False):
                clock[0] += 8.0
                if self.pings:
                    self.pong_matched = True
                    self_worker._stop_event.set()
                    return FakeWebSocketModule.ABNF.OPCODE_PONG, self.pings[-1]
                raise FakeWebSocketModule.WebSocketTimeoutException()

        self_worker = self.worker
        sock = ResponsiveSocket([snap])
        mod = FakeWebSocketModule(sock)
        with patch.object(self.worker, "_post_ticket", return_value=("A" * 43, 200)), patch(
            "licenx.realtime.time.monotonic", side_effect=lambda: clock[0]
        ):
            self.worker._run_connection(mod)
        self.assertTrue(sock.pong_matched)
        self.assertEqual(len(sock.pings), 1)
        self.assertTrue(sock.closed)
        self.assertEqual(self.storage.get_realtime_state(), "CONNECTED")

    def test_initial_wss_ticket_outage_uses_http_and_keeps_retrying(self):
        self.storage.on_invalidated = Mock()
        self.storage.offline_grace_seconds = 0
        with patch.object(self.worker, "_post_ticket", return_value=(None, 503)), patch.object(
            self.worker, "_signed_check", return_value=True
        ), patch.object(self.storage, "enter_signed_http_fallback", return_value=True):
            self.assertEqual(self.worker._run_connection(Mock()), "HTTP_FALLBACK")
        self.storage.on_invalidated.assert_not_called()
        # A successful HTTP fallback must not permanently terminate the WSS worker.
        calls = []
        def stop_after_two(attempt):
            calls.append(attempt)
            if len(calls) == 2:
                self.worker._stop_event.set()
        with patch.dict(sys.modules, {"websocket": Mock()}), patch.object(
            self.worker, "_run_connection",
            side_effect=[_RealtimeSecurityError("REALTIME_SIGNATURE_INVALID"), "HTTP_FALLBACK"],
        ) as run, patch.object(
            self.worker, "_signed_check", return_value=False
        ), patch.object(self.worker, "_retry_wait", side_effect=stop_after_two):
            self.worker._run()
        self.assertEqual(run.call_count, 2)
        self.assertEqual(len(calls), 2)
        self.storage.on_invalidated.assert_not_called()
        self.assertTrue(self.storage._running)
        self.assertFalse(self.storage.is_authorized())

    def test_verified_server_terminal_denial_invalidates_only_once(self):
        callback = Mock()
        self.storage.on_invalidated = callback
        self.storage.realtime_signed_heartbeat(False, {
            "code": "DEVICE_UNBOUND", "_licenx_terminal_denial": True,
        })
        self.storage.realtime_signed_heartbeat(False, {
            "code": "DEVICE_UNBOUND", "_licenx_terminal_denial": True,
        })
        callback.assert_called_once_with("DEVICE_UNBOUND")
        self.assertEqual(self.storage.get_realtime_state(), "INVALIDATED")

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
        with patch("licenx.storage.time.monotonic", side_effect=[100.0, 101.0, 121.0]):
            self.storage.realtime_signed_heartbeat(False, {"code":"SERVER_UNREACHABLE"})
            self.assertEqual(self.storage.get_realtime_state(), "OFFLINE_GRACE")
            self.assertTrue(self.storage.is_authorized())
            self.storage.realtime_signed_heartbeat(False, {"code":"TIMEOUT"})
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.assertFalse(self.storage.is_authorized())
        revoked = Mock()
        self.storage.on_invalidated = revoked
        self.storage.realtime_signed_heartbeat(False, {
            "code": "LICENSE_INACTIVE", "_licenx_terminal_denial": True
        })
        revoked.assert_called_once_with("LICENSE_INACTIVE")
        self.assertEqual(self.storage.get_realtime_state(), "INVALIDATED")
        self.assertFalse(self.storage.is_authorized())

    def test_signed_legacy_policy_flag_does_not_change_ui_continuity(self):
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
        # Both stored signed legacy policy values have exactly the same
        # modern UI-retention behavior; protected operations still fail closed.
        self.storage.offline_grace_seconds = 0
        self.storage.on_invalidated = Mock()
        self.storage.realtime_signed_heartbeat(False, {"code": "TIMEOUT"})
        self.assertTrue(self.storage._running)
        self.assertFalse(self.storage.is_authorized())
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.storage.on_invalidated.assert_not_called()
        snapshot["version"] = 5
        snapshot["keep_login_on_network_error"] = "true"
        with self.assertRaises(_RealtimeSecurityError):
            self.worker._verify_snapshot(signed(snapshot, self.key))

    def test_policy_off_retains_ui_but_pauses_after_network_grace(self):
        invalidated = Mock()
        self.storage.on_invalidated = invalidated
        self.storage.offline_grace_seconds = 0
        self.assertFalse(self.storage._keep_login_on_network_error)
        self.storage.realtime_signed_heartbeat(False, {"code": "TIMEOUT"})
        invalidated.assert_not_called()
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.assertTrue(self.storage._running)
        self.assertFalse(self.storage.is_authorized())
        self.storage.realtime_signed_heartbeat(True, {"valid": True})
        self.assertEqual(self.storage.get_realtime_state(), "HTTP_FALLBACK")
        self.assertTrue(self.storage.is_authorized())

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


    def test_clean_wss_close_starts_bounded_grace_without_ui_logout(self):
        self.storage.offline_grace_seconds = 20
        invalidated = Mock()
        self.storage.on_invalidated = invalidated
        snap = signed({
            "type": "license.snapshot", "app_id": "app-one",
            "license_id": "lic-one", "device_id": "dev-one",
            "valid": True, "version": 4,
            "server_time": self.worker._server_now_ms(),
        }, self.key)

        class ClosingSocket(FakeWebSocket):
            def recv_data(self, control_frame=False):
                return FakeWebSocketModule.ABNF.OPCODE_CLOSE, b""

        socket = ClosingSocket([snap])
        with patch.object(self.worker, "_post_ticket", return_value=("A" * 43, 200)):
            self.worker._run_connection(FakeWebSocketModule(socket))
        self.assertTrue(socket.closed)
        self.assertEqual(self.storage.get_realtime_state(), "OFFLINE_GRACE")
        self.assertTrue(self.storage.is_authorized())
        first_disconnection = self.storage._offline_since
        self.assertIsNotNone(first_disconnection)
        with patch("licenx.storage.time.monotonic", return_value=first_disconnection + 10):
            self.storage.set_realtime_connected(False)
            self.assertEqual(self.storage._offline_since, first_disconnection)
        client = XLicenseClient.__new__(XLicenseClient)
        client.config = self.config
        client.storage = self.storage
        client._authenticated = True
        # Use an unambiguous post-deadline instant across Python/OS float clocks.
        with patch("licenx.storage.time.monotonic", return_value=first_disconnection + 21):
            self.assertEqual(self.storage.get_realtime_state(), "OFFLINE_GRACE")
            self.assertEqual(client.get_connection_state(), "PAUSED_UNVERIFIED")
            self.assertFalse(client.is_authenticated())
            self.assertTrue(client.has_login_session())
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        invalidated.assert_not_called()
        with patch.object(self.communicator, "ping_heartbeat", return_value=(
            True, {"valid": True, "status": "active",
                   "server_time": int(time.time() * 1000)},
        )):
            self.assertTrue(self.worker._signed_check())
        self.assertTrue(self.storage.is_authorized())
        self.assertEqual(self.storage.get_realtime_state(), "HTTP_FALLBACK")
        invalidated.assert_not_called()

    def test_missing_websocket_dependency_preserves_http_permission_boundary(self):
        with patch.dict(sys.modules, {"websocket": None}):
            self.worker._run()
        self.assertEqual(self.storage.get_realtime_state(), "HTTP_FALLBACK")
        self.assertTrue(self.storage.is_authorized())
        self.storage.pause_for_signed_reverification()
        with patch.dict(sys.modules, {"websocket": None}):
            self.worker._run()
        self.assertEqual(self.storage.get_realtime_state(), "PAUSED_UNVERIFIED")
        self.assertFalse(self.storage.is_authorized())


if __name__ == "__main__":
    unittest.main()
