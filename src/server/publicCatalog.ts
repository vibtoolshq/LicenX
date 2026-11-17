/**
 * PN-01 P01: bounded public catalog stored inside existing site_settings_json.
 * No schema migration, network lookup, privileged operation, or draft on public GET.
 */
import crypto from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseClient } from "./database/contracts.js";
import type {
  PublicCatalogAdmin, PublicCatalogPublished, PublicCatalogUpdate,
  PublicNavItem, PublicToolItem,
} from "../types.js";

type JsonRecord = Record<string, unknown>;
type SiteSnapshot = { id: string; raw: string | null; settings: JsonRecord };
const PUBLIC_PATHS = new Set(["/", "/tools", "/home", "/check", "/index.html"]);
const ASSET_PATH = /^\/api\/(?:public\/assets|storage\/file)\/branding\/[A-Za-z0-9][A-Za-z0-9_.-]{0,200}\.(png|jpe?g|gif|webp|ico)$/i;
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const UNSAFE_TEXT = /[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const URL_CONTROL = /[\u0000-\u0020\u007f\\<>"'\u202a-\u202e\u2066-\u2069]/u;
const HEX_VERSION = /^[a-f0-9]{64}$/i;

export class PublicCatalogError extends Error {
  constructor(
    public readonly status: 400 | 409 | 503,
    public readonly code: string,
  ) {
    super(code);
    this.name = "PublicCatalogError";
  }
}
function invalid(code: string): never { throw new PublicCatalogError(400, code); }
function unavailable(): never { throw new PublicCatalogError(503, "CATALOG_UNAVAILABLE"); }

function record(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: JsonRecord, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid("INVALID_CATALOG_ITEM");
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max ||
      UNSAFE_TEXT.test(value) || value !== value.trim()) invalid("INVALID_CATALOG_ITEM");
  return value;
}
function safeExternal(value: string): string {
  if (URL_CONTROL.test(value) || Buffer.byteLength(value, "utf8") > 2048 ||
      !value.startsWith("https://")) invalid("INVALID_CATALOG_URL");
  let url: URL;
  try { url = new URL(value); }
  catch { return invalid("INVALID_CATALOG_URL"); }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0 ||
      /(?:^localhost$|\.localhost$|\.local$|\.internal$|\.test$|\.invalid$)/i.test(url.hostname) ||
      url.hostname.endsWith(".") || url.href.length > 2048) invalid("INVALID_CATALOG_URL");
  return url.href;
}
function safeHref(value: unknown, allowInternal: boolean, allowPlaceholder = false): string {
  if (typeof value !== "string" || value.length > 2048) invalid("INVALID_CATALOG_URL");
  if (allowPlaceholder && value === "#") return value;
  if (allowInternal && PUBLIC_PATHS.has(value)) return value;
  return safeExternal(value);
}
function safeIcon(value: unknown): string {
  if (value === "" || value == null) return "";
  if (typeof value !== "string") invalid("INVALID_CATALOG_URL");
  if (ASSET_PATH.test(value)) return value;
  const checked = safeExternal(value);
  // Remote icons must be conventional raster images; never embed SVG/HTML.
  if (!/\.(?:png|jpe?g|gif|webp|ico)(?:[?#]|$)/i.test(new URL(checked).pathname)) {
    invalid("INVALID_CATALOG_URL");
  }
  return checked;
}
function validArray(value: unknown, max: number): JsonRecord[] {
  if (!Array.isArray(value)) invalid("INVALID_CATALOG_ITEM");
  if (value.length > max) invalid("CATALOG_LIMIT_EXCEEDED");
  if (!value.every(record)) invalid("INVALID_CATALOG_ITEM");
  return value;
}
function validateId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) invalid("INVALID_CATALOG_ITEM");
  return value;
}
function validateOrder(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10000) {
    invalid("INVALID_CATALOG_ITEM");
  }
  return value;
}
function validateBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid("INVALID_CATALOG_ITEM");
  return value;
}
function validateTarget(value: unknown): "same" | "new" {
  if (value !== "same" && value !== "new") invalid("INVALID_CATALOG_ITEM");
  return value;
}
function navItems(value: unknown, buyLicenseUrl: string, fromStorage = false): PublicNavItem[] {
  const seen = new Set<string>();
  return validArray(value, 24).map((item): PublicNavItem => {
    keys(item, fromStorage ?
      ["id", "label", "href", "kind", "enabled", "target", "order"] :
      ["id", "label", "href", "kind", "enabled", "target", "order"]);
    const id = validateId(item.id);
    if (seen.has(id)) invalid("INVALID_CATALOG_ITEM");
    seen.add(id);
    const kind = item.kind;
    if (kind !== "link" && kind !== "cta") invalid("INVALID_CATALOG_ITEM");
    if (id === "buy-license" && kind !== "cta") invalid("INVALID_CATALOG_ITEM");
    if (kind === "cta" && id !== "buy-license") invalid("INVALID_CATALOG_ITEM");
    if (id === "tools" && (kind !== "link" || item.href !== "/tools")) invalid("INVALID_CATALOG_ITEM");
    const href = id === "buy-license" && fromStorage ?
      safeLegacyBuyLicense(buyLicenseUrl) :
      safeHref(item.href, true, id === "buy-license");
    return {
      id, label: text(item.label, 60), href, kind,
      enabled: validateBoolean(item.enabled),
      target: validateTarget(item.target),
      order: validateOrder(item.order),
    };
  }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
function toolItems(value: unknown): PublicToolItem[] {
  const seen = new Set<string>();
  return validArray(value, 100).map(item => {
    keys(item, ["id", "name", "description", "url", "iconUrl", "enabled", "order"]);
    const id = validateId(item.id);
    if (seen.has(id)) invalid("INVALID_CATALOG_ITEM");
    seen.add(id);
    return {
      id, name: text(item.name, 80), description: text(item.description, 240, true),
      url: safeHref(item.url, false), iconUrl: safeIcon(item.iconUrl),
      enabled: validateBoolean(item.enabled), order: validateOrder(item.order),
    };
  }).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
function safeLegacyBuyLicense(value: unknown): string {
  // No mutation of pre-existing Site Settings values, even if unsafe for new links.
  try { return safeHref(typeof value === "string" ? value : "#", true, true); }
  catch { return "#"; }
}
function defaultNavigation(buyLicenseUrl: string): PublicNavItem[] {
  return [
    { id: "tools", label: "Tools", href: "/tools", kind: "link", enabled: true, target: "same", order: 0 },
    { id: "buy-license", label: "Buy License", href: safeLegacyBuyLicense(buyLicenseUrl),
      kind: "cta", enabled: true, target: "new", order: 1 },
  ];
}
function cleanStoredNavigation(items: PublicNavItem[]): JsonRecord[] {
  return items.map(item => item.id === "buy-license" ?
    { id: item.id, label: item.label, kind: item.kind,
      enabled: item.enabled, target: item.target, order: item.order } :
    { ...item });
}
function parseSettings(raw: string | null): JsonRecord {
  if (raw === null || raw === "") return {};
  try {
    const data: unknown = JSON.parse(raw);
    if (!record(data)) return unavailable();
    return data;
  } catch {
    return unavailable();
  }
}
async function snapshot(db: DatabaseClient): Promise<SiteSnapshot | null> {
  const result = await db.execute("SELECT id, site_settings_json FROM admin_config LIMIT 1");
  const row = result.rows[0];
  if (!row) return null;
  if (typeof row.id !== "string" ||
      (row.site_settings_json !== null && typeof row.site_settings_json !== "string")) return unavailable();
  const raw = row.site_settings_json as string | null;
  return { id: row.id, raw, settings: parseSettings(raw) };
}
function version(raw: string | null): string {
  return crypto.createHash("sha256").update(raw ?? "\u0000").digest("hex");
}
function catalog(settings: JsonRecord, raw: string | null): PublicCatalogAdmin {
  const buyLicenseUrl = typeof settings.buyLicenseUrl === "string" ?
    settings.buyLicenseUrl : "#";
  const navigation = settings.publicNavigation === undefined ?
    defaultNavigation(buyLicenseUrl) : navItems(settings.publicNavigation, buyLicenseUrl, true);
  const tools = settings.publicTools === undefined ? [] : toolItems(settings.publicTools);
  return { version: version(raw), buyLicenseUrl, navigation, tools };
}
export function publicSiteSettingsProjection(value: JsonRecord): JsonRecord {
  const safe = { ...value };
  delete safe.publicNavigation;
  delete safe.publicTools;
  return safe;
}
export async function readAdminPublicCatalog(db: DatabaseClient): Promise<PublicCatalogAdmin> {
  const row = await snapshot(db);
  return catalog(row?.settings ?? {}, row?.raw ?? null);
}
export async function readPublishedPublicCatalog(db: DatabaseClient): Promise<PublicCatalogPublished> {
  const row = await snapshot(db);
  const all = catalog(row?.settings ?? {}, row?.raw ?? null);
  return {
    navigation: all.navigation.filter(item => item.enabled),
    tools: all.tools.filter(item => item.enabled),
  };
}
async function conditionalWrite(
  db: DatabaseClient, current: SiteSnapshot, updated: JsonRecord,
): Promise<boolean> {
  const encoded = JSON.stringify(updated);
  const sql = current.raw === null ?
    "UPDATE admin_config SET site_settings_json = ?, updated_at = ? WHERE id = ? AND site_settings_json IS NULL" :
    "UPDATE admin_config SET site_settings_json = ?, updated_at = ? WHERE id = ? AND site_settings_json = ?";
  const args = current.raw === null ? [encoded, Date.now(), current.id] :
    [encoded, Date.now(), current.id, current.raw];
  const result = await db.execute({ sql, args });
  return result.rowsAffected === 1;
}
export async function updateAdminPublicCatalog(
  db: DatabaseClient, input: unknown,
): Promise<PublicCatalogAdmin> {
  if (!record(input)) invalid("INVALID_CATALOG_ITEM");
  keys(input, ["version", "section", "items"]);
  if (typeof input.version !== "string" || !HEX_VERSION.test(input.version)) invalid("INVALID_CATALOG_ITEM");
  if (input.section !== "navigation" && input.section !== "tools") invalid("INVALID_CATALOG_ITEM");
  const row = await snapshot(db);
  if (!row) return unavailable();
  if (version(row.raw) !== input.version) {
    throw new PublicCatalogError(409, "CATALOG_VERSION_CONFLICT");
  }
  // Fail closed if another stored section is corrupt: never overwrite it.
  catalog(row.settings, row.raw);
  const next: JsonRecord = { ...row.settings };
  if (input.section === "navigation") {
    const current = navItems(input.items, String(next.buyLicenseUrl ?? "#"));
    const buy = current.find(item => item.id === "buy-license");
    if (buy) next.buyLicenseUrl = buy.href;
    next.publicNavigation = cleanStoredNavigation(current);
  } else {
    next.publicTools = toolItems(input.items);
  }
  if (!(await conditionalWrite(db, row, next))) {
    throw new PublicCatalogError(409, "CATALOG_VERSION_CONFLICT");
  }
  return catalog(next, JSON.stringify(next));
}
export async function saveExistingSiteSettings(
  db: DatabaseClient, changes: unknown, defaults: JsonRecord,
): Promise<JsonRecord> {
  if (!record(changes)) invalid("INVALID_CATALOG_ITEM");
  if (Object.hasOwn(changes, "publicNavigation") || Object.hasOwn(changes, "publicTools") ||
      Object.hasOwn(changes, "__proto__") || Object.hasOwn(changes, "constructor") ||
      Object.hasOwn(changes, "prototype")) invalid("INVALID_CATALOG_ITEM");
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await snapshot(db);
    if (!row) return unavailable();
    const updated = { ...defaults, ...row.settings, ...changes };
    // Existing settings remain authoritative. Never copy a second CTA URL into nav metadata.
    if (await conditionalWrite(db, row, updated)) return updated;
  }
  throw new PublicCatalogError(409, "CATALOG_VERSION_CONFLICT");
}
