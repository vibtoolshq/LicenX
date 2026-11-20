"""
VCON Python Client SDK - Server Transport & Protocol Layer
Handles HTTP requests (with requests or native urllib fallback), SSL verification,
Ed25519 cryptographic validation, heartbeat pings, and remote unbind / logout notifications.
"""

import time
import json
import base64
import ipaddress
import re
import socket
import secrets
import ssl
import urllib.error
import urllib.request
from typing import Dict, Any, Tuple, Optional
from urllib.parse import urlsplit
from .config import SDKConfig
from .diagnostics import SafeDiagnosticBuffer, tls_verify_code

# Graceful HTTP Transport import (requests preferred, urllib built-in fallback)
try:
    import requests  # type: ignore
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

# Force IPv4 resolution globally to prevent dual-stack Cloudflare AAAA timeouts on Windows RDP / restricted networks
try:
    import urllib3.util.connection as urllib3_cn
    urllib3_cn.allowed_gai_family = lambda: socket.AF_INET
except Exception:
    pass

# Signature verification fails closed when the required cryptography package is unavailable.
try:
    from cryptography.hazmat.primitives.serialization import load_pem_public_key  # type: ignore
    HAS_CRYPTOGRAPHY = True
except ImportError:
    HAS_CRYPTOGRAPHY = False


