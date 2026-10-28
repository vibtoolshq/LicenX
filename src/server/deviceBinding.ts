import type { DatabaseClient, DatabaseTransaction } from "./database/contracts.js";
import { DEFAULT_DEVICE_LEASE_SECONDS } from "./licensePolicy.js";

const MAX_TRANSACTION_ATTEMPTS = 12;

export async function getDeviceLeaseSeconds(
  db: DatabaseClient,
  appId: unknown,
): Promise<number> {
  if (typeof appId !== "string" || !appId) {
    return DEFAULT_DEVICE_LEASE_SECONDS;
  }

  const result = await db.execute({
    sql: "SELECT device_lease_seconds FROM apps WHERE id = ? LIMIT 1",
    args: [appId],
  });
  const configuredLease = Number(result.rows[0]?.device_lease_seconds);
  return Number.isSafeInteger(configuredLease) && configuredLease > 0
    ? configuredLease
    : DEFAULT_DEVICE_LEASE_SECONDS;
}

interface BindDeviceParams {
  db: DatabaseClient;
  licenseId: string;
  hwid: string;
  deviceId: string;
  deviceName: string;
  osInfo: string;
  ipAddress: string;
  now: number;
  deviceLimit: number;
  deviceLeaseSeconds?: number;
  rejectBlocked: boolean;
  activateLicense?: boolean;
}

export type BindDeviceResult =
  | {
      status: "bound";
      existingDevice: boolean;
      activeDevicesCount: number;
      boundDevicesCount: number;
      activation?: { activatedAt: number; expiresAt: number | null };
    }
  | {
      status: "limit";
      existingDevice: boolean;
      activeDevicesCount: number;
      deviceLimit: number;
    }
  | { status: "blocked" };

export function bindDeviceWithinLimit(
  params: BindDeviceParams & { rejectBlocked: false },
): Promise<Exclude<BindDeviceResult, { status: "blocked" }>>;
export function bindDeviceWithinLimit(
  params: BindDeviceParams & { rejectBlocked: true },
): Promise<BindDeviceResult>;
export function bindDeviceWithinLimit(
  params: BindDeviceParams,
): Promise<BindDeviceResult>;
export async function bindDeviceWithinLimit({
  db,
  licenseId,
  hwid,
  deviceId,
  deviceName,
  osInfo,
  ipAddress,
  now,
  deviceLimit,
  deviceLeaseSeconds = DEFAULT_DEVICE_LEASE_SECONDS,
  rejectBlocked,
  activateLicense = false,
}: BindDeviceParams): Promise<BindDeviceResult> {
  const staleBefore = now - deviceLeaseSeconds * 1000;

  for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt++) {
    let transaction: DatabaseTransaction | undefined;

    try {
      transaction = await db.transaction("write");
      await transaction.lockLicense?.(licenseId);
      await transaction.execute({
        sql: "UPDATE devices SET status = 'logged_out' WHERE license_id = ? AND status = 'active' AND last_ping_at <= ?",
        args: [licenseId, staleBefore],
      });
      const existingResult = await transaction.execute({
        sql: "SELECT id, status FROM devices WHERE license_id = ? AND hwid = ? LIMIT 1",
        args: [licenseId, hwid],
      });
      const countResult = await transaction.execute({
        sql: "SELECT COUNT(*) AS active_count FROM devices WHERE license_id = ? AND status = 'active'",
        args: [licenseId],
      });

      const existingDevice = existingResult.rows[0];
      const existingStatus = existingDevice?.status as string | undefined;
      const activeDevicesCount = Number(countResult.rows[0]?.active_count || 0);

      if (rejectBlocked && existingStatus === "blocked") {
        await transaction.rollback();
        return { status: "blocked" };
      }

      const wasActive = existingStatus === "active";
      const shouldCheckLimit = !wasActive;

      if (
        shouldCheckLimit &&
        deviceLimit !== -1 &&
        activeDevicesCount >= deviceLimit
      ) {
        await transaction.rollback();
        return {
          status: "limit",
          existingDevice: Boolean(existingDevice),
          activeDevicesCount,
          deviceLimit,
        };
      }

      if (existingDevice) {
        await transaction.execute({
          sql: "UPDATE devices SET status = 'active', last_ping_at = ?, device_name = ?, os_info = ?, ip_address = ? WHERE id = ?",
          args: [
            now,
            deviceName,
            osInfo,
            ipAddress,
            existingDevice.id as string,
          ],
        });
      } else {
        await transaction.execute({
          sql: `INSERT INTO devices (id, license_id, hwid, device_name, os_info, ip_address, first_bound_at, last_ping_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
          args: [
            deviceId,
            licenseId,
            hwid,
            deviceName,
            osInfo,
            ipAddress,
            now,
            now,
          ],
        });
      }

      let activation: { activatedAt: number; expiresAt: number | null } | undefined;
      if (activateLicense) {
        const result = await transaction.execute({
          sql: "SELECT activated_at, expires_at, validity_type, validity_value FROM licenses WHERE id = ?",
          args: [licenseId],
        });
        const license = result.rows[0];
        if (!license) throw new Error("License no longer exists");
        let activatedAt = Number(license.activated_at) || now;
        let expiresAt = license.expires_at === null ? null : Number(license.expires_at);
        if (!license.activated_at) {
          const duration = license.validity_type === "hourly" ? 3_600_000 : license.validity_type === "daily" ? 86_400_000 : 0;
          if (duration && Number(license.validity_value) > 0) expiresAt = now + Number(license.validity_value) * duration;
          await transaction.execute({
            sql: "UPDATE licenses SET activated_at = ?, expires_at = ? WHERE id = ?",
            args: [activatedAt, expiresAt, licenseId],
          });
        }
        activation = { activatedAt, expiresAt };
      }
      await transaction.commit();
      return {
        status: "bound",
        existingDevice: Boolean(existingDevice),
        activeDevicesCount,
        boundDevicesCount: wasActive
          ? activeDevicesCount
          : activeDevicesCount + 1,
        ...(activation ? { activation } : {}),
      };
    } catch (error) {
      if (transaction) await transaction.rollback();
      if (
        !isTransientLockError(error) ||
        attempt === MAX_TRANSACTION_ATTEMPTS - 1
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          (attempt + 1) * 10 + Math.floor(Math.random() * 10),
        ),
      );
    } finally {
      transaction?.close();
    }
  }

  throw new Error("Device binding transaction retry limit reached");
}

function isTransientLockError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = error.code;
  return (
    typeof code === "string" &&
    (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED") || code === "40001" || code === "40P01")
  );
}
