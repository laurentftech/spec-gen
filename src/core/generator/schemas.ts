/**
 * JSON Schema definitions for LLM responses.
 *
 * Passing these schemas to completeJSON forces the model to return
 * the correct top-level structure (e.g. an array instead of a single object).
 * See: https://github.com/clay-good/openlore/issues/26
 */

export const STAGE2_ENTITY_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['name', 'description', 'properties', 'relationships', 'validations', 'scenarios'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      properties: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'type'],
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            description: { type: 'string' },
            required: { type: 'boolean' },
          },
        },
      },
      relationships: {
        type: 'array',
        items: {
          type: 'object',
          required: ['targetEntity', 'type'],
          properties: {
            targetEntity: { type: 'string' },
            type: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
      validations: { type: 'array', items: { type: 'string' } },
      scenarios: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'given', 'when', 'then'],
          properties: {
            name: { type: 'string' },
            given: { type: 'string' },
            when: { type: 'string' },
            then: { type: 'string' },
            and: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      location: { type: 'string' },
    },
  },
} as const;

export const STAGE3_SERVICE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['name', 'purpose', 'operations', 'dependencies', 'sideEffects', 'domain'],
    properties: {
      name: { type: 'string' },
      purpose: { type: 'string' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'description', 'scenarios'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            inputs: { type: 'array', items: { type: 'string' } },
            outputs: { type: 'array', items: { type: 'string' } },
            functionName: { type: 'string' },
            scenarios: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'given', 'when', 'then'],
                properties: {
                  name: { type: 'string' },
                  given: { type: 'string' },
                  when: { type: 'string' },
                  then: { type: 'string' },
                  and: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      dependencies: { type: 'array', items: { type: 'string' } },
      sideEffects: { type: 'array', items: { type: 'string' } },
      domain: { type: 'string' },
    },
  },
} as const;

export const STAGE4_ENDPOINT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['method', 'path', 'purpose', 'scenarios'],
    properties: {
      method: { type: 'string' },
      path: { type: 'string' },
      purpose: { type: 'string' },
      authentication: { type: 'string' },
      requestSchema: { type: 'object' },
      responseSchema: { type: 'object' },
      scenarios: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'given', 'when', 'then'],
          properties: {
            name: { type: 'string' },
            given: { type: 'string' },
            when: { type: 'string' },
            then: { type: 'string' },
            and: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      relatedEntity: { type: 'string' },
    },
  },
} as const;

export const STAGE6_ADR_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['id', 'title', 'status', 'context', 'decision', 'consequences', 'alternatives', 'relatedLayers', 'relatedDomains'],
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string' },
      context: { type: 'string' },
      decision: { type: 'string' },
      consequences: { type: 'array', items: { type: 'string' } },
      alternatives: { type: 'array', items: { type: 'string' } },
      relatedLayers: { type: 'array', items: { type: 'string' } },
      relatedDomains: { type: 'array', items: { type: 'string' } },
    },
  },
} as const;

export const SUBSPEC_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    required: ['name', 'callee', 'purpose', 'operations'],
    properties: {
      name: { type: 'string' },
      callee: { type: 'string' },
      purpose: { type: 'string' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'description', 'scenarios'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            inputs: { type: 'array', items: { type: 'string' } },
            outputs: { type: 'array', items: { type: 'string' } },
            functionName: { type: 'string' },
            scenarios: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'given', 'when', 'then'],
                properties: {
                  name: { type: 'string' },
                  given: { type: 'string' },
                  when: { type: 'string' },
                  then: { type: 'string' },
                  and: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
