import crypto from "node:crypto";

/** VPS owner claim is opt-in for the Node PostgreSQL runtime only. */
export function ownerBootstrapRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.DATABASE_PROVIDER || "").toLowerCase() === "postgres"
    || /^postgres(?:ql)?:\/\//i.test(env.DATABASE_URL || "");
}

export function validOwnerSetupCode(input: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!ownerBootstrapRequired(env)) return true;
  const expected = env.OWNER_SETUP_CODE_SHA256 || "";
  if (!/^[a-f0-9]{64}$/i.test(expected) || typeof input !== "string"
      || !/^[a-f0-9]{64}$/i.test(input)) return false;
  const providedDigest = crypto.createHash("sha256").update(input, "utf8").digest();
  const expectedDigest = Buffer.from(expected, "hex");
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}
