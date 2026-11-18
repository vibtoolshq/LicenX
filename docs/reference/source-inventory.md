# Forensic source inventory — generated from workspace files

> 2026-11-18 workspace snapshot. This is a **machine-read inventory**, not a claim that each individual code branch was executed or reviewed manually. Repo-relative paths and visible symbol names were extracted from file contents. Private notes, Git internals, dependency/build outputs and binary artifacts are out of scope.

- Eligible non-generated file entries discovered: **250**.
- Text/config file contents read: **241** (208 code/config inventory entries, 29 documentation entries, and 4 additional repository metadata text files).
- Code/config entries: **208**; documentation/notes-like entries outside private notes: **29**.
- Exclusions: .git, node_modules, build, dist, local private notes, ignored data, __pycache__, .pytest_cache, egg-info, binary files (such as local SQLite databases and images). The remaining 9 eligible files were non-text/binary and not content scanned.

## Source and configuration content inventory

| File | Lines read | Implemented symbol sample (declarations only) |
| --- | ---: | --- |
| .env.example | 14 | — |
| .github/workflows/admin-realtime-e2e.yml | 204 | r, r, body |
| .github/workflows/backup-system.yml | 81 | r |
| .github/workflows/phase03-docker.yml | 149 | urls, response, body, unknown |
| .github/workflows/phase04-installer.yml | 239 | urls, response, body, unknown, base, csrfRes, csrf |
| .github/workflows/phase05-security.yml | 508 | paths, urls, response, body, unknown, base, csrfRes |
| .github/workflows/pn01-public-catalog.yml | 66 | — |
| .github/workflows/release-python-sdk.yml | 255 | — |
| .github/workflows/sd01-server-diagnostics.yml | 62 | — |
| .github/workflows/start-python-sdk-release.yml | 86 | — |
| .vscode/tasks.json | 75 | — |
| compose.yaml | 72 | — |
| deploy/Caddyfile | 18 | — |
| deploy/compose.existing-proxy.yaml | 5 | — |
| Dockerfile | 22 | — |
| engine/socketcore/config.js | 87 | DEFAULT_LIMITS, DEFAULT_HEARTBEAT, DEFAULT_PORT, DEFAULT_TIMEOUTS, resolveOptions, resolved, resolveLimits |
| engine/socketcore/connection-manager.js | 361 | createConnectionManager, allowedOptions, limits, heartbeat, metrics, clients, groups |
| engine/socketcore/index.js | 488 | resolveUpgradePath, parsed, createEngine, config, heartbeatConfig, timeoutConfig, upgradePath |
| engine/socketcore/message-router.js | 60 | createMessageRouter, handlers, metrics, register, dispatch, handler |
| engine/socketcore/observability.js | 71 | safeErrorDetails, details, safeLog, log, result, createMetrics, methods |
| examples/restricted-license-tool/licenxClient.mjs | 77 | TOKEN_RE, KEY_RE, normalizeLicenseKey, key, allowedApiOrigin, url, loopback |
| examples/restricted-license-tool/server.mjs | 105 | DEFAULT_WINDOW_MS, DEFAULT_RATE, MAX_CLIENTS, MAX_BODY, respond, createLimiter, clients |
| functions/api/[[catchall]].ts | 16 | Env, onRequest |
| functions/health.ts | 6 | onRequest |
| functions/types.d.ts | 23 | EventContext, PagesFunction |
| functions/v1/[[catchall]].ts | 16 | Env, onRequest |
| index.html | 18 | — |
| metadata.json | 7 | — |
| package.json | 55 | — |
| package-lock.json | 5492 | — |
| public/_routes.json | 19 | — |
| scripts/buildPythonSdkArchive.mjs | 69 | projectRoot, sdkDirectory, configTemplate, publicDirectory, archivePath, tempArchivePath, fixedArchiveDate |
| scripts/install-vps.sh | 119 | — |
| scripts/loadRealtime.mjs | 225 | mode, total, appId, appSlug, serial, lic, dev |
| scripts/restoreData.mjs | 90 | APP_COLUMNS, LICENSE_COLUMNS, records, restoreAll, source, target, data |
| SDK/client/python/licenx.config.py | 58 | — |
| SDK/client/python/licenx/__init__.py | 27 | — |
| SDK/client/python/licenx/client.py | 323 | XLicenseClient, __init__, _stop_realtime, _start_realtime, login, auto_login, logout |
| SDK/client/python/licenx/config.py | 413 | SDKConfigError, __init__, SDKConfig, __post_init__, _from_mapping, from_file, from_json_file |
| SDK/client/python/licenx/device.py | 216 | DeviceManager, get_motherboard_uuid, get_disk_serial, get_mac_address, get_cpu_info, get_local_ip, get_public_ip |
| SDK/client/python/licenx/diagnostics.py | 58 | tls_verify_code, SafeDiagnosticBuffer, __init__, record, snapshot |
| SDK/client/python/licenx/example_app.py | 98 | on_revoked_callback, main |
| SDK/client/python/licenx/login.py | 129 | LoginResult, LoginManager, __init__, login, auto_login |
| SDK/client/python/licenx/logout.py | 145 | LogoutManager, __init__, set_realtime_stop_callback, set_active_session, has_pending_release, retry_pending_logout, logout |
| SDK/client/python/licenx/offline.py | 45 | OfflineGuard, is_clock_tampered, verify_clock, check_online_policy |
| SDK/client/python/licenx/pyproject.toml | 42 | — |
| SDK/client/python/licenx/realtime.py | 430 | _RealtimeSecurityError, RealtimeLicenseWorker, __init__, _report, start, stop, _retry_wait |
| SDK/client/python/licenx/server.py | 617 | ServerCommunicator, __init__, record_diagnostic, get_diagnostics, _transport_stage, send_diagnostic, _build_url |
| SDK/client/python/licenx/storage.py | 430 | BackgroundLicenseWorker, __init__, save_session, load_saved_session, clear_session, start_monitoring, stop_monitoring |
| SDK/client/python/licenx/test/app.py | 1810 | MissingClientVersionError, create_diagnostic_client, admin_logout_observation_timeout_ms, get_live_target_environment, is_admin_device_logout_reason, record_session_revocation, load_live_config |
| SDK/client/python/licenx/test/test_client_session_replacement.py | 124 | ClientSessionReplacementTests, setUp, login_result, test_first_login_does_not_logout_an_existing_session, test_successful_replacement_releases_old_key_before_new_validation, test_failed_replacement_leaves_no_old_local_session_or_worker, test_failed_old_session_logout_stops_replacement_validation |
| SDK/client/python/licenx/test/test_example_app_security.py | 32 | ExampleAppSecurityTests, test_processing_output_never_prints_license_key |
| SDK/client/python/licenx/test/test_heartbeat.py | 442 | public_key_pem, sign_payload, HeartbeatVerificationTests, test_accepts_nonce_bound_rsa_and_ed25519_heartbeat_signatures, post, test_server_supplied_transient_codes_do_not_grant_grace_on_bad_responses, test_rejects_missing_tampered_and_wrong_nonce_signatures |
| SDK/client/python/licenx/test/test_heartbeat_interval.py | 139 | public_key_pem, HeartbeatIntervalValidationTests, test_sdk_config_rejects_invalid_intervals, test_worker_rejects_invalid_intervals_before_starting, test_config_and_worker_reject_invalid_offline_grace, test_invalid_file_interval_raises_config_error, test_client_does_not_replace_explicit_zero_with_default |
| SDK/client/python/licenx/test/test_live_config.py | 1116 | LiveConfigTests, setUp, tearDown, write_config, test_loads_explicit_remote_https_config, test_downloaded_app_wss_boolean_roundtrip_and_strict_type, test_admin_download_config_requires_operator_version_without_using_minimum |
| SDK/client/python/licenx/test/test_login_cleanup.py | 119 | LoginBindingCleanupTests, setUp, test_signature_rejection_never_unbinds_existing_device, test_signed_login_ignores_client_clock_without_unbind, test_ordinary_server_denial_does_not_send_logout, test_server_request_id_is_exposed_on_failed_login_result, test_cleanup_failure_does_not_replace_signature_rejection |
| SDK/client/python/licenx/test/test_logout_lifecycle.py | 160 | LogoutLifecycleTests, setUp, _registered_signal_handlers, test_previous_handlers_run_and_exit_cleanup_runs_once, test_default_and_ignored_handlers_keep_their_signal_semantics, test_verified_validation_strips_logout_proof_from_public_result, test_proof_bound_v2_logout_only_and_no_legacy_fallback |
| SDK/client/python/licenx/test/test_lx_s02_lifecycle.py | 228 | SignedHttpRecoveryTests, setUp, tearDown, _run_failure, assert_paused_before_http, test_ws_tls_fails_but_fresh_verified_https_allows_http_only, test_ws_tls_and_unverifiable_http_fail_closed |
| SDK/client/python/licenx/test/test_network_recovery.py | 330 | _RequestsErrors, SSLError, ConnectionError, Timeout, _FakeRequests, __init__, post |
| SDK/client/python/licenx/test/test_pin_is_ignored.py | 45 | LicensePinSeparationTests, test_login_does_not_forward_legacy_pin, test_communicator_does_not_send_legacy_pin |
| SDK/client/python/licenx/test/test_python_config.py | 325 | PythonConfigLoaderTests, setUp, tearDown, write_config, test_loads_literal_app_config_and_ignores_metadata_maps, test_generated_wss_config_boolean_round_trips_without_network, test_omitted_fields_keep_sdk_defaults |
| SDK/client/python/licenx/test/test_readme_quick_start.py | 95 | ReadmeQuickStartTests, test_sdk_readme_python_examples_are_valid_syntax, test_basic_integration_example_matches_sdk_api, ExampleClient, __init__, assert_trust_anchor, login |
| SDK/client/python/licenx/test/test_realtime.py | 607 | public_pem, signed, FakeWebSocket, __init__, send, recv, settimeout |
| SDK/client/python/licenx/test/test_safe_diagnostics.py | 116 | SafeDiagnosticsTests, test_bounded_local_allowlist_drops_arbitrary_payloads, test_numeric_tls_metadata_never_emits_exception_text, test_wss_tls_failure_retains_safe_code_and_fails_closed, test_ticket_denial_classified_by_safe_server_code, test_signed_diagnostic_bearer_is_ram_only_not_part_of_license_result, fake_http |
| SDK/client/python/licenx/test/test_secure_transport.py | 74 | SecureTransportTests, communicator, test_accepts_https_and_normalizes_api_prefix, test_allows_explicit_http_loopback_addresses, test_rejects_remote_http_before_sending_license_credentials, test_rejects_non_loopback_http_and_localhost_lookalikes, test_rejects_malformed_or_unsupported_server_urls |
| SDK/client/python/licenx/test/test_signature_verification.py | 243 | SignatureVerificationTests, setUp, public_key_pem, test_ed25519_rejects_valid_signature_without_cryptography, test_ed25519_valid_and_invalid_signatures_with_cryptography, test_rsa_rejects_valid_signature_without_cryptography, test_rsa_rejects_invalid_signature_with_cryptography |
| SDK/client/python/licenx/test/test_storage_security.py | 51 | LicenseSessionStorageSecurityTests, setUp, tearDown, test_save_does_not_persist_session_key, test_base64_session_is_loaded_correctly, test_clear_session_removes_existing_file |
| SDK/client/python/licenx/test/test_transport_errors.py | 260 | _FakeResponse, __init__, json, _FakeRequestsExceptions, SSLError, ConnectionError, Timeout |
| SDK/test/app.py | 14 | — |
| server.ts | 253 | root, app, port, storageRoot, isProduction, trustedProxy, requestId |
| src/App.tsx | 552 | isAdminRoute, isPublicHome, isPublicToolsPath, VALID_TABS, resolveActiveTab, path, params |
| src/components/adminApiKeySafety.ts | 23 | AdminApiKeyIdentity, getExplicitTestAdminApiKeys, deleteExplicitTestAdminApiKeys, testKeys, results, deleted |
| src/components/AdminApisTab.tsx | 1205 | AdminApisTabProps, AdminApisTab, confirm, testKeys, loadData, handleCreateKey, res |
| src/components/AppsTab.tsx | 439 | AppsTab, confirm, loadSerial, p, handleDownloadSdk, loadApps, serial |
| src/components/BackupTab.tsx | 199 | AccountDraft, newAccount, BackupTab, load, result, timer, perform |
| src/components/BulkLicenseModal.tsx | 383 | BulkLicenseModalProps, BulkLicenseModal, appList, handleGenerate, res, handleDownloadCsv, blob |
| src/components/ClientCodeTab.tsx | 317 | ClientCodeTabProps, ClientCodeTab, saved, handleSelectLang, serverUrl, handleDownloadSdk, pythonQuickExample |
| src/components/CreateAppModal.tsx | 198 | CreateAppModalProps, CreateAppModal, handleSubmit, res, handleDownloadConfig |
| src/components/CreateLicenseModal.tsx | 503 | CreateLicenseModalProps, CreateLicenseModal, appList, validApps, handleSubmit, res, getAllKeysText |
| src/components/DevicesTab.tsx | 320 | DevicesTab, confirm, loadSerial, p, loadDevices, serial, res |
| src/components/EditAppModal.tsx | 271 | EditAppModalProps, EditAppModal, refresh, request, unsubscribe, relevant, interval |
| src/components/ErrorBoundary.tsx | 89 | Props, State, ErrorBoundary |
| src/components/HeaderBar.tsx | 133 | HeaderBarProps, HeaderBar, update, timer, titles |
| src/components/LandingPage.tsx | 1069 | QuickCheckResult, AnalysisData, LandingPageProps, LandingPage, handleCopyLicenseKey, handleCopyHwid, metaDesc |
| src/components/LicensesTab.tsx | 1026 | LicensesTabProps, LicensesTab, confirm, loadSerial, appOptionsSerial, p, handleOutsideClick |
| src/components/LiveMonitorTab.tsx | 701 | SNAPSHOT_FRESH_MS, REFRESH_MS, MonitorHealth, MonitorMetrics, count, getLiveMonitorMetrics, unknown |
| src/components/LoginModal.tsx | 101 | LoginModalProps, LoginModal, handleLogin, res |
| src/components/LogsTab.tsx | 282 | LogsTab, confirm, loadSerial, p, loadLogs, serial, res |
| src/components/ManageDevicesModal.tsx | 236 | ManageDevicesModalProps, ManageDevicesModal, confirm, fetchDevices, res, devList, totalPages |
| src/components/NotFoundPage.tsx | 129 | NotFoundPageProps, NotFoundPage, displayPath |
| src/components/OverviewTab.tsx | 261 | OverviewTabProps, OverviewTab, loadSerial, loadData, serial, logList, unsubscribe |
| src/components/ProfileTab.tsx | 206 | ProfileTabProps, ProfileTab, handleUpdatePassword, res |
| src/components/PublicHeader.tsx | 135 | PUBLIC_PATHS, UNSAFE_URL_CHARACTERS, safePublicHref, url, hostname, publishedHeaderLinks, PublicHeaderProps |
| src/components/PublicLicenseApiTab.tsx | 163 | PublicLicenseApiTab, confirm, refresh, value, changeGlobal, target, ok |
| src/components/PublicNavMenuTab.tsx | 267 | LEGACY_URL, inputStyle, actionStyle, reorderNavItems, copy, nextNavId, used |
| src/components/PublicToolsPage.tsx | 137 | BRANDING_ICON, RASTER_EXTENSION, publishedToolCards, safePublicToolIcon, href, PublicToolCard, href |
| src/components/PublicToolsTab.tsx | 309 | inputStyle, actionStyle, IMAGE_TYPES, MAX_ICON_BYTES, reorderToolItems, copy, nextToolId |
| src/components/ServerDiagnosticsTab.tsx | 178 | browserCheck, browserHttp, start, result, formatServerDiagnosticsReport, lines, ServerDiagnosticsTab |
| src/components/SettingsTab.tsx | 435 | SettingsTabProps, SettingsTab, confirm, loadSettings, backupList, handleTestR2, res |
| src/components/SetupModal.tsx | 208 | SetupModalProps, SetupModal, handleSubmit, payload, res |
| src/components/Sidebar.tsx | 455 | NavItem, NavGroup, SidebarProps, Sidebar, navGroups, saved, initial |
| src/components/SimulatorTab.tsx | 273 | SimulatorTab, appList, validApps, defaultSlug, generateRandomHwid, chars, handleTestValidation |
| src/components/SiteSettingsTab.tsx | 680 | SiteSettingsTabProps, SiteSettingsTab, confirm, logoInputRef, faviconInputRef, ogInputRef, fetchSettings |
| src/components/TablePagination.tsx | 155 | TablePaginationProps, TablePagination, totalPages, safeCurrentPage, startItem, endItem, getPageNumbers |
| src/context/ConfirmContext.tsx | 158 | ConfirmOptions, ConfirmFunction, ConfirmContext, ConfirmProvider, resolverRef, confirm, options |
| src/index.css | 61 | — |
| src/main.tsx | 11 | — |
| src/server/adminApiInput.ts | 55 | isRecord, isIntegerLike, validateAdminLicenseCreation, strings, value, decodeAdminLicensePathKey |
| src/server/adminApiRateLimiter.ts | 34 | createAdminApiRateLimiter, entries, id, current |
| src/server/adminAuthCookies.ts | 72 | ADMIN_SESSION_COOKIE, ADMIN_CSRF_COOKIE, ADMIN_SESSION_MAX_AGE_SECONDS, getCookieValue, separator, createAdminSessionCookie, clearAdminSessionCookie |
| src/server/adminLoginRateLimit.ts | 109 | ADMIN_LOGIN_MAX_FAILURES, ADMIN_LOGIN_WINDOW_MS, ADMIN_LOGIN_BLOCK_MS, AdminLoginRateLimit, createAdminLoginAttemptKey, getAdminLoginRateLimit, result |
| src/server/api.ts | 3924 | archiver, SAFE_SERVER_ERROR, apiRouter, outcome, header, token, outcome |
| src/server/backupControl.ts | 316 | Account, Job, Schedule, State, root, folder, archiveFolder |
| src/server/bootstrap.ts | 18 | ownerBootstrapRequired, validOwnerSetupCode, expected, providedDigest, expectedDigest |
| src/server/cloudflareHandler.ts | 3514 | SAFE_SERVER_ERROR, corsHeaders, jsonResponse, errorResponse, isValidLicenseValidationPayload, fields, value |
| src/server/crypto.ts | 423 | CryptoKeyPair, Ed25519KeyPair, RSAKeyPair, generateRSAKeyPair, publicKeyPem, privateKeyPem, generateEd25519KeyPair |
| src/server/database/contracts.ts | 29 | DatabaseResult, DatabaseExecutor, DatabaseTransaction, DatabaseClient |
| src/server/database/postgres.ts | 128 | safeDatabaseError, code, execute, query, rows, value, PostgresTransaction |
| src/server/database/postgresSchema.ts | 289 | initialSchema, migratePostgres, transaction, result, rateLimitMigration, domainMigration, realtimeMigration |
| src/server/database/sqlDialect.ts | 38 | postgresStatement, sql, parameters, rest, quoted, end, value |
| src/server/db.ts | 659 | initializedClients, schemaInitPromises, DatabaseEnvironment, ResolvedDatabaseConfig, AdminApiKey, DatabaseConfigurationError, RemoteDatabaseInitializationError |
| src/server/deviceBinding.ts | 221 | MAX_TRANSACTION_ATTEMPTS, getDeviceLeaseSeconds, result, configuredLease, BindDeviceParams, BindDeviceResult, bindDeviceWithinLimit |
| src/server/diagnostics.ts | 126 | TOKEN_TTL_MS, EVENT_TTL_MS, MAX_TOKENS, MAX_EVENTS, MAX_ADMIN_EVENTS_PER_MIN, SDK_CODES, ADMIN_CODES |
| src/server/fullBackupWorker.ts | 256 | BACKUP_TABLES, MAGIC, storageRoot, store, archives, maxArchiveBytes, shell |
| src/server/licensePolicy.ts | 33 | DEFAULT_DEVICE_LEASE_SECONDS, DEFAULT_PING_INTERVAL_SECONDS, MIN_PING_INTERVAL_SECONDS, MAX_PING_INTERVAL_SECONDS, DEFAULT_OFFLINE_GRACE_SECONDS, MAX_OFFLINE_GRACE_SECONDS, HEARTBEAT_REQUEST_TIMEOUT_SECONDS |
| src/server/publicAccessSettings.ts | 26 | PublicAccessSetting, isPublicAccessEnabled, result, settingsJson, value |
| src/server/publicCatalog.ts | 259 | JsonRecord, SiteSnapshot, PUBLIC_PATHS, ASSET_PATH, ID, UNSAFE_TEXT, URL_CONTROL |
| src/server/publicLicenseApiControl.ts | 132 | PublicApiControlError, normalizeAllowedToolOrigin, u, origin, getPublicApiControl, settings, items |
| src/server/r2.ts | 387 | R2Config, ensureDOMParser, g, parseXmlToDom, TEXT_NODE, ELEMENT_NODE, parseString |
| src/server/realtime/adminEventBridge.ts | 141 | POLL_INTERVAL_MS, MAX_LOG_SAMPLE, MAX_SCOPED_LOG_APPS, Gateway, LogSample, affectedResource, resource |
| src/server/realtime/adminGateway.ts | 345 | ADMIN_REALTIME_PATH, ADMIN_REALTIME_PROOF_COOKIE, BOOTSTRAP_TTL_MS, MAX_PENDING, MAX_CONNECTED, MAX_REVOKED, SESSION_CHECK_MS |
| src/server/realtime/eventCursor.ts | 30 | RealtimeDbEvent, currentRealtimeCursor, r, eventsAfter, r, eventAffects |
| src/server/realtime/eventPublisher.ts | 65 | WsClients, createRealtimeEventPublisher, init, tick, events, keyResult, key |
| src/server/realtime/leaseManager.ts | 52 | WsClients, BATCH_SIZE, createRealtimeLeaseManager, connected, register, tick, entries |
| src/server/realtime/logoutProof.ts | 49 | TTL_MS, MAX_PROOFS, Proof, active, hash, identityKey, prune |
| src/server/realtime/presence.ts | 142 | PresenceSocket, PresenceEntry, entries, PresenceChange, PresenceChangeListener, changeListeners, subscribeRealtimePresence |
| src/server/realtime/sessionTickets.ts | 97 | RealtimeIdentity, PendingTicket, REALTIME_TICKET_TTL_MS, validateRealtimeDevice, result, row, createRealtimeTickets |
| src/server/restrictedPublicLicenseCheck.ts | 196 | PUBLIC_LICENSE_CHECK_PATH, PUBLIC_CHECK_MAX_BODY_BYTES, RESPONSE_HEADERS, CheckResponse, CheckParams, output, digest |
| src/server/serverDiagnostics.ts | 149 | CHECK_TIMEOUT_MS, COOLDOWN_MS, ALLOWED_PATHS, DiagnosticsProbes, port, n, defaultDiagnosticsProbes |
| src/server/storage/contracts.ts | 54 | StorageError, StoredObject, StorageProvider, imageTypes, assertPublicAssetKey, assertBackupKey, assetContentType |
| src/server/storage/index.ts | 104 | StorageEnvironment, StorageContext, configuration, parsed, record, text, environment |
| src/server/storage/local.ts | 94 | localStorageError, code, LocalStorage, segments, stat, directory, directory |
| src/server/storage/r2.ts | 42 | R2Storage, result, result, result, result |
| src/server/userControlRateLimit.ts | 117 | USER_CONTROL_PIN_MAX_FAILURES, USER_CONTROL_PIN_WINDOW_MS, USER_CONTROL_PIN_LOCKOUT_MS, UserControlPinRateLimit, getAttemptKey, getUserControlPinRateLimit, attemptKey |
| src/services/adminRealtime.ts | 339 | Change, AdminRealtimeNotice, AdminBrowserSocket, AdminRealtimeDependencies, APP_ID, STREAM_ID, MAX_RETRIES |
| src/services/apiClient.ts | 1093 | clearAuthToken, CacheEntry, clientCache, API_REQUEST_TIMEOUT_MS, SafeDiagnostic, ApiError, safeErrorMessage |
| src/types.ts | 346 | AppItem, RealtimePresenceReport, MonitoringDeviceRow, MonitoringDevicesResponse, AdminRealtimeState, AdminRealtimeEnvelope, AdminRealtimeChange |
| tailwind.config.js | 20 | — |
| tests/adminApiEndpoints.test.ts | 682 | originalEnvironment, middleware, req, res, next, middleware, req |
| tests/adminApiKey.test.ts | 101 | originalEnvironment, generated, generatedStore, db, testKey, now, testPermissions |
| tests/adminApiKeyUiSafety.test.ts | 36 | entries, deleted, result, result |
| tests/adminApiScopedResetCloudflare.test.ts | 133 | original, db, nonce, ownApp, otherApp, ownLic, otherLic |
| tests/adminApiValidation.test.ts | 62 | invalid, limiter, limiter |
| tests/adminAuth.test.ts | 607 | ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET, originalEnvironment, app, address, cloudflareRequest |
| tests/adminRealtimeAuth.test.ts | 180 | openSocket, socket, keys, previousEnv, db, gateway, app |
| tests/adminRealtimeClient.test.ts | 313 | AdminBrowserSocket, AdminRealtimeNotice, pause, report, FakeSocket, ready, change |
| tests/adminRealtimeEvents.test.ts | 327 | SocketStub, notifications, unsubscribe, first, second, identity, delivered |
| tests/apiClientErrors.test.ts | 200 | withFetch, originalFetch, result, requestHeaders, originalSetTimeout, signal, rejectOnAbort |
| tests/backupScheduleTiming.test.ts | 23 | HOUR, DAY, start, nextAt, now |
| tests/backupSystemDocker.mjs | 56 | exec, db, root, source, marker, tampered, fd |
| tests/bootstrapSetup.test.ts | 24 | code, env, legacy |
| tests/cloudflareLicenseSigning.test.ts | 288 | licenseId, licenseKey, hwid, originalEnvironment, keyPair, response, responseBody |
| tests/dbConfiguration.test.ts | 261 | originalValues, response, body, env, client, response, body |
| tests/deviceBinding.test.ts | 269 | databaseUrl, bind, requestDb, settled, results, activeRows, result |
| tests/e2e/admin-browser.mjs | 670 | origin, evidence, check, poll, end, captureSocket, sockets |
| tests/e2e/admin-load.mjs | 290 | origin, held, report, check, pct, sorted, docker |
| tests/e2e/seed-disposable.mjs | 77 | db, now, total, index, license, index, createdAt |
| tests/errorRedaction.test.ts | 399 | originalEnvironment, app, address, getNode, postNode, getCloudflare, postCloudflare |
| tests/installer.test.ts | 26 | script |
| tests/licenseHeartbeat.test.ts | 316 | CryptoKeyPair, licenseId, licenseKey, hwid, deviceId, originalEnvironment, app |
| tests/licensePin.test.ts | 25 | pin, originalRandom |
| tests/licenseRuntimeParity.test.ts | 560 | licenseId, licenseKey, requestHwid, originalEnvironment, app, address, keyPair |
| tests/liveMonitorApi.test.ts | 308 | StubSocket, keys, old, db, socket, now, signature |
| tests/liveMonitorUi.test.ts | 284 | now, fixture, source, result, stale, app, sidebar |
| tests/localStorage.test.ts | 67 | storage, restarted, storage, linkedRoot, linkedFile, nested, storage |
| tests/lxS01Diagnostics.test.ts | 54 | capability, result, serialized, result |
| tests/lxS03Contracts.test.ts | 84 | mockDb, actions, transaction, sql, db, params, bound |
| tests/phase05Integration.mjs | 92 | sql, base, appA, appB, keyA, keyB, hwid |
| tests/phase05Security.test.ts | 48 | source, code, guards, node, cloudflare, code, start |
| tests/postgresConfiguration.test.ts | 31 | url, query |
| tests/postgresIntegration.test.ts | 192 | url, testOwnerSetupCode, integration, original, app, request, response |
| tests/privateBackupAccess.test.ts | 199 | original, token, config, objects, send, key, data |
| tests/productionPackaging.test.ts | 54 | source, scripts, ignore, docker, compose, caddy, server |
| tests/publicAccessRoutes.test.ts | 312 | licenseId, licenseKey, licensePin, originalEnvironment, app, address, setSiteSettings |
| tests/publicAccessSettings.test.ts | 65 | — |
| tests/publicCatalogApi.test.ts | 290 | old, db, secret, token, call, bearer, nav |
| tests/publicCatalogUi.test.ts | 303 | source, input, before, clean, nav, tool, original |
| tests/publicLicenseApiControl.test.ts | 144 | old, db, now, addLicense, before, legacy, created |
| tests/publicLicenseApiOrigin.test.ts | 16 | — |
| tests/realtimeAdmin.test.ts | 210 | StubSocket, keys, oldEnv, db, now, keys, first |
| tests/realtimeIntegration.test.ts | 137 | waitForMessage, timer, listener, error, dispose, connect, socket |
| tests/realtimeServerPolicy.test.ts | 183 | original, db, keys, now, defaults, issuer, input |
| tests/realtimeTransport.test.ts | 82 | handshakeStatus, socket, source, pkg, server, engine, unsubscribe |
| tests/restrictedPublicLicenseCheck.test.ts | 173 | RATE_SECRET, PATH, now, active, old, db, now |
| tests/restrictedPublicLicensePure.test.ts | 29 | now, active, globalResult, valid |
| tests/restrictedPublicLicenseTool.test.mjs | 93 | TOKEN, API, TOOL, NOW, valid, mock, start |
| tests/s3StorageAndSiteSettings.test.ts | 120 | parser, xml, doc, customError, response403Error, response404Error, req |
| tests/sdkArchiveRoutes.test.ts | 79 | originalEnvironment, app, address, response, archive, response |
| tests/serverDiagnosticsApi.test.ts | 156 | DiagnosticsProbes, fixture, paths, run, result, result, failing |
| tests/serverDiagnosticsUi.test.ts | 55 | source, html, file, report, text |
| tests/siteSettingsSync.test.ts | 97 | req, res, cacheControl, data, req, res, data |
| tests/userControlRateLimit.test.ts | 124 | now, result, fifthAttempt, now, now, afterWindow, result |
| tests/verify_sdk_archive.py | 57 | eligible_source_files, main |
| tests/verifyRealtimeClient.py | 69 | trusted_local_connection |
| tests/vpsInstallMode.test.ts | 19 | script, overlay |
| tsconfig.json | 28 | — |
| vite.config.ts | 23 | — |
| wrangler.toml | 11 | — |

