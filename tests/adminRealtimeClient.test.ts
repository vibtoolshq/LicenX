import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  adminRealtimeSocketUrl,
  createAdminRealtimeClient,
  type AdminBrowserSocket,
  type AdminRealtimeNotice,
} from "../src/services/adminRealtime.js";
import type { RealtimePresenceReport, AdminRealtimeChange } from "../src/types.js";

const pause = (ms = 1) => new Promise<void>(resolve => setTimeout(resolve, ms));
const report = (n = 1): RealtimePresenceReport => ({
  transportEnabled: true, connectedNow: n, activeSockets: n, boundActive: n,
  staleBound: 0, connectedDeviceIds: [], observedAt: Date.now(), scope: null,
});

class FakeSocket implements AdminBrowserSocket {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closeCalls = 0;
  sent: string[] = [];
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closeCalls++; }
  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  drop(code = 1006): void {
    this.onclose?.({ code } as CloseEvent);
  }
}
function ready(socket: FakeSocket, stream = "11111111-2222-3333-4444-555555555555"): void {
  socket.emit({ type: "admin.ready", stream_id: stream, sequence: 0, observedAt: Date.now() });
}
function change(type: string, sequence: number, appId = "app-1", extra: Record<string, unknown> = {}): unknown {
  return {
    type, app_id: appId, sequence, observedAt: Date.now(),
    stream_id: "11111111-2222-3333-4444-555555555555", ...extra,
  };
}

