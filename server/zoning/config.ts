import { z } from 'zod';

const OptionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.string().url().optional());

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: OptionalUrl,
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  REDIS_URL: OptionalUrl,
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  VITE_GOOGLE_MAPS_API_KEY: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  PERPLEXITY_SEARCH_ENDPOINT: OptionalUrl,
  ZONING_ADMIN_API_KEY: z.string().min(16).optional(),
  ZONING_CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:4173'),
});

export interface ZoningServerConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl?: string;
  databaseSsl: boolean;
  redisUrl?: string;
  googleMapsApiKey?: string;
  perplexityApiKey?: string;
  perplexitySearchEndpoint?: string;
  adminApiKey?: string;
  corsOrigins: string[];
}

export function readZoningServerConfig(env: NodeJS.ProcessEnv = process.env): ZoningServerConfig {
  const parsed = EnvironmentSchema.parse(env);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    databaseSsl: parsed.DATABASE_SSL === 'true',
    redisUrl: parsed.REDIS_URL,
    googleMapsApiKey: parsed.GOOGLE_MAPS_API_KEY ?? parsed.VITE_GOOGLE_MAPS_API_KEY,
    perplexityApiKey: parsed.PERPLEXITY_API_KEY,
    perplexitySearchEndpoint: parsed.PERPLEXITY_SEARCH_ENDPOINT,
    adminApiKey: parsed.ZONING_ADMIN_API_KEY,
    corsOrigins: parsed.ZONING_CORS_ORIGINS.split(',').map((value) => value.trim()).filter(Boolean),
  };
}
