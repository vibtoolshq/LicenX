"""Focused offline heartbeat recovery and bounded HTTP retry regressions.

No live server, database, or license credentials are used.
"""
import contextlib
import io
import ssl
import unittest
import urllib.error
from unittest.mock import Mock, patch

from licenx import server
from licenx.config import SDKConfig
from licenx.server import ServerCommunicator
from licenx.storage import BackgroundLicenseWorker


class _RequestsErrors:
    class SSLError(Exception):
        pass

    class ConnectionError(Exception):
        pass

    class Timeout(Exception):
        pass


class _FakeRequests:
    exceptions = _RequestsErrors

    def __init__(self, responses=()):
        self.responses = iter(responses)
        self.post_calls = 0
        self.get_calls = 0

    def post(self, *_args, **_kwargs):
        self.post_calls += 1
        value = next(self.responses)
        if isinstance(value, Exception):
            raise value
        return value

    def get(self, *_args, **_kwargs):
        self.get_calls += 1
        value = next(self.responses)
        if isinstance(value, Exception):
            raise value
        return value


class _Response:
    def __init__(self, code, body):
        self.status_code = code
        self.body = body

    def json(self):
        return self.body


class HeartbeatRecoveryTests(unittest.TestCase):
    @staticmethod
    def run_worker(steps, *, grace=1200, interval=600, callback=None):
        """Run the same worker loop synchronously with a virtual monotonic clock."""
        clock = [0.0]
        waits = []
        invalidations = []
        communicator = Mock()
        communicator.ping_heartbeat.side_effect = steps
        worker = BackgroundLicenseWorker(
            "test-app", ping_interval_seconds=interval,
            offline_grace_seconds=grace,
            on_invalidated=invalidations.append,
            on_heartbeat_success=callback,
        )
        worker._server_communicator = communicator
        worker._current_license_key = "REDACTED"
        worker._current_hwid = "HWID"
        worker._running = True

        def fake_wait(seconds):
            waits.append(seconds)
            clock[0] += seconds
            # Once supplied response sequence is exhausted, stop before another ping.
            return len(waits) > len(steps) and worker._remaining_grace_seconds() is None

        worker._stop_event.wait = fake_wait
        with patch("licenx.storage.time.monotonic", side_effect=lambda: clock[0]):
            worker._worker_loop()
        return waits, invalidations, communicator, worker

    def test_retries_at_30_seconds_during_grace_and_restores_normal_interval(self):
        callbacks = []
        waits, invalidations, communicator, worker = self.run_worker(
            [(False, {"code": "TIMEOUT"}), (True, {"valid": True})],
            callback=callbacks.append,
        )
        self.assertEqual(waits, [600, 30, 600])
        self.assertEqual(communicator.ping_heartbeat.call_count, 2)
        self.assertEqual(invalidations, [])
        self.assertEqual(callbacks, [{"valid": True}])
        self.assertIsNone(worker._remaining_grace_seconds())

    def test_grace_boundary_invalidates_without_extra_request(self):
        waits, invalidations, communicator, _ = self.run_worker(
            [(False, {"code": "SERVER_UNREACHABLE"}), (False, {"code": "TIMEOUT"})],
            grace=45,
        )
        self.assertEqual(waits, [600, 30, 15])
        self.assertEqual(communicator.ping_heartbeat.call_count, 2)
        self.assertEqual(invalidations, ["Offline grace period expired"])

    def test_signed_security_failure_invalidates_immediately(self):
        waits, invalidations, communicator, _ = self.run_worker(
            [(False, {"code": "HEARTBEAT_SIGNATURE_FAILED"})],
            grace=1200,
        )
        self.assertEqual(waits, [600])
        self.assertEqual(communicator.ping_heartbeat.call_count, 1)
        self.assertTrue(invalidations)

    def test_unexpected_exception_does_not_expose_secret_to_callback(self):
        waits, invalidations, _, _ = self.run_worker(
            [RuntimeError("SECRET-PRIVATE-TOKEN")],
            grace=0,
        )
        self.assertEqual(waits, [600])
        self.assertEqual(len(invalidations), 1)
        self.assertNotIn("SECRET", invalidations[0])

    def test_callback_errors_do_not_log_raw_details(self):
        def callback(_payload):
            raise RuntimeError("SECRET-CALLBACK-TOKEN")

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.run_worker([(True, {"valid": True})], callback=callback)
        self.assertNotIn("SECRET", out.getvalue())


