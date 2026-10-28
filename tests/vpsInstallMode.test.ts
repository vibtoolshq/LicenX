import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const script=fs.readFileSync('scripts/install-vps.sh','utf8');
const overlay=fs.readFileSync('deploy/compose.existing-proxy.yaml','utf8');
test('pre-existing proxy mode never publishes TLS ports or exposes database',()=>{
  assert.match(script,/INSTALL_MODE=standalone/);
  assert.match(script,/existing-proxy/);
  assert.match(script,/compose\.existing-proxy\.yaml/);
  assert.match(overlay,/127\.0\.0\.1:/);
  assert.doesNotMatch(overlay,/443:443|80:80|5432:5432/);
});
test('private generated installer credentials and rerun remain guarded',()=>{
  assert.match(script,/openssl rand -hex 32/);
  assert.match(script,/OWNER_SETUP_CODE_SHA256/);
  assert.match(script,/Existing configuration preserved/);
  assert.match(script,/chmod 600/);
});