## Existing external documentation indexed

- .ai-rules
- .github/copilot-instructions.md
- AGENTS.md
- AI_INSTRUCTIONS.md
- CODE_OF_CONDUCT.md
- CONTRIBUTING.md
- deploy/ADMIN_REALTIME_RELEASE_GATE.md
- deploy/PRODUCTION_BASELINE_2026-11-16.md
- deploy/WS05_RELEASE_GATE.md
- examples/restricted-license-tool/README.md
- MEMORY.md
- project/README.md
- README.md
- SDK/client/python/licenx/licenx.egg-info/dependency_links.txt
- SDK/client/python/licenx/licenx.egg-info/requires.txt
- SDK/client/python/licenx/licenx.egg-info/SOURCES.txt
- SDK/client/python/licenx/licenx.egg-info/top_level.txt
- SDK/client/python/licenx/README.md
- SDK/client/python/licenx/requirements.txt
- SDK/client/python/licenx/test/README.md
- SDK/PRIMARY_SDK_MIGRATION.md
- SDK/RELEASE_NOTES_v1.2.2.md
- SDK/RELEASE_NOTES_v1.2.3.md
- SDK/release-requests/python-sdk-v1.2.3.txt
- SDK/release-requests/python-sdk-v1.2.4.txt
- SDK/release-requests/python-sdk-v1.2.5.txt
- SDK/release-requests/python-sdk-v1.2.6.txt
- SDK/VERIFICATION_AUDIT.md
- SECURITY.md

## Additional inspected repository metadata

- .gitattributes
- .gitignore
- .dockerignore
- .npmrc

## Evidence limits

Automated text-content scans support inventory and symbol discovery. Targeted manual code tracing was performed on the React entry/sidebar and page handlers, Express route families, PostgreSQL migration/schema and adapter, runtime flags, backup worker/controller, public catalog, realtime gateway, license policy/device binding, Python SDK client/config, Docker/installer/manifest/README. Not every branch/SDK test fixture was reviewed line by line. None of these sources were executed against production.