class BoundedTransportTests(unittest.TestCase):
    def setUp(self):
        self.communicator = ServerCommunicator(
            SDKConfig(server_url="https://license.example", app_name="example")
        )

    def test_heartbeat_uses_configurable_bounded_timeout(self):
        for configured, expected in ((35, 20), (7, 7), (0, 1), (-5, 1), (1000, 20)):
            with self.subTest(configured=configured):
                self.communicator.config.request_timeout_seconds = configured
                with patch.object(self.communicator, "_http_post", return_value=(408, {"code": "TIMEOUT"})) as send:
                    self.communicator.ping_heartbeat("TEST", "HWID")
                self.assertEqual(send.call_args.args[2], expected)

    def test_requests_heartbeat_retries_three_times_and_redacts_errors(self):
        fake = _FakeRequests([_RequestsErrors.ConnectionError("SECRET-RAW")] * 3)
        with patch.object(server, "requests", fake, create=True), patch.object(server, "HAS_REQUESTS", True), patch.object(server.time, "sleep") as sleep:
            status, data = self.communicator._http_post(
                "https://license.example/api/v1/license/ping", {}, 7
            )
        self.assertEqual(fake.post_calls, 3)
        self.assertEqual(sleep.call_args_list[0].args, (1.0,))
        self.assertEqual(sleep.call_args_list[1].args, (2.0,))
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(status, 503)
        self.assertEqual(data["code"], "SERVER_UNREACHABLE")
        self.assertNotIn("SECRET", str(data))

    def test_normal_post_keeps_existing_two_attempts(self):
        fake = _FakeRequests([_RequestsErrors.Timeout("SECRET")] * 2)
        with patch.object(server, "requests", fake, create=True), patch.object(server, "HAS_REQUESTS", True), patch.object(server.time, "sleep") as sleep:
            status, data = self.communicator._http_post(
                "https://license.example/api/v1/license/validate", {}, 9
            )
        self.assertEqual(fake.post_calls, 2)
        self.assertEqual(sleep.call_count, 1)
        self.assertEqual(sleep.call_args.args, (0.5,))
        self.assertEqual(status, 408)
        self.assertEqual(data["code"], "TIMEOUT")

    def test_requests_get_retry_recovers_after_second_failure(self):
        fake = _FakeRequests([
            _RequestsErrors.Timeout("SECRET"),
            _RequestsErrors.ConnectionError("SECRET"),
            _Response(200, {"status": "online"}),
        ])
        with patch.object(server, "requests", fake, create=True), patch.object(server, "HAS_REQUESTS", True), patch.object(server.time, "sleep") as sleep:
            status, data = self.communicator._http_get("https://license.example/api/health", 5)
        self.assertEqual((status, data), (200, {"status": "online"}))
        self.assertEqual(fake.get_calls, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1.0, 2.0])

    def test_http_rejection_is_never_retried(self):
        fake = _FakeRequests([_Response(403, {"code": "REVOKED"})])
        with patch.object(server, "requests", fake, create=True), patch.object(server, "HAS_REQUESTS", True), patch.object(server.time, "sleep") as sleep:
            status, data = self.communicator._http_post(
                "https://license.example/api/v1/license/ping", {}, 5
            )
        self.assertEqual(status, 403)
        self.assertEqual(fake.post_calls, 1)
        sleep.assert_not_called()
        self.assertEqual(data["code"], "REVOKED")

    def test_tls_failure_never_retried(self):
        fake = _FakeRequests([_RequestsErrors.SSLError("SECRET-CERT")])
        with patch.object(server, "requests", fake, create=True), patch.object(server, "HAS_REQUESTS", True), patch.object(server.time, "sleep") as sleep:
            status, data = self.communicator._http_post(
                "https://license.example/api/v1/license/ping", {}, 5
            )
        self.assertEqual(fake.post_calls, 1)
        self.assertEqual(status, 495)
        self.assertEqual(data["code"], "SSL_ERROR")
        self.assertNotIn("SECRET", str(data))
        sleep.assert_not_called()

    def test_urllib_ping_retries_with_bounded_backoff(self):
        err = urllib.error.URLError(OSError("SECRET"))
        with patch.object(server, "HAS_REQUESTS", False), patch.object(server.urllib.request, "urlopen", side_effect=err) as call, patch.object(server.time, "sleep") as sleep:
            status, data = self.communicator._http_post(
                "https://license.example/api/v1/license/ping", {}, 7
            )
        self.assertEqual(call.call_count, 3)
        self.assertEqual([c.args[0] for c in sleep.call_args_list], [1.0, 2.0])
        self.assertEqual(status, 503)
        self.assertEqual(data["code"], "SERVER_UNREACHABLE")
        self.assertNotIn("SECRET", str(data))

    def test_urllib_get_tls_error_fails_closed_without_retry(self):
        err = urllib.error.URLError(ssl.SSLCertVerificationError("SECRET"))
        with patch.object(server, "HAS_REQUESTS", False), patch.object(server.urllib.request, "urlopen", side_effect=err) as call, patch.object(server.time, "sleep") as sleep:
            status, data = self.communicator._http_get("https://license.example/api/health", 7)
        self.assertEqual(call.call_count, 1)
        self.assertEqual(status, 495)
        self.assertEqual(data["code"], "SSL_ERROR")
        self.assertNotIn("SECRET", str(data))
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
