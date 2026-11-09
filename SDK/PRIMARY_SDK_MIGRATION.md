# Single primary Python SDK migration

## Identity and breaking changes

The one maintained SDK is licenx at SDK/client/python/licenx. The former
reference package x_license_python has been removed from active source and
release workflows. Existing applications importing x_license_python must
migrate explicitly; this is a breaking change. Historical audit Markdown
may retain references as recorded evidence.

## Install and config

Use `python -m pip install ./SDK/client/python/licenx` from a trusted checkout.
The Admin download endpoint `GET /api/sdk/download/python` now serves
`licenx-python-sdk.zip`, whose extracted directory supports `pip install .`.
A vetted wheel from a separately authorized GitHub Release is also supported.
Public `pip install licenx` must NOT be trusted until PyPI name ownership,
package integrity, versions, signing and release have been verified.
No PyPI upload, tag push, or release asset publication was authorized here.

Create application-root `licenx.config.py` with a literal `app_config` dict.
The SDK uses AST literal parsing, not arbitrary Python execution. Include the
actual client app_version, valid HTTPS server_url, app slug and known trusted
public_key_pem. No private signing key, customer license, token or password
belongs in the config. An editable Python config is not a security boundary;
production apps should independently pin trusted endpoint and public key
fingerprint or verify cryptographically signed key rotation.

## Release guardrails

Source ZIP excludes test directories, Python caches, egg-info, private data
and symlinks. The parity verifier ensures byte-for-byte source agreement.
Node, Cloudflare and Docker use the same primary ZIP name. GitHub SDK tag
workflow checks pyproject.toml as the single SDK version source, tests only
the maintained package, builds wheel+sdist, and verifies checksum assets.
Before a new authorized release, choose a fresh SDK version and tag rather
than overwriting an existing version. Test pip installation from the built
wheel in a clean venv and validate signature/nonce/WSS/HTTP regressions.

## No production action

This is a source/CI migration, not a VPS deployment or Admin WSS activation.
CalGrid prior standalone EXE bundles remain historical binaries until a new
separately approved Windows build and controlled PC/RDP login retest.
