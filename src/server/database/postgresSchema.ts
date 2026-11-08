import type { DatabaseClient } from "./contracts.js";
import crypto from "node:crypto";

const initialSchema = [
  `CREATE TABLE IF NOT EXISTS user_control_pin_attempts (
        attempt_key TEXT PRIMARY KEY,
        window_started_at BIGINT NOT NULL,
        failed_attempts BIGINT NOT NULL DEFAULT 0,
        blocked_until BIGINT NOT NULL DEFAULT 0
      )`,
  `CREATE INDEX IF NOT EXISTS idx_user_control_pin_attempts_window
      ON user_control_pin_attempts(window_started_at)`,
  `CREATE TABLE IF NOT EXISTS admin_login_attempts (
        attempt_key TEXT PRIMARY KEY,
        window_started_at BIGINT NOT NULL,
        failed_attempts BIGINT NOT NULL DEFAULT 0,
        blocked_until BIGINT NOT NULL DEFAULT 0
      )`,
  `CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_expiry
      ON admin_login_attempts(blocked_until, window_started_at)`,
  `CREATE TABLE IF NOT EXISTS admin_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        permissions_json TEXT NOT NULL,
        app_id TEXT,
        last_used_at BIGINT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at BIGINT NOT NULL
      )`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_prefix
      ON admin_api_keys(key_prefix)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_status
      ON admin_api_keys(status)`,
  `CREATE INDEX IF NOT EXISTS idx_api_keys_secret_hash
      ON admin_api_keys(secret_hash)`,
  `CREATE TABLE IF NOT EXISTS admin_config (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        jwt_secret TEXT NOT NULL,
        ed25519_private_key TEXT NOT NULL,
        ed25519_public_key TEXT NOT NULL,
        r2_config_json TEXT,
        site_settings_json TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );`,
  `CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      app_slug TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      min_version TEXT NOT NULL DEFAULT '1.0.0',
      status TEXT NOT NULL DEFAULT 'active',
      app_secret TEXT NOT NULL,
      description TEXT,
      device_lease_seconds BIGINT NOT NULL DEFAULT 7200,
      ping_interval_seconds BIGINT NOT NULL DEFAULT 1200,
      offline_grace_seconds BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );`,
  `CREATE INDEX IF NOT EXISTS idx_apps_slug ON apps(app_slug);`,
  `CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status);`,
  `CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      tier TEXT DEFAULT 'Standard',
      app_id TEXT,
      device_limit BIGINT DEFAULT 1,
      validity_type TEXT DEFAULT 'lifetime',
      validity_value BIGINT DEFAULT 0,
      activated_at BIGINT,
      expires_at BIGINT,
      created_at BIGINT NOT NULL,
      customer_name TEXT,
      customer_email TEXT,
      notes TEXT,
      metadata_json TEXT,
      r2_backup_id TEXT,
      pin TEXT
    );`,
  `CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);`,
  `CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);`,
  `CREATE INDEX IF NOT EXISTS idx_licenses_app ON licenses(app_id);`,
  `CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      license_id TEXT NOT NULL,
      hwid TEXT NOT NULL,
      device_name TEXT,
      os_info TEXT,
      ip_address TEXT,
      first_bound_at BIGINT NOT NULL,
      last_ping_at BIGINT NOT NULL,
      status TEXT DEFAULT 'active',
      FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
    );`,
  `CREATE INDEX IF NOT EXISTS idx_devices_license_id ON devices(license_id);`,
  `CREATE INDEX IF NOT EXISTS idx_devices_hwid ON devices(hwid);`,
  `CREATE TABLE IF NOT EXISTS validation_logs (
      id TEXT PRIMARY KEY,
      license_key TEXT,
      app_slug TEXT,
      hwid TEXT,
      ip_address TEXT,
      action TEXT NOT NULL,
      status_code BIGINT NOT NULL,
      message TEXT,
      created_at BIGINT NOT NULL
    );`,
  `CREATE INDEX IF NOT EXISTS idx_logs_created_at ON validation_logs(created_at DESC);`,
  `CREATE TABLE IF NOT EXISTS r2_backups (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      record_count BIGINT NOT NULL,
      file_size BIGINT NOT NULL,
      r2_url TEXT,
      created_at BIGINT NOT NULL
    );`,
  `CREATE INDEX IF NOT EXISTS idx_licenses_created_at ON licenses(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_first_bound ON devices(first_bound_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_action ON validation_logs(action, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_licenses_created_at ON licenses(created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_devices_first_bound ON devices(first_bound_at DESC);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_license_hwid ON devices(license_id, hwid)`,
];

export async function migratePostgres(db: DatabaseClient): Promise<void> {
  const transaction = await db.transaction("write");
  try {
    await transaction.execute("SELECT pg_advisory_xact_lock(1280197464)");
    await transaction.execute(`CREATE TABLE IF NOT EXISTS licenx_schema_migrations (
      version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL
    )`);
    const result = await transaction.execute("SELECT version FROM licenx_schema_migrations WHERE version = 1");
    if (!result.rows.length) {
      for (const statement of initialSchema) await transaction.execute(statement);
      await transaction.execute({
        sql: "INSERT INTO licenx_schema_migrations (version, applied_at) VALUES (1, ?)",
        args: [Date.now()],
      });
    }
    const rateLimitMigration = await transaction.execute("SELECT version FROM licenx_schema_migrations WHERE version = 2");
    if (!rateLimitMigration.rows.length) {
      await transaction.execute(`CREATE TABLE IF NOT EXISTS public_license_check_limits (
        bucket_key TEXT PRIMARY KEY,
        window_start BIGINT NOT NULL,
        requests BIGINT NOT NULL DEFAULT 0
      )`);
      await transaction.execute("CREATE INDEX IF NOT EXISTS idx_public_license_check_limits_window ON public_license_check_limits(window_start)");
      await transaction.execute({ sql: "INSERT INTO licenx_schema_migrations (version, applied_at) VALUES (2, ?)", args: [Date.now()] });
    }
    const domainMigration = await transaction.execute("SELECT version FROM licenx_schema_migrations WHERE version = 3");
    if (!domainMigration.rows.length) {
      await transaction.execute(`CREATE TABLE IF NOT EXISTS public_license_api_settings (
        id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, secret_key TEXT NOT NULL
      )`);
      await transaction.execute({
        sql: "INSERT INTO public_license_api_settings (id, enabled, secret_key) VALUES ('main', 0, ?) ON CONFLICT(id) DO NOTHING",
        args: [crypto.randomBytes(32).toString("hex")],
      });
      await transaction.execute(`CREATE TABLE IF NOT EXISTS public_license_api_domains (
        id TEXT PRIMARY KEY, domain_origin TEXT UNIQUE NOT NULL, app_id TEXT NOT NULL,
        key_id TEXT UNIQUE NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL
      )`);
      await transaction.execute({ sql: "INSERT INTO licenx_schema_migrations (version, applied_at) VALUES (3, ?)", args: [Date.now()] });
    }

    // WS-02: additive, transactional and disabled-by-default realtime policy.
    const realtimeMigration = await transaction.execute("SELECT version FROM licenx_schema_migrations WHERE version = 4");
    if (!realtimeMigration.rows.length) {
      await transaction.execute("ALTER TABLE apps ADD COLUMN IF NOT EXISTS realtime_websocket_enabled INTEGER NOT NULL DEFAULT 0");
      await transaction.execute("ALTER TABLE apps ADD COLUMN IF NOT EXISTS keep_login_on_network_error INTEGER NOT NULL DEFAULT 0");
      await transaction.execute(`CREATE TABLE IF NOT EXISTS realtime_events (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        event_type TEXT NOT NULL,
        app_id TEXT,
        license_id TEXT,
        device_id TEXT,
        created_at BIGINT NOT NULL
      )`);
      await transaction.execute("CREATE INDEX IF NOT EXISTS idx_realtime_events_created ON realtime_events(created_at)");
      await transaction.execute(`CREATE OR REPLACE FUNCTION licenx_realtime_audit_event()
      RETURNS trigger LANGUAGE plpgsql AS $licenx$
      DECLARE aid TEXT; lid TEXT; did TEXT; eventName TEXT;
      BEGIN
        IF TG_TABLE_NAME = 'apps' THEN
          aid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
          eventName := CASE WHEN TG_OP = 'DELETE' THEN 'app.deleted' ELSE 'app.changed' END;
        ELSIF TG_TABLE_NAME = 'licenses' THEN
          aid := CASE WHEN TG_OP = 'DELETE' THEN OLD.app_id ELSE NEW.app_id END;
          lid := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
          eventName := CASE WHEN TG_OP = 'DELETE' THEN 'license.deleted' ELSE 'license.changed' END;
        ELSIF TG_TABLE_NAME = 'devices' THEN
          lid := CASE WHEN TG_OP = 'DELETE' THEN OLD.license_id ELSE NEW.license_id END;
          did := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
          SELECT app_id INTO aid FROM licenses WHERE id = lid;
          eventName := CASE WHEN TG_OP = 'DELETE' THEN 'device.deleted' ELSE 'device.changed' END;
        END IF;
        INSERT INTO realtime_events(event_type,app_id,license_id,device_id,created_at)
          VALUES(eventName,aid,lid,did,(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT);
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END; $licenx$`);
      await transaction.execute(`CREATE TRIGGER licenx_rt_app_update
        AFTER UPDATE OF status,realtime_websocket_enabled,keep_login_on_network_error,device_lease_seconds,ping_interval_seconds,offline_grace_seconds,min_version
        ON apps FOR EACH ROW WHEN (
          ROW(OLD.status,OLD.realtime_websocket_enabled,OLD.keep_login_on_network_error,OLD.device_lease_seconds,OLD.ping_interval_seconds,OLD.offline_grace_seconds,OLD.min_version)
          IS DISTINCT FROM
          ROW(NEW.status,NEW.realtime_websocket_enabled,NEW.keep_login_on_network_error,NEW.device_lease_seconds,NEW.ping_interval_seconds,NEW.offline_grace_seconds,NEW.min_version)
        ) EXECUTE FUNCTION licenx_realtime_audit_event()`);
      await transaction.execute("CREATE TRIGGER licenx_rt_app_delete AFTER DELETE ON apps FOR EACH ROW EXECUTE FUNCTION licenx_realtime_audit_event()");
      await transaction.execute(`CREATE TRIGGER licenx_rt_license_update
        AFTER UPDATE OF status,expires_at,app_id,device_limit,tier ON licenses
        FOR EACH ROW WHEN (ROW(OLD.status,OLD.expires_at,OLD.app_id,OLD.device_limit,OLD.tier)
          IS DISTINCT FROM ROW(NEW.status,NEW.expires_at,NEW.app_id,NEW.device_limit,NEW.tier))
        EXECUTE FUNCTION licenx_realtime_audit_event()`);
      await transaction.execute("CREATE TRIGGER licenx_rt_license_delete AFTER DELETE ON licenses FOR EACH ROW EXECUTE FUNCTION licenx_realtime_audit_event()");
      await transaction.execute(`CREATE TRIGGER licenx_rt_device_update
        AFTER UPDATE OF status ON devices FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
        EXECUTE FUNCTION licenx_realtime_audit_event()`);
      await transaction.execute("CREATE TRIGGER licenx_rt_device_delete AFTER DELETE ON devices FOR EACH ROW EXECUTE FUNCTION licenx_realtime_audit_event()");
      await transaction.execute({
        sql: "INSERT INTO licenx_schema_migrations (version, applied_at) VALUES (4, ?)",
        args: [Date.now()],
      });
    }
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  } finally {
    transaction.close();
  }
}
