"""WS-05 disposable CI-only real Python SDK WSS smoke. Never against live VPS."""
import os
import pathlib
import ssl
import sys
import time

if os.environ.get("WS05_CI_RUN") != "1" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("WS05 Python smoke may only run in disposable GitHub Actions")

import websocket

from licenx.config import SDKConfig
from licenx.server import ServerCommunicator
from licenx.storage import BackgroundLicenseWorker
from licenx.realtime import RealtimeLicenseWorker

ca = os.environ["WS05_CA_FILE"]
public_key = pathlib.Path(os.environ["WS05_PUBLIC_KEY_FILE"]).read_text(encoding="utf-8")
assert pathlib.Path(ca).is_file(), "Local CI CA is required"
config = SDKConfig(
    app_name="ws05-ci-app",
    server_url="https://localhost",
    public_key_pem=public_key,
    app_version="1.0.0",
    useWebSocket=True,
    offline_grace_seconds=1200,
    auto_logout_on_exit=False,
)
communicator = ServerCommunicator(config)
storage = BackgroundLicenseWorker("ws05-py-ci", offline_grace_seconds=1200)
storage.enable_realtime()
storage._running = True
# CI-only failure classification: an internal constant code, never keys/tokens/URL.
invalidated_codes = []
storage.on_invalidated = invalidated_codes.append

# For a local Caddy-generated CA; production TLS uses normal system trust.
real_connect = websocket.create_connection

def trusted_local_connection(url, **kwargs):
    assert url == "wss://localhost/api/realtime"
    return real_connect(url, sslopt={"ca_certs": ca, "cert_reqs": ssl.CERT_REQUIRED}, **kwargs)

websocket.create_connection = trusted_local_connection
worker = RealtimeLicenseWorker(
    communicator, storage, "WS05-KEY-000002", "WS05-HWID-000002",
    {"app_id": "ws05-ci-app"},
)
try:
    worker.start()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        state = storage.get_realtime_state()
        if state == "CONNECTED":
            assert storage._keep_login_on_network_error is True
            assert storage.is_authorized()
            print("WS05_PYTHON_SDK_REAL_WSS=PASS signed_policy=ON secure_TLS=CA_VALIDATED")
            break
        if state == "INVALIDATED":
            raise AssertionError("Python realtime worker invalidated: " + (invalidated_codes[-1] if invalidated_codes else "UNKNOWN"))
        time.sleep(0.2)
    else:
        raise AssertionError("Python SDK did not authenticate over trusted Caddy WSS")
finally:
    worker.stop()
    storage.stop_monitoring()
    websocket.create_connection = real_connect
