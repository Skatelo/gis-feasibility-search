import { readZoningServerConfig } from './config';
import { createZoningDatabase } from './database';

const config = readZoningServerConfig();
if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the coverage report');
const database = createZoningDatabase(config.databaseUrl, config.databaseSsl);

try {
  const coverage = await database.sql.query<{
    state: string;
    jurisdiction_type: string;
    zoning_status: string;
    jurisdictions: number;
    verified: number;
  }>(
    `select j.state, j.jurisdiction_type, j.zoning_status,
            count(*)::integer as jurisdictions,
            count(*) filter (where exists (
              select 1 from public.zoning_gis_sources s
               where s.jurisdiction_id = j.id and s.dataset_type = 'zoning'
                 and s.active and s.official_source
                 and s.validation_status in ('verified','high_confidence')
                 and s.classification in ('verified_current_zoning','likely_current_zoning')
            ))::integer as verified
       from public.zoning_jurisdictions j
      where j.active
      group by j.state, j.jurisdiction_type, j.zoning_status
      order by j.state, j.jurisdiction_type, j.zoning_status`,
  );
  const health = await database.sql.query<{
    state: string;
    status: string;
    sources: number;
  }>(
    `select j.state, coalesce(latest.status, 'never_checked') as status, count(*)::integer as sources
       from public.zoning_gis_sources s
       join public.zoning_jurisdictions j on j.id = s.jurisdiction_id
       left join lateral (
         select h.status from public.zoning_gis_health_checks h
          where h.source_id = s.id order by h.checked_at desc limit 1
       ) latest on true
      where s.active
      group by j.state, coalesce(latest.status, 'never_checked')
      order by j.state, status`,
  );
  console.info(JSON.stringify({ generatedAt: new Date().toISOString(), coverage: coverage.rows, health: health.rows }, null, 2));
} finally {
  await database.close();
}
