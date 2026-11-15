import io
import json
import ssl
import unittest
import urllib.error
from unittest.mock import patch

from licenx import server
from licenx.config import SDKConfig
from licenx.server import ServerCommunicator


class _FakeResponse:
    status_code = 502

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return self.payload


class _FakeRequestsExceptions:
    class SSLError(Exception):
        pass

    class ConnectionError(Exception):
        pass

    class Timeout(Exception):
        pass


class _FakeRequests:
    exceptions = _FakeRequestsExceptions

    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error

    def post(self, *_args, **_kwargs):
        if self.error:
            raise self.error
        return self.response

    def get(self, *_args, **_kwargs):
        if self.error:
            raise self.error
        return self.response


class _UrlResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def getcode(self):
        return 200

    def read(self):
        return self.payload


class TransportErrorRedactionTests(unittest.TestCase):
    def setUp(self):
        self.communicator = ServerCommunicator(
            SDKConfig(server_url="https://license.example.com")
        )

    def test_requests_transport_redacts_response_errors_for_get_and_post(self):
        request_id = "74dedd91-e751-465e-a17e-6f6ceebedd8a"
        fake_requests = _FakeRequests(response=_FakeResponse({
            "error": "backend detail sentinel",
            "code": "UPSTREAM_FAILURE",
            "request_id": request_id,
            "diagnostic": {"error_message": "private diagnostic sentinel"},
            "response_body": "response body secret sentinel",
        }))
        with patch.object(server, "HAS_REQUESTS", True), patch.object(
            server, "requests", fake_requests, create=True
        ):
            for method in (self.communicator._http_get, self.communicator._http_post):
                with self.subTest(method=method.__name__):
                    status, data = (
                        method("https://license.example.com/test", 3)
                        if method == self.communicator._http_get
                        else method("https://license.example.com/test", {}, 3)
                    )
                    self.assertEqual(status, 502)
                    self.assertEqual(data, {
                        "error": "License server rejected the request (HTTP 502)",
                        "code": "UPSTREAM_FAILURE",
                        "request_id": request_id,
                    })
                    self.assertNotIn("backend detail sentinel", data["error"])
                    self.assertNotIn("response body secret sentinel", str(data))
                    self.assertNotIn("private diagnostic sentinel", str(data))

    def test_requests_transport_exception_does_not_expose_exception_text(self):
        fake_requests = _FakeRequests(error=RuntimeError("private path sentinel"))
        with patch.object(server, "HAS_REQUESTS", True), patch.object(
            server, "requests", fake_requests, create=True
        ):
            status, data = self.communicator._http_get(
                "https://license.example.com/test", 3
            )

        self.assertEqual(status, 500)
        self.assertEqual(data, {
            "error": "License server request failed",
            "code": "REQUEST_ERROR",
        })
        self.assertNotIn("private path sentinel", str(data))

    def test_urllib_transport_redacts_response_errors_for_get_and_post(self):
        raw_response = _UrlResponse(
            json.dumps({"error": "backend detail sentinel", "code": "UPSTREAM_FAILURE"}).encode()
        )
        with patch.object(server, "HAS_REQUESTS", False), patch.object(
            server.urllib.request, "urlopen", return_value=raw_response
        ):
            for method in (self.communicator._http_get, self.communicator._http_post):
                with self.subTest(method=method.__name__):
                    status, data = (
                        method("https://license.example.com/test", 3)
                        if method == self.communicator._http_get
                        else method("https://license.example.com/test", {}, 3)
                    )
                    self.assertEqual(status, 200)
                    self.assertEqual(data["error"], "License server reported a validation error")
                    self.assertNotIn("backend detail sentinel", str(data))

    def test_urllib_http_error_redacts_body_and_preserves_safe_code(self):
        request_id = "ec74115f-5253-4a31-9adb-22d21c904bb6"
        error = urllib.error.HTTPError(
            "https://license.example.com/test",
            403,
            "forbidden",
            {},
            io.BytesIO(
                json.dumps({
                    "error": "private backend sentinel",
                    "code": "LICENSE_REJECTED",
                    "request_id": request_id,
                    "diagnostic": {"error_message": "private diagnostic sentinel"},
                    "response_body": "private response sentinel",
                }).encode()
            ),
        )
        with patch.object(server, "HAS_REQUESTS", False), patch.object(
            server.urllib.request, "urlopen", side_effect=error
        ):
            status, data = self.communicator._http_get(
                "https://license.example.com/test", 3
            )

        self.assertEqual(status, 403)
        self.assertEqual(data["code"], "LICENSE_REJECTED")
        self.assertEqual(data["error"], "License server rejected the request (HTTP 403)")
        self.assertEqual(data["request_id"], request_id)
        self.assertNotIn("private backend sentinel", str(data))
        self.assertNotIn("private diagnostic sentinel", str(data))
        self.assertNotIn("private response sentinel", str(data))

    def test_bounded_denial_candidate_passes_without_exposing_private_fields(self):
        import hashlib
        from licenx.server import ServerCommunicator

        candidate = {
            "valid": False, "code": "DEVICE_UNBOUND",
            "nonce": "safe_nonce_1234567890123456789012345678",
            "request_binding": hashlib.sha256(b"synthetic-binding").hexdigest(),
            "server_time": 123456789,
            "signature": "A" * 88,
            "error": "private backend stack sentinel",
            "private_key": "private key sentinel",
            "diagnostic": {"secret": "secret diagnostic sentinel"},
        }
        safe = ServerCommunicator._safe_response(403, candidate)
        for key in ("valid", "code", "nonce", "request_binding",
                    "server_time", "signature"):
            self.assertEqual(safe[key], candidate[key])
        for secret in ("private backend", "private key", "secret diagnostic"):
            self.assertNotIn(secret, str(safe))
        # Untrusted 200/502 responses and malformed 403 candidate are not
        # allowed to carry a signature through general error sanitization.
        for status, altered in (
            (502, candidate),
            (403, {**candidate, "signature": "short"}),
            (403, {**candidate, "request_binding": "not-a-hash"}),
            (403, {**candidate, "valid": True}),
        ):
            with self.subTest(status=status, altered=altered):
                result = ServerCommunicator._safe_response(status, altered)
                self.assertNotIn("signature", result)
                self.assertNotIn("private_key", result)

    def test_invalid_or_missing_request_ids_are_omitted_for_both_transports(self):
        payloads = [
            {"error": "backend detail", "code": "UPSTREAM_FAILURE", "request_id": "not-a-uuid"},
            {"error": "backend detail", "code": "UPSTREAM_FAILURE", "request_id": 42},
            {"error": "backend detail", "code": "UPSTREAM_FAILURE"},
        ]

        for payload in payloads:
            expected = {
                "error": "License server rejected the request (HTTP 502)",
                "code": "UPSTREAM_FAILURE",
            }
            with self.subTest(transport="requests", request_id=payload.get("request_id")):
                fake_requests = _FakeRequests(response=_FakeResponse(payload))
                with patch.object(server, "HAS_REQUESTS", True), patch.object(
                    server, "requests", fake_requests, create=True
                ):
                    status, data = self.communicator._http_post(
                        "https://license.example.com/test", {}, 3
                    )
                self.assertEqual(status, 502)
                self.assertEqual(data, expected)

            with self.subTest(transport="urllib", request_id=payload.get("request_id")):
                error = urllib.error.HTTPError(
                    "https://license.example.com/test",
                    502,
                    "bad gateway",
                    {},
                    io.BytesIO(json.dumps(payload).encode()),
                )
                with patch.object(server, "HAS_REQUESTS", False), patch.object(
                    server.urllib.request, "urlopen", side_effect=error
                ):
                    status, data = self.communicator._http_post(
                        "https://license.example.com/test", {}, 3
                    )
                self.assertEqual(status, 502)
                self.assertEqual(data, expected)

    def test_urllib_tls_verification_failure_is_not_reported_as_network_outage(self):
        error = urllib.error.URLError(
            ssl.SSLCertVerificationError("certificate verification failed")
        )
        with patch.object(server, "HAS_REQUESTS", False), patch.object(
            server.urllib.request, "urlopen", side_effect=error
        ):
            status, data = self.communicator._http_post(
                "https://license.example.com/test", {}, 3
            )

        self.assertEqual(status, 495)
        self.assertEqual(data["code"], "SSL_ERROR")


if __name__ == "__main__":
    unittest.main()