test("ADMIN-RT-03: initial HTTPS snapshot, single browser socket, ordered scoped invalidation and gap resync", async () => {
  const sockets: FakeSocket[] = [];
  const invalidated: Array<AdminRealtimeChange | null> = [];
  const notices: AdminRealtimeNotice[] = [];
  let snapshots = 0;
  let bootstrap = 0;
  const client = createAdminRealtimeClient({
    bootstrap: async () => { bootstrap++; },
    snapshot: async () => report(++snapshots),
    invalidate: value => invalidated.push(value),
    socket: url => {
      assert.equal(url, "wss://ivib.cc/api/admin/realtime");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    origin: () => "https://ivib.cc",
  });
  const unwatch = client.subscribe(notice => notices.push(notice));
  client.start();
  client.start();
  await pause();
  assert.equal(bootstrap, 1);
  assert.equal(sockets.length, 1);
  assert.equal(snapshots, 1, "authenticated HTTP snapshot happens before WSS bootstrap");
  ready(sockets[0]);
  await pause();
  assert.equal(client.getStatus().state, "CONNECTED");
  assert.ok(snapshots >= 2, "resync after server WSS ready");
  sockets[0].emit(change("presence.changed", 1));
  await pause();
  sockets[0].emit(change("resource.changed", 2, "app-1", {
    resource: "licenses", source_version: 7,
  }));
  sockets[0].emit(change("resource.changed", 2, "app-1", {
    resource: "licenses", source_version: 7,
  })); // duplicate ignored
  const changeNotices = notices.filter(x => x.type === "change");
  assert.equal(changeNotices.length, 2, "one notification for each distinct sequence");
  assert.equal(invalidated.filter(x => x?.type === "resource.changed").length, 1);
  const beforeGap = snapshots;
  sockets[0].emit(change("resource.changed", 4, "app-1", {
    resource: "devices", source_version: 8,
  })); // gap: sequence 3 was lost
  await pause();
  assert.ok(snapshots > beforeGap, "missing change triggers authoritative HTTP resync");
  assert.ok(notices.some(x => x.type === "resync"));
  assert.ok(invalidated.includes(null), "resync clears cached App/License/Device/Log data");
  sockets[0].emit(change("stream.resync", 5, null as unknown as string, { reason: "backlog" }));
  await pause();
  assert.equal(client.getStatus().state, "CONNECTED");
  const oldSocket = sockets[0];
  unwatch();
  client.stop();
  assert.equal(oldSocket.closeCalls, 1);
  assert.equal(oldSocket.onmessage, null);
  assert.equal(oldSocket.onclose, null);
  assert.equal(client.getStatus().report, null, "logout leaves no stale HTTP snapshot");
  assert.equal(sockets.length, 1);
});

test("ADMIN-RT-03: HTTP 401 and 403 stop retries and mark session expired", async () => {
  for (const status of [401, 403]) {
    let attempts = 0;
    const client = createAdminRealtimeClient({
      bootstrap: async () => { attempts++; throw { status }; },
      snapshot: async () => report(),
      invalidate: () => {},
      socket: () => { throw Error("must not open WSS after denied bootstrap"); },
      origin: () => "https://ivib.cc",
      retryBaseMs: 1, retryMaxMs: 2, fallbackMs: 5,
    });
    client.start();
    await pause(25);
    assert.equal(attempts, 1, "no retry on auth denial");
    assert.equal(client.getStatus().state, "AUTH_EXPIRED");
    client.stop();
  }
});

test("ADMIN-RT-03: disabled Admin gate retains HTTP fallback with visibility-aware polling", async () => {
  let snapshots = 0, attempts = 0, visible = true;
  let visibilityNotify = () => {};
  let visibilityCleanups = 0;
  const client = createAdminRealtimeClient({
    bootstrap: async () => { attempts++; throw { status: 404 }; },
    snapshot: async () => report(++snapshots),
    invalidate: () => {},
    socket: () => { throw Error("disabled Admin gate must not create WSS"); },
    origin: () => "https://ivib.cc",
    isVisible: () => visible,
    onVisibility: cb => { visibilityNotify = cb; return () => { visibilityCleanups++; }; },
    fallbackMs: 10,
  });
  client.start();
  await pause(27);
  assert.equal(attempts, 1);
  assert.equal(client.getStatus().state, "HTTP_FALLBACK");
  assert.ok(snapshots >= 2, "bounded shared HTTP fallback samples fresh presence");
  visible = false;
  const beforeHidden = snapshots;
  await pause(26);
  assert.equal(snapshots, beforeHidden, "hidden document must pause fallback");
  // Gate disabled; a foreground return is allowed to retry once with a fresh bootstrap.
  visible = true;
  visibilityNotify();
  await pause(2);
  assert.ok(snapshots > beforeHidden, "foreground performs HTTP re-sync");
  client.stop();
  assert.equal(visibilityCleanups, 1);
  const afterStop = snapshots;
  await pause(20);
  assert.equal(snapshots, afterStop, "no retained timers after stop");
});

test("ADMIN-RT-03: transient network retry, reconnect, stream-id renewal and logout cleanup", async () => {
  const sockets: FakeSocket[] = [];
  let bootstrap = 0;
  let snapshotCount = 0;
  const client = createAdminRealtimeClient({
    bootstrap: async () => {
      bootstrap++;
      if (bootstrap === 1) throw { status: 0 };
    },
    snapshot: async () => report(++snapshotCount),
    invalidate: () => {},
    socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    origin: () => "http://localhost:3000",
    retryBaseMs: 2, retryMaxMs: 3, random: () => 0,
  });
  client.start();
  await pause(24);
  assert.equal(bootstrap, 2, "single network error uses bounded retry");
  assert.equal(sockets.length, 1);
  ready(sockets[0]);
  await pause();
  assert.equal(client.getStatus().state, "CONNECTED");
  sockets[0].drop();
  await pause(18);
  assert.equal(sockets.length, 2);
  const beforeRenew = snapshotCount;
  ready(sockets[1], "aaaa0000-bbbb-cccc-dddd-eeeeffffffff");
  await pause();
  assert.ok(snapshotCount > beforeRenew, "new stream requires new authenticated HTTP snapshot");
  assert.equal(client.getStatus().state, "CONNECTED");
  sockets[1].drop(4003);
  await pause(5);
  assert.equal(client.getStatus().state, "AUTH_EXPIRED");
  const afterExpiry = bootstrap;
  await pause(15);
  assert.equal(bootstrap, afterExpiry, "4003 stops all further retry attempts");
  client.stop();
});

test("ADMIN-RT-03: denied HTTP snapshot stops transport without retrying credentials", async () => {
  let bootstraps = 0;
  const client = createAdminRealtimeClient({
    bootstrap: async () => { bootstraps++; },
    snapshot: async () => { throw { status: 403 }; },
    invalidate: () => {},
    socket: () => { throw Error("snapshot denial must block WS bootstrap"); },
    origin: () => "https://ivib.cc",
    retryBaseMs: 1, retryMaxMs: 3, fallbackMs: 5,
  });
  client.start();
  await pause(20);
  assert.equal(bootstraps, 0);
  assert.equal(client.getStatus().state, "AUTH_EXPIRED");
  client.stop();
});

test("ADMIN-RT-03: stale snapshot and malformed event never grant Connected freshness", async () => {
  const sockets: FakeSocket[] = [];
  let rejectSnapshots = false;
  const client = createAdminRealtimeClient({
    bootstrap: async () => {},
    snapshot: async () => {
      if (rejectSnapshots) throw { status: 503 };
      return report();
    },
    invalidate: () => {},
    socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    origin: () => "https://ivib.cc",
  });
  client.start();
  await pause();
  rejectSnapshots = true;
  ready(sockets[0]);
  await pause();
  assert.equal(client.getStatus().state, "STALE");
  rejectSnapshots = false;
  await client.refreshSnapshot();
  assert.equal(client.getStatus().state, "CONNECTED");
  sockets[0].emit({ type: "resource.changed", app_id: "app-1", stream_id: "bad",
    sequence: 1, observedAt: Date.now(), resource: "licenses" });
  await pause();
  assert.equal(client.getStatus().state, "CONNECTED", "malformed payload triggers a successful full resync");
  assert.equal(adminRealtimeSocketUrl("http://localhost:3000"), "ws://localhost:3000/api/admin/realtime");
  assert.throws(() => adminRealtimeSocketUrl("file:///etc/passwd"), /HTTP/);
  client.stop();
});


test("ADMIN-RT-05: six existing UI components retain controls and subscribe to scoped HTTP refresh", () => {
  // Source contract only: this is NOT a substitute for browser DOM / production WSS testing.
  const names = [
    "AppsTab", "LicensesTab", "DevicesTab",
    "EditAppModal", "LogsTab", "OverviewTab",
  ] as const;
  const sources = Object.fromEntries(names.map(name => [
    name, readFileSync(new URL("../src/components/" + name + ".tsx", import.meta.url), "utf8"),
  ])) as Record<(typeof names)[number], string>;

  for (const name of names) {
    const source = sources[name];
    assert.match(source, /adminRealtime\.subscribe\(/, name + " must listen to shared Admin client");
    assert.match(source, /unsubscribe\(\)/, name + " must detach on unmount");
    assert.match(source, /clearTimeout\(timer\)/, name + " must cancel pending refetch");
    assert.match(source, /clearInterval\(/, name + " must cancel page-local fallback");
    assert.match(source, /api\.get(?:Apps|Licenses|Devices|RealtimePresence|Logs|Stats)\(/,
      name + " must read authoritative authenticated HTTP API");
  }
  assert.match(sources.AppsTab, /appliedSearch/, "App search is applied only on submission");
  assert.match(sources.AppsTab, /selectedIds/, "App selections remain intact");
  assert.match(sources.LicensesTab, /notice\.change\.app_id === appFilter/,
    "App-filtered license refresh is scoped");
  assert.match(sources.LicensesTab, /editingLicense/, "Edit state remains intact");
  assert.match(sources.EditAppModal, /notice\.change\.app_id === app\.id/,
    "Edit modal only refetches matching App presence");
  assert.match(sources.EditAppModal, /License Session Policy/, "Existing policy controls retained");
  assert.match(sources.EditAppModal, /presence\.observedAt/, "Timestamp explicitly displayed");

  const devices = sources.DevicesTab;
  assert.match(devices, /offset: \(currentPage - 1\) \* pageSize/,
    "Device offset must exceed the former first-100 cap");
  assert.match(devices, /limit: pageSize/, "Device page is a bounded API query");
  assert.match(devices, /totalItems=\{total\}/, "Page count must use server total");
  assert.match(devices, /pageDeviceIds/, "Presence is requested for current page IDs only");
  assert.match(devices, /api\.getRealtimePresence\(\{ deviceIds:/);
  assert.match(devices, /last_ping_at/, "HTTP heartbeat timestamp retained");
  assert.match(devices, /Connected/);
  assert.match(devices, /No WS/);
  assert.match(devices, /Unknown/, "Unavailable cannot be mislabeled disconnected");
  assert.match(devices, /Last Heartbeat/, "Existing table columns retained");

  assert.match(sources.LogsTab, /Log data stale/, "Log errors must not be silently shown as fresh");
  assert.match(sources.LogsTab, /lastUpdated/, "Log freshness timestamp");
  assert.match(sources.OverviewTab, /Recent activity unavailable/, "Overview stale report");
  assert.match(sources.OverviewTab, /Live Client Validation Stream/, "Existing layout kept");
});
