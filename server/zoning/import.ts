import { INITIAL_NC_SC_SOURCE_RECORDS, PostgresSourceRegistry } from '../../src/services/zoning/registry';
import { importNcScJurisdictions } from '../../src/services/zoning/jurisdiction';
import { readZoningServerConfig } from './config';
import { createZoningDatabase } from './database';

const config = readZoningServerConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the jurisdiction importer');
const database = createZoningDatabase(config.databaseUrl, config.databaseSsl);
const sourcesOnly = process.argv.includes('--sources-only');
const boundariesOnly = process.argv.includes('--boundaries-only');

try {
  const boundaryResult = sourcesOnly
    ? { states: [], counties: 0, municipalities: 0 }
    : await importNcScJurisdictions(database.sql);
  let sources = 0;
  if (!boundariesOnly) {
    const registry = new PostgresSourceRegistry(database.sql);
    for (const record of INITIAL_NC_SC_SOURCE_RECORDS) {
      await registry.put(record);
      sources += 1;
    }
  }
  console.info(JSON.stringify({ imported: { ...boundaryResult, sources } }, null, 2));
} finally {
  await database.close();
}
