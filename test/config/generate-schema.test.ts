import { describe, expect, it } from 'vitest'
import { generateSchema } from '../../src/config/generate-schema.js'

type JsonObject = Record<string, any>

const envPattern = {
  string: '^\\$s\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$',
  integer: '^\\$i\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$',
  number: '^\\$f\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$',
  boolean: '^\\$b\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}$',
  embedded: '\\$[sifb]\\{[A-Za-z_][A-Za-z0-9_]*(?:\\|[^}]*)?\\}',
  ref: '^#/\\$defs(?:/[^\\s]+)+$'
}

const asObject = (value: unknown): JsonObject => {
  expect(value).toBeTypeOf('object')
  expect(value).not.toBeNull()
  expect(Array.isArray(value)).toBe(false)

  return value as JsonObject
}

const asArray = <T = unknown>(value: unknown): T[] => {
  expect(Array.isArray(value)).toBe(true)

  return value as T[]
}

const variantsOf = (schema: unknown): JsonObject[] =>
  asArray<JsonObject>(asObject(schema).anyOf)

const prop = (schema: unknown, key: string): JsonObject => {
  const properties = asObject(asObject(schema).properties)
  expect(properties[key]).toBeDefined()

  return asObject(properties[key])
}

const def = (schema: unknown, key: string): JsonObject => {
  const defs = asObject(asObject(schema).$defs)
  expect(defs[key]).toBeDefined()

  return asObject(defs[key])
}

const firstVariant = (schema: unknown): JsonObject =>
  asObject(variantsOf(schema)[0])

const expectAnyOfContainsPattern = (
  schema: unknown,
  pattern: string
): void => {
  expect(variantsOf(schema)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'string',
        pattern
      })
    ])
  )
}

const findMergeVariant = (schema: unknown): JsonObject => {
  const variant = variantsOf(schema).find(candidate => {
    const required = candidate.required

    return (
      candidate.type === 'object' &&
      Array.isArray(required) &&
      required.includes('$ref')
    )
  })

  expect(variant).toBeDefined()

  return asObject(variant)
}

