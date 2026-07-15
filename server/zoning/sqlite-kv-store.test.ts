import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KvSourceRegistry, INITIAL_NC_SC_SOURCE_RECORDS } from '../../src/services/zoning/registry';
import { SqliteKVStore } from './sqlite-kv-store';

test('SQLite local registry survives a process-style reopen and honors cache expiry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zoning-sqlite-'));
  const filename = join(directory, 'registry.sqlite');
  try {
    const firstStore = new SqliteKVStore(filename);
    const firstRegistry = new KvSourceRegistry(firstStore);
    const source = INITIAL_NC_SC_SOURCE_RECORDS[0];
    await firstRegistry.put(source);
    await firstRegistry.cacheSet('fixture', 'expired', { stale: true }, -1);
    firstStore.close();

    const secondStore = new SqliteKVStore(filename);
    try {
      const secondRegistry = new KvSourceRegistry(secondStore);
      const persisted = await secondRegistry.get(source.id);
      assert.equal(persisted?.id, source.id);
      assert.equal(persisted?.serviceUrl, source.serviceUrl);
      assert.deepEqual(persisted?.zoningLayers, source.zoningLayers);
      assert.equal(await secondRegistry.cacheGet('fixture', 'expired'), null);
    } finally {
      secondStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
