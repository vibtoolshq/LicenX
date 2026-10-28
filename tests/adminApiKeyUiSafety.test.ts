import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteExplicitTestAdminApiKeys, getExplicitTestAdminApiKeys } from '../src/components/adminApiKeySafety.js';

const entries = [
  { id: 'prod1', key_prefix: 'vcon_live_1234abcd' },
  { id: 'test1', key_prefix: 'vcon_test_1234abcd' },
  { id: 'prod2', key_prefix: 'vcon_store_87654321' },
  { id: 'test2', key_prefix: 'vcon_test_fedcba98' },
  { id: 'fake', key_prefix: 'vcon_test_more_00000000' },
  { id: 'uppercase', key_prefix: 'vcon_TEST_1234abcd' },
];

test('bulk clean scope includes only explicitly test-prefixed generated API keys', () => {
  assert.deepEqual(getExplicitTestAdminApiKeys(entries).map((x) => x.id), ['test1', 'test2']);
  assert.deepEqual(getExplicitTestAdminApiKeys(entries.filter(x => x.id.startsWith('prod'))), []);
});

test('bulk clean never touches production keys and reports partial failures', async () => {
  const deleted: string[] = [];
  const result = await deleteExplicitTestAdminApiKeys(entries, async (id) => {
    deleted.push(id);
    if (id === 'test2') throw new Error('simulated delete failure');
  });
  assert.deepEqual(deleted, ['test1', 'test2']);
  assert.deepEqual(result, { attempted: 2, deleted: 1, failed: 1 });
});

test('bulk clean returns zero with no test keys and never invokes delete API', async () => {
  const result = await deleteExplicitTestAdminApiKeys(
    [{ id: 'real', key_prefix: 'vcon_live_ffffeeee' }],
    async () => { throw new Error('must not be called'); },
  );
  assert.deepEqual(result, { attempted: 0, deleted: 0, failed: 0 });
});