describe('generateSchema', () => {
  it('génère les métadonnées racine et la section $defs de configuration', () => {
    const generated = generateSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.test/source.schema.json',
      type: 'object',
      properties: {
        name: {
          type: 'string'
        }
      }
    })

    expect(generated).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://geocomposer.local/config-and-rules.schema.json',
      title: 'GeoComposer config with expansion rules',
      type: 'object'
    })

    expect(prop(generated, '$defs')).toMatchObject({
      type: 'object',
      description: 'Définitions de configuration réutilisables avant expansion'
    })

    expect(variantsOf(prop(generated, 'name'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'string' }),
        expect.objectContaining({ pattern: envPattern.string }),
        expect.objectContaining({ pattern: envPattern.embedded }),
        expect.objectContaining({ pattern: envPattern.ref })
      ])
    )
  })

  it('ajoute les variables d’environnement typées selon le type JSON Schema', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        text: { type: 'string' },
        port: { type: 'integer', minimum: 0, maximum: 65535 },
        ratio: { type: 'number' },
        enabled: { type: 'boolean' }
      }
    })

    expectAnyOfContainsPattern(prop(generated, 'text'), envPattern.string)
    expectAnyOfContainsPattern(prop(generated, 'text'), envPattern.embedded)
    expectAnyOfContainsPattern(prop(generated, 'port'), envPattern.integer)
    expectAnyOfContainsPattern(prop(generated, 'ratio'), envPattern.number)
    expectAnyOfContainsPattern(prop(generated, 'enabled'), envPattern.boolean)

    expect(variantsOf(prop(generated, 'port'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'integer',
          minimum: 0,
          maximum: 65535
        })
      ])
    )

    expect(variantsOf(prop(generated, 'port'))).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ pattern: envPattern.string }),
        expect.objectContaining({ pattern: envPattern.number }),
        expect.objectContaining({ pattern: envPattern.boolean })
      ])
    )
  })

  it('transforme aussi les propriétés placées dans $defs', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        server: { $ref: '#/$defs/server' }
      },
      $defs: {
        server: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'integer', minimum: 0, maximum: 65535 },
            logLevel: { enum: ['DEBUG', 'LOG', 'WARN', 'ERROR', 'NONE'] }
          }
        }
      }
    })

    const server = firstVariant(def(generated, 'server'))

    expectAnyOfContainsPattern(prop(server, 'port'), envPattern.integer)
    expectAnyOfContainsPattern(prop(server, 'logLevel'), envPattern.string)
    expectAnyOfContainsPattern(prop(server, 'logLevel'), envPattern.embedded)

    expect(variantsOf(prop(generated, 'server'))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ $ref: '#/$defs/server' }),
        expect.objectContaining({ type: 'object', required: ['$ref'] })
      ])
    )
  })

  it('déduit le type depuis const et enum', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        stringConst: { const: 'abc' },
        integerConst: { const: 1 },
        numberConst: { const: 1.5 },
        booleanConst: { const: true },
        stringEnum: { enum: ['A', 'B'] },
        integerEnum: { enum: [1, 2] },
        numberEnum: { enum: [1.5, 2.5] },
        booleanEnum: { enum: [true, false] },
        mixedEnum: { enum: ['A', 1] },
        emptyEnum: { enum: [] }
      }
    })

    expectAnyOfContainsPattern(prop(generated, 'stringConst'), envPattern.string)
    expectAnyOfContainsPattern(prop(generated, 'integerConst'), envPattern.integer)
    expectAnyOfContainsPattern(prop(generated, 'numberConst'), envPattern.number)
    expectAnyOfContainsPattern(prop(generated, 'booleanConst'), envPattern.boolean)

    expectAnyOfContainsPattern(prop(generated, 'stringEnum'), envPattern.string)
    expectAnyOfContainsPattern(prop(generated, 'integerEnum'), envPattern.integer)
    expectAnyOfContainsPattern(prop(generated, 'numberEnum'), envPattern.number)
    expectAnyOfContainsPattern(prop(generated, 'booleanEnum'), envPattern.boolean)

    expect(variantsOf(prop(generated, 'mixedEnum'))).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ pattern: envPattern.string }),
        expect.objectContaining({ pattern: envPattern.integer }),
        expect.objectContaining({ pattern: envPattern.number }),
        expect.objectContaining({ pattern: envPattern.boolean })
      ])
    )

    expect(variantsOf(prop(generated, 'emptyEnum'))).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ pattern: envPattern.string }),
        expect.objectContaining({ pattern: envPattern.integer }),
        expect.objectContaining({ pattern: envPattern.number }),
        expect.objectContaining({ pattern: envPattern.boolean })
      ])
    )
  })

  it('résout les $ref locaux pour déduire le type avec échappement JSON Pointer', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        value: { $ref: '#/$defs/a~1b~0c' }
      },
      $defs: {
        'a/b~c': { type: 'integer' }
      }
    })

    expectAnyOfContainsPattern(prop(generated, 'value'), envPattern.integer)
  })

  it('préserve les $ref externes ou non résolus sans déduction de type', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        external: { $ref: 'https://example.test/external.schema.json' },
        missing: { $ref: '#/$defs/missing' }
      },
      $defs: {}
    })

    expect(firstVariant(prop(generated, 'external'))).toMatchObject({
      $ref: 'https://example.test/external.schema.json'
    })

    expect(firstVariant(prop(generated, 'missing'))).toMatchObject({
      $ref: '#/$defs/missing'
    })

    expect(variantsOf(prop(generated, 'external'))).toEqual(
      expect.not.arrayContaining([
        expect.objectContaining({ pattern: envPattern.string }),
        expect.objectContaining({ pattern: envPattern.integer })
      ])
    )
  })

  it('génère une variante de fusion objet avec $ref local et propriétés héritées par allOf', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        item: { $ref: '#/$defs/item' }
      },
      $defs: {
        common: {
          type: 'object',
          properties: {
            title: { type: 'string' }
          }
        },
        item: {
          type: 'object',
          allOf: [{ $ref: '#/$defs/common' }],
          additionalProperties: { type: 'string' },
          unevaluatedProperties: false,
          properties: {
            count: { type: 'integer' }
          }
        }
      }
    })

    const mergeVariant = findMergeVariant(prop(generated, 'item'))

    expect(mergeVariant).toMatchObject({
      type: 'object',
      required: ['$ref']
    })

    expect(asObject(mergeVariant.properties)).toMatchObject({
      title: expect.any(Object),
      count: expect.any(Object),
      $ref: expect.objectContaining({ pattern: envPattern.ref })
    })

    expectAnyOfContainsPattern(prop(mergeVariant, 'title'), envPattern.string)
    expectAnyOfContainsPattern(prop(mergeVariant, 'count'), envPattern.integer)
  })

  it('préserve additionalProperties false dans les variantes de fusion objet', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        closed: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' }
          }
        }
      }
    })

    const mergeVariant = findMergeVariant(prop(generated, 'closed'))

    expect(mergeVariant.additionalProperties).toBe(false)
    expect(asObject(mergeVariant.properties)).toMatchObject({
      name: expect.any(Object),
      $ref: expect.any(Object)
    })
  })

  it('transforme les sous-schémas items, prefixItems, contains, propertyNames, not, if, then et else', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'integer' },
          prefixItems: [{ type: 'string' }],
          contains: { type: 'string' },
          propertyNames: { type: 'string' },
          not: { type: 'boolean' },
          if: { type: 'string' },
          then: { type: 'number' },
          else: { type: 'boolean' }
        }
      }
    })

    const list = firstVariant(prop(generated, 'list'))

    expectAnyOfContainsPattern(list.items, envPattern.integer)
    expectAnyOfContainsPattern(asArray(list.prefixItems)[0], envPattern.string)
    expectAnyOfContainsPattern(list.contains, envPattern.string)
    expectAnyOfContainsPattern(list.propertyNames, envPattern.string)
    expectAnyOfContainsPattern(list.not, envPattern.boolean)
    expectAnyOfContainsPattern(list.if, envPattern.string)
    expectAnyOfContainsPattern(list.then, envPattern.number)
    expectAnyOfContainsPattern(list.else, envPattern.boolean)
  })

