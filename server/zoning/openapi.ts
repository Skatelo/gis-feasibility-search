const addressBody = {
  required: true,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['address'],
        properties: { address: { type: 'string', minLength: 5, maxLength: 400 } },
      },
    },
  },
} as const;

const standardResponses = {
  '400': { $ref: '#/components/responses/BadRequest' },
  '422': { $ref: '#/components/responses/Unprocessable' },
  '502': { $ref: '#/components/responses/UpstreamFailure' },
} as const;

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'NC/SC Official Zoning API',
    version: '1.0.0',
    description: 'Registry-only parcel and zoning lookup backed by verified public government GIS layers.',
  },
  servers: [{ url: 'http://localhost:8787', description: 'Local zoning service' }],
  tags: [
    { name: 'Lookup', description: 'Public deterministic lookup endpoints' },
    { name: 'Administration', description: 'Protected source registry and maintenance endpoints' },
  ],
  paths: {
    '/health': {
      get: { operationId: 'health', responses: { '200': { description: 'Service health' } } },
    },
    '/v1/geocode': {
      post: {
        tags: ['Lookup'], operationId: 'geocodeAddress', summary: 'Geocode a high-quality NC or SC address',
        requestBody: addressBody,
        responses: { '200': { description: 'Normalized geocode', content: { 'application/json': { schema: { $ref: '#/components/schemas/Geocode' } } } }, ...standardResponses },
      },
    },
    '/v1/jurisdictions/resolve': {
      post: {
        tags: ['Lookup'], operationId: 'resolveJurisdiction', summary: 'Resolve the controlling zoning authority spatially',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { oneOf: [
            { type: 'object', required: ['address'], properties: { address: { type: 'string' } } },
            { type: 'object', required: ['latitude', 'longitude'], properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
          ] } } },
        },
        responses: { '200': { description: 'Controlling jurisdiction' }, ...standardResponses },
      },
    },
    '/v1/parcels/lookup': {
      post: {
        tags: ['Lookup'], operationId: 'lookupParcel', summary: 'Locate an official parcel and its interior point',
        requestBody: addressBody,
        responses: { '200': { description: 'Parcel result or explicit unavailable status' }, ...standardResponses },
      },
    },
    '/v1/zoning/lookup': {
      post: {
        tags: ['Lookup'], operationId: 'lookupZoning', summary: 'Return evidence-backed base zoning and overlays',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ZoningLookupRequest' } } },
        },
        responses: {
          '200': { description: 'Verified result, no-zoning record, or manual-review result', content: { 'application/json': { schema: { $ref: '#/components/schemas/ZoningResult' } } } },
          ...standardResponses,
        },
      },
    },
    '/v1/admin/sources': {
      get: { tags: ['Administration'], security: [{ AdminKey: [] }], summary: 'List source records', responses: { '200': { description: 'Source records' }, '401': { $ref: '#/components/responses/Unauthorized' } } },
      post: { tags: ['Administration'], security: [{ AdminKey: [] }], summary: 'Add an unverified source candidate', responses: { '201': { description: 'Candidate created' }, '401': { $ref: '#/components/responses/Unauthorized' } } },
    },
    '/v1/admin/sources/{id}': {
      patch: {
        tags: ['Administration'], security: [{ AdminKey: [] }], summary: 'Review, classify, or disable a source',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Updated source' }, '401': { $ref: '#/components/responses/Unauthorized' }, '404': { description: 'Source not found' } },
      },
    },
    '/v1/admin/sources/{id}/inspect': {
      get: { tags: ['Administration'], security: [{ AdminKey: [] }], summary: 'Read live layer metadata and samples', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Metadata and sample attributes' } } },
    },
    '/v1/admin/sources/{id}/versions': {
      get: { tags: ['Administration'], security: [{ AdminKey: [] }], summary: 'Read immutable source history', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Version history' } } },
    },
    '/v1/admin/sources/{id}/validate': {
      post: { tags: ['Administration'], security: [{ AdminKey: [] }], summary: 'Queue metadata, sample, and real point validation', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Validation queued' } } },
    },
    '/v1/admin/discovery': {
      post: { tags: ['Administration'], security: [{ AdminKey: [] }], summary: 'Queue maintenance-only source discovery', responses: { '200': { description: 'Discovery queued' } } },
    },
    '/v1/admin/health/run': {
      post: { tags: ['Administration'], security: [{ AdminKey: [] }], summary: 'Queue a source health scan', responses: { '200': { description: 'Health scan queued' } } },
    },
  },
  components: {
    securitySchemes: {
      AdminKey: { type: 'apiKey', in: 'header', name: 'x-admin-key' },
    },
    responses: {
      BadRequest: { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unauthorized: { description: 'Administrative credentials required' },
      Unprocessable: { description: 'Address is outside NC/SC or geocode precision is insufficient' },
      UpstreamFailure: { description: 'Official GIS request failed within the configured deadline' },
    },
    schemas: {
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' }, detail: { type: 'string' }, details: { type: 'array', items: {} } } },
      Geocode: {
        type: 'object', required: ['inputAddress', 'normalizedAddress', 'coordinates', 'precision', 'state', 'provider', 'confidence'],
        properties: {
          inputAddress: { type: 'string' }, normalizedAddress: { type: 'string' },
          coordinates: { $ref: '#/components/schemas/Coordinates' }, precision: { type: 'string' },
          state: { type: 'string', enum: ['NC', 'SC'] }, stateFips: { type: ['string', 'null'] },
          county: { type: ['string', 'null'] }, countyFips: { type: ['string', 'null'] },
          provider: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
      Coordinates: { type: 'object', required: ['latitude', 'longitude'], properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } },
      ZoningLookupRequest: {
        type: 'object', required: ['address'],
        properties: {
          address: { type: 'string', minLength: 5, maxLength: 400 }, parcelId: { type: 'string' },
          includeParcel: { type: 'boolean', default: true }, includeOverlays: { type: 'boolean', default: true },
          includeGeometry: { type: 'boolean', default: false }, includeSourceEvidence: { type: 'boolean', default: true },
          forceRefresh: { type: 'boolean', default: false }, mode: { type: 'string', enum: ['fast', 'verified', 'deep'], default: 'verified' },
        },
      },
      ZoningResult: {
        type: 'object', required: ['status', 'address', 'jurisdiction', 'overlays', 'confidence', 'sources', 'warnings', 'performance'],
        properties: {
          status: { type: 'string', enum: ['verified', 'verified-with-warnings', 'possible-match', 'manual_review', 'not_found', 'no_zoning', 'error'] },
          reason: { type: 'string' }, address: { type: 'object' }, coordinates: { oneOf: [{ $ref: '#/components/schemas/Coordinates' }, { type: 'null' }] },
          jurisdiction: { type: 'object' }, parcel: { type: ['object', 'null'] }, baseZoning: { type: ['object', 'null'] },
          overlays: { type: 'array', items: { type: 'object' } }, confidence: { type: 'object' },
          sources: { type: 'array', items: { type: 'object' } }, warnings: { type: 'array', items: { type: 'string' } },
          performance: { type: 'object', required: ['cached', 'responseTimeMs'], properties: { cached: { type: 'boolean' }, responseTimeMs: { type: 'integer' } } },
        },
      },
    },
  },
} as const;
