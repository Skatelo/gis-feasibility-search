import { buildZoningApi } from './api';
import { readZoningServerConfig } from './config';
import { createZoningRuntime } from './runtime';

const config = readZoningServerConfig();
const runtime = await createZoningRuntime(config);
const app = await buildZoningApi(runtime);

const shutdown = async () => {
  await app.close();
  await runtime.close();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