it('transforme patternProperties, dependentSchemas, definitions, anyOf, oneOf et allOf', () => {
  const generated = generateSchema({
    type: 'object',
    patternProperties: {
      '^x-': { type: 'string' }
    },
    dependentSchemas: {
      enabled: {
        type: 'object',
        properties: {
          mode: { type: 'string' }
        }
      }
    },
    definitions: {
      legacy: { type: 'integer' }
    },
    properties: {
      union: {
        anyOf: [{ type: 'string' }, { type: 'integer' }]
      },
      exclusive: {
        oneOf: [{ type: 'number' }, { type: 'boolean' }]
      },
      composed: {
        allOf: [
          {
            type: 'object',
            properties: {
              name: { type: 'string' }
            }
          }
        ]
      }
    }
  })

  expectAnyOfContainsPattern(
    asObject(generated.patternProperties)['^x-'],
    envPattern.string
  )

  const dependentEnabled = firstVariant(
    asObject(generated.dependentSchemas).enabled
  )

  expectAnyOfContainsPattern(
    prop(dependentEnabled, 'mode'),
    envPattern.string
  )

  expectAnyOfContainsPattern(
    asObject(generated.definitions).legacy,
    envPattern.integer
  )

  const union = firstVariant(prop(generated, 'union'))

  expectAnyOfContainsPattern(
    asArray<JsonObject>(union.anyOf)[0],
    envPattern.string
  )

  expectAnyOfContainsPattern(
    asArray<JsonObject>(union.anyOf)[1],
    envPattern.integer
  )

  const exclusive = firstVariant(prop(generated, 'exclusive'))

  expectAnyOfContainsPattern(
    asArray<JsonObject>(exclusive.oneOf)[0],
    envPattern.number
  )

  expectAnyOfContainsPattern(
    asArray<JsonObject>(exclusive.oneOf)[1],
    envPattern.boolean
  )

  const composed = firstVariant(prop(generated, 'composed'))
  const composedAllOf = asArray<JsonObject>(composed.allOf)
  const composedObject = firstVariant(composedAllOf[0])

  expectAnyOfContainsPattern(
    prop(composedObject, 'name'),
    envPattern.string
  )
})

  it('conserve les sous-schémas booléens', () => {
    const generated = generateSchema({
      type: 'object',
      properties: {
        passthrough: {
          type: 'object',
          additionalProperties: true,
          unevaluatedProperties: false
        }
      }
    })

    const passthrough = firstVariant(prop(generated, 'passthrough'))

    expect(passthrough.additionalProperties).toBe(true)
    expect(passthrough.unevaluatedProperties).toBe(false)
  })
})