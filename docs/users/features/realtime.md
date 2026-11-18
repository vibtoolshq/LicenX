# Optional realtime license and admin updates

Two independent realtime subsystems exist in the Node deployment.

**License/session transport:** `LICENX_REALTIME_TRANSPORT_ENABLED=true` enables an optional SocketCore path under `/api/realtime` and short-lived ticket issue through `POST /api/v1/realtime/ticket`. Connection identity is bound to a validated licensed device; group subscription is restricted to that app or license. Signed HTTP validate/ping/logout remains the fallback contract.

**Admin transport:** `LICENX_ADMIN_REALTIME_ENABLED=true` enables `/api/admin/realtime`, with authenticated same-origin bootstrap `POST /api/admin/realtime/bootstrap`. The gateway bounds pending/connected clients, checks session validity and sends sanitized presence/resource invalidation events. Browser UI can fall back to ordinary HTTP refresh.

Both environment switches default **false** in `compose.yaml`; individual app flags such as `realtime_websocket_enabled` are also required for license transport. Do not infer either system is enabled in current production from a component existing in source. Treat old CI load measurements as bounded disposable tests, not a production SLA.

**Source:** `server.ts:106-210`, `src/server/realtime/adminGateway.ts`, `adminEventBridge.ts`, `sessionTickets.ts`, `leaseManager.ts`, `src/services/apiClient.ts`, `engine/socketcore/`, `compose.yaml`.