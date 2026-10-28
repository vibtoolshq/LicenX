/** Keep one-click test-key cleanup scoped to deliberately generated test credentials. */
export type AdminApiKeyIdentity = { id: string; key_prefix: string };

export function getExplicitTestAdminApiKeys<T extends AdminApiKeyIdentity>(
  keys: readonly T[],
): T[] {
  return keys.filter(({ key_prefix }) => /^vcon_test_[a-f0-9]{8}$/.test(key_prefix));
}

export async function deleteExplicitTestAdminApiKeys(
  keys: readonly AdminApiKeyIdentity[],
  deleteKey: (id: string) => Promise<unknown>,
): Promise<{ attempted: number; deleted: number; failed: number }> {
  const testKeys = getExplicitTestAdminApiKeys(keys);
  const results = await Promise.allSettled(testKeys.map((key) => deleteKey(key.id)));
  const deleted = results.filter((result) => result.status === 'fulfilled').length;
  return {
    attempted: testKeys.length,
    deleted,
    failed: testKeys.length - deleted,
  };
}
