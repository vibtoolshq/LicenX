# Legacy PIN Compatibility Tests

Test source: `SDK/client/python/licenx/test/test_pin_is_ignored.py`

The Python client retains the old optional `pin` argument for source compatibility, but PINs belong to web-panel license-control workflows and must not be forwarded as part of SDK login or network validation. This suite checks both the client-to-login-manager and communicator request boundaries.

Run with `python -m unittest -q licenx.test.test_pin_is_ignored` from `SDK/`.
