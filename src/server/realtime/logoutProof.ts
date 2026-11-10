/** LX-S03: opt-in, single-use device logout bearer. Never authorizes a license. */
import crypto from "node:crypto";

const TTL_MS = 60 * 60_000;
const MAX_PROOFS = 4096;
type Proof = { deviceId: string; licenseId: string; hwid: string; expiresAt: number };
const active = new Map<string, { hash: string; proof: Proof }>();
const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const identityKey = (licenseId: string, hwid: string) => licenseId.length + ":" + licenseId + ":" + hwid;

function prune(now: number) {
  for (const [key, value] of active) if (value.proof.expiresAt <= now) active.delete(key);
  while (active.size >= MAX_PROOFS) active.delete(active.keys().next().value!);
}
export function prepareDeviceLogoutProof() {
  // Only called after input, license and app validation, inside signed validation finalizer.
  return crypto.randomBytes(32).toString("base64url");
}
export function activateDeviceLogoutProof(
  token: string, deviceId: string, licenseId: string, hwid: string,
): void {
  prune(Date.now());
  active.set(identityKey(licenseId, hwid), {
    hash: hash(token),
    proof: { deviceId, licenseId, hwid, expiresAt: Date.now() + TTL_MS },
  });
}
export function invalidateDeviceLogoutProof(licenseId: string, hwid: string): void {
  active.delete(identityKey(licenseId, hwid));
}
export function takeDeviceLogoutProof(token: unknown): Proof | null {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = hash(token);
  const now = Date.now();
  for (const [key, entry] of active) {
    if (entry.proof.expiresAt <= now) { active.delete(key); continue; }
    if (crypto.timingSafeEqual(Buffer.from(entry.hash, "hex"), Buffer.from(tokenHash, "hex"))) {
      active.delete(key); // One use; an old token cannot later revoke a rebound device.
      return { ...entry.proof };
    }
  }
  return null;
}
export function restoreDeviceLogoutProof(token: string, proof: Proof): void {
  if (proof.expiresAt <= Date.now()) return;
  const key = identityKey(proof.licenseId, proof.hwid);
  if (!active.has(key)) active.set(key, { hash: hash(token), proof: { ...proof } });
}
