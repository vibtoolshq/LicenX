import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const script = readFileSync("scripts/install-vps.sh", "utf8");
test("Ubuntu installer preflights Docker and profile without host takeover", () => {
  assert.match(script, /VERSION_ID.*24\.04/);
  assert.match(script, /docker compose version/);
  assert.match(script, /--profile standalone-https/);
  assert.match(script, /Ports 80\/443 are occupied/);
  assert.doesNotMatch(script, /docker compose down --volumes|docker compose down -v|git reset --hard/);
});
test("rerun preserves secrets, owner claim, and persisted Compose volumes", () => {
  assert.match(script, /if \[\[ -f "\$ROOT\/\.env" \]\]/);
  assert.match(script, /Existing configuration preserved/);
  assert.match(script, /refusing to overwrite configuration/);
  assert.match(script, /OWNER_SETUP_CODE_SHA256/);
  assert.match(script, /\.env\.owner-setup/);
  assert.match(script, /chmod 600/);
  assert.match(script, /openssl rand -hex 32/);
  assert.match(script, /if \[\[ -t 1 \]\]/);
});
test("installer shell keeps POSIX LF and does not include secrets", () => {
  assert.equal(script.includes("\r"), false);
  assert.match(readFileSync(".gitattributes","utf8"), /scripts\/install-vps\.sh text eol=lf/);
});