class ServerCommunicator:
    def __init__(self, config: SDKConfig):
        self.config = config
        self.diagnostics = SafeDiagnosticBuffer()
        self._diagnostic_token = None
        self._stats_capability = None

    def record_diagnostic(self, stage, code, attempt=0, verify_code=None):
        return self.diagnostics.record(stage, code, attempt, verify_code)

    def get_diagnostics(self):
        """Bounded, privacy-safe process-local events; not an authorization decision."""
        return self.diagnostics.snapshot()

    @staticmethod
    def _transport_stage(url):
        path = urlsplit(url).path
        if path.endswith("/realtime/ticket"):
            return "ticket"
        if path.endswith("/license/ping"):
            return "heartbeat"
        return "validate"

    def send_diagnostic(self, bearer_token, stage, code, attempt=0, verify_code=None):
        """Best-effort HTTPS report from an already signed login, never from UI thread."""
        if not isinstance(bearer_token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", bearer_token):
            return False
        event = self.record_diagnostic(stage, code, attempt, verify_code)
        if event is None:
            return False
        data = {k: event[k] for k in ("stage", "code", "attempt")}
        if "tls_verify_code" in event:
            data["tls_verify_code"] = event["tls_verify_code"]
        try:
            url = self._build_url("api/v1/diagnostics/report")
            request = urllib.request.Request(
                url,
                data=json.dumps(data, separators=(",", ":")).encode("utf-8"),
                headers={"Content-Type": "application/json", "Authorization": "Bearer " + bearer_token},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=3, context=ssl.create_default_context()) as response:
                return response.getcode() == 202
        except Exception:
            return False

    def _build_url(self, endpoint: str) -> str:
        """Constructs clean URL handling trailing slashes and redundant api prefixes"""
        base = self.config.server_url
        if not isinstance(base, str) or not base or base != base.strip():
            raise ValueError("server_url must be a valid absolute HTTP(S) URL")

        base = base.rstrip("/")
        if base.endswith("/api"):
            base = base[:-4]

        try:
            parsed_url = urlsplit(base)
            hostname = parsed_url.hostname
            _ = parsed_url.port
        except ValueError as error:
            raise ValueError("server_url must be a valid absolute HTTP(S) URL") from error

        if (
            parsed_url.scheme not in ("http", "https")
            or not parsed_url.netloc
            or not hostname
            or any(character.isspace() for character in base)
            or parsed_url.username is not None
            or parsed_url.password is not None
            or "?" in base
            or "#" in base
        ):
            raise ValueError("server_url must be a valid absolute HTTP(S) URL")

        is_loopback = hostname.rstrip(".").lower() == "localhost"
        if not is_loopback:
            try:
                is_loopback = ipaddress.ip_address(hostname).is_loopback
            except ValueError:
                is_loopback = False

        if parsed_url.scheme != "https" and not is_loopback:
            raise ValueError(
                "server_url must use HTTPS unless it targets localhost or a loopback IP"
            )

        endpoint = endpoint.lstrip("/")
        return f"{base}/{endpoint}"

    @staticmethod
    def canonical_json(data: Dict[str, Any]) -> str:
        """Produces canonical sorted JSON string matching server-side signing format"""
        return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    def verify_signature(self, payload: Dict[str, Any], signature_b64: str) -> bool:
        """
        Cryptographically verifies the RSA (2048/4096-bit) or Ed25519 signature
        against the server's public key.
        Guarantees response authenticity and prevents MITM or fake server bypass.
        """
        if not self.config.public_key_pem or not signature_b64:
            return False
        if not HAS_CRYPTOGRAPHY:
            return False

        try:
            pem_str = self.config.public_key_pem.strip()
            if "\\n" in pem_str and "\n" not in pem_str:
                pem_str = pem_str.replace("\\n", "\n")

            canonical_str = self.canonical_json(payload)
            signature_bytes = base64.b64decode(signature_b64)

            pub_key = load_pem_public_key(pem_str.encode("utf-8"))
            if hasattr(pub_key, "key_size"):
                # RSA 2048/4096 bit key with SHA-256
                from cryptography.hazmat.primitives.asymmetric import padding
                from cryptography.hazmat.primitives import hashes
                pub_key.verify(
                    signature_bytes,
                    canonical_str.encode("utf-8"),
                    padding.PKCS1v15(),
                    hashes.SHA256(),
                )
            else:
                # Ed25519 key
                pub_key.verify(signature_bytes, canonical_str.encode("utf-8"))
            return True
        except Exception as e:
            print("[VCON-SDK] Cryptographic signature verification failed")
            return False

    @staticmethod
    def _safe_response(status_code: int, data: Any) -> Dict[str, Any]:
        if 200 <= status_code < 300 and isinstance(data, dict):
            if any(
                isinstance(data.get(key), str)
                for key in ("error", "message", "detail")
            ):
                return {
                    **data,
                    "error": "License server reported a validation error",
                }
            return data

        code = data.get("code") if isinstance(data, dict) else None
        if not isinstance(code, str) or not re.fullmatch(r"[A-Z0-9_]{1,64}", code):
            code = f"HTTP_{status_code}" if status_code >= 400 else "INVALID_RESPONSE"
        safe_response = {
            "error": (
                f"License server rejected the request (HTTP {status_code})"
                if status_code >= 400
                else "Invalid response from license server"
            ),
            "code": code,
        }
        request_id = data.get("request_id") if isinstance(data, dict) else None
        if isinstance(request_id, str) and re.fullmatch(
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
            request_id,
            re.IGNORECASE,
        ):
            safe_response["request_id"] = request_id
        # Carry a strictly bounded *candidate* negative proof through HTTP
        # sanitization. This is not an authentication decision: ping_heartbeat
        # independently checks nonce, request binding and configured-key signature.
        terminal = {
            "NOT_FOUND", "LICENSE_INACTIVE", "LICENSE_EXPIRED",
            "APP_NOT_FOUND", "APP_INACTIVE", "DEVICE_UNBOUND",
            "DEVICE_BLOCKED", "DEVICE_LEASE_EXPIRED",
        }
        if (status_code in (403, 404) and isinstance(data, dict)
                and code in terminal and data.get("valid") is False
                and isinstance(data.get("nonce"), str)
                and re.fullmatch(r"[A-Za-z0-9_-]{16,128}", data["nonce"])
                and isinstance(data.get("request_binding"), str)
                and re.fullmatch(r"[0-9a-f]{64}", data["request_binding"])
                and type(data.get("server_time")) is int
                and data["server_time"] > 0
                and isinstance(data.get("signature"), str)
                and re.fullmatch(r"[A-Za-z0-9+/=]{64,1024}", data["signature"])):
            safe_response.update({
                key: data[key] for key in (
                    "valid", "nonce", "request_binding", "server_time", "signature"
                )
            })
        return safe_response

    def _http_post(self, url: str, json_data: Dict[str, Any], timeout: int) -> Tuple[int, Dict[str, Any]]:
        """
        Universal HTTP POST supporting requests and native urllib fallback.
        Preserves the existing single retry for normal POSTs; allows two bounded retries for heartbeat.
        Returns (status_code, response_json_dict).
        """
        retry_delays = (1.0, 2.0) if urlsplit(url).path.endswith("/api/v1/license/ping") else (0.5,)
        if HAS_REQUESTS:
            for attempt in range(len(retry_delays) + 1):
                try:
                    resp = requests.post(
                        url,
                        json=json_data,
                        timeout=timeout,
                        headers={
                            "User-Agent": f"VCON-Python-SDK/{self.config.app_name}",
                            "Content-Type": "application/json",
                        },
                    )
                    try:
                        data = resp.json()
                    except Exception:
                        data = None
                    return resp.status_code, self._safe_response(resp.status_code, data)
                except requests.exceptions.SSLError:
                    self.record_diagnostic("tls_handshake", "SDK_HTTP_TLS_ERROR")
                    return 495, {"error": "SSL handshake with license server failed", "code": "SSL_ERROR"}
                except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                    if attempt < len(retry_delays):
                        time.sleep(retry_delays[attempt])
                        continue
                    if isinstance(e, requests.exceptions.Timeout):
                        self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_TIMEOUT")
                        return 408, {"error": "Connection to license server timed out", "code": "TIMEOUT"}
                    self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_NETWORK_ERROR")
                    return 503, {"error": "Cannot connect to license server", "code": "SERVER_UNREACHABLE"}
                except Exception:
                    self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_UNEXPECTED")
                    return 500, {"error": "License server request failed", "code": "REQUEST_ERROR"}

        # Native Python standard library fallback
        post_bytes = json.dumps(json_data).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=post_bytes,
            headers={
                "User-Agent": f"VCON-Python-SDK/{self.config.app_name}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        ctx = ssl.create_default_context()
        for attempt in range(len(retry_delays) + 1):
            try:
                with urllib.request.urlopen(req, timeout=timeout, context=ctx) as response:
                    status_code = response.getcode()
                    raw_body = response.read().decode("utf-8")
                    try:
                        data = json.loads(raw_body)
                    except Exception:
                        data = None
                    return status_code, self._safe_response(status_code, data)
            except urllib.error.HTTPError as e:
                status_code = e.code
                try:
                    data = json.loads(e.read().decode("utf-8"))
                except Exception:
                    data = None
                return status_code, self._safe_response(status_code, data)
            except urllib.error.URLError as error:
                if isinstance(error.reason, ssl.SSLError):
                    self.record_diagnostic("tls_handshake", "SDK_HTTP_TLS_ERROR",
                                           verify_code=tls_verify_code(error.reason))
                    return 495, {
                        "error": "SSL handshake with license server failed",
                        "code": "SSL_ERROR",
                    }
                if attempt < len(retry_delays):
                    time.sleep(retry_delays[attempt])
                    continue
                self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_NETWORK_ERROR")
                return 503, {"error": "Cannot connect to license server", "code": "SERVER_UNREACHABLE"}
            except socket.timeout:
                if attempt < len(retry_delays):
                    time.sleep(retry_delays[attempt])
                    continue
                self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_TIMEOUT")
                return 408, {"error": "Connection to license server timed out", "code": "TIMEOUT"}
            except Exception:
                self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_UNEXPECTED")
                return 500, {"error": "License server request failed", "code": "UNKNOWN_ERROR"}

    def _http_get(self, url: str, timeout: int) -> Tuple[int, Dict[str, Any]]:
        """
        Universal HTTP GET supporting requests and native urllib fallback.
        Includes at most three attempts with bounded backoff on transport failures.
        Returns (status_code, response_json_dict).
        """
        retry_delays = (1.0, 2.0)
        if HAS_REQUESTS:
            for attempt in range(len(retry_delays) + 1):
                try:
                    resp = requests.get(
                        url,
                        timeout=timeout,
                        headers={
                            "User-Agent": f"VCON-Python-SDK/{self.config.app_name}",
                        },
                    )
                    try:
                        data = resp.json()
                    except Exception:
                        data = None
                    return resp.status_code, self._safe_response(resp.status_code, data)
                except requests.exceptions.SSLError:
                    self.record_diagnostic("tls_handshake", "SDK_HTTP_TLS_ERROR")
                    return 495, {"error": "SSL handshake with license server failed", "code": "SSL_ERROR"}
                except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                    if attempt < len(retry_delays):
                        time.sleep(retry_delays[attempt])
                        continue
                    if isinstance(e, requests.exceptions.Timeout):
                        self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_TIMEOUT")
                        return 408, {"error": "Connection to license server timed out", "code": "TIMEOUT"}
                    self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_NETWORK_ERROR")
                    return 503, {"error": "Cannot connect to license server", "code": "SERVER_UNREACHABLE"}
                except Exception:
                    self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_UNEXPECTED")
                    return 500, {"error": "License server request failed", "code": "REQUEST_ERROR"}

        # Native Python standard library fallback
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": f"VCON-Python-SDK/{self.config.app_name}",
            },
            method="GET",
        )
        ctx = ssl.create_default_context()
        for attempt in range(len(retry_delays) + 1):
            try:
                with urllib.request.urlopen(req, timeout=timeout, context=ctx) as response:
                    status_code = response.getcode()
                    raw_body = response.read().decode("utf-8")
                    try:
                        data = json.loads(raw_body)
                    except Exception:
                        data = None
                    return status_code, self._safe_response(status_code, data)
            except urllib.error.HTTPError as e:
                status_code = e.code
                try:
                    data = json.loads(e.read().decode("utf-8"))
                except Exception:
                    data = None
                return status_code, self._safe_response(status_code, data)
            except urllib.error.URLError as error:
                if isinstance(error.reason, ssl.SSLError):
                    return 495, {"error": "SSL handshake with license server failed", "code": "SSL_ERROR"}
                if attempt < len(retry_delays):
                    time.sleep(retry_delays[attempt])
                    continue
                self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_NETWORK_ERROR")
                return 503, {"error": "Cannot connect to license server", "code": "SERVER_UNREACHABLE"}
            except socket.timeout:
                if attempt < len(retry_delays):
                    time.sleep(retry_delays[attempt])
                    continue
                self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_TIMEOUT")
                return 408, {"error": "Connection to license server timed out", "code": "TIMEOUT"}
            except Exception:
                self.record_diagnostic(self._transport_stage(url), "SDK_HTTP_UNEXPECTED")
                return 500, {"error": "License server request failed", "code": "UNKNOWN_ERROR"}

    def validate_license(
        self,
        license_key: str,
        hwid: str,
        telemetry: Dict[str, Any],
        pin: Optional[str] = None,
    ) -> Tuple[bool, int, Dict[str, Any]]:
        """
        Calls /api/v1/license/validate endpoint.
        The legacy pin argument is accepted for compatibility but never sent.
        Returns (is_valid, http_status_code, response_payload)
        """
        self._diagnostic_token = None
        self._logout_proof = None
        self._logout_proof_session = None
        self._stats_capability = None
        url = self._build_url("api/v1/license/validate")
        app_version = self.config.app_version
        if not isinstance(app_version, str) or not app_version.strip():
            return False, 400, {
                "error": "Application version must be configured before license validation",
                "code": "APP_VERSION_REQUIRED",
            }

        body = {
            "license_key": license_key.strip().upper(),
            "hwid": hwid,
            "device_name": telemetry.get("device_name", "Unknown-PC"),
            "os_info": telemetry.get("os_info", "Generic-OS"),
            "app_name": self.config.app_name,
            "app_version": app_version.strip(),
            "nonce": secrets.token_urlsafe(32),
            "logout_proof_version": 2,
        }

        status_code, data = self._http_post(url, body, self.config.request_timeout_seconds)

        if status_code == 200 and data.get("valid") is True:
            # The configured public key is the trust anchor; response keys are not trusted.
            sig = data.pop("signature", None)
            data.pop("public_key", None)

            # Verify cryptographic signature
            if not sig or not self.verify_signature(data, sig):
                return False, 403, {"error": "Server cryptographic signature mismatch", "code": "SIGNATURE_FAILED"}
            if (
                data.get("nonce") != body["nonce"]
                or data.get("request_app") != body["app_name"].strip()
                or data.get("license_key") != body["license_key"]
                or data.get("hwid") != hwid.strip()
            ):
                return False, 403, {"error": "Signed validation does not match request", "code": "VALIDATION_BINDING_FAILED"}

            # Keep the signed, short-lived diagnostic bearer capability in RAM only.
            # Never expose it via LoginResult/license_data or session storage.
            # Default login has no statistics opt-in. Never export any unsolicited
            # report capability to the host or retain it in normal session state.
            data.pop("stats_capability", None)
            capability = data.pop("diagnostic_token", None)
            if isinstance(capability, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", capability):
                self._diagnostic_token = capability
            # Extract AFTER signature and challenge verification, BEFORE
            # returning anything the host can display or persist.
            proof = data.pop("device_logout_proof", None)
            if (isinstance(proof, str) and re.fullmatch(
                    r"(?:[A-Za-z0-9_-]{43}|lx2\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43})",
                    proof,
            )):
                self._logout_proof = proof
                self._logout_proof_session = (body["license_key"], hwid)
            return True, 200, data
        else:
            return False, status_code, data

    def ping_heartbeat(self, license_key: str, hwid: str) -> Tuple[bool, Dict[str, Any]]:
        """
        Sends heartbeat ping to server.
        Verifies the signed response and its one-time challenge before accepting it.
        Returns (active, payload); any unverifiable response is rejected.
        """
        url = self._build_url("api/v1/license/ping")
        nonce = secrets.token_urlsafe(32)
        body = {
            "license_key": license_key.strip().upper(),
            "hwid": hwid,
            "app_name": self.config.app_name,
            "nonce": nonce,
            "logout_proof_version": 2,
        }
        if isinstance(self._stats_capability, str):
            # Refresh only a previously signed and stored report-only token.
            body["stats_capability_version"] = 1
            body["stats_capability"] = self._stats_capability

        # Honor the SDK request timeout, but bound heartbeat attempts so that
        # a network outage does not stall the grace recovery worker indefinitely.
        configured_timeout = self.config.request_timeout_seconds
        heartbeat_timeout = min(20, max(1, configured_timeout)) if type(configured_timeout) is int else 10
        status_code, data = self._http_post(url, body, heartbeat_timeout)
        if not isinstance(data, dict):
            return False, {"error": "Invalid heartbeat response", "code": "INVALID_RESPONSE"}

        if status_code == 200 and data.get("valid") is True:
            signature = data.pop("signature", None)
            data.pop("public_key", None)
            if (
                data.get("status") != "active"
                or data.get("nonce") != nonce
                or not signature
                or not self.verify_signature(data, signature)
            ):
                return False, {
                    "error": "Heartbeat signature or challenge verification failed",
                    "code": "HEARTBEAT_SIGNATURE_FAILED",
                }
            stats_token = data.pop("stats_capability", None)
            if isinstance(stats_token, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", stats_token):
                self._stats_capability = stats_token
            # Rotate the session's RAM-only proof from this signed response.
            # An old proof is never trusted as a replacement for a new session.
            proof = data.pop("device_logout_proof", None)
            session = (body["license_key"], hwid)
            if (isinstance(proof, str)
                    and re.fullmatch(
                        r"(?:[A-Za-z0-9_-]{43}|lx2\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43})",
                        proof,
                    )
                    and (getattr(self, "_logout_proof_session", None) is None
                         or self._logout_proof_session == session)):
                self._logout_proof = proof
                self._logout_proof_session = session
            return True, data
        # Only an explicit HTTPS license/app/device denial is terminal.
        # No socket/TLS/timeout/malformed/signature failure may impersonate it.
        terminal_codes = {
            "NOT_FOUND", "LICENSE_INACTIVE", "LICENSE_EXPIRED",
            "APP_NOT_FOUND", "APP_INACTIVE", "DEVICE_UNBOUND",
            "DEVICE_BLOCKED", "DEVICE_LEASE_EXPIRED",
        }
        if status_code in (403, 404) and data.get("code") in terminal_codes:
            import hashlib
            expected_binding = hashlib.sha256(self.canonical_json({
                "license_key": body["license_key"],
                "hwid": hwid,
                "app_name": body["app_name"],
            }).encode("utf-8")).hexdigest()
            proof = {
                "valid": False,
                "code": data["code"],
                "nonce": data.get("nonce"),
                "request_binding": data.get("request_binding"),
                "server_time": data.get("server_time"),
            }
            if (data.get("valid") is False
                    and data.get("nonce") == nonce
                    and data.get("request_binding") == expected_binding
                    and type(data.get("server_time")) is int
                    and data["server_time"] > 0
                    and isinstance(data.get("signature"), str)
                    and self.verify_signature(proof, data["signature"])):
                return False, {
                    "code": data["code"], "_licenx_terminal_denial": True,
                }
            # An unsigned, mismatched or tampered HTTP error cannot terminate
            # a verified local session. Remain fail-closed for licensed work.
            return False, {"code": "DENIAL_UNVERIFIED"}
        transient_codes = {
            "SERVER_UNREACHABLE",
            "TIMEOUT",
            "REQUEST_ERROR",
            "UNKNOWN_ERROR",
            "SERVICE_UNAVAILABLE",
        }
        if status_code in (408, 429) or 500 <= status_code < 600:
            if data.get("code") not in transient_codes:
                data = {**data, "code": "SERVICE_UNAVAILABLE"}
        elif data.get("code") in transient_codes:
            data = {**data, "code": "INVALID_RESPONSE"}
        return False, data

    def request_stats_capability(self, license_key: str, hwid: str,
                                 telemetry: Dict[str, Any]) -> Dict[str, Any]:
        """Explicit opt-in revalidation, leaving existing login/logout session intact.

        An unverified license-key/HWID heartbeat is never sufficient to mint the
        first report capability. The server signs a fresh challenge and binding.
        """
        version = self.config.app_version
        if not isinstance(version, str) or not version.strip():
            return {"success": False, "code": "STATS_UNAVAILABLE"}
        try:
            nonce = secrets.token_urlsafe(32)
            request = {
                "license_key": license_key.strip().upper(),
                "hwid": hwid.strip(),
                "device_name": telemetry.get("device_name", "Unknown-PC"),
                "os_info": telemetry.get("os_info", "Generic-OS"),
                "app_name": self.config.app_name,
                "app_version": version.strip(),
                "nonce": nonce,
                "stats_capability_version": 1,
            }
            status, response = self._http_post(
                self._build_url("api/v1/license/validate"),
                request, self.config.request_timeout_seconds
            )
            if status != 200 or not isinstance(response, dict):
                code = "STATS_UNAUTHORIZED" if status in (400, 401, 403, 404) else "STATS_NETWORK_ERROR"
                return {"success": False, "code": code}
            signed = dict(response)
            signature = signed.pop("signature", None)
            signed.pop("public_key", None)
            if (signed.get("valid") is not True or
                    signed.get("status") != "active" or
                    signed.get("nonce") != nonce or
                    signed.get("request_app") != self.config.app_name.strip() or
                    signed.get("license_key") != request["license_key"] or
                    signed.get("hwid") != request["hwid"] or
                    not isinstance(signature, str) or
                    not self.verify_signature(signed, signature)):
                return {"success": False, "code": "STATS_UNAUTHORIZED"}
            capability = signed.get("stats_capability")
            if capability is None:
                return {"success": False, "code": "STATS_UNSUPPORTED"}
            if not isinstance(capability, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", capability):
                return {"success": False, "code": "STATS_UNAUTHORIZED"}
            self._stats_capability = capability
            return {"success": True, "code": "STATS_CAPABILITY_READY"}
        except Exception:
            return {"success": False, "code": "STATS_UNAVAILABLE"}

    def send_stats(self, stats: Dict[str, Any]) -> Dict[str, Any]:
        """Explicit report-only request: no retries, no authorization grants."""
        token = self._stats_capability
        if not isinstance(token, str):
            return {"success": False, "code": "STATS_UNSUPPORTED"}
        if not isinstance(stats, dict) or not 1 <= len(stats) <= 40:
            return {"success": False, "code": "INVALID_STATS"}
        forbidden = re.compile(r"password|passwd|secret|token|private|credential|cookie|authorization|license.?key|hwid|bearer|access.?key|api.?key", re.I)
        for label, value in stats.items():
            if (not isinstance(label, str) or not label or len(label) > 64 or
                    label != label.strip() or re.search(r"[\x00-\x1f\x7f-\x9f]", label) or
                    label.lower() in ("__proto__", "constructor", "prototype") or forbidden.search(label)):
                return {"success": False, "code": "INVALID_STAT_LABEL"}
            if (value is not None and type(value) not in (str, int, float, bool)) or (
                isinstance(value, str) and (len(value) > 256 or re.search(r"[\x00-\x1f\x7f-\x9f]", value))
            ):
                return {"success": False, "code": "INVALID_STAT_VALUE"}
            if type(value) is int and abs(value) > 9007199254740991:
                return {"success": False, "code": "INVALID_STAT_VALUE"}
            if type(value) is float:
                import math
                if not math.isfinite(value):
                    return {"success": False, "code": "INVALID_STAT_VALUE"}
        try:
            raw_stats = json.dumps(stats, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            body = b'{"stats":' + raw_stats + b'}'
            if len(raw_stats) > 4096 or len(body) > 4608:
                return {"success": False, "code": "STATS_TOO_LARGE"}
        except (TypeError, ValueError, OverflowError):
            return {"success": False, "code": "INVALID_STATS"}
        try:
            req = urllib.request.Request(self._build_url("api/v1/device/stats"),
                data=body, headers={"Content-Type": "application/json",
                                    "Authorization": "Bearer " + token}, method="POST")
            with urllib.request.urlopen(req, timeout=min(10, self.config.request_timeout_seconds),
                                        context=ssl.create_default_context()) as response:
                return {"success": response.getcode() == 202,
                        "code": "STATS_ACCEPTED" if response.getcode() == 202 else "STATS_ERROR"}
        except urllib.error.HTTPError as e:
            code = {400:"INVALID_STATS",401:"STATS_UNAUTHORIZED",403:"STATS_UNAUTHORIZED",
                    404:"STATS_UNSUPPORTED",413:"STATS_TOO_LARGE",429:"STATS_RATE_LIMITED"}.get(e.code,"STATS_UNAVAILABLE")
            return {"success": False, "code": code}
        except (urllib.error.URLError, TimeoutError, OSError):
            return {"success": False, "code": "STATS_NETWORK_ERROR"}
        except Exception:
            return {"success": False, "code": "STATS_UNAVAILABLE"}

    def send_logout(self, license_key: str, hwid: str) -> bool:
        """Unbind only with the current session's signed, one-use v2 bearer."""
        session = (license_key.strip().upper(), hwid)
        proof = getattr(self, "_logout_proof", None) if getattr(self, "_logout_proof_session", None) == session else None

        def post_v2(bearer):
            try:
                request = urllib.request.Request(
                    self._build_url("api/v2/license/logout"),
                    data=b"{}",
                    headers={
                        "Authorization": "Bearer " + bearer,
                        "Content-Type": "application/json",
                    },
                    method="POST",
                )
                with urllib.request.urlopen(
                    request, timeout=6, context=ssl.create_default_context()
                ) as response:
                    return response.getcode() == 200, False
            except urllib.error.HTTPError as error:
                # Single-use/expired proof may be renewed ONLY by a new
                # signature- and nonce-verified heartbeat from this device.
                return False, error.code == 403
            except (urllib.error.URLError, TimeoutError, OSError):
                return False, False
            except Exception:
                return False, False

        if not proof:
            active, _ = self.ping_heartbeat(*session)
            proof = getattr(self, "_logout_proof", None) if active and getattr(self, "_logout_proof_session", None) == session else None
        if not proof:
            return False  # No anonymous v1/deactivate fallback.
        success, retryable = post_v2(proof)
        if not success and retryable:
            active, _ = self.ping_heartbeat(*session)
            renewed = getattr(self, "_logout_proof", None) if active and getattr(self, "_logout_proof_session", None) == session else None
            if renewed and renewed != proof:
                success, _ = post_v2(renewed)
        if success and getattr(self, "_logout_proof_session", None) == session:
            self._logout_proof = None
            self._logout_proof_session = None
        return success


# Alias for backward-compatibility and clean imports
ServerClient = ServerCommunicator
